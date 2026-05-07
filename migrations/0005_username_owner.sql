-- Phase D.3: cloud auth becomes the source of truth.
-- Adds usernames (alternative login identifier), the can_create_groups gate (replaces the old
-- local SUPER_BOOTSTRAP), and group_code/admin_code columns so the cloud knows what local codes
-- map to which group (previously these lived only in localStorage / snapshot payloads).

-- Users: optional username (case-insensitive, unique-when-set) + group-creation permission.
ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN can_create_groups INTEGER NOT NULL DEFAULT 0;

-- Existing owners keep the right to create groups. Backfill before the gate goes live so
-- the David-shaped cold-start case (already an owner via D.2) doesn't lock himself out.
UPDATE users
   SET can_create_groups = 1
 WHERE id IN (SELECT user_id FROM memberships WHERE role = 'owner');

-- Groups: the codes a user types into the Sign up form. Backfill from the latest snapshot per
-- group, since payload.meta.{groupCode,adminCode} have been mirrored there since Phase C.
ALTER TABLE groups ADD COLUMN group_code TEXT;
ALTER TABLE groups ADD COLUMN admin_code TEXT;

UPDATE groups
   SET group_code = (
     SELECT json_extract(payload, '$.meta.groupCode')
       FROM snapshots
      WHERE snapshots.group_id = groups.id
      ORDER BY server_ts DESC
      LIMIT 1
   ),
   admin_code = (
     SELECT json_extract(payload, '$.meta.adminCode')
       FROM snapshots
      WHERE snapshots.group_id = groups.id
      ORDER BY server_ts DESC
      LIMIT 1
   )
 WHERE group_code IS NULL;

-- Partial unique indexes (D1/SQLite supports WHERE in CREATE INDEX).
CREATE UNIQUE INDEX idx_users_username_notnull ON users(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX idx_groups_group_code      ON groups(group_code) WHERE group_code IS NOT NULL;

-- Per-IP rate limit for the new signup endpoint (separate stream from password_attempts so a
-- brute-force on one doesn't burn the budget for the other).
CREATE TABLE signup_attempts (
  ip      TEXT NOT NULL,
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  ok      INTEGER NOT NULL
);
CREATE INDEX idx_signup_attempts_lookup ON signup_attempts(ip, ts);
