-- Phase C: per-group state snapshot. One row per group — last write wins, so we always have
-- the freshest local-state mirror for the "your other device has newer data" check.
-- Full version history lives in R2 (one immutable object per write); D1 only carries the latest.

CREATE TABLE snapshots (
  group_id    TEXT PRIMARY KEY REFERENCES groups(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  payload     TEXT NOT NULL,
  client_ts   INTEGER NOT NULL,
  server_ts   INTEGER NOT NULL DEFAULT (unixepoch())
);
