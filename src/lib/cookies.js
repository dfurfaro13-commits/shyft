// Cookie helpers. Sessions use SameSite=Lax so the magic-link top-level GET
// from the user's email client carries the freshly-set cookie back to the app.

export const SESSION_COOKIE = "shift_sid";

export function parseCookies(req) {
  const header = req.headers.get("Cookie") || "";
  const out = {};
  for (const pair of header.split(/;\s*/)) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    if (i < 0) continue;
    out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  return out;
}

export function setCookie(name, value, { maxAge, path = "/" } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

export function clearCookie(name, { path = "/" } = {}) {
  return `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
