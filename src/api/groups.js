import { exec, q1, nowSec } from "../lib/db.js";
import { newId, randomToken } from "../lib/ids.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson } from "../lib/http.js";

const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;

// POST /api/groups  { name }
export async function createGroup(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const body = await readJson(req);
  const name = String(body.name || "").trim();
  if (!name) return err(400, "name_required");
  if (name.length > 80) return err(400, "name_too_long");

  const groupId = newId("grp");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, owner_user_id) VALUES (?, ?, ?)")
      .bind(groupId, name, user.id),
    env.DB.prepare("INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, 'owner')")
      .bind(user.id, groupId),
  ]);
  return json({ groupId, name });
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
