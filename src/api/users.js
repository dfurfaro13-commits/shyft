import { exec, q1, nowSec } from "../lib/db.js";
import { newId, randomToken, sha256Hex } from "../lib/ids.js";
import { hashPassword, generateTempPassword } from "../lib/passwords.js";
import { sendMagicLink } from "../lib/email.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson, normalizeEmail, isEmail } from "../lib/http.js";

const MIN_PASSWORD_LEN = 8;

// POST /api/users  { kind: 'real'|'test', role: 'admin'|'provider', displayName, email?, groupId, localUid? }
//
// - kind='real':   email required; sends magic-link sign-in invitation; no password generated.
// - kind='test':   email synthesized from <localUid>@<groupId>.test.invalid (RFC 2606 reserved);
//                  random temp password generated and returned in response so admin can hand it
//                  out. The invite-link / magic-link path doesn't apply.
//
// In both cases, the caller must be an owner or admin of `groupId`. A `users` row is created
// (or reused if the email already exists) and a `memberships` row is added if not present.
export async function createUser(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");

  const body = await readJson(req);
  const kind = body.kind === "test" ? "test" : "real";
  const role = body.role === "admin" ? "admin" : "provider";
  const displayName = String(body.displayName || "").trim();
  const groupId = String(body.groupId || "");
  const localUid = body.localUid != null ? String(body.localUid) : null;
  if (!groupId) return err(400, "missing_group");
  if (!displayName) return err(400, "missing_display_name");

  // Caller must be owner or admin of groupId.
  const callerMem = await q1(
    env,
    "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
    caller.id, groupId,
  );
  if (!callerMem || (callerMem.role !== "owner" && callerMem.role !== "admin")) {
    return err(403, "forbidden");
  }

  // Resolve the email up front. For test users, derive synthetic; for real, validate input.
  let email;
  if (kind === "test") {
    const slug = (localUid || newId("u").slice(2));   // strip "u_" prefix when generating fallback
    email = `${slug}@${groupId}.test.invalid`.toLowerCase();
  } else {
    email = normalizeEmail(body.email);
    if (!isEmail(email)) return err(400, "invalid_email");
  }

  // Reuse existing users row if present (a person with that email may already be elsewhere).
  let user = await q1(env, "SELECT id, email, kind FROM users WHERE email = ?", email);
  let tempPassword = null;

  if (!user) {
    const userId = newId("usr");
    let passwordHash = null;
    if (kind === "test") {
      tempPassword = generateTempPassword();
      passwordHash = await hashPassword(tempPassword);
    }
    await exec(
      env,
      "INSERT INTO users (id, email, display_name, kind, password_hash) VALUES (?, ?, ?, ?, ?)",
      userId, email, displayName, kind, passwordHash,
    );
    user = { id: userId, email, kind };
  }

  // Add membership if missing. If a membership already exists with a different role, leave
  // it alone — admin can use a separate "change role" action (not yet implemented) to alter.
  const existingMem = await q1(
    env,
    "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id, groupId,
  );
  if (!existingMem) {
    await exec(
      env,
      "INSERT INTO memberships (user_id, group_id, role, local_uid) VALUES (?, ?, ?, ?)",
      user.id, groupId, role, localUid,
    );
  }

  // Real users with a real email get a magic-link sent so they can sign in. We pre-issue a
  // login_token directly here rather than calling /api/auth/request — the caller is an
  // authenticated admin, so the rate-limit doesn't apply.
  if (kind === "real") {
    try {
      const raw = randomToken(32);
      const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
      const expiresAt = nowSec() + (60 * 15);
      await exec(
        env,
        "INSERT INTO login_tokens (token_hash, email, invite_token, expires_at) VALUES (?, ?, NULL, ?)",
        tokenHash, email, expiresAt,
      );
      const link = `${env.APP_URL}/api/auth/verify?token=${encodeURIComponent(raw)}`;
      await sendMagicLink(env, { to: email, link });
    } catch (e) {
      console.error("user-create magic-link send failed:", e?.message || e);
    }
  }

  return json({
    userId: user.id,
    email,
    kind,
    tempPassword,                        // null for real users; the temp password for test users
    reused: !!existingMem || (user.kind && user.kind !== kind),
  });
}

// POST /api/users/me/password  { password }
//
// Phase D.3 preflight: lets a cloud-signed-in user set or change their own password. Required
// before D.3 ships so users who only ever signed in via magic-link can switch to the new
// password-first sign-in flow without being locked out (magic-link still works as fallback).
// No rate-limit — caller is already authenticated.
export async function setMyPassword(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const body = await readJson(req);
  const password = String(body.password || "");
  if (password.length < MIN_PASSWORD_LEN) return err(400, "password_too_short");

  const passwordHash = await hashPassword(password);
  await exec(env, "UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, user.id);
  return json({ ok: true });
}
