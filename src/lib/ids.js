// Prefixed IDs so a stray ID in a log line is self-describing.
// crypto.randomUUID() is available in Workers runtime.

export function newId(prefix) {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return prefix + "_" + uuid;
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(input, pepper = "") {
  const data = new TextEncoder().encode(pepper + input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
