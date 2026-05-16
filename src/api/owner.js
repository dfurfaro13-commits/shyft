// Phase D.3 follow-up: owner-only "Accounts" tab in SuperDashboard. Lets the owner of one or
// more groups see every user in those groups, change their email/password, or delete them.
//
// Multi-tenant scoping: every endpoint filters on memberships where the caller is owner. An
// owner can never read or edit a user who isn't in one of their groups.

import { exec, q1, nowSec } from "../lib/db.js";
import { hashPassword } from "../lib/passwords.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson, normalizeEmail, isEmail } from "../lib/http.js";

const MIN_PASSWORD_LEN = 8;

async function callerOwnedGroupIds(env, callerId) {
  const rows = (await env.DB.prepare(
    "SELECT group_id AS gid FROM memberships WHERE user_id = ? AND role = 'owner'",
  ).bind(callerId).all()).results || [];
  return rows.map(r => r.gid);
}

// True if caller owns at least one group the target is a member of.
async function callerCanManage(env, callerId, targetId) {
  const row = await q1(env, `
    SELECT 1 AS ok
      FROM memberships c
      JOIN memberships t ON t.group_id = c.group_id
     WHERE c.user_id = ? AND c.role = 'owner' AND t.user_id = ?
     LIMIT 1
  `, callerId, targetId);
  return !!row;
}

// GET /api/owner/snapshots/:gid/r2-list
//   Lists R2 snapshot history for a group the caller owns. Used for manual recovery
//   when the latest D1 snapshot has been corrupted (e.g. an empty-payload wipe). Returns
//   up to `limit` (default 50, max 500) keys, sorted server_ts descending.
export async function listSnapshotHistory(req, env, { gid }) {
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  const ownedIds = await callerOwnedGroupIds(env, caller.id);
  if (!ownedIds.includes(gid)) return err(403, "not_owner");
  if (!env.R2) return err(503, "r2_unavailable");

  const url = new URL(req.url);
  const limitRaw = +url.searchParams.get("limit");
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 50;

  const prefix = `snapshots/${gid}/`;
  const result = await env.R2.list({ prefix, limit: 1000 });
  const all = (result.objects || []).map(o => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded,
    serverTs: parseInt(o.customMetadata?.serverTs || "0", 10) || 0,
    clientTs: parseInt(o.customMetadata?.clientTs || "0", 10) || 0,
  }));
  all.sort((a, b) => b.serverTs - a.serverTs);
  return json({
    groupId: gid,
    count: all.length,
    items: all.slice(0, limit),
    truncated: !!result.truncated,
  });
}

// POST /api/owner/snapshots/:gid/restore  { r2Key }
//   Reads the named R2 object and writes its payload back as both the latest D1 snapshot
//   AND a fresh R2 history entry. Owner-only. Path-scoped: the r2Key must be under this
//   group's prefix, so an owner of group A cannot read group B's history.
export async function restoreSnapshot(req, env, { gid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  const ownedIds = await callerOwnedGroupIds(env, caller.id);
  if (!ownedIds.includes(gid)) return err(403, "not_owner");
  if (!env.R2) return err(503, "r2_unavailable");

  const body = await readJson(req);
  const r2Key = String(body.r2Key || "");
  const expectedPrefix = `snapshots/${gid}/`;
  if (!r2Key.startsWith(expectedPrefix)) return err(400, "key_not_for_this_group");

  const obj = await env.R2.get(r2Key);
  if (!obj) return err(404, "r2_object_not_found");

  const payloadStr = await obj.text();
  let payload;
  try { payload = JSON.parse(payloadStr); } catch { return err(400, "r2_object_not_json"); }

  const clientTs = Date.now();
  const serverTs = nowSec();

  await exec(
    env,
    `INSERT INTO snapshots (group_id, user_id, payload, client_ts, server_ts)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       user_id   = excluded.user_id,
       payload   = excluded.payload,
       client_ts = excluded.client_ts,
       server_ts = excluded.server_ts`,
    gid, caller.id, payloadStr, clientTs, serverTs,
  );

  const newKey = `snapshots/${gid}/${serverTs}-${clientTs}.json`;
  try {
    await env.R2.put(newKey, payloadStr, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        groupId: gid,
        userId: caller.id,
        clientTs: String(clientTs),
        serverTs: String(serverTs),
        restoredFrom: r2Key,
      },
    });
  } catch (e) {
    console.error("R2 put on restore failed:", newKey, e?.message || e);
  }

  return json({
    groupId: gid,
    restoredFrom: r2Key,
    newKey,
    serverTs,
    clientTs,
    users: Array.isArray(payload?.users) ? payload.users.length : 0,
    blocks: Array.isArray(payload?.config?.blocks) ? payload.config.blocks.length : 0,
  });
}

// GET /api/owner/users
//   Returns every user in the caller's owned groups, with their per-group memberships rolled
//   into one entry. Excludes the caller themselves (owner manages everyone except self via this).
export async function listOwnerUsers(req, env) {
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  const ownedIds = await callerOwnedGroupIds(env, caller.id);
  if (!ownedIds.length) return json({ users: [] });

  const placeholders = ownedIds.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName, u.username, u.kind,
            u.created_at AS createdAt, u.password_hash AS passwordHash,
            m.group_id AS groupId, m.role, m.local_uid AS localUid,
            g.name AS groupName
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN groups g ON g.id = m.group_id
      WHERE m.group_id IN (${placeholders}) AND u.id != ?`,
  ).bind(...ownedIds, caller.id).all()).results || [];

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.id)) {
      byUser.set(r.id, {
        id: r.id,
        email: r.email,
        displayName: r.displayName,
        username: r.username,
        kind: r.kind,
        createdAt: r.createdAt,
        hasPassword: !!r.passwordHash,
        memberships: [],
      });
    }
    byUser.get(r.id).memberships.push({
      groupId: r.groupId,
      groupName: r.groupName,
      role: r.role,
      localUid: r.localUid,
    });
  }
  // Stable order: by display name, falling back to email.
  const users = Array.from(byUser.values()).sort((a, b) =>
    (a.displayName || a.email || "").localeCompare(b.displayName || b.email || ""),
  );
  return json({ users });
}

// PATCH /api/owner/users/:uid  { email?, password? }
//   Owner-only. Rejects self-edits (use the existing set-password button on the cloud strip).
//   Email change validates uniqueness; password change hashes and stores.
export async function updateOwnerUser(req, env, { uid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  if (caller.id === uid) return err(400, "cannot_edit_self");
  if (!(await callerCanManage(env, caller.id, uid))) return err(403, "forbidden");

  const body = await readJson(req);
  const updates = [];
  const params = [];
  let newEmail = null;

  if (body.email !== undefined) {
    newEmail = normalizeEmail(body.email);
    if (!isEmail(newEmail)) return err(400, "invalid_email");
    const existing = await q1(env, "SELECT id FROM users WHERE email = ? AND id != ?", newEmail, uid);
    if (existing) return err(409, "email_taken");
    updates.push("email = ?");
    params.push(newEmail);
  }

  if (body.password !== undefined) {
    const password = String(body.password || "");
    if (password.length < MIN_PASSWORD_LEN) return err(400, "password_too_short");
    const hash = await hashPassword(password);
    updates.push("password_hash = ?");
    params.push(hash);
  }

  if (!updates.length) return err(400, "nothing_to_update");

  params.push(uid);
  await exec(env, `UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...params);

  // If email changed, the email-keyed rate-limit + login_tokens rows for the OLD email are
  // stale but harmless. The new email starts with a fresh budget. Don't try to migrate.
  return json({ ok: true });
}

// DELETE /api/owner/users/:uid
//   Removes the user from every group the caller owns. If after that the user has no remaining
//   memberships anywhere (the common case for David's test users), we anonymize the row and
//   wipe sign-in artifacts so they can't recover the account. Events/snapshots are preserved
//   for ML continuity (their FK still resolves to the now-tombstoned users row).
export async function deleteOwnerUser(req, env, { uid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  if (caller.id === uid) return err(400, "cannot_delete_self");
  if (!(await callerCanManage(env, caller.id, uid))) return err(403, "forbidden");

  // Refuse to delete a user who owns any group — would orphan ownership of someone else's data.
  const targetOwnsAny = await q1(
    env,
    "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND role = 'owner' LIMIT 1",
    uid,
  );
  if (targetOwnsAny) return err(400, "target_is_owner");

  const target = await q1(env, "SELECT email FROM users WHERE id = ?", uid);
  if (!target) return err(404, "not_found");

  const ownedIds = await callerOwnedGroupIds(env, caller.id);
  if (!ownedIds.length) return err(403, "forbidden");

  // 1. Drop memberships in caller's groups.
  const placeholders = ownedIds.map(() => "?").join(",");
  await exec(
    env,
    `DELETE FROM memberships WHERE user_id = ? AND group_id IN (${placeholders})`,
    uid, ...ownedIds,
  );

  // 2. If no memberships remain anywhere, fully tombstone.
  const remaining = await q1(env, "SELECT 1 AS ok FROM memberships WHERE user_id = ? LIMIT 1", uid);
  let fullyDeleted = false;
  if (!remaining) {
    await exec(env, "DELETE FROM sessions WHERE user_id = ?", uid);
    await exec(env, "DELETE FROM login_tokens WHERE email = ?", target.email);
    await exec(env, "DELETE FROM password_attempts WHERE email = ?", target.email);
    const tombstone = `deleted-${uid}-${nowSec()}@deleted.invalid`;
    await exec(
      env,
      "UPDATE users SET email = ?, username = NULL, password_hash = NULL, display_name = 'Deleted user' WHERE id = ?",
      tombstone, uid,
    );
    fullyDeleted = true;
  }
  return json({ ok: true, fullyDeleted });
}
