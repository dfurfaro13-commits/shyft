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

// 6-char human-readable group join code. Same alphabet as the local genCode helper in JSX
// (no 0/O, 1/I/L) so codes look consistent across cloud and local UIs. ~31 bits of entropy
// — plenty for the join-by-code flow given uniqueness is enforced by the DB index.
const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateJoinCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
  return out;
}
