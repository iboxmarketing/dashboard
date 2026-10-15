import { SessionLostError, authFetch } from "@/lib/auth-fetch";
import {
  MARKETING_COVERAGE, MARKETING_MANAGER_ICP, MARKETING_OPTIONS, MARKETING_ROWS, MARKETING_SUMMARIES,
  buildMarketingDealFixtures,
} from "./marketing-fixtures";
import {
  EMPTY_MARKETING_OPTIONS,
  type FixtureIcpBreakdown,
  type FixtureMarketingEntityRow,
  type MarketingCostStatus,
  type MarketingCosts,
  type MarketingDataAdapter,
  type MarketingDealRequest,
  type MarketingDealRow,
  type MarketingDealsResponse,
  type MarketingEntitiesRequest,
  type MarketingEntitiesResponse,
  type MarketingEntityLevel,
  type MarketingEntityRow,
  type MarketingFilterOptions,
  type MarketingFilters,
  type MarketingIcpResponse,
  type MarketingQueryContext,
  type MarketingSummaryResponse,
  type MarketingCoverageResponse,
  type MarketingMetaStatus,
  type MarketingPopulation,
  type MarketingSpendAttribution,
} from "./marketing-types";
import {
  isMarketingWorkspaceKey, marketingProjectForWorkspace, marketingWorkspace, type MarketingWorkspaceKey,
} from "./marketing-workspaces";

export const MARKETING_ENDPOINTS = {
  summary: "/api/marketing/summary",
  entities: "/api/marketing/entities",
  deals: "/api/marketing/deals",
  icp: "/api/marketing/icp",
  coverage: "/api/marketing/coverage",
} as const;

export type MarketingAdapterErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "WORKSPACE_NOT_ACTIVATED"
  | "ICP_NOT_APPLICABLE"
  | "NOT_APPLICABLE"
  | "HTTP_ERROR";

export class MarketingAdapterError extends Error {
  constructor(message: string, readonly code: MarketingAdapterErrorCode = "HTTP_ERROR", readonly status = 0) {
    super(message);
    this.name = "MarketingAdapterError";
  }
}

const FIXTURE_LEVELS: Record<MarketingEntityLevel, FixtureMarketingEntityRow["level"] | null> = {
  campaign: "CAMPAIGN",
  adset: "AD_SET",
  ad: "AD",
  creative: "AD",
  placement: "PLACEMENT",
  landing: "LANDING_FORM",
};

const ratioFromFixturePercent = (value: number) => value / 100;

function fixtureMetrics(row: FixtureMarketingEntityRow | (typeof MARKETING_SUMMARIES)[keyof typeof MARKETING_SUMMARIES]) {
  return {
    leadCount: row.leadCount,
    classifiedCount: row.classifiedCount,
    // Fixture-only preview values; the HTTP adapter binds the API's own rates.
    classifiedRate: row.leadCount ? row.classifiedCount / row.leadCount : null,
    icpEvaluationShare: row.leadCount ? row.icpEvaluatedCount / row.leadCount : null,
    icpEvaluatedCount: row.icpEvaluatedCount,
    icpFitCount: row.icpFitCount,
    icpOtherCount: row.icpOtherCount,
    icpUnsetCount: row.icpUnsetCount,
    icpFitRate: ratioFromFixturePercent(row.icpFitRate),
    sqlCount: row.sqlCount,
    sqlRate: ratioFromFixturePercent(row.sqlRate),
    pipelineCount: row.pipelineCount,
    saleCount: row.saleCount,
    sqlToSaleRate: ratioFromFixturePercent(row.sqlToSaleRate),
    revenue: row.revenue,
  };
}

function activeFixtureProject(workspace: MarketingWorkspaceKey) {
  const project = marketingProjectForWorkspace(workspace);
  if (!project) throw new MarketingAdapterError("Bu workspace hali faollashtirilmagan", "WORKSPACE_NOT_ACTIVATED", 409);
  return project;
}

function fixtureCosts(costs: MarketingCosts, saleCount: number, spendApplies = true): MarketingCosts {
  if (!spendApplies) return { ...costs, status: "NOT_APPLICABLE", message: "Bu kesimda spend qo‘llanilmaydi", spend: null, cpl: null, costPerIcp: null, costPerSql: null, cmc: null, roas: null };
  if (costs.status !== "AVAILABLE") return costs;
  if (costs.spend === 0) return { ...costs, status: "NO_SPEND", message: "Spend yo‘q", cpl: null, costPerIcp: null, costPerSql: null, cmc: null, roas: null };
  if (saleCount === 0) return { ...costs, status: "NO_SALES", message: "Sotuv yo‘q", cmc: null };
  return costs;
}

function fixtureEntity(row: FixtureMarketingEntityRow, level: MarketingEntityLevel): MarketingEntityRow {
  return {
    ...fixtureMetrics(row),
    id: row.id,
    level,
    parentId: row.parentId,
    name: row.name,
    secondary: row.secondary,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    adSetId: row.adSetId,
    adSetName: row.adSetName,
    adId: row.adId,
    platform: row.platform,
    placement: row.placement,
    landingId: row.landingId,
    landingLabel: row.landingLabel,
    landingType: row.landingType,
    marketingSource: row.marketingSource,
    costs: fixtureCosts(row.costs, row.saleCount, level !== "placement" && level !== "landing"),
  };
}

function fixtureIcpBreakdown(icp: FixtureIcpBreakdown) {
  return {
    icpEvaluatedCount: icp.icpEvaluatedCount,
    icpFitCount: icp.icpFitCount,
    icpOtherCount: icp.icpOtherCount,
    icpUnsetCount: icp.icpUnsetCount,
    icpFitRate: ratioFromFixturePercent(icp.icpFitRate),
    rows: icp.rows.map((row) => ({
      segment: row.segment,
      metric: row.segment === "OTHER" ? "icp_other" as const : row.segment === "UNSET" ? "icp_unset" as const : "icp_fit" as const,
      label: row.label,
      meaning: row.meaning,
      count: row.count,
    })),
  };
}

/** Deterministic implementation used by this UI-only branch and unit tests. */
export class FixtureMarketingAdapter implements MarketingDataAdapter {
  readonly source = "fixtures" as const;

  async getSummary(request: MarketingQueryContext): Promise<MarketingSummaryResponse> {
    const project = activeFixtureProject(request.workspace);
    const definition = marketingWorkspace(request.workspace);
    const source = MARKETING_SUMMARIES[project];
    const coverage = project === "IBOX"
      ? { campaignIdCoverage: 0.94, adsetIdCoverage: 0.9, adIdCoverage: 0.92 }
      : { campaignIdCoverage: 0.91, adsetIdCoverage: 0.84, adIdCoverage: 0.81 };
    return {
      workspace: request.workspace,
      workspaceName: definition.label,
      dataAsOf: "2026-10-14T09:00:00+05:00",
      meta: null,
      scope: request.scope ?? "meta",
      population: null,
      usdToUzs: null,
      spendAttribution: null,
      fixture: true,
      capabilities: { ...definition.capabilities },
      options: MARKETING_OPTIONS[project],
      summary: { workspace: request.workspace, ...fixtureMetrics(source), costs: fixtureCosts(source.costs, source.saleCount, !request.filters.placement && !request.filters.landing), coverage },
    };
  }

  async getEntities(request: MarketingEntitiesRequest): Promise<MarketingEntitiesResponse> {
    const project = activeFixtureProject(request.workspace);
    const fixtureLevel = FIXTURE_LEVELS[request.level];
    const rows = fixtureLevel ? MARKETING_ROWS[project]
      .filter((row) => row.level === fixtureLevel)
      .filter((row) => request.level !== "adset" || !request.filters.campaignId || row.campaignId === request.filters.campaignId)
      .filter((row) => (request.level !== "ad" && request.level !== "creative") || !request.filters.adsetId || row.adSetId === request.filters.adsetId)
      .map((row) => fixtureEntity(row, request.level)) : [];
    return { workspace: request.workspace, level: request.level, rows };
  }

  async getDeals(request: MarketingDealRequest): Promise<MarketingDealsResponse> {
    const project = activeFixtureProject(request.workspace);
    const seed = {
      campaign: request.entity?.campaignName ?? request.entity?.name,
      adSet: request.entity?.adSetName ?? undefined,
      ad: request.entity?.level === "ad" ? request.entity.name : undefined,
      platform: request.entity?.platform,
      marketingSource: request.entity?.marketingSource,
      icp: request.metric === "icp_other" ? "OTHER" as const : request.metric === "icp_unset" ? "UNSET" as const : undefined,
    };
    const expectedCount = request.expectedCount ?? 0;
    const deals = buildMarketingDealFixtures(project, expectedCount, Object.fromEntries(Object.entries(seed).filter(([, value]) => value !== undefined)));
    return { workspace: request.workspace, metric: request.metric, count: deals.length, deals, truncated: false };
  }

  async getIcp(request: MarketingQueryContext): Promise<MarketingIcpResponse> {
    const project = activeFixtureProject(request.workspace);
    if (!marketingWorkspace(request.workspace).capabilities.icp) return { status: "ICP_NOT_APPLICABLE", workspace: request.workspace };
    return {
      status: "ENABLED",
      workspace: request.workspace,
      breakdown: fixtureIcpBreakdown(MARKETING_SUMMARIES[project].icp),
      byManager: MARKETING_MANAGER_ICP[project].map((row) => ({ ...row, fitRate: ratioFromFixturePercent(row.fitRate) })),
    };
  }

  async getCoverage(request: MarketingQueryContext): Promise<MarketingCoverageResponse> {
    const project = activeFixtureProject(request.workspace);
    return { workspace: request.workspace, coverage: MARKETING_COVERAGE[project] };
  }
}

type HttpCommon = {
  project?: string;
  workspace: string;
  icpStatus: "ENABLED" | "NOT_APPLICABLE";
  range: { startDate: string; endDate: string };
  filters: unknown;
  fx: { usdToUzs: number };
  dataAsOf: string | null;
};

type HttpCostFields = {
  spendByCurrency: Record<string, number>;
  spendUzs: number | null;
  cmcUzs: number | null;
  roas: number | null;
  cplUzs: number | null;
  costPerIcpFitUzs?: number | null;
  costPerSqlUzs: number | null;
  costPerSaleUzs: number | null;
  /** The backend's availability verdict for this row (lib/marketing/metrics.ts costStatus). */
  costStatus?: MarketingCostStatus;
  /** Optional forward-compatible Meta connection state. */
  metaStatus?: "CONNECTED" | "DISCONNECTED" | "PENDING";
};

type HttpFunnelFields = {
  leadCount: number;
  saralanganCount: number;
  sqlCount: number;
  inPipelineCount: number;
  saleCount: number;
  revenueUzs: number | null;
  icpStatus: "ENABLED" | "NOT_APPLICABLE";
  icpEvaluatedCount?: number;
  icpFitCount?: number;
  icpOtherCount?: number;
  icpUnsetCount?: number;
  icpFitRate?: number | null;
  icpEvaluationShare?: number | null;
  saralanganRate?: number | null;
  sqlRate?: number | null;
  saleRate?: number | null;
};

type HttpSummary = HttpFunnelFields & HttpCostFields & {
  spendApplies: boolean;
  coverage: { campaignIdCoverage: number | null; adsetIdCoverage: number | null; adIdCoverage: number | null };
};

type HttpSummaryPayload = HttpCommon & {
  summary: HttpSummary; options?: MarketingFilterOptions;
  spendAttribution?: MarketingSpendAttribution | null; meta?: MarketingMetaStatus; fx?: { usdToUzs: number };
  scope?: "meta" | "workspace"; population?: MarketingPopulation;
};
type HttpEntity = HttpFunnelFields & HttpCostFields & { id: string; name: string | null; campaignId: string | null; adsetId: string | null };
type HttpEntitiesPayload = HttpCommon & { level: MarketingEntityLevel; rows: HttpEntity[] };
type HttpDeal = {
  dealId: string; title: string | null; createdAt: string; bitrixUrl: string | null; stage: string | null;
  assignedManagerId: string | null; assignedManager?: string | null; source?: string | null; wonAt?: string | null;
  saralangan: boolean; sql: boolean; nr: boolean; sale: boolean;
  opportunity: number; currencyId: string | null; icpClass: string;
  campaignId: string | null; campaignName: string | null; adsetId: string | null; adsetName: string | null;
  adId: string | null; adName: string | null; channel: string; attributionConflict: boolean;
};
type HttpDealsPayload = HttpCommon & { metric: string; count: number; deals: HttpDeal[]; truncated: boolean };
type HttpIcpCounts = { evaluated: number; fit: number; notFit: number; unset: number; byTier: Record<string, number>; fitRate: number | null };
type HttpIcpPayload = HttpCommon & { icp?: HttpIcpCounts; byManager?: Array<{ key: string; name?: string } & HttpIcpCounts> };
type HttpCoveragePayload = HttpCommon & { coverage: MarketingCoverageResponse["coverage"] };

const COST_STATUSES = new Set<MarketingCostStatus>([
  "AVAILABLE", "NO_SALES", "NO_SPEND", "META_NOT_CONNECTED", "NOT_INGESTED", "PENDING", "CURRENCY_UNAVAILABLE", "NOT_APPLICABLE",
]);

/** Availability only; every displayed number remains the backend-supplied value. */
export function resolveMarketingCosts(input: HttpCostFields & { spendApplies: boolean; saleCount: number }): MarketingCosts {
  let status: MarketingCostStatus;
  if (input.costStatus && COST_STATUSES.has(input.costStatus)) status = input.costStatus;
  else if (!input.spendApplies) status = "NOT_APPLICABLE";
  else if (input.metaStatus === "DISCONNECTED") status = "META_NOT_CONNECTED";
  else if (input.metaStatus === "PENDING") status = "PENDING";
  else if (input.spendUzs === null && Object.keys(input.spendByCurrency).length > 0) status = "CURRENCY_UNAVAILABLE";
  else if (input.spendUzs === null) status = "PENDING";
  else if (input.spendUzs === 0) status = "NO_SPEND";
  else if (input.saleCount === 0) status = "NO_SALES";
  else status = "AVAILABLE";
  const messages: Record<MarketingCostStatus, string | null> = {
    AVAILABLE: null,
    NO_SALES: "Sotuv yo‘q",
    NO_SPEND: "Spend yo‘q",
    META_NOT_CONNECTED: "Meta Insights ulanmagan",
    NOT_INGESTED: "Meta ma’lumoti yuklanmagan",
    PENDING: "Spend ma’lumoti kutilmoqda",
    CURRENCY_UNAVAILABLE: "Currency rate unavailable",
    NOT_APPLICABLE: "Bu kesimda spend qo‘llanilmaydi",
  };
  return {
    status,
    message: messages[status],
    // Every cost field the API returns is whole UZS (spendUzs, cplUzs, cmcUzs, …),
    // whatever currency Meta billed in — the native currency is never the label.
    currency: "UZS",
    spend: input.spendUzs,
    cpl: input.cplUzs,
    costPerIcp: input.costPerIcpFitUzs ?? null,
    costPerSql: input.costPerSqlUzs,
    cmc: input.cmcUzs,
    roas: input.roas,
  };
}

function normalizedMetrics(row: HttpFunnelFields) {
  const icpEnabled = row.icpStatus === "ENABLED";
  return {
    leadCount: row.leadCount,
    classifiedCount: row.saralanganCount,
    classifiedRate: row.saralanganRate ?? null,
    icpEvaluationShare: icpEnabled ? row.icpEvaluationShare ?? null : null,
    icpEvaluatedCount: icpEnabled ? row.icpEvaluatedCount ?? null : null,
    icpFitCount: icpEnabled ? row.icpFitCount ?? null : null,
    icpOtherCount: icpEnabled ? row.icpOtherCount ?? null : null,
    icpUnsetCount: icpEnabled ? row.icpUnsetCount ?? null : null,
    icpFitRate: icpEnabled ? row.icpFitRate ?? null : null,
    sqlCount: row.sqlCount,
    sqlRate: row.sqlRate ?? null,
    pipelineCount: row.inPipelineCount,
    saleCount: row.saleCount,
    sqlToSaleRate: row.saleRate ?? null,
    revenue: row.revenueUzs,
  };
}

function queryParams(context: MarketingQueryContext) {
  const params = new URLSearchParams();
  params.set("workspace", context.workspace);
  if (context.scope === "workspace") params.set("scope", "workspace");
  const { filters } = context;
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.source) params.append("source", filters.source);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (filters.adsetId) params.set("adsetId", filters.adsetId);
  if (filters.adId) params.set("adId", filters.adId);
  if (filters.placement) params.set("placement", filters.placement);
  if (filters.landing) params.set("landing", filters.landing);
  return params;
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  const message = typeof payload?.error === "string" && payload.error ? payload.error : `Marketing API xatosi (${response.status})`;
  const code = payload?.code === "WORKSPACE_NOT_ACTIVATED" || payload?.code === "ICP_NOT_APPLICABLE"
    ? payload.code : response.status === 404 ? "NOT_APPLICABLE" : "HTTP_ERROR";
  return new MarketingAdapterError(message, code, response.status);
}

/** HTTP implementation bound to the five agreed read endpoints. */
export class HttpMarketingAdapter implements MarketingDataAdapter {
  readonly source = "http" as const;

  constructor(private readonly fetchImpl: typeof fetch = authFetch, private readonly timeoutMs = 15_000) {}

  private async get<T>(endpoint: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${endpoint}?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) throw await responseError(response);
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") throw new MarketingAdapterError("Marketing API JSON qaytarmadi", "INVALID_RESPONSE", response.status);
      return payload as T;
    } catch (error) {
      if (error instanceof MarketingAdapterError || error instanceof SessionLostError) throw error;
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new MarketingAdapterError("Marketing so‘rovi bekor qilindi", "ABORTED");
        throw new MarketingAdapterError("Marketing API javob berish vaqti tugadi", "TIMEOUT");
      }
      throw new MarketingAdapterError("Marketing API bilan aloqa yo‘q", "NETWORK");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private workspace(payload: HttpCommon, requested: MarketingWorkspaceKey) {
    if (!isMarketingWorkspaceKey(payload.workspace) || payload.workspace !== requested) {
      throw new MarketingAdapterError("Marketing API boshqa workspace qaytardi", "INVALID_RESPONSE");
    }
    return payload.workspace;
  }

  async getSummary(request: MarketingQueryContext, signal?: AbortSignal): Promise<MarketingSummaryResponse> {
    const payload = await this.get<HttpSummaryPayload>(MARKETING_ENDPOINTS.summary, queryParams(request), signal);
    const workspace = this.workspace(payload, request.workspace);
    if (!payload.summary || typeof payload.summary !== "object") throw new MarketingAdapterError("Marketing API summary qaytarmadi", "INVALID_RESPONSE");
    const summary = payload.summary;
    return {
      workspace,
      workspaceName: marketingWorkspace(workspace).label,
      dataAsOf: payload.dataAsOf,
      meta: payload.meta ?? null,
      scope: payload.scope ?? request.scope ?? "meta",
      population: payload.population ?? null,
      usdToUzs: payload.fx?.usdToUzs ?? null,
      spendAttribution: payload.spendAttribution ?? null,
      fixture: false,
      capabilities: { icp: payload.icpStatus === "ENABLED" },
      options: payload.options ?? EMPTY_MARKETING_OPTIONS,
      summary: {
        workspace,
        ...normalizedMetrics(summary),
        costs: resolveMarketingCosts({ ...summary, saleCount: summary.saleCount, spendApplies: summary.spendApplies }),
        coverage: summary.coverage,
      },
    };
  }

  async getEntities(request: MarketingEntitiesRequest, signal?: AbortSignal): Promise<MarketingEntitiesResponse> {
    const params = queryParams(request);
    params.set("level", request.level);
    const payload = await this.get<HttpEntitiesPayload>(MARKETING_ENDPOINTS.entities, params, signal);
    const workspace = this.workspace(payload, request.workspace);
    if (!Array.isArray(payload.rows)) throw new MarketingAdapterError("Marketing API entities ro‘yxatini qaytarmadi", "INVALID_RESPONSE");
    const spendApplies = !request.filters.placement && !request.filters.landing;
    const rows = payload.rows.map((row): MarketingEntityRow => {
      const unattributed = row.id === "__unattributed__";
      const campaignId = request.level === "campaign" ? (unattributed ? null : row.id) : row.campaignId;
      const adSetId = request.level === "adset" ? (unattributed ? null : row.id) : row.adsetId;
      const adId = request.level === "ad" ? (unattributed ? null : row.id) : null;
      return {
        id: row.id,
        level: request.level,
        parentId: request.level === "adset" ? request.filters.campaignId || null : request.level === "ad" ? request.filters.adsetId || null : null,
        name: row.name ?? "Attribution topilmadi",
        secondary: unattributed ? "Stable ID topilmadi" : row.id,
        campaignId,
        campaignName: request.level === "campaign" ? row.name : null,
        adSetId,
        adSetName: request.level === "adset" ? row.name : null,
        adId,
        platform: "—",
        placement: request.level === "placement" && !unattributed ? row.id : null,
        landingId: request.level === "landing" && !unattributed ? row.id : null,
        landingLabel: request.level === "landing" ? row.name : null,
        landingType: request.level === "landing" ? "UNKNOWN" : null,
        marketingSource: request.filters.source || "—",
        ...normalizedMetrics(row),
        costs: resolveMarketingCosts({ ...row, saleCount: row.saleCount, spendApplies }),
      };
    });
    return { workspace, level: request.level, rows };
  }

  async getDeals(request: MarketingDealRequest, signal?: AbortSignal): Promise<MarketingDealsResponse> {
    const params = queryParams(request);
    params.set("metric", request.metric);
    const payload = await this.get<HttpDealsPayload>(MARKETING_ENDPOINTS.deals, params, signal);
    const workspace = this.workspace(payload, request.workspace);
    if (!Array.isArray(payload.deals)) throw new MarketingAdapterError("Marketing API deals ro‘yxatini qaytarmadi", "INVALID_RESPONSE");
    const deals = payload.deals.map((row): MarketingDealRow => ({
      dealId: row.dealId,
      title: row.title ?? `Deal #${row.dealId}`,
      manager: row.assignedManager ?? row.assignedManagerId ?? "Aniqlanmagan",
      currentStage: row.stage ?? "—",
      quality: row.nr ? "Not Relevant" : row.sql ? "SQL" : row.saralangan ? "Saralangan" : "Saralanmagan",
      icp: row.icpClass,
      crmSource: row.source ?? (request.filters.source || "—"),
      marketingSource: row.channel,
      platform: "—",
      campaign: row.campaignName ?? row.campaignId ?? "Attribution topilmadi",
      adSet: row.adsetName ?? row.adsetId ?? "Attribution topilmadi",
      ad: row.adName ?? row.adId ?? "Attribution topilmadi",
      createdAt: row.createdAt,
      saleAt: row.wonAt ?? null,
      revenue: row.opportunity,
      currency: row.currencyId ?? "UZS",
      attributionConflict: row.attributionConflict,
      bitrixUrl: row.bitrixUrl,
    }));
    return { workspace, metric: request.metric, count: payload.count, deals, truncated: payload.truncated };
  }

  async getIcp(request: MarketingQueryContext, signal?: AbortSignal): Promise<MarketingIcpResponse> {
    const payload = await this.get<HttpIcpPayload>(MARKETING_ENDPOINTS.icp, queryParams(request), signal);
    const workspace = this.workspace(payload, request.workspace);
    if (payload.icpStatus === "NOT_APPLICABLE" || !payload.icp) return { status: "ICP_NOT_APPLICABLE", workspace };
    const counts = payload.icp;
    return {
      status: "ENABLED",
      workspace,
      breakdown: {
        icpEvaluatedCount: counts.evaluated,
        icpFitCount: counts.fit,
        icpOtherCount: counts.notFit,
        icpUnsetCount: counts.unset,
        icpFitRate: counts.fitRate,
        rows: [
          ...Object.entries(counts.byTier).map(([segment, count]) => ({ segment, metric: "icp_fit" as const, label: segment, meaning: "Mos" as const, count })),
          { segment: "OTHER", metric: "icp_other", label: "Other", meaning: "Mos emas", count: counts.notFit },
          { segment: "UNSET", metric: "icp_unset", label: "Belgilanmagan", meaning: "Belgilanmagan", count: counts.unset },
        ],
      },
      byManager: (payload.byManager ?? []).map((row) => ({
        managerId: row.key, managerName: row.name ?? row.key, evaluatedCount: row.evaluated,
        fitCount: row.fit, fitRate: row.fitRate, unsetCount: row.unset,
      })),
    };
  }

  async getCoverage(request: MarketingQueryContext, signal?: AbortSignal): Promise<MarketingCoverageResponse> {
    const payload = await this.get<HttpCoveragePayload>(MARKETING_ENDPOINTS.coverage, queryParams(request), signal);
    const workspace = this.workspace(payload, request.workspace);
    if (!payload.coverage || typeof payload.coverage !== "object") throw new MarketingAdapterError("Marketing API coverage qaytarmadi", "INVALID_RESPONSE");
    return { workspace, coverage: payload.coverage };
  }
}

export function nextMarketingLevel(row: MarketingEntityRow) {
  if (row.level === "campaign") return "adset" as const;
  if (row.level === "adset") return "ad" as const;
  return null;
}

export function inheritedMarketingFilters(filters: MarketingFilters, row: MarketingEntityRow): MarketingFilters {
  const inherited = {
    ...filters,
    campaignId: row.campaignId ?? filters.campaignId,
    adsetId: row.adSetId ?? filters.adsetId,
    adId: row.adId ?? filters.adId,
    placement: row.level === "placement" ? row.placement ?? filters.placement : filters.placement,
    landing: row.level === "landing" ? row.landingId ?? filters.landing : filters.landing,
  };
  if (row.level === "campaign") return { ...inherited, adsetId: "", adId: "" };
  if (row.level === "adset") return { ...inherited, adId: "" };
  return inherited;
}
