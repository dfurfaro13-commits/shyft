import { exec, q1, nowSec } from "../lib/db.js";
import { newId, randomToken, generateJoinCode } from "../lib/ids.js";
import { hashPassword, generateTempPassword } from "../lib/passwords.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson } from "../lib/http.js";

const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;
const CODE_GEN_RETRIES = 5;

// Allocate a unique 6-char code for the given column (join_code or admin_code), retrying on
// collision. With 31^6 ≈ 887M possible codes and a tiny group count, this loop almost never
// retries. We don't enforce join_code != admin_code globally — within a group it's fine for
// them to differ purely by happenstance.
async function allocateUniqueCode(env, column) {
  for (let i = 0; i < CODE_GEN_RETRIES; i++) {
    const code = generateJoinCode();
    const hit = await q1(env, `SELECT id FROM groups WHERE ${column} = ?`, code);
    if (!hit) return code;
  }
  throw new Error(`${column}_exhausted`);
}
const allocateUniqueJoinCode = (env) => allocateUniqueCode(env, "join_code");
const allocateUniqueAdminCode = (env) => allocateUniqueCode(env, "admin_code");

async function callerCanCreateGroups(env, userId) {
  const row = await q1(env, "SELECT can_create_groups FROM users WHERE id = ?", userId);
  return !!row?.can_create_groups;
}

// POST /api/groups  { name }
export async function createGroup(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");
  if (!(await callerCanCreateGroups(env, user.id))) return err(403, "not_allowed");

  const body = await readJson(req);
  const name = String(body.name || "").trim();
  if (!name) return err(400, "name_required");
  if (name.length > 80) return err(400, "name_too_long");

  const groupId = newId("grp");
  const joinCode = await allocateUniqueJoinCode(env);
  const adminCode = await allocateUniqueAdminCode(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, owner_user_id, join_code, admin_code) VALUES (?, ?, ?, ?, ?)")
      .bind(groupId, name, user.id, joinCode, adminCode),
    env.DB.prepare("INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, 'owner')")
      .bind(user.id, groupId),
  ]);
  return json({ groupId, name, joinCode, adminCode });
}

// POST /api/groups/:gid/join-code
//   Owner-only. Returns an existing code or provisions a new one. Idempotent.
export async function ensureJoinCode(req, env, { gid }) {
  return ensureCode(req, env, gid, "join_code", "joinCode");
}

// POST /api/groups/:gid/admin-code
//   Owner-only. Returns an existing admin code or provisions a new one. Idempotent.
export async function ensureAdminCode(req, env, { gid }) {
  return ensureCode(req, env, gid, "admin_code", "adminCode");
}

async function ensureCode(req, env, gid, column, fieldName) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const mem = await q1(env, "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?", user.id, gid);
  if (!mem || mem.role !== "owner") return err(403, "not_owner");

  const row = await q1(env, `SELECT ${column} AS code FROM groups WHERE id = ?`, gid);
  if (!row) return err(404, "not_found");
  if (row.code) return json({ [fieldName]: row.code, generated: false });

  const code = await allocateUniqueCode(env, column);
  await exec(env, `UPDATE groups SET ${column} = ? WHERE id = ?`, code, gid);
  return json({ [fieldName]: code, generated: true });
}

// POST /api/groups/join  { joinCode, adminCode? }
//   Authenticated user joins a cloud group via its public join code. If `adminCode` is also
//   provided AND matches the group's admin_code, the user joins as `admin`. Wrong adminCode
//   is an explicit error (no silent demotion). If already a member at a lower role, a correct
//   adminCode upgrades them to admin.
export async function joinGroupByCode(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const body = await readJson(req);
  const joinCode = String(body.joinCode || "").trim().toUpperCase();
  const adminCode = String(body.adminCode || "").trim().toUpperCase();
  if (!joinCode) return err(400, "code_required");

  const group = await q1(env, "SELECT id, name, admin_code FROM groups WHERE join_code = ?", joinCode);
  if (!group) return err(404, "invalid_code");

  let requestedRole = "provider";
  if (adminCode) {
    if (!group.admin_code || adminCode !== group.admin_code) return err(400, "invalid_admin_code");
    requestedRole = "admin";
  }

  const existing = await q1(
    env,
    "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id, group.id,
  );

  let finalRole;
  if (!existing) {
    await exec(
      env,
      "INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, ?)",
      user.id, group.id, requestedRole,
    );
    finalRole = requestedRole;
  } else if (existing.role === "owner") {
    finalRole = "owner";  // never demote an owner
  } else if (requestedRole === "admin" && existing.role === "provider") {
    await exec(env, "UPDATE memberships SET role = 'admin' WHERE user_id = ? AND group_id = ?", user.id, group.id);
    finalRole = "admin";
  } else {
    finalRole = existing.role;
  }
  return json({ groupId: group.id, name: group.name, role: finalRole });
}

// POST /api/memberships/:gid/local-uid  { localUid }
//   Phase D.3: lets a freshly-joined cloud user record the local profile id they just created
//   on this device, so subsequent sign-ins auto-link cleanly. Idempotent: only sets when the
//   current value is NULL — never clobbers an existing link.
export async function setMyLocalUid(req, env, { gid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const body = await readJson(req);
  const localUid = String(body.localUid || "").trim();
  if (!localUid) return err(400, "missing_local_uid");

  const m = await q1(env, "SELECT local_uid FROM memberships WHERE user_id = ? AND group_id = ?", user.id, gid);
  if (!m) return err(404, "not_a_member");
  if (m.local_uid) return json({ ok: true, alreadySet: true });

  await exec(env, "UPDATE memberships SET local_uid = ? WHERE user_id = ? AND group_id = ?", localUid, user.id, gid);
  return json({ ok: true });
}

// POST /api/groups/:gid/backfill-usernames
//   Body: [{ localUid, username, name?, role? }, ...]
//   Owner-only. Idempotent. Two purposes:
//     1. Set username on existing cloud users created during D.2 migration that never got one.
//     2. Provision a cloud test user for any local user that has no cloud counterpart at all
//        (e.g. added via admin "+ Add user" after the group was migrated). Returns the temp
//        password so the admin can hand it out.
//   Joins on memberships.local_uid → users.id. Conflicts (username already taken globally)
//   are reported per-entry so a single bad name doesn't fail the whole batch.
export async function backfillUsernames(req, env, { gid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");

  const mem = await q1(env, "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?", caller.id, gid);
  if (!mem || mem.role !== "owner") return err(403, "not_owner");

  const body = await readJson(req);
  if (!Array.isArray(body)) return err(400, "expected_array");

  let updated = 0, skipped = 0;
  const conflicts = [];
  const created = [];
  for (const entry of body) {
    const localUid = String(entry?.localUid ?? "").trim();
    const username = String(entry?.username ?? "").trim();
    const displayName = String(entry?.name ?? "").trim() || username || "user";
    const role = entry?.role === "admin" ? "admin" : "provider";
    if (!localUid || !username) { skipped++; continue; }
    // Backfill regex is intentionally looser than sign-up: legacy local usernames may contain
    // spaces (e.g. "cloud admin") so we tolerate them here. Sign-in by username works because
    // the lookup is exact-match COLLATE NOCASE — no parsing involved.
    if (!/^[a-zA-Z0-9_. \-]{2,40}$/.test(username)) { skipped++; continue; }

    const m = await q1(
      env,
      "SELECT user_id FROM memberships WHERE group_id = ? AND local_uid = ?",
      gid, localUid,
    );

    if (m) {
      // Existing cloud user — only set username if currently NULL.
      const cur = await q1(env, "SELECT username FROM users WHERE id = ?", m.user_id);
      if (cur?.username) { skipped++; continue; }
      try {
        await exec(env, "UPDATE users SET username = ? WHERE id = ?", username, m.user_id);
        updated++;
      } catch {
        conflicts.push({ localUid, username });
      }
      continue;
    }

    // No membership yet — provision a cloud test user with synthetic email + temp password.
    const email = `${localUid}@${gid}.test.invalid`.toLowerCase();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const userId = newId("usr");
    try {
      await exec(
        env,
        "INSERT INTO users (id, email, display_name, username, kind, password_hash) VALUES (?, ?, ?, ?, 'test', ?)",
        userId, email, displayName, username, passwordHash,
      );
      await exec(
        env,
        "INSERT INTO memberships (user_id, group_id, role, local_uid) VALUES (?, ?, ?, ?)",
        userId, gid, role, localUid,
      );
      created.push({ localUid, name: displayName, username, email, tempPassword, role });
    } catch (e) {
      // Likely a username collision (global unique). Skip — user can rename and re-sync.
      const msg = String(e?.message || e || "");
      if (msg.includes("UNIQUE")) conflicts.push({ localUid, username, reason: "username_or_email_taken" });
      else { skipped++; }
    }
  }
  return json({ updated, skipped, conflicts, created });
}

// POST /api/groups/:gid/invites  { role, expiresInDays? }
export async function createInvite(req, env, { gid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const membership = await q1(
    env,
    "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    gid,
  );
  if (!membership || membership.role !== "owner") return err(403, "not_owner");

  const body = await readJson(req);
  const role = body.role === "admin" ? "admin" : "provider";
  const days = Math.min(
    MAX_INVITE_TTL_DAYS,
    Math.max(1, Number(body.expiresInDays) || DEFAULT_INVITE_TTL_DAYS),
  );

  const token = randomToken(24);
  const expiresAt = nowSec() + days * 86400;

  await exec(
    env,
    "INSERT INTO invites (token, group_id, created_by_user_id, role, expires_at) VALUES (?, ?, ?, ?, ?)",
    token,
    gid,
    user.id,
    role,
    expiresAt,
  );

  const url = `${env.APP_URL}/?invite=${encodeURIComponent(token)}`;
  return json({ token, url, role, expiresAt });
}

// GET /api/invites/:token   (public)
export async function getInvite(req, env, { token }) {
  const row = await q1(
    env,
    `SELECT i.token, i.group_id AS groupId, i.role, i.expires_at AS expiresAt, i.used_at AS usedAt,
            g.name AS groupName
       FROM invites i
       JOIN groups g ON g.id = i.group_id
      WHERE i.token = ?`,
    token,
  );
  if (!row) return err(404, "not_found");
  if (row.usedAt) return err(410, "already_used");
  if (row.expiresAt < nowSec()) return err(410, "expired");
  return json({
    token: row.token,
    groupId: row.groupId,
    groupName: row.groupName,
    role: row.role,
    expiresAt: row.expiresAt,
  });
}

// POST /api/groups/:gid/migrate
//   { name, snapshot: <full snapshot payload>, users: [{ localId, name, role }, ...] }
//
// Phase D.2: turns a local-only group into a cloud group. The cloud-signed-in caller
// becomes the new group's owner. Every local user listed becomes a `kind='test'` cloud
// user with a synthetic email and a freshly-generated password — returned in the response
// so the migrating admin can hand them out for testing. No emails are sent.
//
// `:gid` here is the LOCAL group id (numeric/timestamp). We mint a fresh cloud group id
// ourselves; the local id is informational only.
export async function migrateGroup(req, env, { gid }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");
  if (!(await callerCanCreateGroups(env, caller.id))) return err(403, "not_allowed");

  const body = await readJson(req);
  const name = String(body.name || "").trim();
  if (!name) return err(400, "name_required");
  const localUsers = Array.isArray(body.users) ? body.users : [];
  const snapshotPayload = body.snapshot || null;
  if (!snapshotPayload) return err(400, "snapshot_required");

  const cloudGroupId = newId("grp");
  const joinCode = await allocateUniqueJoinCode(env);
  const adminCode = await allocateUniqueAdminCode(env);
  const nowS = nowSec();

  // 1. Create the group + caller's owner membership.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, owner_user_id, join_code, admin_code) VALUES (?, ?, ?, ?, ?)")
      .bind(cloudGroupId, name, caller.id, joinCode, adminCode),
    env.DB.prepare("INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, 'owner')")
      .bind(caller.id, cloudGroupId),
  ]);

  // 2. Create one test user per local user with a synthetic email + temp password.
  const created = [];
  for (const u of localUsers) {
    const localId = String(u.localId ?? "");
    const displayName = String(u.name || "user").slice(0, 80);
    const role = u.role === "admin" ? "admin" : "provider";
    const email = `${localId || newId("u").slice(2)}@${cloudGroupId}.test.invalid`.toLowerCase();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const userId = newId("usr");
    try {
      await exec(
        env,
        "INSERT INTO users (id, email, display_name, kind, password_hash) VALUES (?, ?, ?, 'test', ?)",
        userId, email, displayName, passwordHash,
      );
      await exec(
        env,
        "INSERT INTO memberships (user_id, group_id, role, local_uid) VALUES (?, ?, ?, ?)",
        userId, cloudGroupId, role, localId || null,
      );
      created.push({ localId, name: displayName, email, tempPassword, role });
    } catch (e) {
      console.error("migrate user create failed:", displayName, e?.message || e);
    }
  }

  // 3. Upload the snapshot directly into D1 + R2 so the new cloud group has data immediately.
  const payloadStr = typeof snapshotPayload === "string" ? snapshotPayload : JSON.stringify(snapshotPayload);
  const clientTs = Number.isFinite(+body.clientTs) ? Math.floor(+body.clientTs) : Date.now();
  await exec(
    env,
    `INSERT INTO snapshots (group_id, user_id, payload, client_ts, server_ts) VALUES (?, ?, ?, ?, ?)`,
    cloudGroupId, caller.id, payloadStr, clientTs, nowS,
  );
  if (env.R2) {
    try {
      const key = `snapshots/${cloudGroupId}/${nowS}-${clientTs}.json`;
      await env.R2.put(key, payloadStr, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          groupId: cloudGroupId,
          userId: caller.id,
          clientTs: String(clientTs),
          serverTs: String(nowS),
          migratedFromLocal: String(gid),
        },
      });
    } catch (e) {
      console.error("migrate snapshot R2 write failed:", e?.message || e);
    }
  }

  return json({ cloudGroupId, name, joinCode, adminCode, users: created });
}
