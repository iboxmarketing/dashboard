import { assertSafeMutation, clientAddress, sessionCookie } from "./security";
import {
  IP_BLOCK_MS, IP_LIMIT, USER_BLOCK_MS, USER_LIMIT, ipBucketKey, isBlocked, recordFailure, userBucketKey,
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
 * Order matters:
 *   1. a blocked IP bucket is refused with 429 before any lookup or PBKDF2;
 *   2. a blocked USER bucket is answered exactly like a wrong password — same
 *      status, same sentence, and the dummy PBKDF2 still runs — so the block
 *      itself cannot reveal that the account exists;
 *   3. a failure counts against the IP bucket always, and against the user
 *      bucket only when the account exists. Unknown emails write nothing new.
 */
export async function handleLogin(request: Request, deps: LoginDeps): Promise<Response> {
  try { assertSafeMutation(request); }
  catch { return json({ error: "So‘rov manbasi rad etildi" }, 403); }
  const now = deps.now?.() ?? new Date();
  const payload = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";

  const ipKey = await ipBucketKey(clientAddress(request));
  if (isBlocked(await deps.throttle.get(ipKey), now)) return json({ error: THROTTLED_ERROR }, 429, { "retry-after": String(IP_BLOCK_MS / 1000) });
  if (!email || password.length > 256) {
    await recordFailure(deps.throttle, ipKey, IP_LIMIT, IP_BLOCK_MS, now);
    return json({ error: GENERIC_LOGIN_ERROR }, 401);
  }

  const account = await deps.findUserByEmail(email);
  const userKey = account ? userBucketKey(account.id) : null;
  const userBlocked = userKey ? isBlocked(await deps.throttle.get(userKey), now) : false;
  // A blocked account still pays the same PBKDF2 cost as an unknown one, so
  // neither timing nor wording separates "blocked" from "does not exist".
  const user = await deps.authenticate(userBlocked ? null : account, password);
  if (!user) {
    await recordFailure(deps.throttle, ipKey, IP_LIMIT, IP_BLOCK_MS, now);
    if (userKey) await recordFailure(deps.throttle, userKey, USER_LIMIT, USER_BLOCK_MS, now);
    return json({ error: GENERIC_LOGIN_ERROR }, 401);
  }

  if (userKey) await deps.throttle.delete(userKey);
  const { token } = await deps.createSession(user.id);
  await deps.completeLogin(user.id);
  const context = await deps.resolveSession(token);
  if (!context) throw new Error("Created session could not be resolved");
  return json({ user: context.user }, 200, { "set-cookie": sessionCookie(token) });
}
