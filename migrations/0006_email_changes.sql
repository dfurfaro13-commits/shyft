-- Self-service profile: email-change confirmation tokens.
-- The user requests an email change via POST /api/me/change-email-request; we mint a token
-- and send a magic link to the NEW address. Clicking the link (GET /api/auth/verify-email-change)
-- flips users.email to the new value. Verification on the new address is what proves intent —
-- old-address spoofing wouldn't help an attacker hijack the account.

CREATE TABLE email_change_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  new_email   TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_email_change_tokens_user ON email_change_tokens(user_id);
CREATE INDEX idx_email_change_tokens_expiry ON email_change_tokens(expires_at);
