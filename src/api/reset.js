// Forgot-password flow. Three endpoints:
//   POST /api/auth/forgot-password  { emailOrUsername }  → emails a reset link (always 200,
//     even on miss, so callers can't enumerate accounts).
//   GET  /api/auth/reset-password?token=…                → server-rendered HTML form. Same style
//     as authVerify's confirmation pages so the user stays in a trusted UI surface.
//   POST /api/auth/reset-password  { token, newPassword } → applies the change, mints a session,
//     redirects to the app. CSRF still required (inline page script adds the header), so a
//     plain HTML form embed on a third-party site can't drive this.

import { exec, q1, nowSec } from "../lib/db.js";
import { hashPassword } from "../lib/passwords.js";
import { randomToken, sha256Hex } from "../lib/ids.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { createSession, sessionSetCookieHeader } from "../lib/session.js";
import { sendPasswordResetLink } from "../lib/email.js";
import { json, err, readJson, html, noContent } from "../lib/http.js";

const RESET_TOKEN_TTL_SEC = 60 * 15;
const MAX_REQUESTS_PER_HOUR = 5;
const MIN_PASSWORD_LEN = 8;

// POST /api/auth/forgot-password  { emailOrUsername }
export async function forgotPassword(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const body = await readJson(req);
  const identifier = String(body.emailOrUsername || "").trim().toLowerCase();
  if (!identifier) return err(400, "missing_identifier");

  // Single lookup against either email or username (both COLLATE NOCASE). Constant-time-ish
  // response shape: every branch returns 204 so timing is dominated by the email-send call
  // which only fires on the matched path, but the difference is small enough to ignore at
  // hobby scale.
  const user = await q1(
    env,
    "SELECT id, email FROM users WHERE email = ? OR username = ?",
    identifier, identifier,
  );

  if (user) {
    const since = nowSec() - 3600;
    const rate = await q1(
      env,
      "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND created_at >= ?",
      user.id, since,
    );
    // Silently drop on rate limit. The user might be confused but it's better than letting
    // an attacker burn through tokens or pile up emails to a victim.
    if ((rate?.n || 0) < MAX_REQUESTS_PER_HOUR) {
      const raw = randomToken(32);
      const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
      const expiresAt = nowSec() + RESET_TOKEN_TTL_SEC;
      await exec(
        env,
        "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        tokenHash, user.id, expiresAt,
      );

      const link = `${env.APP_URL}/api/auth/reset-password?token=${encodeURIComponent(raw)}`;
      try {
        await sendPasswordResetLink(env, { to: user.email, link });
      } catch (e) {
        console.error("password reset link send failed:", e?.message || e);
      }
    }
  }

  return noContent();
}

// GET /api/auth/reset-password?token=…
export async function showResetPage(req, env) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("token");
  if (!raw) return resetErrorPage("Missing reset token.");

  const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const row = await q1(
    env,
    "SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?",
    tokenHash,
  );
  if (!row) return resetErrorPage("This reset link is invalid.");
  if (row.used_at) return resetErrorPage("This reset link has already been used. Request a new one from the sign-in page.");
  if (row.expires_at < nowSec()) return resetErrorPage("This reset link has expired. Request a new one from the sign-in page.");

  return html(resetFormPage(raw, env.APP_URL || "/"));
}

// POST /api/auth/reset-password  { token, newPassword }
export async function applyResetPassword(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const body = await readJson(req);
  const raw = String(body.token || "");
  const newPassword = String(body.newPassword || "");
  if (!raw) return err(400, "missing_token");
  if (newPassword.length < MIN_PASSWORD_LEN) return err(400, "password_too_short");

  const tokenHash = await sha256Hex(raw, env.SESSION_PEPPER || "");
  const row = await q1(
    env,
    "SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?",
    tokenHash,
  );
  if (!row) return err(400, "invalid_token");
  if (row.used_at) return err(400, "token_used");
  if (row.expires_at < nowSec()) return err(400, "token_expired");

  const hash = await hashPassword(newPassword);
  await exec(env, "UPDATE users SET password_hash = ? WHERE id = ?", hash, row.user_id);
  await exec(env, "UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?", nowSec(), tokenHash);

  // Revoke other live sessions for this user — a forgotten password could mean compromise.
  // Then mint a fresh session so the user lands signed in.
  await exec(env, "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", nowSec(), row.user_id);
  const { raw: sidRaw } = await createSession(env, row.user_id);
  return json({ ok: true }, {
    headers: { "Set-Cookie": sessionSetCookieHeader(sidRaw) },
  });
}

function resetFormPage(token, appUrl) {
  const safeToken = escapeHtml(token);
  const safeUrl = escapeHtml(appUrl);
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Reset your SHIFT password</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 24rem; margin: 0 auto; color: #0f172a; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { color: #475569; line-height: 1.5; font-size: .9rem; }
  label { display:block; font-size: .8rem; font-weight:600; color:#334155; margin: .75rem 0 .25rem; }
  input { width:100%; padding:.6rem .75rem; border:1px solid #cbd5e1; border-radius:.5rem; font-size:1rem; box-sizing:border-box; }
  input:focus { outline:none; border-color:#2563eb; }
  button { width:100%; margin-top:1rem; padding:.7rem 1rem; background:#2563eb; color:#fff; border:0; border-radius:.5rem; font-weight:600; font-size:.95rem; cursor:pointer; }
  button:disabled { background:#94a3b8; cursor:not-allowed; }
  .err { color:#b91c1c; font-size:.8rem; margin-top:.5rem; min-height: 1em; }
  .ok { background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; padding:.75rem; border-radius:.5rem; font-size:.9rem; }
</style>
</head>
<body>
  <h1>Reset your password</h1>
  <p>Enter a new password to finish resetting your SHIFT account.</p>
  <form id="f">
    <label for="p1">New password (8+ characters)</label>
    <input id="p1" type="password" autocomplete="new-password" required minlength="8"/>
    <label for="p2">Confirm new password</label>
    <input id="p2" type="password" autocomplete="new-password" required minlength="8"/>
    <div id="err" class="err"></div>
    <button id="b" type="submit">Set new password</button>
  </form>
  <div id="done" style="display:none" class="ok">
    Password updated. <a href="${safeUrl}/">Continue to SHIFT</a>.
  </div>
  <script>
    var token = ${JSON.stringify(token)};
    var f = document.getElementById('f');
    var err = document.getElementById('err');
    var btn = document.getElementById('b');
    var done = document.getElementById('done');
    f.addEventListener('submit', async function(e){
      e.preventDefault();
      err.textContent = '';
      var p1 = document.getElementById('p1').value;
      var p2 = document.getElementById('p2').value;
      if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
      if (p1 !== p2) { err.textContent = "New passwords don't match."; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        var r = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'X-Requested-With':'shift' },
          body: JSON.stringify({ token: token, newPassword: p1 }),
        });
        if (!r.ok) {
          var body = {}; try { body = await r.json(); } catch(_) {}
          var msg = ({
            token_expired: 'This reset link has expired. Request a new one from the sign-in page.',
            token_used: 'This reset link has already been used.',
            invalid_token: 'This reset link is invalid.',
            password_too_short: 'Password must be at least 8 characters.',
          })[body && body.error] || 'Could not reset password.';
          err.textContent = msg;
          btn.disabled = false; btn.textContent = 'Set new password';
          return;
        }
        f.style.display = 'none';
        done.style.display = 'block';
        setTimeout(function(){ location.replace(${JSON.stringify(appUrl)} + '/'); }, 1500);
      } catch (e2) {
        err.textContent = 'Network error. Try again.';
        btn.disabled = false; btn.textContent = 'Set new password';
      }
    });
  </script>
</body></html>`;
}

function resetErrorPage(message) {
  return html(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Reset problem</title>
<style>body{font-family:system-ui;padding:2rem;max-width:24rem;margin:0 auto;color:#0f172a}h1{font-size:1.25rem}</style>
</head><body><h1>Reset problem</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to SHIFT</a></p></body></html>`,
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
