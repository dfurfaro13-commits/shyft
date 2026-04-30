// Thin D1 helpers. D1's prepare/bind API is awkward to call directly everywhere.

export function q(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).all();
}

export async function q1(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...params).first();
  return row || null;
}

export function exec(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

export function batch(env, statements) {
  return env.DB.batch(statements);
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
