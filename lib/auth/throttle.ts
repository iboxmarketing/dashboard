import { hashOpaqueToken } from "./security";
import { normalizeEmail } from "./types";

/**
 * Login throttling: atomic, bounded, and identical for every email.
 *
 * Each attempt RESERVES a slot in two buckets before any password work, with
 * one atomic INSERT … ON CONFLICT DO UPDATE … RETURNING per bucket. Concurrent
 * requests therefore cannot all read the same stale count: the database hands
 * each one a distinct, increasing number, and every reservation past the limit
 * is refused without running PBKDF2. A hundred parallel failures run at most
 * IP_LIMIT password checks and leave the counter at its cap, not at 1.
 *
 * Buckets never grow with attacker input:
 *   ip:<n>    n = hash(client network) mod IP_BUCKETS. The network is the
 *             numerically canonical IPv4 address or IPv6 /64 of the trusted
 *             CF-Connecting-IP header — equivalent spellings share a bucket.
 *   acct:<n>  n = hash(normalized email) mod ACCOUNT_BUCKETS, for EVERY email.
 * Known and unknown emails perform exactly the same storage operations, so
 * neither the table nor the timing tells them apart. No raw address and no
 * email is ever stored. At most IP_BUCKETS + ACCOUNT_BUCKETS rows can exist.
 */

export const IP_BUCKETS = 4096;
export const ACCOUNT_BUCKETS = 4096;
export const WINDOW_MS = 15 * 60 * 1000;
export const IP_LIMIT = 20;
export const IP_BLOCK_MS = 15 * 60 * 1000;
export const ACCOUNT_LIMIT = 10;
export const ACCOUNT_BLOCK_MS = 10 * 60 * 1000;
/** Rows are kept this long after their last write, then swept. */
export const ROW_TTL_MS = 24 * 60 * 60 * 1000;
/** Each reservation sweeps at most this many expired rows — cleanup stays bounded. */
export const CLEANUP_BATCH = 50;
/** The stored counter is capped to the table's CHECK constraint. */
export const MAX_COUNT = 100;

export type Reservation = { count: number; blockedUntil: string | null };

/** Storage the throttle needs. D1 in production, SQLite in tests. */
export interface ThrottleStore {
  /** Atomically counts one attempt against `key` and returns the new count. */
  reserve(key: string, input: { now: string; windowStart: string; limit: number; blockUntil: string }): Promise<Reservation>;
  /** A successful login gives its IP slot back (never below zero). */
  refund(key: string): Promise<void>;
  /** A successful login clears its account bucket. */
  clear(key: string): Promise<void>;
  /** Delete up to `limit` rows last written before `before`, whose block has also passed. */
  sweep(before: string, now: string, limit: number): Promise<void>;
}

/**
 * The single atomic statement behind `reserve`. Parameters:
 *   ?1 key  ?2 now  ?3 window start  ?4 limit  ?5 block-until
 * A window resets only once it has expired AND no block is running. SQLite
 * evaluates every SET expression against the row's OLD values.
 */
export const RESERVE_SQL = `
INSERT INTO app_login_attempts (key_hash, failure_count, window_started_at, blocked_until, updated_at)
VALUES (?1, 1, ?2, CASE WHEN 1 >= ?4 THEN ?5 ELSE NULL END, ?2)
ON CONFLICT(key_hash) DO UPDATE SET
  failure_count = CASE
    WHEN window_started_at < ?3 AND (blocked_until IS NULL OR blocked_until <= ?2) THEN 1
    ELSE MIN(failure_count + 1, ${MAX_COUNT}) END,
  blocked_until = CASE
    WHEN window_started_at < ?3 AND (blocked_until IS NULL OR blocked_until <= ?2) THEN CASE WHEN 1 >= ?4 THEN ?5 ELSE NULL END
    WHEN MIN(failure_count + 1, ${MAX_COUNT}) >= ?4 AND (blocked_until IS NULL OR blocked_until <= ?2) THEN ?5
    ELSE blocked_until END,
  window_started_at = CASE
    WHEN window_started_at < ?3 AND (blocked_until IS NULL OR blocked_until <= ?2) THEN ?2
    ELSE window_started_at END,
  updated_at = ?2
RETURNING failure_count, blocked_until`;
export const REFUND_SQL = "UPDATE app_login_attempts SET failure_count = MAX(failure_count - 1, 0) WHERE key_hash = ?1";
export const CLEAR_SQL = "DELETE FROM app_login_attempts WHERE key_hash = ?1";
export const SWEEP_SQL = `DELETE FROM app_login_attempts WHERE key_hash IN (
  SELECT key_hash FROM app_login_attempts WHERE updated_at < ?1 AND (blocked_until IS NULL OR blocked_until < ?2) LIMIT ?3)`;

/* ------------------------------------------------------------- addresses */

function parseIPv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null. Handles `::`, embedded IPv4, zone ids and brackets. */
export function parseIPv6(input: string): number[] | null {
  let value = input.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = value.lastIndexOf(":");
  if (value.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(value.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    value = value.slice(0, lastColon);
    if (value.endsWith(":")) value += ":";
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part ? part.split(":") : []).map((group) => (/^[0-9a-f]{1,4}$/u.test(group) ? parseInt(group, 16) : Number.NaN));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1) return explicit === 8 ? [...head, ...tail] : null;
  if (explicit > 7) return null;
  return [...head, ...Array<number>(8 - explicit).fill(0), ...rest, ...tail];
}

/**
 * The network a client belongs to, in one canonical spelling: an IPv4 address
 * (also when written IPv4-mapped, ::ffff:a.b.c.d), or the first 64 bits of an
 * IPv6 address as four fixed-width groups. Anything unparseable is "invalid".
 */
export function clientNetwork(address: string) {
  const value = address.trim();
  const v4 = parseIPv4(value);
  if (v4) return v4.join(".");
  const v6 = parseIPv6(value);
  if (!v6) return "invalid";
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return [v6[6] >> 8, v6[6] & 255, v6[7] >> 8, v6[7] & 255].join(".");
  }
  return `${v6.slice(0, 4).map((group) => group.toString(16).padStart(4, "0")).join(":")}::/64`;
}

/** Only Cloudflare's own header is trusted; X-Forwarded-For is caller-controlled. */
export function throttleAddress(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

async function bucket(prefix: string, material: string, buckets: number) {
  const digest = await hashOpaqueToken(material);
  let value = 0;
  for (const character of digest.slice(0, 4)) value = value * 64 + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(character);
  return `${prefix}:${value % buckets}`;
}

export const ipBucketKey = (address: string) => bucket("ip", `login-ip|${clientNetwork(address)}`, IP_BUCKETS);
export const accountBucketKey = (email: string) => bucket("acct", `login-account|${normalizeEmail(email)}`, ACCOUNT_BUCKETS);

/** Reserves one attempt; `allowed` is false once the bucket has spent its limit. */
export async function reserveAttempt(store: ThrottleStore, key: string, limit: number, blockMs: number, now: Date) {
  const reservation = await store.reserve(key, {
    now: now.toISOString(),
    windowStart: new Date(now.getTime() - WINDOW_MS).toISOString(),
    limit,
    blockUntil: new Date(now.getTime() + blockMs).toISOString(),
  });
  await store.sweep(new Date(now.getTime() - ROW_TTL_MS).toISOString(), now.toISOString(), CLEANUP_BATCH);
  return { ...reservation, allowed: reservation.count <= limit };
}

type SqlHandle = {
  prepare(sql: string): { bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown> } };
};

/** A ThrottleStore over any SQL handle with prepare/bind/first/run (D1, or an adapter over SQLite). */
export function sqlThrottleStore(db: SqlHandle): ThrottleStore {
  return {
    async reserve(key, input) {
      const row = await db.prepare(RESERVE_SQL).bind(key, input.now, input.windowStart, input.limit, input.blockUntil)
        .first<{ failure_count: number; blocked_until: string | null }>();
      if (!row) throw new Error("THROTTLE_RESERVE_FAILED");
      return { count: Number(row.failure_count), blockedUntil: row.blocked_until };
    },
    async refund(key) { await db.prepare(REFUND_SQL).bind(key).run(); },
    async clear(key) { await db.prepare(CLEAR_SQL).bind(key).run(); },
    async sweep(before, now, limit) { await db.prepare(SWEEP_SQL).bind(before, now, limit).run(); },
  };
}
