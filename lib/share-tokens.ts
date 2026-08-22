import type { PageWidget, WidgetType } from "./custom-pages";

/**
 * Share tokens for read-only Custom Page links.
 *
 * The raw token is a bearer credential: it is returned exactly once, at
 * creation, and never persisted. D1 stores only a SHA-256 hash, so a database
 * dump cannot be replayed against the public route.
 *
 * Kept free of Cloudflare imports so entropy, hashing, expiry and the widget
 * allowlist are directly testable.
 */

/** 32 bytes = 256 bits, the minimum the brief requires. */
export const SHARE_TOKEN_BYTES = 32;

/** Shown for every unavailable share, whatever the underlying reason. */
export const SHARE_UNAVAILABLE_MESSAGE = "Bu sahifa mavjud emas yoki ulashish havolasi faol emas.";

/** URL-safe base64 of 256 random bits — 43 characters, no padding. */
export function generateShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Lookup key for a raw token. SHA-256 is sufficient here: the token is 256
 * bits of CSPRNG output, so there is no low-entropy secret to grind.
 */
export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rejects anything that is not shaped like one of our tokens before it reaches
 * the database or a hash call. Returns "" for junk so callers can bail early.
 */
export function normalizeShareToken(value: unknown): string {
  const raw = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{22,128}$/.test(raw) ? raw : "";
}

/**
 * Share metadata as the management UI sees it.
 *
 * Note what is absent: neither the raw token nor its hash has a home in this
 * type, so no list endpoint can leak one by accident.
 */
export type PageShare = {
  id: string;
  pageId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  widgetIds: string[];
};

export type ShareStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export const SHARE_STATUS_LABELS: Record<ShareStatus, string> = {
  ACTIVE: "Faol",
  REVOKED: "Bekor qilingan",
  EXPIRED: "Muddati tugagan",
};

export function shareStatus(share: Pick<PageShare, "expiresAt" | "revokedAt">, now: Date = new Date()): ShareStatus {
  if (share.revokedAt) return "REVOKED";
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

/**
 * Conservative defaults: anything that can carry internal prose — project
 * names, update text, hand-written notes — starts unchecked. The owner opts in
 * per share, never the other way round.
 */
export const DEFAULT_SHARED_WIDGET_TYPES: WidgetType[] = [
  "SECTION_HEADER", "SALES_KPI", "PROJECT_SUMMARY", "PROJECT_STATUS_BREAKDOWN", "MANUAL_KPI",
];

export function isDefaultSharedWidgetType(type: WidgetType) {
  return DEFAULT_SHARED_WIDGET_TYPES.includes(type);
}

export function defaultVisibleWidgetIds(widgets: PageWidget[]): string[] {
  return widgets.filter((widget) => isDefaultSharedWidgetType(widget.widgetType)).map((widget) => widget.id);
}

/** A bare date means "usable through the end of that day". */
export function normalizeShareExpiry(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59.999Z`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * @param pageWidgetIds every widget currently on the page; ids outside it are
 *   dropped rather than stored, so a share can never reference another page.
 */
export function validateShareInput(payload: unknown, pageWidgetIds: string[]): ValidationResult<{
  label: string; expiresAt: string | null; widgetIds: string[];
}> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const label = String(input.label ?? "").trim().slice(0, 120);
  const allowed = new Set(pageWidgetIds);
  const requested = Array.isArray(input.widgetIds) ? input.widgetIds.map(String) : [];
  const widgetIds = [...new Set(requested)].filter((id) => allowed.has(id));
  if (!widgetIds.length) return { ok: false, error: "Kamida bitta widget tanlang" };
  return { ok: true, value: { label, expiresAt: normalizeShareExpiry(input.expiresAt), widgetIds } };
}

/** Absolute link handed to the owner once, at creation. */
export function shareUrl(origin: string, token: string) {
  return `${String(origin).replace(/\/+$/, "")}/share/${token}`;
}
