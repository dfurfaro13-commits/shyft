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
