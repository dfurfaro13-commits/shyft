import { exec, q1 } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { requireCsrfHeader } from "../lib/csrf.js";
import { getSessionUser } from "../lib/session.js";
import { noContent, err, readJson } from "../lib/http.js";

const ALLOWED_TYPES = new Set([
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
]);

const MAX_PAYLOAD_BYTES = 16 * 1024;

// POST /api/events  { groupId, type, payload, blockId?, localUid?, clientTs? }
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

  await exec(
    env,
    "INSERT INTO events (id, group_id, user_id, local_uid, block_id, type, payload, client_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    groupId,
    user.id,
    localUid,
    blockId,
    type,
    payloadStr,
    clientTs,
  );

  return noContent();
}
