// Self-service profile endpoints. Each requires an active session; no Owner gate.
// The Owner-managed Accounts modal (src/api/owner.js) is for editing OTHER users; this
// file is the surface a signed-in user uses to edit themselves.

import { exec, q1, nowSec } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { randomToken, sha256Hex } from "../lib/ids.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { sendEmailChangeLink } from "../lib/email.js";
import { json, err, readJson, normalizeEmail, isEmail } from "../lib/http.js";

const MIN_PASSWORD_LEN = 8;
const MIN_DISPLAY_NAME = 1;
const MAX_DISPLAY_NAME = 80;
const EMAIL_CHANGE_TTL_SEC = 60 * 15;

// PATCH /api/me/profile  { displayName }
//   Updates users.display_name. Frontend additionally propagates per-group users[gid][i].name
//   via user.update events for each of the caller's memberships so the local name (which is
//   what's actually rendered everywhere in the schedule UI) stays in sync.
export async function updateMyProfile(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");

  const body = await readJson(req);
  if (body.displayName === undefined) return err(400, "nothing_to_update");
  const displayName = String(body.displayName || "").trim();
  if (displayName.length < MIN_DISPLAY_NAME) return err(400, "name_too_short");
  if (displayName.length > MAX_DISPLAY_NAME) return err(400, "name_too_long");

  await exec(env, "UPDATE users SET display_name = ? WHERE id = ?", displayName, caller.id);
  return json({ ok: true, displayName });
}

// POST /api/me/password  { currentPassword, newPassword }
//   Self-service password rotation. Requires re-auth via currentPassword so a hijacked
//   open session can't lock the real user out by changing the password.
export async function updateMyPassword(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");

  const body = await readJson(req);
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");
  if (!current) return err(400, "current_password_required");
  if (next.length < MIN_PASSWORD_LEN) return err(400, "password_too_short");

  // Look up the stored hash directly — session row doesn't include it.
  const row = await q1(env, "SELECT password_hash FROM users WHERE id = ?", caller.id);
  if (!row) return err(404, "not_found");
  if (!row.password_hash) return err(400, "no_password_set");

  const ok = await verifyPassword(current, row.password_hash);
  if (!ok) return err(401, "current_password_incorrect");

  const hash = await hashPassword(next);
  await exec(env, "UPDATE users SET password_hash = ? WHERE id = ?", hash, caller.id);
  return json({ ok: true });
}

// POST /api/me/change-email-request  { newEmail }
//   Step 1 of email change. Validates the new address, mints a confirmation token, and
//   sends a magic link to the new address. The change isn't applied until the user clicks
//   the link (GET /api/auth/verify-email-change).
//
//   No re-auth required because the session is already authenticated and the proof-of-
//   ownership step happens on the receiving end. If multiple requests are made, the
//   newest token wins (we delete any prior pending tokens for this user).
export async function requestEmailChange(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const caller = await getSessionUser(env, req);
  if (!caller) return err(401, "unauthorized");

  const body = await readJson(req);
  const newEmail = normalizeEmail(body.newEmail);
  if (!isEmail(newEmail)) return err(400, "invalid_email");
  if (newEmail === normalizeEmail(caller.email)) return err(400, "same_email");

  const existing = await q1(env, "SELECT id FROM users WHERE email = ? AND id != ?", newEmail, caller.id);
  if (existing) return err(409, "email_taken");

  // Replace any prior pending tokens for this user so the latest request wins.
  await exec(env, "DELETE FROM email_change_tokens WHERE user_id = ?", caller.id);

  const raw = randomToken(32);
  const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const expiresAt = nowSec() + EMAIL_CHANGE_TTL_SEC;
  await exec(
    env,
    "INSERT INTO email_change_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, ?, ?, ?)",
    tokenHash, caller.id, newEmail, expiresAt,
  );

  const link = `${env.APP_URL}/api/auth/verify-email-change?token=${encodeURIComponent(raw)}`;
  try {
    await sendEmailChangeLink(env, { to: newEmail, link });
  } catch (e) {
    console.error("email change link send failed:", e?.message || e);
  }
  return json({ ok: true, sentTo: newEmail });
}
