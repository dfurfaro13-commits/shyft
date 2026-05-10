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

// GET /api/owner/lookup?email=xxx
//   Owner-only. Returns the cloud user matching `email` (exact, case-insensitive) plus EVERY
//   membership they hold, regardless of who owns those groups. Use this to investigate ghost
//   accounts that exist in the users table but don't appear in /api/owner/users (because they
//   have no membership in any of the caller's owned groups, or have no memberships at all).
//
//   Gated on canCreateGroups=1 — i.e., the caller has at least one owner-tier capability.
//   Returns 404 if the email isn't in the users table.
export async function lookupUser(req, env) {
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  if (!caller.canCreateGroups) return err(403, "forbidden");

  const url = new URL(req.url);
  const email = normalizeEmail(url.searchParams.get("email") || "");
  if (!isEmail(email)) return err(400, "invalid_email");

  const u = await q1(
    env,
    `SELECT id, email, display_name AS displayName, username, kind,
            password_hash AS passwordHash, can_create_groups AS canCreateGroups
       FROM users WHERE email = ?`,
    email,
  );
  if (!u) return err(404, "not_found");

  const memberships = (await env.DB.prepare(
    `SELECT m.group_id AS groupId, m.role, m.local_uid AS localUid,
            g.name AS groupName, g.owner_user_id AS ownerUserId
       FROM memberships m
       JOIN groups g ON g.id = m.group_id
      WHERE m.user_id = ?`,
  ).bind(u.id).all()).results || [];

  // Tag whether the caller owns each group, so the UI can decide whether to offer Edit/Delete.
  const ownedIds = new Set(await callerOwnedGroupIds(env, caller.id));
  const tagged = memberships.map(m => ({ ...m, callerOwns: ownedIds.has(m.groupId) }));

  return json({
    user: {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      username: u.username,
      kind: u.kind,
      hasPassword: !!u.passwordHash,
      canCreateGroups: !!u.canCreateGroups,
    },
    memberships: tagged,
    isSelf: u.id === caller.id,
  });
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

  // Authorization: the caller can act on the target if either
  //   (a) they share an owned group (the normal Accounts-list case), or
  //   (b) the caller has canCreateGroups AND the target has zero memberships anywhere
  //       — this lets owners clean up "ghost" cloud users (signed up with the bootstrap
  //       owner code, never created a group, never joined one) that the lookup endpoint
  //       surfaces but the regular /api/owner/users list can't see.
  const sharesGroup = await callerCanManage(env, caller.id, uid);
  let allowed = sharesGroup;
  if (!allowed && caller.canCreateGroups) {
    const anyMembership = await q1(env, "SELECT 1 AS ok FROM memberships WHERE user_id = ? LIMIT 1", uid);
    if (!anyMembership) allowed = true;
  }
  if (!allowed) return err(403, "forbidden");

  // Refuse to delete a user who owns any group — would orphan ownership of someone else's data.
  const targetOwnsAny = await q1(
    env,
    "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND role = 'owner' LIMIT 1",
    uid,
  );
  if (targetOwnsAny) return err(400, "target_is_owner");

  const target = await q1(env, "SELECT email FROM users WHERE id = ?", uid);
  if (!target) return err(404, "not_found");

  // 1. Drop memberships in caller's groups (no-op for the orphan-cleanup path where the
  //    caller doesn't share any groups with the target — they're already memberless).
  const ownedIds = await callerOwnedGroupIds(env, caller.id);
  if (ownedIds.length) {
    const placeholders = ownedIds.map(() => "?").join(",");
    await exec(
      env,
      `DELETE FROM memberships WHERE user_id = ? AND group_id IN (${placeholders})`,
      uid, ...ownedIds,
    );
  }

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
