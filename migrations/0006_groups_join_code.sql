-- Phase D.3: cloud groups gain a public join code so a regular user (not invite-link recipient)
-- can join by typing the code on the no-membership landing screen. Mirrors the local groupCode
-- UX. New groups (createGroup, migrateGroup) auto-provision a code; pre-existing migrated groups
-- backfill via POST /api/groups/:gid/join-code.
ALTER TABLE groups ADD COLUMN join_code TEXT;
CREATE UNIQUE INDEX idx_groups_join_code ON groups(join_code) WHERE join_code IS NOT NULL;
