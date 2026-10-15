import { getD1 } from "@/db";
import { hasPermission, type PermissionKey } from "@/lib/auth/permissions";
import type { AuthRole } from "@/lib/auth/types";
import { buildKpiDetail, KPI_ICP_CLASSES_SQL, KpiDetailError, kpiIcpConfig, kpiIcpDealIds, parseKpiParams } from "@/lib/kpi-detail";
import { presentKpiDetail } from "@/lib/kpi-detail-presenter";
import { ensureMarketingSchema } from "@/lib/marketing/store";
import { loadSalesRecords, requestProject, salesServerTiming } from "@/lib/sales-http";
import { filterPermissionError, isSalesReady, parseSalesQuery } from "@/lib/sales-sections";

const noStore = { "cache-control": "no-store" };

async function readIcpClasses(dealIds: string[]): Promise<Map<string, string>> {
  if (!dealIds.length) return new Map();
  const db = getD1();
  await ensureMarketingSchema(db);
  const { results } = await db.prepare(KPI_ICP_CLASSES_SQL).bind(JSON.stringify(dealIds)).all<{ deal_id: string; icp_class: string }>();
  return new Map((results ?? []).map((row) => [String(row.deal_id), String(row.icp_class || "")]));
}

/**
 * `GET /api/kpi-detail` (the whole detail) and `GET /api/kpi-detail/deals`
 * (the Deal page only, for pagination and drilldown). Each route checks
 * `dashboard` before calling this. Filtered exactly like the Dashboard: the Dashboard's
 * own query parser, the same filter-permission refusals, the same cached
 * Sales dataset. Deal rows additionally need `deals`, manager breakdowns
 * `managers` — the same permissions that guard those views.
 */
export async function kpiDetailResponse(request: Request, user: { role: AuthRole; permissions: readonly string[] }, mode: "detail" | "deals" | "ui") {
  const can = (permission: PermissionKey) => hasPermission(user.role, user.permissions, permission);
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  const params = new URL(request.url).searchParams;
  const parsed = parseSalesQuery(params);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: noStore });
  const kpi = parseKpiParams(params);
  if (!kpi.ok) return Response.json({ error: kpi.error }, { status: 400, headers: noStore });
  const refused = filterPermissionError(parsed.query, can);
  if (refused) return Response.json({ error: refused, code: "FILTER_FORBIDDEN" }, { status: 403, headers: noStore });
  const query = { ...parsed.query, ...kpi.params };
  try {
    const { records, settings, sync, projectSync, configured, timing } = await loadSalesRecords(new Date(), scoped.project);
    if (!isSalesReady(configured, records.length, sync.status)) return Response.json({ ready: false, project: scoped.project }, { headers: noStore });
    const icpClasses = query.metric === "icp_fit" && kpiIcpConfig(scoped.project).enabled
      ? await readIcpClasses(kpiIcpDealIds(records, query))
      : undefined;
    const detail = buildKpiDetail(records, query, { project: scoped.project, can, settings, icpClasses });
    const dataAsOf = projectSync?.lastSyncAt ?? sync.lastSyncAt ?? null;
    const body = mode === "ui"
      ? presentKpiDetail(detail)
      : mode === "deals"
      ? { ready: true, project: scoped.project, metric: detail.metric, status: detail.status, dataAsOf, deals: detail.deals }
      : { ready: true, dataAsOf, ...detail };
    return Response.json(body, { headers: { ...noStore, "server-timing": salesServerTiming(timing) } });
  } catch (error) {
    if (error instanceof KpiDetailError) return Response.json({ error: error.message }, { status: 400, headers: noStore });
    return Response.json({ error: "KPI ma’lumotlarini yuklab bo‘lmadi" }, { status: 500, headers: noStore });
  }
}
