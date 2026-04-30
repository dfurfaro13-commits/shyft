// PBKDF2-SHA256 via Web Crypto. Workers don't ship Argon2 or bcrypt. Cloudflare caps
// PBKDF2 iterations at 100k per call (NotSupportedError above that), so we use the cap.
// Combined with a 16-byte random salt and per-(email,ip) rate limiting on the password
// endpoint, this is the right slow-KDF choice for hobby/small-team deployments. The
// stored format includes the iter count so future runtime upgrades can rotate without
// invalidating existing hashes.
//
// Stored format: pbkdf2$<iters>$<salt_b64>$<hash_b64>

const ITERS = 100_000;
const KEYLEN = 32;     // 256 bits
const SALT_LEN = 16;

export async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await deriveBits(plain, salt, ITERS);
  return `pbkdf2$${ITERS}$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = parseInt(parts[1], 10);
  if (!Number.isFinite(iters) || iters < 1000) return false;
  const salt = unb64(parts[2]);
  const expected = parts[3];
  const key = await deriveBits(plain, salt, iters);
  return constantTimeEq(b64(key), expected);
}

async function deriveBits(plain, salt, iters) {
  const km = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plain),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" },
    km,
    KEYLEN * 8,
  );
  return new Uint8Array(bits);
}

function b64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - s.length % 4) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time string comparison so a timing oracle can't reveal hash prefixes.
function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Generates a readable temp password for admin-created accounts. ~62 bits of entropy with
// the default length=10 (no ambiguous characters: 0/O, 1/l/I).
export function generateTempPassword(length = 10) {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
