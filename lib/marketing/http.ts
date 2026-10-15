import { isEligibleCohortDeal } from "../sales-logic";
import { loadSalesRecords, requestProject } from "../sales-http";
import { salesPopulations, type SalesQuery } from "../sales-sections";
import type { ProjectKey } from "../sales-projects";
import type { AttributionView, OutcomeRecord, SpendRow } from "./metrics";
import type { MarketingFx } from "./money";
import type { IcpConfig } from "./icp";
import { getMarketingSettings, listAttributionViews, listSpend, marketingFx } from "./store";
import { workspaceForProject, workspaceIcp, type WorkspaceKey } from "./workspaces";

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
  /** False when a placement/landing filter is active: Meta daily spend has no such breakdown. */
  spendApplies: boolean; dataAsOf: string | null;
};

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
  const spendApplies = !query.placement && !query.landing;
  const spend = spendApplies ? await listSpend(project, query.startDate, query.endDate, query) : [];
  const workspace = workspaceForProject(project);
  return {
    project, workspace, icp: workspaceIcp(workspace), query, fx: marketingFx(settings), cohort, attribution, spend, spendApplies,
    dataAsOf: projectSync?.lastSyncAt ?? sync.lastSyncAt ?? null,
  };
}

/**
 * Project + query + context, then the endpoint's own body. Formatting is the
 * UI's job. The caller has ALREADY guarded the request — every marketing route
 * calls `authorizePermission` itself (dashboard to read, settings to run jobs),
 * where the route-guard audit can see it.
 */
export async function marketingResponse(request: Request, build: (context: MarketingContext, params: URLSearchParams) => unknown) {
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  const params = new URL(request.url).searchParams;
  const parsed = parseMarketingQuery(params);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: noStore });
  try {
    const context = await loadMarketingContext(scoped.project, parsed.query);
    const body = build(context, params);
    if (body instanceof Response) return body;
    return Response.json({
      project: scoped.project, workspace: context.workspace, icpStatus: context.icp.enabled ? "ENABLED" : "NOT_APPLICABLE", range: { startDate: parsed.query.startDate, endDate: parsed.query.endDate },
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
