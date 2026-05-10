import { exec, q1, nowSec } from "../lib/db.js";
import { newId, randomToken } from "../lib/ids.js";
import { hashPassword, generateTempPassword } from "../lib/passwords.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson } from "../lib/http.js";

const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;

// POST /api/groups  { name, groupCode?, adminCode? }
//
// D.3: gated on users.can_create_groups (set by signup with a valid OWNER_BOOTSTRAP_CODE, or
// by the migration's grandfather pass). Optional groupCode/adminCode persist the codes a member
// will type when joining via the Sign up form; if omitted the row is created without codes
// (admin can set them later — not yet wired).
export async function createGroup(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");
  if (!user.canCreateGroups) return err(403, "not_authorized_to_create_groups");

  const body = await readJson(req);
  const name = String(body.name || "").trim();
  if (!name) return err(400, "name_required");
  if (name.length > 80) return err(400, "name_too_long");
  const groupCode = body.groupCode ? String(body.groupCode).trim().toUpperCase() : null;
  const adminCode = body.adminCode ? String(body.adminCode).trim().toUpperCase() : null;

  if (groupCode) {
    const taken = await q1(env, "SELECT 1 AS ok FROM groups WHERE group_code = ?", groupCode);
    if (taken) return err(409, "group_code_taken");
  }

  const groupId = newId("grp");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, owner_user_id, group_code, admin_code) VALUES (?, ?, ?, ?, ?)")
      .bind(groupId, name, user.id, groupCode, adminCode),
    env.DB.prepare("INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, 'owner')")
      .bind(user.id, groupId),
  ]);
  return json({ groupId, name, groupCode, adminCode });
}

// PATCH /api/groups/:gid/codes  { groupCode?, adminCode? }
//
// D.3 follow-up: lets the owner roll the group/admin codes after creation, so the
// codes shown on the local SuperDashboard stay in sync with what the cloud accepts on
// signup. Idempotent: if the supplied codes already match what's stored, returns ok
// without writing. Validates uniqueness against other groups.
export async function updateGroupCodes(req, env, { gid }) {
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
  const groupCode = body.groupCode != null ? String(body.groupCode).trim().toUpperCase() : undefined;
  const adminCode = body.adminCode != null ? String(body.adminCode).trim().toUpperCase() : undefined;
  if (groupCode === undefined && adminCode === undefined) return err(400, "nothing_to_update");

  const current = await q1(
    env,
    "SELECT group_code AS groupCode, admin_code AS adminCode FROM groups WHERE id = ?",
    gid,
  );
  if (!current) return err(404, "not_found");

  const updates = [];
  const params = [];
  if (groupCode !== undefined && groupCode !== (current.groupCode || "")) {
    if (groupCode) {
      const taken = await q1(env, "SELECT id FROM groups WHERE group_code = ? AND id != ?", groupCode, gid);
      if (taken) return err(409, "group_code_taken");
    }
    updates.push("group_code = ?");
    params.push(groupCode || null);
  }
  if (adminCode !== undefined && adminCode !== (current.adminCode || "")) {
    updates.push("admin_code = ?");
    params.push(adminCode || null);
  }
  if (!updates.length) return json({ ok: true, changed: false, groupCode: current.groupCode, adminCode: current.adminCode });

  params.push(gid);
  await exec(env, `UPDATE groups SET ${updates.join(", ")} WHERE id = ?`, ...params);
  return json({
    ok: true,
    changed: true,
    groupCode: groupCode !== undefined ? (groupCode || null) : current.groupCode,
    adminCode: adminCode !== undefined ? (adminCode || null) : current.adminCode,
  });
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
  if (!caller.canCreateGroups) return err(403, "not_authorized_to_create_groups");

  const body = await readJson(req);
  const name = String(body.name || "").trim();
  if (!name) return err(400, "name_required");
  const localUsers = Array.isArray(body.users) ? body.users : [];
  const snapshotPayload = body.snapshot || null;
  if (!snapshotPayload) return err(400, "snapshot_required");

  // Pull group/admin codes out of the snapshot meta so the cloud row knows what local users
  // will be typing into the Sign up form.
  const meta = (snapshotPayload && typeof snapshotPayload === "object" && snapshotPayload.meta) || {};
  const groupCode = meta.groupCode ? String(meta.groupCode).trim().toUpperCase() : null;
  const adminCode = meta.adminCode ? String(meta.adminCode).trim().toUpperCase() : null;

  // If this group code already exists in cloud (re-migration of the same local group), bail
  // rather than create a duplicate row that the partial unique index would reject anyway.
  if (groupCode) {
    const taken = await q1(env, "SELECT id FROM groups WHERE group_code = ?", groupCode);
    if (taken) return err(409, "group_code_taken");
  }

  const cloudGroupId = newId("grp");
  const nowS = nowSec();

  // 1. Create the group + caller's owner membership.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, owner_user_id, group_code, admin_code) VALUES (?, ?, ?, ?, ?)")
      .bind(cloudGroupId, name, caller.id, groupCode, adminCode),
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

  return json({ cloudGroupId, name, users: created });
}
