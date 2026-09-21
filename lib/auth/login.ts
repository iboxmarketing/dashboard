import { assertSafeMutation, sessionCookie } from "./security";
import {
  ACCOUNT_BLOCK_MS, ACCOUNT_LIMIT, IP_BLOCK_MS, IP_LIMIT, accountBucketKey, ipBucketKey, reserveAttempt, throttleAddress,
  type ThrottleStore,
} from "./throttle";
import { normalizeEmail, type AuthContext, type AuthUser } from "./types";

export const GENERIC_LOGIN_ERROR = "Email yoki parol noto‘g‘ri";
export const THROTTLED_ERROR = "Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring";

export type LoginDeps = {
  throttle: ThrottleStore;
  findUserByEmail: (email: string) => Promise<AuthUser | null>;
  /** Runs PBKDF2 for a real user, or the equal-cost dummy for none. */
  authenticate: (user: AuthUser | null, password: string) => Promise<AuthUser | null>;
  createSession: (userId: string) => Promise<{ token: string }>;
  completeLogin: (userId: string) => Promise<void>;
  resolveSession: (token: string) => Promise<AuthContext | null>;
  now?: () => Date;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * POST /api/auth/login, with its storage injected so it can be tested.
 *
 * Every attempt — known email, unknown email, malformed body — takes the same
 * path through storage: reserve an IP slot, reserve an account slot, then (if
 * both were granted) look the user up and run PBKDF2 once. The reservations are
 * atomic and happen BEFORE the password check, so a burst of parallel requests
 * cannot outrun the counter, and a refused reservation costs no PBKDF2 at all.
 * The account bucket is keyed by the hashed email whether or not that account
 * exists, so a refusal says nothing about existence.
 */
export async function handleLogin(request: Request, deps: LoginDeps): Promise<Response> {
  try { assertSafeMutation(request); }
  catch { return json({ error: "So‘rov manbasi rad etildi" }, 403); }
  const now = deps.now?.() ?? new Date();
  const payload = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";

  const ipKey = await ipBucketKey(throttleAddress(request));
  const ip = await reserveAttempt(deps.throttle, ipKey, IP_LIMIT, IP_BLOCK_MS, now);
  if (!ip.allowed) return json({ error: THROTTLED_ERROR }, 429, { "retry-after": String(IP_BLOCK_MS / 1000) });
  const accountKey = await accountBucketKey(email);
  const account = await reserveAttempt(deps.throttle, accountKey, ACCOUNT_LIMIT, ACCOUNT_BLOCK_MS, now);
  if (!account.allowed) return json({ error: THROTTLED_ERROR }, 429, { "retry-after": String(ACCOUNT_BLOCK_MS / 1000) });

  const found = email && password.length <= 256 ? await deps.findUserByEmail(email) : null;
  const user = await deps.authenticate(found, password);
  if (!user) return json({ error: GENERIC_LOGIN_ERROR }, 401);

  // Success returns the IP slot and clears the account bucket.
  await deps.throttle.refund(ipKey);
  await deps.throttle.clear(accountKey);
  const { token } = await deps.createSession(user.id);
  await deps.completeLogin(user.id);
  const context = await deps.resolveSession(token);
  if (!context) throw new Error("Created session could not be resolved");
  return json({ user: context.user }, 200, { "set-cookie": sessionCookie(token) });
}
