import { isEligibleCohortDeal } from "../sales-logic";
import { loadSalesRecords, requestProject } from "../sales-http";
import { salesPopulations, type SalesQuery } from "../sales-sections";
import type { ProjectKey } from "../sales-projects";
import type { AttributionView, OutcomeRecord, SpendRow } from "./metrics";
import type { MarketingFx } from "./money";
import type { IcpConfig } from "./icp";
import { spendRangeStatus, type SpendStatus } from "./meta-insights";
import { getDictionary } from "../storage";
import { getMarketingSettings, listAttributionViews, marketingFx, spendAssignmentReport } from "./store";
import { summarizeAssignment, type BucketTotals } from "./assignment";
import { minorToUzs } from "./money";
import { MARKETING_WORKSPACES, WORKSPACE_KEYS, workspaceForProject, workspaceIcp, type WorkspaceKey } from "./workspaces";

const noStore = { "cache-control": "no-store" };

export type MarketingQuery = {
  startDate: string; endDate: string;
  sources: string[];
  campaignId: string | null; adsetId: string | null; adId: string | null;
  placement: string | null; landing: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{5,25}$/;

export function parseMarketingQuery(params: URLSearchParams, today = new Date()): { ok: true; query: MarketingQuery } | { ok: false; error: string } {
  const end = params.get("endDate") ?? today.toISOString().slice(0, 10);
  const start = params.get("startDate") ?? new Date(new Date(`${end}T00:00:00Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!DATE.test(start) || !DATE.test(end) || start > end) return { ok: false, error: "Sana oralig‘i noto‘g‘ri" };
  const id = (name: string) => {
    const value = params.get(name);
    if (value === null || value === "") return { ok: true as const, value: null };
    return ID.test(value) ? { ok: true as const, value } : { ok: false as const };
  };
  const campaign = id("campaignId"); const adset = id("adsetId"); const ad = id("adId");
  if (!campaign.ok || !adset.ok || !ad.ok) return { ok: false, error: "ID noto‘g‘ri" };
  const text = (name: string) => { const value = params.get(name)?.trim(); return value ? value.slice(0, 300) : null; };
  const sources = params.getAll("source").map((value) => value.trim()).filter(Boolean).slice(0, 30);
  return {
    ok: true,
    query: { startDate: start, endDate: end, sources, campaignId: campaign.value, adsetId: adset.value, adId: ad.value, placement: text("placement"), landing: text("landing") },
  };
}

export type MarketingContext = {
  project: ProjectKey; workspace: WorkspaceKey; icp: IcpConfig; query: MarketingQuery; fx: MarketingFx;
  cohort: OutcomeRecord[]; attribution: Map<string, AttributionView>; spend: SpendRow[];
  /** True only when spendStatus is AVAILABLE; otherwise spend and its ratios are null. */
  spendApplies: boolean; spendStatus: SpendStatus; dataAsOf: string | null;
  /** The cohort before any entity filter, for the filter catalogue. */
  baseCohort: OutcomeRecord[];
  /** Where this range's Meta spend went (assigned here, other workspaces, MIXED, UNASSIGNED, NON_DASHBOARD). */
  spendAttribution: SpendAttribution | null;
  meta: { status: SpendStatus; since: string | null; until: string | null; updatedAt: string | null; accounts: number };
};

export type SpendAttribution = {
  /** Spend assigned to THIS workspace — the only spend in its CMC/ROAS. */
  assigned: BucketTotals; otherWorkspaces: BucketTotals; mixed: BucketTotals; unassigned: BucketTotals; nonDashboard: BucketTotals;
};

const emptyBucket = (): BucketTotals => ({ ads: 0, adDays: 0, spendByCurrency: {}, spendUzs: 0 });
function mergeBuckets(items: BucketTotals[]): BucketTotals {
  return items.reduce((sum, item) => {
    const spendByCurrency = { ...sum.spendByCurrency };
    for (const [currency, minor] of Object.entries(item.spendByCurrency)) spendByCurrency[currency] = (spendByCurrency[currency] ?? 0) + minor;
    return { ads: sum.ads + item.ads, adDays: sum.adDays + item.adDays, spendByCurrency,
      spendUzs: sum.spendUzs === null || item.spendUzs === null ? null : sum.spendUzs + item.spendUzs };
  }, emptyBucket());
}

/**
 * The marketing population for one request: the dashboard's own cohort
 * (eligible Deals created in the range, the same Lead count the Sales pages
 * show), joined by Deal ID to its attribution, narrowed by any entity filter,
 * plus the project's Meta spend for the same calendar days.
 */
export async function loadMarketingContext(project: ProjectKey, query: MarketingQuery): Promise<MarketingContext> {
  const salesQuery: SalesQuery = {
    from: query.startDate, to: query.endDate, managers: [], sources: query.sources,
    pipeline: "", stage: "", period: "", sla: "", processing: "", search: "",
  } as SalesQuery;
  const [{ records, projectSync, sync }, settings] = await Promise.all([loadSalesRecords(new Date(), project), getMarketingSettings()]);
  const base = salesPopulations(records, salesQuery).cohort.filter(isEligibleCohortDeal) as unknown as OutcomeRecord[];
  // A day of slack on each side: attribution is matched by Deal ID, the window only bounds the read.
  const pad = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString();
  const attribution = await listAttributionViews(project, pad(query.startDate, -1), pad(query.endDate, 2));
  const cohort = base.filter((record) => {
    const view = attribution.get(record.dealId);
    if (query.campaignId && view?.campaignId !== query.campaignId) return false;
    if (query.adsetId && view?.adsetId !== query.adsetId) return false;
    if (query.adId && view?.adId !== query.adId) return false;
    if (query.placement && view?.placement !== query.placement) return false;
    if (query.landing && view?.landingPath !== query.landing) return false;
    return true;
  });
  // Spend answers only a range Meta has fully delivered, and only for dimensions it breaks down.
  const meta = await getDictionary<{ updatedAt?: string; accounts?: { completedSince?: string | null; completedUntil?: string | null; paused?: boolean; currency?: string | null }[] } | null>("metaInsightsSync", null);
  const rangeStatus = spendRangeStatus(meta?.accounts, query.startDate, query.endDate);
  const spendStatus: SpendStatus = query.placement || query.landing ? "NOT_BROKEN_DOWN" : rangeStatus;
  const spendApplies = spendStatus === "AVAILABLE";
  const workspace = workspaceForProject(project);
  const fx = marketingFx(settings);
  // One assignment pass: the workspace's spend AND the data-quality buckets come from it.
  let spend: SpendRow[] = [];
  let spendAttribution: SpendAttribution | null = null;
  if (rangeStatus === "AVAILABLE") {
    const report = await spendAssignmentReport(query.startDate, query.endDate, query);
    const buckets = summarizeAssignment(report.rows, report.assignment, (minor, currency) => minorToUzs(minor, currency, fx));
    spendAttribution = {
      assigned: buckets[workspace],
      otherWorkspaces: mergeBuckets(WORKSPACE_KEYS.filter((key) => key !== workspace).map((key) => buckets[key])),
      mixed: buckets.MIXED, unassigned: buckets.UNASSIGNED, nonDashboard: buckets.NON_DASHBOARD,
    };
    if (spendApplies) spend = report.rows.filter((row) => report.assignment.get(row.adId) === workspace);
  }
  const ingested = (meta?.accounts ?? []).filter((account) => account.completedSince);
  return {
    project, workspace, icp: workspaceIcp(workspace), query, fx, cohort, attribution, spend, spendApplies, spendStatus,
    dataAsOf: projectSync?.lastSyncAt ?? sync.lastSyncAt ?? null,
    baseCohort: base, spendAttribution,
    meta: {
      status: rangeStatus,
      since: ingested.length ? ingested.map((account) => account.completedSince as string).sort()[0] : null,
      until: ingested.length ? ingested.map((account) => account.completedUntil ?? "").sort()[0] || null : null,
      updatedAt: meta?.updatedAt ?? null, accounts: ingested.length,
    },
  };
}

/**
 * `?workspace=IBOX_UZ|SD_UZ` (or the dashboard's `?project=`). A reserved
 * workspace (IBOX_KZ, SD_KZ) has no CRM analytics yet, so it is refused with an
 * explicit code rather than answered with an empty population.
 */
export function marketingScope(request: Request): { ok: true; project: ProjectKey } | { ok: false; response: Response } {
  const raw = new URL(request.url).searchParams.get("workspace");
  if (raw === null || raw === "") return requestProject(request);
  const workspace = MARKETING_WORKSPACES.find((item) => item.key === raw);
  if (!workspace) return { ok: false, response: Response.json({ error: "Workspace noto‘g‘ri" }, { status: 400, headers: noStore }) };
  if (!workspace.activated || !workspace.project) {
    return { ok: false, response: Response.json({ error: "Bu workspace hali faollashtirilmagan", code: "WORKSPACE_NOT_ACTIVATED", workspace: workspace.key }, { status: 409, headers: noStore }) };
  }
  return { ok: true, project: workspace.project };
}

/**
 * Project + query + context, then the endpoint's own body. Formatting is the
 * UI's job. The caller has ALREADY guarded the request — every marketing route
 * calls `authorizePermission` itself (dashboard to read, settings to run jobs),
 * where the route-guard audit can see it.
 */
export async function marketingResponse(request: Request, build: (context: MarketingContext, params: URLSearchParams) => unknown) {
  const scoped = marketingScope(request);
  if (!scoped.ok) return scoped.response;
  const params = new URL(request.url).searchParams;
  const parsed = parseMarketingQuery(params);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: noStore });
  try {
    const context = await loadMarketingContext(scoped.project, parsed.query);
    const body = build(context, params);
    if (body instanceof Response) return body;
    return Response.json({
      project: scoped.project, workspace: context.workspace, icpStatus: context.icp.enabled ? "ENABLED" : "NOT_APPLICABLE",
      spendStatus: context.spendStatus, meta: context.meta, range: { startDate: parsed.query.startDate, endDate: parsed.query.endDate },
      filters: parsed.query, fx: { usdToUzs: context.fx.usdToUzs }, dataAsOf: context.dataAsOf, ...(body as object),
    }, { headers: noStore });
  } catch {
    return Response.json({ error: "Marketing ma’lumotlarini yuklab bo‘lmadi" }, { status: 500, headers: noStore });
  }
}

/** A guarded (settings) job endpoint's body; see marketingResponse for where the guard lives. */
export async function marketingAdminResponse(request: Request, run: (payload: Record<string, unknown>) => Promise<unknown>) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  try { return Response.json(await run(payload), { headers: noStore }); }
  catch { return Response.json({ error: "Marketing amali bajarilmadi" }, { status: 500, headers: noStore }); }
}
