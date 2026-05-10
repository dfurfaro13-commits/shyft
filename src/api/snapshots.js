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

  // Phase D: optimistic concurrency. Caller may pass `If-Match: <serverTs>` (or `ifMatch`
  // in the body for clients that can't set headers). If set and mismatched, return 409 with
  // the current serverTs so the client can refetch and re-apply.
  const ifMatchHeader = req.headers.get("If-Match");
  const ifMatch = ifMatchHeader != null
    ? parseInt(ifMatchHeader.replace(/"/g, ""), 10)
    : (Number.isFinite(+body.ifMatch) ? Math.floor(+body.ifMatch) : null);
  if (ifMatch != null) {
    const existing = await q1(env, "SELECT server_ts FROM snapshots WHERE group_id = ?", groupId);
    const currentServerTs = existing?.server_ts || 0;
    if (currentServerTs !== ifMatch) {
      return new Response(JSON.stringify({ error: "stale", serverTs: currentServerTs }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

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

// GET /api/owner/snapshots/:groupId/history?limit=N
//   Owner-only. Lists every R2 history object for the group, newest first. Each entry has
//   the R2 key, the embedded server_ts/client_ts (parsed from the key), the byte size, and
//   a few stats about the payload (user count, prefs/shifts presence) so the owner can pick
//   a known-good snapshot to roll back to without downloading them all blindly.
//
//   Returning the full payload here would be expensive — instead we attach `summary` derived
//   from R2 customMetadata + a one-time fetch of each object's first KB to extract counts.
//   Keep `limit` modest (default 30, max 100) to bound work.
export async function listSnapshotHistory(req, env, { groupId }) {
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  // Owner gate — explicit, since the history endpoint is more sensitive than read-only listing.
  const membership = await q1(
    env,
    "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    groupId,
  );
  if (!membership || membership.role !== "owner") return err(403, "not_owner");

  if (!env.R2) return err(503, "r2_unavailable");

  const url = new URL(req.url);
  const rawLimit = parseInt(url.searchParams.get("limit") || "30", 10);
  const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 30));

  const prefix = `snapshots/${groupId}/`;
  const list = await env.R2.list({ prefix, limit: 1000 });

  // R2 listing is unsorted; sort by serverTs descending (encoded in the key as <server>-<client>.json).
  const objects = (list.objects || []).map(o => {
    const m = o.key.match(/snapshots\/[^/]+\/(\d+)-(\d+)\.json$/);
    const serverTs = m ? parseInt(m[1], 10) : 0;
    const clientTs = m ? parseInt(m[2], 10) : 0;
    return { key: o.key, serverTs, clientTs, size: o.size, uploaded: o.uploaded };
  }).sort((a, b) => b.serverTs - a.serverTs).slice(0, limit);

  // For the first ~10 we'll do a bounded fetch to extract user/prefs counts so the owner has
  // some signal beyond timestamp + size. Beyond that, leave summary null and let them pick.
  const SUMMARY_DEPTH = Math.min(10, objects.length);
  const enriched = await Promise.all(objects.map(async (o, i) => {
    if (i >= SUMMARY_DEPTH) return { ...o, summary: null };
    try {
      const obj = await env.R2.get(o.key);
      if (!obj) return { ...o, summary: null };
      const text = await obj.text();
      const payload = JSON.parse(text);
      const userCount = Array.isArray(payload?.users) ? payload.users.length : 0;
      const prefsCount = payload?.prefs && typeof payload.prefs === "object" ? Object.keys(payload.prefs).length : 0;
      const shiftsDayCount = payload?.shifts && typeof payload.shifts === "object" ? Object.keys(payload.shifts).length : 0;
      const topOptionsDayCount = payload?.topOptions && typeof payload.topOptions === "object" ? Object.keys(payload.topOptions).length : 0;
      return {
        ...o,
        summary: { userCount, prefsCount, shiftsDayCount, topOptionsDayCount, name: payload?.meta?.name || null },
      };
    } catch (e) {
      return { ...o, summary: null, summaryError: String(e?.message || e) };
    }
  }));

  // Also report the current D1 latest so the owner can see what they're rolling back from.
  const current = await q1(env, "SELECT client_ts AS clientTs, server_ts AS serverTs FROM snapshots WHERE group_id = ?", groupId);

  return json({ groupId, current, history: enriched });
}

// POST /api/owner/snapshots/:groupId/restore   { key }
//   Owner-only. Copies the contents of the named R2 object into D1 as the new "latest"
//   snapshot for the group. The R2 key MUST be inside the snapshots/<groupId>/ prefix —
//   any other key is rejected so a caller can't promote arbitrary objects. The original
//   R2 object is left untouched (history remains intact); we ALSO write a fresh history
//   object marking that this restore happened, so the audit trail is preserved.
export async function restoreSnapshot(req, env, { groupId }) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const membership = await q1(
    env,
    "SELECT role FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    groupId,
  );
  if (!membership || membership.role !== "owner") return err(403, "not_owner");

  if (!env.R2) return err(503, "r2_unavailable");

  const body = await readJson(req);
  const key = String(body.key || "");
  // Strict prefix check — must point inside this group's history.
  const expectedPrefix = `snapshots/${groupId}/`;
  if (!key.startsWith(expectedPrefix) || !key.endsWith(".json")) return err(400, "invalid_key");

  const obj = await env.R2.get(key);
  if (!obj) return err(404, "snapshot_not_found");
  const payloadStr = await obj.text();
  // Parse to validate JSON shape — we don't want to promote a corrupt object.
  let payload;
  try { payload = JSON.parse(payloadStr); }
  catch { return err(400, "snapshot_corrupt"); }
  if (!payload || typeof payload !== "object") return err(400, "snapshot_corrupt");

  const clientTs = Date.now();
  const serverTs = nowSec();

  // Promote into D1.
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

  // Write a fresh history object so the restore is itself recorded — the new "latest" lives
  // alongside the original at a new key so it's not confusingly identical to the source.
  try {
    const newKey = `snapshots/${groupId}/${serverTs}-${clientTs}.json`;
    await env.R2.put(newKey, payloadStr, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        groupId,
        userId: user.id,
        clientTs: String(clientTs),
        serverTs: String(serverTs),
        restoredFrom: key,
      },
    });
  } catch (e) {
    // History write failure isn't fatal — the D1 promotion already succeeded. Log only.
    console.error("restore: history copy failed:", e?.message || e);
  }

  return json({ ok: true, groupId, serverTs, clientTs, restoredFrom: key, payload });
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
