// Tiny response helpers so handlers don't repeat themselves.

export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export function noContent(init = {}) {
  return new Response(null, { status: 204, ...init });
}

export function err(status, code, extra = {}) {
  return json({ error: code, ...extra }, { status });
}

export function html(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers || {}) },
  });
}

export async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

export function normalizeEmail(s) {
  return String(s || "").trim().toLowerCase();
}

export function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
