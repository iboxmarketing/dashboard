import { getWebhookUrl } from "@/lib/bitrix";
import type { DashboardRecord } from "@/lib/dashboard-record";
import { authError, requirePermission } from "@/lib/auth/http";
import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";
import { normalizeSettings } from "@/lib/settings-safety";
import { getSettings, getSyncState, listDashboardRecordJsonWithFingerprint, readSalesFingerprint } from "@/lib/storage";
import { salesBaseCache, salesCacheKey } from "@/lib/sales-cache";
import {
  SALES_SECTION_PERMISSION, buildSalesSection, filterPermissionError, isSalesReady, parseSalesQuery, prepareSalesBase, resolveSalesSla,
  type SalesSection,
} from "@/lib/sales-sections";

export type SalesLoadTiming = { cache: "hit" | "miss"; loadMs: number };

/**
 * The prepared Sales dataset. The clock-independent base comes from the
 * isolate cache while the D1 fingerprint is unchanged (`lib/sales-cache.ts`);
 * otherwise the rows are read together with their fingerprint, parsed and
 * prepared once. The SLA state is resolved against `now` on every request.
 */
export async function loadSalesRecords(now = new Date()) {
  const started = Date.now();
  const [fingerprint, rawSettings, sync] = await Promise.all([readSalesFingerprint(), getSettings(), getSyncState()]);
  const settings = normalizeSettings(rawSettings);
  let base = salesBaseCache.get(salesCacheKey(fingerprint, settings), Date.now());
  const cache: SalesLoadTiming["cache"] = base ? "hit" : "miss";
  if (!base) {
    const fresh = await listDashboardRecordJsonWithFingerprint();
    base = prepareSalesBase(fresh.rows.map((row) => JSON.parse(row) as DashboardRecord), settings);
    salesBaseCache.set(salesCacheKey(fresh.fingerprint, settings), base, Date.now());
  }
  // Workers advance the clock only across I/O, so this is the D1 wall time.
  const timing: SalesLoadTiming = { cache, loadMs: Date.now() - started };
  return { records: resolveSalesSla(base, settings, now), settings, sync, configured: Boolean(getWebhookUrl()), timing };
}

/** `Server-Timing` for a Sales-backed response: the data-load wall time and the cache outcome, nothing else. */
export function salesServerTiming(timing: SalesLoadTiming) {
  return `load;dur=${timing.loadMs};desc="${timing.cache}"`;
}

const noStore = { "cache-control": "no-store" };

/**
 * One handler for every Sales section. The section decides the permission, and
 * the permission is checked before anything is read; filters that would let
 * this section answer another section's question are refused with 403.
 */
export async function salesSectionResponse(request: Request, section: SalesSection) {
  let can: (permission: PermissionKey) => boolean;
  try {
    const context = await requirePermission(request, SALES_SECTION_PERMISSION[section]);
    can = (permission) => hasPermission(context.user.role, context.user.permissions, permission);
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 });
  }
  const parsed = parseSalesQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: noStore });
  const refused = filterPermissionError(parsed.query, can);
  if (refused) return Response.json({ error: refused, code: "FILTER_FORBIDDEN" }, { status: 403, headers: noStore });
  if (section === "manager" && !parsed.query.managerId) return Response.json({ error: "Menejer tanlanmagan" }, { status: 400, headers: noStore });
  try {
    const { records, settings, sync, configured, timing } = await loadSalesRecords();
    if (!isSalesReady(configured, records.length, sync.status)) return Response.json({ ready: false }, { headers: noStore });
    const body = buildSalesSection(section, records, parsed.query, { can, settings, dataAsOf: sync.lastSyncAt ?? null });
    return Response.json(body, { headers: { ...noStore, "server-timing": salesServerTiming(timing) } });
  } catch {
    return Response.json({ error: "Sales ma’lumotlarini yuklab bo‘lmadi" }, { status: 500, headers: noStore });
  }
}
