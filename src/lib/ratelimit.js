// Per-email rate limit on /auth/request. Counts unexpired login_tokens issued
// in the last hour. D1 row-count is plenty fast at hobby scale.

import { q1, nowSec } from "./db.js";

const MAX_PER_HOUR = 5;

export async function checkLoginRateLimit(env, email) {
  const since = nowSec() - 3600;
  const row = await q1(
    env,
    "SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at >= ?",
    email,
    since,
  );
  return (row?.n || 0) < MAX_PER_HOUR;
}
