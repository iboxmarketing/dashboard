const encoder = new TextEncoder();
/**
 * PBKDF2-HMAC-SHA-512 at 100,000 iterations.
 *
 * Cloudflare Workers rejects PBKDF2 above 100,000 iterations on the live edge
 * ("iteration counts above 100000 are not supported") — confirmed 2026-09-21,
 * even though Node and local workerd accept more. 600,000 × SHA-256 therefore
 * cannot run in production at all. SHA-512 at the platform maximum is the
 * strongest PBKDF2 the runtime allows (OWASP rates 210k SHA-512 ≈ 600k SHA-256).
 * The verifier string records scheme and count, so it can be upgraded later.
 */
export const PASSWORD_SCHEME = "pbkdf2-sha512";
export const PASSWORD_ITERATIONS = 100_000;
/** Workers' hard cap. A stored count above it could never be verified. */
export const MAX_EDGE_ITERATIONS = 100_000;
const HASH_BYTES = 64;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function base64UrlToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: saltBuffer, iterations }, key, HASH_BYTES * 8));
}
export function validatePassword(password: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof password !== "string") return { ok: false, error: "Parol kerak" };
  if (password.length < 12) return { ok: false, error: "Parol kamida 12 ta belgidan iborat bo‘lishi kerak" };
  if (password.length > 256) return { ok: false, error: "Parol 256 ta belgidan oshmasligi kerak" };
  if (!/[a-z]/u.test(password) || !/[A-Z]/u.test(password) || !/[0-9]/u.test(password)) return { ok: false, error: "Parolda katta harf, kichik harf va raqam bo‘lishi kerak" };
  return { ok: true, value: password };
}
export async function hashPassword(password: string) {
  const checked = validatePassword(password);
  if (!checked.ok) throw new Error(checked.error);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(checked.value, salt, PASSWORD_ITERATIONS);
  return `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [scheme, rawIterations, rawSalt, rawHash, extra] = stored.split("$");
  const iterations = Number(rawIterations);
  if (scheme !== PASSWORD_SCHEME || extra !== undefined || !Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > MAX_EDGE_ITERATIONS || !rawSalt || !rawHash) return false;
  try {
    const expected = base64UrlToBytes(rawHash);
    const actual = await derive(password, base64UrlToBytes(rawSalt), iterations);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
    return difference === 0;
  } catch { return false; }
}
const DUMMY_SALT = new Uint8Array([41, 91, 7, 199, 33, 14, 211, 65, 92, 18, 44, 166, 2, 113, 76, 205]);
export async function consumePasswordCheck(password: string) { await derive(password.slice(0, 256), DUMMY_SALT, PASSWORD_ITERATIONS); }
