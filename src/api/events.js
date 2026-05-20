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
  // D.4.E — event types for the three previously-local-only handlers. shift.confirm extended
  // to carry value (null/"ok") for the un-confirm path; shift.clear-flag is admin clearing
  // without swap; shift.admin-assign is direct slot fill with optional incentive credit.
  "shift.clear-flag",
  "shift.admin-assign",
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

  // D.4.E: accept a client-issued event id (used by the frontend's buildEventBody) so the
  // outbox can retry a failed POST without creating a duplicate row. Validate the shape to
  // bound the attack surface: 8–64 chars, URL-safe alphabet. Anything else falls back to a
  // server-minted id (back-compat for any caller still relying on the old behavior).
  const rawId = body.id ? String(body.id) : "";
  const idLooksOk = rawId.length >= 8 && rawId.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(rawId);
  const id = idLooksOk ? rawId : newId("evt");
  const blockId = body.blockId ? String(body.blockId) : null;
  const localUid = body.localUid ? String(body.localUid) : null;
  const clientTs = Number.isFinite(+body.clientTs) ? Math.floor(+body.clientTs) : Date.now();

  // INSERT OR IGNORE + RETURNING: on the happy path, RETURNING gives us the freshly-inserted
  // server_ts. On id collision (outbox retry of an already-committed event), the INSERT is
  // a no-op and RETURNING yields no rows — we fall back to fetching the existing row's
  // server_ts so the client still gets a meaningful response. Both branches are idempotent
  // from the client's point of view.
  const row = await env.DB.prepare(
    "INSERT OR IGNORE INTO events (id, group_id, user_id, local_uid, block_id, type, payload, client_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING server_ts",
  ).bind(id, groupId, user.id, localUid, blockId, type, payloadStr, clientTs).first();

  if (row) return json({ id, serverTs: row.server_ts });

  const existing = await q1(env, "SELECT server_ts FROM events WHERE id = ?", id);
  return json({ id, serverTs: existing?.server_ts ?? null, duplicate: true });
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
