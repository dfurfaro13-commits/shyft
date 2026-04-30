// Opaque session-id cookie. Server stores SHA-256(pepper + raw id) — a DB leak
// alone can't resurrect sessions because the pepper is a secret env var.

import { exec, q1, nowSec } from "./db.js";
import { SESSION_COOKIE, parseCookies, setCookie, clearCookie } from "./cookies.js";
import { randomToken, sha256Hex } from "./ids.js";

const SESSION_TTL_SEC = 60 * 60 * 24 * 30;   // 30 days

export async function createSession(env, userId) {
  const raw = randomToken(32);
  const idHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const expiresAt = nowSec() + SESSION_TTL_SEC;
  await exec(
    env,
    "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)",
    idHash,
    userId,
    expiresAt,
  );
  return { raw, expiresAt };
}

export async function getSessionUser(env, req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const idHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const row = await q1(
    env,
    `SELECT s.user_id, s.expires_at, s.revoked_at, u.id AS uid, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?`,
    idHash,
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at < nowSec()) return null;
  return { id: row.uid, email: row.email, displayName: row.display_name };
}

export async function revokeSession(env, req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return;
  const idHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  await exec(env, "UPDATE sessions SET revoked_at = ? WHERE id_hash = ?", nowSec(), idHash);
}

export function sessionSetCookieHeader(raw) {
  return setCookie(SESSION_COOKIE, raw, { maxAge: SESSION_TTL_SEC });
}

export function sessionClearCookieHeader() {
  return clearCookie(SESSION_COOKIE);
}
