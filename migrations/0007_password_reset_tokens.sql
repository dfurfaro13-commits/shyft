-- Self-service "Forgot password" flow. Parallel to email_change_tokens but the verify endpoint
-- renders a server-rendered form for setting the new password instead of flipping a value
-- directly. Possession of the email (clicking the link) + setting a new password is what
-- proves intent — we never reveal whether the requested identifier matched a real account.

CREATE TABLE password_reset_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_expiry ON password_reset_tokens(expires_at);
