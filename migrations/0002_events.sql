-- Phase B: append-only event log. localStorage stays source of truth in the app;
-- this is the parallel ML training corpus. One row per meaningful state mutation.
-- Indexed for cheap per-group time-range queries and per-type slicing.

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  local_uid   TEXT,
  block_id    TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  client_ts   INTEGER NOT NULL,
  server_ts   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_events_group_ts      ON events(group_id, server_ts);
CREATE INDEX idx_events_group_type_ts ON events(group_id, type, server_ts);
