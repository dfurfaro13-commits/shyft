-- Phase A: auth + invite-only group membership.
-- Email is identity. Tokens are stored as SHA-256 hashes; raw values live only in the email/cookie.
-- localStorage stays source of truth for app data; this schema is purely about WHO is who.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE,
  display_name  TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE);

CREATE TABLE groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE memberships (
  user_id     TEXT NOT NULL REFERENCES users(id),
  group_id    TEXT NOT NULL REFERENCES groups(id),
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','provider')),
  local_uid   TEXT,
  joined_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX idx_memberships_group ON memberships(group_id);

CREATE TABLE invites (
  token                TEXT PRIMARY KEY,
  group_id             TEXT NOT NULL REFERENCES groups(id),
  created_by_user_id   TEXT NOT NULL REFERENCES users(id),
  role                 TEXT NOT NULL CHECK (role IN ('admin','provider')),
  expires_at           INTEGER NOT NULL,
  used_at              INTEGER,
  used_by_user_id      TEXT REFERENCES users(id),
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_invites_group ON invites(group_id);

CREATE TABLE login_tokens (
  token_hash    TEXT PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE,
  invite_token  TEXT REFERENCES invites(token),
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email);

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
