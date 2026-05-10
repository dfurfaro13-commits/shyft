import { exec, q1 } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { json, err, readJson } from "../lib/http.js";

const ALLOWED_TYPES = new Set([
  // Phase B
  "topOption.set",
  "topOption.clear",
  "topOption.link",
  "topOption.unlink",
  "preference.toggle",
  "unavail.toggle",
  "block.reconcile",
  "block.lock",
  "block.unlock",
  "shift.confirm",
  "shift.flag",
  "marketplace.post",
  "marketplace.take",
  "marketplace.cancel",
  // D.4.A — types wired in D.4.B; allow-listed now so the backend accepts them
  // as soon as the frontend starts emitting. snapshot.bootstrap is a placeholder
  // for an eventual "fresh snapshot baseline" pseudo-event.
  "user.create",
  "user.update",
  "user.delete",
  "block.reset",
  "shift.swap-admin",
  "shift.trade-admin",
  "trade.offer-post",
  "trade.offer-accept",
  "trade.offer-decline",
  "incentive.open-set",
  "config.update",
  "unavail.reason",
  "snapshot.bootstrap",
]);

// Bumped 16K → 64K in D.4.A to absorb cascade payloads (e.g. user.delete listing
// every dependent shift / unavail / preference for a long-tenured user).
const MAX_PAYLOAD_BYTES = 64 * 1024;

// POST /api/events  { groupId, type, payload, blockId?, localUid?, clientTs? }
// → 200 { id, serverTs }. serverTs is the canonical ordering key consumers use as
// the `since` cursor on GET /api/events.
export async function logEvent(req, env) {
  const csrf = requireCsrfHeader(req);
  if (csrf) return csrf;
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const body = await readJson(req);
  const groupId = String(body.groupId || "");
  const type = String(body.type || "");
  if (!groupId || !type) return err(400, "missing_fields");
  if (!ALLOWED_TYPES.has(type)) return err(400, "unknown_type");

  // Caller must be a member of the target group. Prevents events being attributed to groups
  // the user shouldn't see in their training corpus.
  const membership = await q1(
    env,
    "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    groupId,
  );
  if (!membership) return err(403, "not_a_member");

  const payload = body.payload === undefined ? {} : body.payload;
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (payloadStr.length > MAX_PAYLOAD_BYTES) return err(413, "payload_too_large");

  const id = newId("evt");
  const blockId = body.blockId ? String(body.blockId) : null;
  const localUid = body.localUid ? String(body.localUid) : null;
  const clientTs = Number.isFinite(+body.clientTs) ? Math.floor(+body.clientTs) : Date.now();

  // RETURNING is supported on D1 (SQLite 3.35+); avoids the extra SELECT round-trip.
  const row = await env.DB.prepare(
    "INSERT INTO events (id, group_id, user_id, local_uid, block_id, type, payload, client_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING server_ts",
  ).bind(id, groupId, user.id, localUid, blockId, type, payloadStr, clientTs).first();

  return json({ id, serverTs: row?.server_ts ?? null });
}

// GET /api/events?gid=&since=&limit=&type=
// Returns events with server_ts >= since, ordered (server_ts ASC, id ASC).
// Consumers MUST dedupe by event id — server_ts is second-granularity so several
// events can share a tick, and nextCursor points to the last returned server_ts
// (inclusive) which means a follow-up call will re-fetch events at that tick.
export async function listEvents(req, env) {
  const user = await getSessionUser(env, req);
  if (!user) return err(401, "unauthorized");

  const url = new URL(req.url);
  const groupId = url.searchParams.get("gid") || "";
  if (!groupId) return err(400, "missing_gid");

  const membership = await q1(
    env,
    "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND group_id = ?",
    user.id,
    groupId,
  );
  if (!membership) return err(403, "not_a_member");

  const sinceRaw = +url.searchParams.get("since");
  const since = Number.isFinite(sinceRaw) ? Math.max(0, Math.floor(sinceRaw)) : 0;
  const limitRaw = +url.searchParams.get("limit");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(2000, Math.max(1, Math.floor(limitRaw)))
    : 500;
  const typeFilter = url.searchParams.get("type");

  // Fetch limit+1 so we can tell if more remain without a COUNT.
  const stmt = typeFilter
    ? env.DB.prepare(
        "SELECT id, user_id, local_uid, block_id, type, payload, client_ts, server_ts FROM events WHERE group_id=? AND type=? AND server_ts >= ? ORDER BY server_ts ASC, id ASC LIMIT ?",
      ).bind(groupId, typeFilter, since, limit + 1)
    : env.DB.prepare(
        "SELECT id, user_id, local_uid, block_id, type, payload, client_ts, server_ts FROM events WHERE group_id=? AND server_ts >= ? ORDER BY server_ts ASC, id ASC LIMIT ?",
      ).bind(groupId, since, limit + 1);

  const rs = await stmt.all();
  const rows = rs.results || [];

  // Soft 512 KB response cap. Payload string dominates row size; +200 covers the
  // metadata wrapper. Stop building once over budget but keep ≥1 row so progress
  // is always possible.
  const SOFT_CAP = 512 * 1024;
  const events = [];
  let size = 0;
  for (const r of rows) {
    if (events.length >= limit) break;
    const rowBytes = (typeof r.payload === "string" ? r.payload.length : 0) + 200;
    if (size + rowBytes > SOFT_CAP && events.length > 0) break;
    events.push({
      id: r.id,
      userId: r.user_id,
      localUid: r.local_uid,
      blockId: r.block_id,
      type: r.type,
      payload: safeParse(r.payload),
      clientTs: r.client_ts,
      serverTs: r.server_ts,
    });
    size += rowBytes;
  }

  const hasMore = rows.length > events.length;
  const nextCursor = hasMore ? events[events.length - 1].serverTs : null;
  return json({ events, nextCursor });
}

function safeParse(s) {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
}
