import { exec, q1, nowSec } from "../lib/db.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson } from "../lib/http.js";

// Soft cap on the per-group snapshot blob. Real groups today are << 100 KB.
// Bigger than this is almost certainly a bug; reject loudly so we notice.
const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MB

// POST /api/snapshots  { groupId, payload, clientTs }
export async function putSnapshot(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const body = await readJson(req);
  const groupId = String(body.groupId || "");
  const clientTs = Number.isFinite(+body.clientTs) ? Math.floor(+body.clientTs) : Date.now();
  if (!groupId || body.payload == null) return err(400, "missing_fields");

  const payloadStr = typeof body.payload === "string" ? body.payload : JSON.stringify(body.payload);
  if (payloadStr.length > MAX_PAYLOAD_BYTES) return err(413, "payload_too_large");

  // Membership check — same gate as /api/events.
  const membership = await q1(
    env,
    "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    groupId,
  );
  if (!membership) return err(403, "not_a_member");

  const serverTs = nowSec();

  // D1: upsert the latest. Conflict on group_id (the primary key) → update.
  await exec(
    env,
    `INSERT INTO snapshots (group_id, user_id, payload, client_ts, server_ts)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       user_id   = excluded.user_id,
       payload   = excluded.payload,
       client_ts = excluded.client_ts,
       server_ts = excluded.server_ts`,
    groupId,
    user.id,
    payloadStr,
    clientTs,
    serverTs,
  );

  // R2: history copy. Best-effort — if R2 is unavailable the snapshot still lives in D1.
  // Path is sortable by timestamp so listing the prefix yields chronological order.
  // customMetadata MUST be flat string→string (a non-flat shape silently fails the put).
  if (env.R2) {
    const key = `snapshots/${groupId}/${serverTs}-${clientTs}.json`;
    try {
      await env.R2.put(key, payloadStr, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          groupId,
          userId: user.id,
          clientTs: String(clientTs),
          serverTs: String(serverTs),
        },
      });
    } catch (e) {
      console.error("R2 put failed:", key, e?.message || e);
    }
  }

  return json({ groupId, serverTs, clientTs });
}

// GET /api/snapshots/:groupId/latest
export async function getLatestSnapshot(req, env, { groupId }) {
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const membership = await q1(
    env,
    "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    groupId,
  );
  if (!membership) return err(403, "not_a_member");

  const row = await q1(
    env,
    "SELECT payload, client_ts AS clientTs, server_ts AS serverTs, user_id AS userId FROM snapshots WHERE group_id = ?",
    groupId,
  );
  if (!row) return err(404, "no_snapshot");

  return json({
    groupId,
    payload: JSON.parse(row.payload),
    clientTs: row.clientTs,
    serverTs: row.serverTs,
    userId: row.userId,
  });
}
