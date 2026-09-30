import { getWebhookUrl } from "@/lib/bitrix";
import type { DashboardRecord } from "@/lib/dashboard-record";
import { authError, requirePermission } from "@/lib/auth/http";
import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";
import { normalizeSettings } from "@/lib/settings-safety";
import { getDictionary, getSettings, getSyncState, listDashboardRecordJsonWithFingerprint, readSalesFingerprint } from "@/lib/storage";
import { DEFAULT_PROJECT, parseProjectKey, type ProjectKey } from "@/lib/sales-projects";
import { projectSyncKey, type ProjectSyncRecord } from "@/lib/project-sync";
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
export async function loadSalesRecords(now = new Date(), project: ProjectKey = DEFAULT_PROJECT) {
  const started = Date.now();
  const [fingerprint, rawSettings, sync, projectSync] = await Promise.all([
    readSalesFingerprint(), getSettings(project), getSyncState(),
    getDictionary<ProjectSyncRecord | null>(projectSyncKey(project), null),
  ]);
  const settings = normalizeSettings(rawSettings);
  let base = salesBaseCache.get(salesCacheKey(fingerprint, settings, project), Date.now(), project);
  const cache: SalesLoadTiming["cache"] = base ? "hit" : "miss";
  if (!base) {
    const fresh = await listDashboardRecordJsonWithFingerprint();
    base = prepareSalesBase(fresh.rows.map((row) => JSON.parse(row) as DashboardRecord), settings, project);
    salesBaseCache.set(salesCacheKey(fresh.fingerprint, settings, project), base, Date.now(), project);
  }
  // Workers advance the clock only across I/O, so this is the D1 wall time.
  const timing: SalesLoadTiming = { cache, loadMs: Date.now() - started };
  return {
    records: resolveSalesSla(base, settings, now), settings, sync, projectSync, project,
    configured: Boolean(getWebhookUrl()), timing,
  };
}

/**
 * The project a request is scoped to: `?project=` (IBOX when absent, for every
 * caller written before projects existed). An unknown project is refused rather
 * than silently served IBOX.
 */
export function requestProject(request: Request): { ok: true; project: ProjectKey } | { ok: false; response: Response } {
  const project = parseProjectKey(new URL(request.url).searchParams.get("project"));
  if (!project) return { ok: false, response: Response.json({ error: "Loyiha noto‘g‘ri" }, { status: 400, headers: noStoreHeaders }) };
  return { ok: true, project };
}

/** `Server-Timing` for a Sales-backed response: the data-load wall time and the cache outcome, nothing else. */
export function salesServerTiming(timing: SalesLoadTiming) {
  return `load;dur=${timing.loadMs};desc="${timing.cache}"`;
}

const noStore = { "cache-control": "no-store" };
const noStoreHeaders = noStore;

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
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  const parsed = parseSalesQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: noStore });
  const refused = filterPermissionError(parsed.query, can);
  if (refused) return Response.json({ error: refused, code: "FILTER_FORBIDDEN" }, { status: 403, headers: noStore });
  if (section === "manager" && !parsed.query.managerId) return Response.json({ error: "Menejer tanlanmagan" }, { status: 400, headers: noStore });
  try {
    const { records, settings, sync, projectSync, configured, timing } = await loadSalesRecords(new Date(), scoped.project);
    if (!isSalesReady(configured, records.length, sync.status)) {
      return Response.json({ ready: false, project: scoped.project }, { headers: noStore });
    }
    const body = buildSalesSection(section, records, parsed.query, {
      can, settings, dataAsOf: projectSync?.lastSyncAt ?? sync.lastSyncAt ?? null,
    });
    // Every Sales answer names the project it answers for, so the client can
    // refuse a response that does not match the workspace on screen.
    return Response.json({ ...body, project: scoped.project }, { headers: { ...noStore, "server-timing": salesServerTiming(timing) } });
  } catch {
    return Response.json({ error: "Sales ma’lumotlarini yuklab bo‘lmadi" }, { status: 500, headers: noStore });
  }
}
