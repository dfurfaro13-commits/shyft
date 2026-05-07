-- Phase D.3: rate-limit table for /api/auth/signup. Mirrors the password_attempts pattern but
-- keyed by IP only (no identifier yet at that point). Cleared opportunistically; queries scope
-- to a recent window so unbounded growth isn't a problem in practice.
CREATE TABLE signup_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_signup_attempts_ip_ts ON signup_attempts(ip, ts);
