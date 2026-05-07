-- Phase D.3: cloud users gain a username (case-insensitive, unique-when-not-null) so the
-- new Sign-in form can accept "email or username" as identifier. `can_create_groups`
-- gates POST /api/groups + POST /api/groups/:gid/migrate so only sign-ups that supply the
-- correct OWNER_BOOTSTRAP_CODE can create new groups. Existing test users will get usernames
-- backfilled from local users[] via POST /api/groups/:gid/backfill-usernames.
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN can_create_groups INTEGER NOT NULL DEFAULT 0;

-- Partial unique index so NULLs (existing rows, brand-new sign-ups before pick) are allowed
-- but any populated username is globally unique. NOCASE matches the `email` collation pattern.
CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
