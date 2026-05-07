-- Phase D.3 follow-up: cloud groups gain an admin_code so the join-by-code form can grant
-- admin role when the new user enters it. Mirrors the existing local groupCode/adminCode
-- pair. Nullable + partial unique index — pre-existing groups backfill via the
-- POST /api/groups/:gid/admin-code endpoint.
ALTER TABLE groups ADD COLUMN admin_code TEXT;
CREATE UNIQUE INDEX idx_groups_admin_code ON groups(admin_code) WHERE admin_code IS NOT NULL;
