export const SESSION_COOKIE = "__Host-ibox_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const LAST_SEEN_WRITE_INTERVAL_MS = 15 * 60 * 1000;
function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export function createSessionToken() { return base64Url(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashOpaqueToken(token: string) { return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))); }
export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS) { return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`; }
export function clearSessionCookie() { return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
export function cookieValue(request: Request, name = SESSION_COOKIE) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
export function assertSafeMutation(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new Error("CROSS_SITE_REQUEST");
  const origin = request.headers.get("origin");
  if (!origin) return;
  let expected: string;
  try { expected = new URL(request.url).origin; } catch { throw new Error("INVALID_REQUEST_ORIGIN"); }
  if (origin !== expected) throw new Error("CROSS_SITE_REQUEST");
}
export function clientAddress(request: Request) { return (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim().slice(0, 80); }
export function sessionIsUsable(session: { expiresAt: string; revokedAt: string | null }, user: { active: boolean } | null, now = new Date()) {
  return Boolean(user?.active && !session.revokedAt && session.expiresAt > now.toISOString());
}
