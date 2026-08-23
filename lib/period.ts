/**
 * Calendar period resolution in Asia/Tashkent.
 *
 * The Sales dashboard has always resolved its ranges as Tashkent calendar days
 * and converted them with an explicit +05:00 offset. Custom Pages instead did
 * `now - N * 86_400_000`, which is a rolling millisecond window: at 09:00
 * Tashkent a "last 7 days" page started mid-morning seven days ago and silently
 * dropped part of the earliest day.
 *
 * This module is the dashboard's semantics, extracted verbatim so pages,
 * shared pages and the dashboard agree. Dashboard behaviour is unchanged.
 */

export const PERIOD_TIMEZONE = "Asia/Tashkent";
/** Tashkent has been UTC+5 year-round since 1995 — no DST to track. */
const OFFSET = "+05:00";

const keyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PERIOD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) as seen in Tashkent. */
export function dateKey(date: Date): string {
  return keyFormatter.format(date);
}

/** The Tashkent calendar date `days` before `date`. */
export function dateKeyBefore(date: Date, days: number): string {
  return dateKey(new Date(date.getTime() - days * 86_400_000));
}

export type DateKeyRange = { from: string; to: string };

/** Inclusive millisecond bounds for a pair of Tashkent calendar dates. */
export function boundsFromKeys(range: DateKeyRange): { from: number; to: number } {
  return {
    from: new Date(`${range.from}T00:00:00${OFFSET}`).getTime(),
    to: new Date(`${range.to}T23:59:59.999${OFFSET}`).getTime(),
  };
}

export const PAGE_RANGE_IDS = ["7", "30", "month", "custom"] as const;
export type PageRangeId = (typeof PAGE_RANGE_IDS)[number];

export type CustomRange = { from?: string | null; to?: string | null };

/**
 * Calendar dates covered by a page range.
 *
 *   7      today and the previous 6 Tashkent days
 *   30     today and the previous 29
 *   month  first of the current Tashkent month through today
 *   custom the given inclusive dates
 *
 * An incomplete custom range falls back to 30 days rather than rendering an
 * empty page.
 */
export function pageRangeKeys(range: string, now: Date = new Date(), custom: CustomRange = {}): DateKeyRange {
  const today = dateKey(now);
  if (range === "custom") {
    const from = normalizeDateKey(custom.from);
    const to = normalizeDateKey(custom.to);
    if (from && to && from <= to) return { from, to };
    return { from: dateKeyBefore(now, 29), to: today };
  }
  if (range === "7") return { from: dateKeyBefore(now, 6), to: today };
  if (range === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: dateKeyBefore(now, 29), to: today };
}

/** Millisecond bounds for a page range — what the metric helpers consume. */
export function pageRangeBounds(range: string, now: Date = new Date(), custom: CustomRange = {}) {
  return boundsFromKeys(pageRangeKeys(range, now, custom));
}

export function normalizeDateKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** A custom range needs both ends, in order. */
export function validateCustomRange(from: unknown, to: unknown): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const start = normalizeDateKey(from);
  const end = normalizeDateKey(to);
  if (!start || !end) return { ok: false, error: "Custom oraliq uchun boshlanish va tugash sanasi kerak" };
  if (start > end) return { ok: false, error: "Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas" };
  return { ok: true, from: start, to: end };
}

/** Human label, used by the builder and the public renderer alike. */
export function pageRangeLabel(range: string, custom: CustomRange = {}): string {
  if (range === "7") return "Oxirgi 7 kun";
  if (range === "month") return "Shu oy";
  if (range === "custom") {
    const from = normalizeDateKey(custom.from);
    const to = normalizeDateKey(custom.to);
    return from && to ? `${from} — ${to}` : "Custom oraliq";
  }
  return "Oxirgi 30 kun";
}
