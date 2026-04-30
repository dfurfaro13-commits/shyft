-- Phase D: cloud users now carry passwords (PBKDF2) and a real/test designator.
-- Test users have synthetic emails (<localId>@<cloudGroupId>.test.invalid) and a password
-- the admin sees once at creation time. Real users keep magic-link as their primary login but
-- can opt into a password too. SHA-256 hashes from the legacy local users[] are NOT carried
-- forward — migrated users get fresh PBKDF2 passwords during D.2.

-- D1's SQLite doesn't accept CHECK constraints inside ALTER TABLE ADD COLUMN. The application
-- layer (src/api/users.js, src/api/groups.js) already validates `kind` against {'real','test'}.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'real';

-- Stricter rate limit for the password endpoint (separate stream from magic-link login_tokens).
-- Keyed on (email, ip) so the same email from different IPs has independent budgets.
CREATE TABLE password_attempts (
  email   TEXT NOT NULL COLLATE NOCASE,
  ip      TEXT NOT NULL,
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  ok      INTEGER NOT NULL
);
CREATE INDEX idx_password_attempts_lookup ON password_attempts(email, ip, ts);
