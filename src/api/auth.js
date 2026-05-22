import { exec, q1, nowSec } from "../lib/db.js";
import { newId, randomToken, sha256Hex } from "../lib/ids.js";
import { sendMagicLink } from "../lib/email.js";
import { checkLoginRateLimit } from "../lib/ratelimit.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { verifyPassword } from "../lib/passwords.js";
import {
  createSession,
  getSessionUser,
  revokeSession,
  sessionSetCookieHeader,
  sessionClearCookieHeader,
} from "../lib/session.js";
import { json, noContent, err, html, readJson, normalizeEmail, isEmail } from "../lib/http.js";

const LOGIN_TOKEN_TTL_SEC = 60 * 15;
const PASSWORD_RATE_LIMIT = 10;          // per (email, ip) per hour
const PASSWORD_RATE_WINDOW = 3600;

// POST /api/auth/request  { email, inviteToken? }
export async function authRequest(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) return err(400, "invalid_email");

  if (!(await checkLoginRateLimit(env, email))) return err(429, "rate_limited");

  let inviteToken = null;
  if (body.inviteToken) {
    const inv = await q1(
      env,
      "SELECT token, expires_at, used_at FROM invites WHERE token = ?",
      body.inviteToken,
    );
    if (!inv || inv.used_at || inv.expires_at < nowSec()) {
      return err(400, "invalid_invite");
    }
    inviteToken = inv.token;
  }

  const raw = randomToken(32);
  const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const expiresAt = nowSec() + LOGIN_TOKEN_TTL_SEC;

  await exec(
    env,
    "INSERT INTO login_tokens (token_hash, email, invite_token, expires_at) VALUES (?, ?, ?, ?)",
    tokenHash,
    email,
    inviteToken,
    expiresAt,
  );

  const link = `${env.APP_URL}/api/auth/verify?token=${encodeURIComponent(raw)}`;
  try {
    await sendMagicLink(env, { to: email, link });
  } catch (e) {
    console.error("magic link send failed:", e?.message || e);
    // Don't leak send failure to caller — they should still be told to check email.
  }
  return noContent();
}

// GET /api/auth/verify?token=xxx
export async function authVerify(req, env) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("token");
  if (!raw) return err(400, "missing_token");

  const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const row = await q1(
    env,
    "SELECT token_hash, email, invite_token, expires_at, used_at FROM login_tokens WHERE token_hash = ?",
    tokenHash,
  );
  if (!row) return verifyErrorPage("This sign-in link is invalid.");
  if (row.used_at) return verifyErrorPage("This sign-in link has already been used.");
  if (row.expires_at < nowSec()) return verifyErrorPage("This sign-in link has expired.");

  // 1. Mark login token used.
  await exec(env, "UPDATE login_tokens SET used_at = ? WHERE token_hash = ?", nowSec(), tokenHash);

  // 2. Upsert user.
  let user = await q1(env, "SELECT id, email FROM users WHERE email = ?", row.email);
  if (!user) {
    const userId = newId("usr");
    await exec(env, "INSERT INTO users (id, email) VALUES (?, ?)", userId, row.email);
    user = { id: userId, email: row.email };
  }

  // 3. Apply invite if present and still valid.
  let inviteNote = "";
  if (row.invite_token) {
    const inv = await q1(
      env,
      "SELECT token, group_id, role, expires_at, used_at FROM invites WHERE token = ?",
      row.invite_token,
    );
    if (inv && !inv.used_at && inv.expires_at >= nowSec()) {
      // Membership: insert if missing, leave existing role alone if already a member.
      const existing = await q1(
        env,
        "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
        user.id,
        inv.group_id,
      );
      if (!existing) {
        await exec(
          env,
          "INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, ?)",
          user.id,
          inv.group_id,
          inv.role,
        );
      }
      await exec(
        env,
        "UPDATE invites SET used_at = ?, used_by_user_id = ? WHERE token = ?",
        nowSec(),
        user.id,
        inv.token,
      );
    } else {
      inviteNote = "Your invite link has expired — ask the group owner for a new one.";
    }
  }

  // 4. Issue session.
  const { raw: sidRaw } = await createSession(env, user.id);

  return html(verifyPage(user.email, env.APP_URL || "/", inviteNote), {
    headers: { "Set-Cookie": sessionSetCookieHeader(sidRaw) },
  });
}

// POST /api/auth/password  { emailOrUsername, password }
// Per stress-test: stricter limits than magic-link (10/hr per (identifier, ip)) since passwords
// are brute-forceable. Constant-time response shape regardless of whether the user exists.
//
// D.3: identifier may be email OR username. Rate-limit key is the literal input string so an
// attacker can't burn the same row twice by alternating shapes.
export async function authPassword(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const body = await readJson(req);
  // Backwards-compat: accept `email` field too. New frontend sends `emailOrUsername`.
  const identifier = String(body.emailOrUsername || body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!identifier || !password) return err(400, "invalid_credentials");

  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const since = nowSec() - PASSWORD_RATE_WINDOW;
  const rate = await q1(
    env,
    "SELECT COUNT(*) AS n FROM password_attempts WHERE email = ? AND ip = ? AND ts >= ?",
    identifier, ip, since,
  );
  if ((rate?.n || 0) >= PASSWORD_RATE_LIMIT) return err(429, "rate_limited");

  // Lookup by email OR username. Both columns are COLLATE NOCASE so a single value works.
  const user = await q1(
    env,
    "SELECT id, email, username, display_name, password_hash, can_create_groups FROM users WHERE email = ? OR username = ?",
    identifier, identifier,
  );
  // Always run the verify even if user is missing — keeps timing roughly constant so
  // attackers can't enumerate accounts via response time.
  const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;

  await exec(env,
    "INSERT INTO password_attempts (email, ip, ok) VALUES (?, ?, ?)",
    identifier, ip, ok ? 1 : 0,
  );

  if (!ok || !user) return err(401, "invalid_credentials");

  const { raw: sidRaw } = await createSession(env, user.id);
  return new Response(JSON.stringify({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      canCreateGroups: !!user.can_create_groups,
    },
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionSetCookieHeader(sidRaw),
    },
  });
}

// POST /api/auth/logout
export async function authLogout(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  await revokeSession(env, req);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": sessionClearCookieHeader() },
  });
}

// GET /api/me
//
// Owner-platform model: any caller with canCreateGroups is treated as an owner of
// every group. Real memberships are returned untouched (e.g. an Owner who also
// joined a different group as a provider keeps the provider role there); for the
// remaining groups we synthesize an owner-role entry. The SuperDashboard's
// auto-restore loop reads `role === "owner"` directly, so this is enough to make
// every group show up in the Owner's local groups[] list with no frontend change.
export async function me(req, env) {
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");
  const memberships = (await env.DB.prepare(
    `SELECT m.group_id AS groupId, m.role AS role, m.local_uid AS localUid,
            g.name AS groupName, g.group_code AS groupCode, g.admin_code AS adminCode
       FROM memberships m
       JOIN groups g ON g.id = m.group_id
      WHERE m.user_id = ?
      ORDER BY g.name`,
  ).bind(user.id).all()).results || [];

  if (user.canCreateGroups) {
    const known = new Set(memberships.map(m => m.groupId));
    const others = (await env.DB.prepare(
      `SELECT id AS groupId, name AS groupName, group_code AS groupCode, admin_code AS adminCode
         FROM groups
        ORDER BY name`,
    ).all()).results || [];
    for (const g of others) {
      if (known.has(g.groupId)) continue;
      memberships.push({
        groupId: g.groupId,
        groupName: g.groupName,
        groupCode: g.groupCode,
        adminCode: g.adminCode,
        role: "owner",
        localUid: null,
      });
    }
    memberships.sort((a, b) => (a.groupName || "").localeCompare(b.groupName || ""));
  }

  return json({ user, memberships });
}

// HTML response for the verify endpoint. Confirmation page rather than auto-redirect
// so a wrong-browser click is visible.
function verifyPage(email, appUrl, inviteNote) {
  const safeEmail = escapeHtml(email);
  const safeUrl = escapeHtml(appUrl);
  const safeNote = escapeHtml(inviteNote || "");
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Signed in to SHIFT</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 28rem; margin: 0 auto; color: #0f172a; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #475569; line-height: 1.5; }
  a.btn { display: inline-block; margin-top: 1rem; padding: .65rem 1rem; background: #2563eb; color: #fff; border-radius: .5rem; text-decoration: none; font-weight: 500; }
  .note { background:#fef3c7; padding:.75rem 1rem; border-radius:.5rem; color:#854d0e; margin: 1rem 0; font-size:.9rem; }
</style>
</head>
<body>
  <h1>You're signed in</h1>
  <p>Signed in as <strong>${safeEmail}</strong>.</p>
  ${safeNote ? `<div class="note">${safeNote}</div>` : ""}
  <p>If this isn't you, close this tab — the session is only set on this device.</p>
  <a class="btn" href="${safeUrl}/">Continue to SHIFT</a>
  <script>setTimeout(function(){ location.replace(${JSON.stringify(appUrl)} + "/"); }, 3000);</script>
</body></html>`;
}

function verifyErrorPage(message) {
  return html(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Sign-in problem</title>
<style>body{font-family:system-ui;padding:2rem;max-width:28rem;margin:0 auto;color:#0f172a}h1{font-size:1.25rem}</style>
</head><body><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to SHIFT</a></p></body></html>`,
    { status: 400 });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
