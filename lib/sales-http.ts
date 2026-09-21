import { getWebhookUrl } from "@/lib/bitrix";
import type { DashboardRecord } from "@/lib/dashboard-record";
import { authError, requirePermission } from "@/lib/auth/http";
import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";
import { normalizeSettings } from "@/lib/settings-safety";
import { getSettings, getSyncState, listDashboardRecordJson } from "@/lib/storage";
import {
  SALES_SECTION_PERMISSION, buildSalesSection, filterPermissionError, isSalesReady, parseSalesQuery, prepareSalesRecords,
  type SalesSection,
} from "@/lib/sales-sections";

/**
 * The prepared Sales dataset, read once per request. Parsing is the price of
 * computing sections on the server: the rows used to be concatenated unparsed
 * straight into a response that handed every record to the browser.
 */
export async function loadSalesRecords(now = new Date()) {
  const [rows, rawSettings, sync] = await Promise.all([listDashboardRecordJson(), getSettings(), getSyncState()]);
  const settings = normalizeSettings(rawSettings);
  const records = prepareSalesRecords(rows.map((row) => JSON.parse(row) as DashboardRecord), settings, now);
  return { records, settings, sync, configured: Boolean(getWebhookUrl()) };
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
    const { records, settings, sync, configured } = await loadSalesRecords();
    if (!isSalesReady(configured, records.length, sync.status)) return Response.json({ ready: false }, { headers: noStore });
    const body = buildSalesSection(section, records, parsed.query, { can, settings, dataAsOf: sync.lastSyncAt ?? null });
    return Response.json(body, { headers: noStore });
  } catch {
    return Response.json({ error: "Sales ma’lumotlarini yuklab bo‘lmadi" }, { status: 500, headers: noStore });
  }
}
