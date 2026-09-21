import { hashOpaqueToken } from "./security";

/**
 * Login throttling with a bounded key space.
 *
 * The old key was hash(email | ip): every new email an attacker typed created
 * a new row, so a loop over fake addresses was an unbounded D1 write stream.
 * Now there are exactly two kinds of bucket, and neither grows with input:
 *
 *   ip:<n>      n = hash(client network) mod IP_BUCKETS. At most IP_BUCKETS
 *               rows exist, whatever addresses are used. The raw address is
 *               never stored — only a bucket number many networks share.
 *   user:<id>   only for an account that EXISTS, so at most one row per real
 *               user. An unknown email never creates or touches a row.
 *
 * IPv6 clients are bucketed by their /64, so rotating addresses inside one
 * allocation does not buy fresh buckets.
 *
 * A blocked IP bucket is refused before any password work: no PBKDF2 runs for
 * a caller who has already spent their budget.
 */

export const IP_BUCKETS = 4096;
export const WINDOW_MS = 15 * 60 * 1000;
export const IP_LIMIT = 20;
export const IP_BLOCK_MS = 15 * 60 * 1000;
export const USER_LIMIT = 10;
export const USER_BLOCK_MS = 10 * 60 * 1000;
/** Rows are kept this long after their last write, then swept. */
export const ROW_TTL_MS = 24 * 60 * 60 * 1000;
/** Each write sweeps at most this many expired rows — cleanup stays bounded. */
export const CLEANUP_BATCH = 50;
/** The stored counter is capped to the table's CHECK constraint. */
export const MAX_COUNT = 100;

export type ThrottleRow = { failureCount: number; windowStartedAt: string; blockedUntil: string | null; updatedAt: string };

/** Storage the throttle needs. D1 in production, a Map in tests. */
export interface ThrottleStore {
  get(key: string): Promise<ThrottleRow | null>;
  put(key: string, row: ThrottleRow): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete up to `limit` rows last written before `before`, whose block has also passed. */
  sweep(before: string, now: string, limit: number): Promise<void>;
}

/** The network a client address belongs to: IPv4 as-is, IPv6 as its /64. */
export function clientNetwork(address: string) {
  const value = address.trim().toLowerCase();
  if (!value.includes(":")) return value;
  const [head] = value.split("::");
  const groups = head.split(":").filter(Boolean);
  // "::" expands to zeros, so fewer than four explicit leading groups pad out.
  while (groups.length < 4) groups.push("0");
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export async function ipBucketKey(address: string) {
  const digest = await hashOpaqueToken(`login-ip|${clientNetwork(address)}`);
  // Four base64url characters carry 24 bits; reduce them to a bucket number.
  let value = 0;
  for (const character of digest.slice(0, 4)) value = value * 64 + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(character);
  return `ip:${value % IP_BUCKETS}`;
}

export const userBucketKey = (userId: string) => `user:${userId}`;

export function isBlocked(row: ThrottleRow | null, now: Date) {
  return Boolean(row?.blockedUntil && row.blockedUntil > now.toISOString());
}

/** Records one failure against `key`; returns the new row. */
export async function recordFailure(store: ThrottleStore, key: string, limit: number, blockMs: number, now: Date) {
  const existing = await store.get(key);
  const reset = !existing || now.getTime() - new Date(existing.windowStartedAt).getTime() > WINDOW_MS;
  const count = Math.min(MAX_COUNT, reset ? 1 : existing.failureCount + 1);
  const stillBlocked = existing && isBlocked(existing, now) ? existing.blockedUntil : null;
  const row: ThrottleRow = {
    failureCount: count,
    windowStartedAt: reset ? now.toISOString() : existing.windowStartedAt,
    blockedUntil: count >= limit ? new Date(now.getTime() + blockMs).toISOString() : stillBlocked,
    updatedAt: now.toISOString(),
  };
  await store.put(key, row);
  await store.sweep(new Date(now.getTime() - ROW_TTL_MS).toISOString(), now.toISOString(), CLEANUP_BATCH);
  return row;
}
