import { exec, q1, nowSec } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { hashPassword } from "../lib/passwords.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { createSession, sessionSetCookieHeader } from "../lib/session.js";
import { json, err, readJson, normalizeEmail, isEmail } from "../lib/http.js";

const SIGNUP_RATE_LIMIT = 10;            // per IP per hour
const SIGNUP_RATE_WINDOW = 3600;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

// POST /api/auth/signup
//   { displayName, email, username, password, groupCode?, adminCode?, ownerCode? }
//
// Phase D.3: cloud-backed self-serve signup. Replaces the local Sign up tab. Group code is
// REQUIRED unless ownerCode is valid — that branch is the cold-start owner case (no group yet).
// On success a fresh session is minted and the user lands as if they'd just signed in.
export async function authSignup(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;

  const body = await readJson(req);
  const displayName = String(body.displayName || "").trim();
  const email = normalizeEmail(body.email);
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const groupCode = String(body.groupCode || "").trim().toUpperCase();
  const adminCode = String(body.adminCode || "").trim().toUpperCase();
  const ownerCode = String(body.ownerCode || "");

  // Per-IP rate limit. Keyed only on IP since signups don't have a stable identifier we trust
  // pre-creation; a determined attacker can rotate emails/usernames trivially.
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const since = nowSec() - SIGNUP_RATE_WINDOW;
  const rate = await q1(
    env,
    "SELECT COUNT(*) AS n FROM signup_attempts WHERE ip = ? AND ts >= ?",
    ip, since,
  );
  if ((rate?.n || 0) >= SIGNUP_RATE_LIMIT) return err(429, "rate_limited");

  // Validation. Field-level errors come back with a stable code so the frontend can target
  // the right input.
  if (!displayName || displayName.length > 80) return err(400, "invalid_display_name");
  if (!isEmail(email)) return err(400, "invalid_email");
  if (!USERNAME_RE.test(username)) return err(400, "invalid_username");
  if (password.length < 8) return err(400, "password_too_short");

  // Owner code: validates against the OWNER_BOOTSTRAP_CODE secret. Empty is fine; wrong is 400.
  let canCreateGroups = 0;
  if (ownerCode) {
    const expected = env.OWNER_BOOTSTRAP_CODE || "";
    if (!expected || ownerCode !== expected) {
      await recordAttempt(env, ip, 0);
      return err(400, "invalid_owner_code");
    }
    canCreateGroups = 1;
  }

  // Group code: required unless owner code is valid (cold-start owner).
  let group = null;
  if (groupCode) {
    group = await q1(
      env,
      "SELECT id, admin_code FROM groups WHERE group_code = ?",
      groupCode,
    );
    if (!group) {
      await recordAttempt(env, ip, 0);
      return err(400, "invalid_group_code");
    }
  } else if (!canCreateGroups) {
    await recordAttempt(env, ip, 0);
    return err(400, "group_code_required");
  }

  // Admin code: only meaningful with a group code. If supplied, must match exactly.
  let role = "provider";
  if (group && adminCode) {
    if ((group.admin_code || "").toUpperCase() !== adminCode) {
      await recordAttempt(env, ip, 0);
      return err(400, "invalid_admin_code");
    }
    role = "admin";
  }

  // Uniqueness checks. Run before insert to surface a friendly error rather than a 500.
  const emailTaken = await q1(env, "SELECT 1 AS ok FROM users WHERE email = ?", email);
  if (emailTaken) {
    await recordAttempt(env, ip, 0);
    return err(409, "email_taken");
  }
  const usernameTaken = await q1(env, "SELECT 1 AS ok FROM users WHERE username = ?", username);
  if (usernameTaken) {
    await recordAttempt(env, ip, 0);
    return err(409, "username_taken");
  }

  // Insert user + (optional) membership in a batch so a crash mid-way doesn't leave a half-state.
  const userId = newId("usr");
  const passwordHash = await hashPassword(password);
  const stmts = [
    env.DB.prepare(
      "INSERT INTO users (id, email, display_name, username, password_hash, kind, can_create_groups) VALUES (?, ?, ?, ?, ?, 'real', ?)",
    ).bind(userId, email, displayName, username, passwordHash, canCreateGroups),
  ];
  if (group) {
    stmts.push(
      env.DB.prepare("INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, ?)")
        .bind(userId, group.id, role),
    );
  }
  await env.DB.batch(stmts);
  await recordAttempt(env, ip, 1);

  // Mint session and assemble the response in the same shape /api/me returns so the frontend
  // can drop it straight into cloudUser without a follow-up fetch.
  const { raw: sidRaw } = await createSession(env, userId);
  const memberships = group
    ? [{
        groupId: group.id,
        role,
        localUid: null,
        groupName: await groupName(env, group.id),
        groupCode: groupCode || null,
        adminCode: group.admin_code || null,
      }]
    : [];
  const user = { id: userId, email, username, displayName, canCreateGroups: !!canCreateGroups };
  return new Response(JSON.stringify({ user, memberships }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionSetCookieHeader(sidRaw),
    },
  });
}

async function recordAttempt(env, ip, ok) {
  try {
    await exec(env, "INSERT INTO signup_attempts (ip, ok) VALUES (?, ?)", ip, ok);
  } catch {}
}

async function groupName(env, groupId) {
  const row = await q1(env, "SELECT name FROM groups WHERE id = ?", groupId);
  return row?.name || "";
}
