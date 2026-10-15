import { isClassifiedLead, isSalesLost } from "../sales-logic";
import { countIcp, ICP_NOT_APPLICABLE, ICP_NOT_FIT, ICP_UNSET, isIcpFit, type IcpClass, type IcpConfig, type IcpCounts } from "./icp";
import { minorToUzs, opportunityToUzs, ratio, ratioWhole, type MarketingFx } from "./money";

/**
 * Marketing performance — a DIMENSION over the existing Deal analytics.
 *
 * No Lead/SQL/Sale classifier lives here. Every outcome is read from the Deal's
 * own analytics record (the accepted, project-specific rules):
 *
 *   Lead        an eligible Deal created in the range (the dashboard's cohort)
 *   Saralangan  isClassifiedLead            SQL   record.qualified
 *   Sale        salesStatus WON             Lost  isSalesLost
 *   In Pipeline SQL AND salesStatus ACTIVE (open, not a sale, not lost)
 *   Revenue     Opportunity of the cohort's Sales
 *
 * The range is the lead-acquisition cohort (Deal created date). Spend is Meta
 * spend delivered on the same calendar days. Period Sales — sales won in the
 * range regardless of creation — never enter acquisition ROAS.
 *
 *   CMC  = Meta spend UZS / attributed cohort Sales     (0 Sales → null)
 *   ROAS = attributed cohort revenue UZS / Meta spend UZS  (0 spend → null)
 */
export type OutcomeRecord = {
  dealId: string; title?: string | null; createdAt: string;
  qualified?: boolean; lossReasonGroup?: string | null; salesStatus?: string;
  opportunity?: number; currencyId?: string | null;
  stage?: string | null; stageId?: string | null; categoryId?: string | null;
  bitrixUrl?: string | null; assignedManagerId?: string | null; assignedManager?: string | null;
  source?: string | null; wonAt?: string | null;
};

/**
 * Funnel conversions as the Marketing page shows them, each against the step
 * before it: Saralangan of Lead, SQL of Saralangan, Sale of SQL. Null on a zero
 * denominator. Supplied here so no screen recomputes them.
 */
export function funnelRates(counts: { leadCount: number; saralanganCount: number; sqlCount: number; saleCount: number }) {
  const rate = (part: number, whole: number) => (whole ? part / whole : null);
  return {
    saralanganRate: rate(counts.saralanganCount, counts.leadCount),
    sqlRate: rate(counts.sqlCount, counts.saralanganCount),
    saleRate: rate(counts.saleCount, counts.sqlCount),
  };
}

export type CostStatus = "AVAILABLE" | "NO_SALES" | "NO_SPEND" | "NOT_INGESTED" | "PENDING" | "CURRENCY_UNAVAILABLE" | "NOT_APPLICABLE";

/**
 * Why a row's cost numbers are what they are, decided where the data is:
 *   NOT_INGESTED          Meta spend not loaded for this range
 *   PENDING               Meta spend loaded for only part of this range
 *   NOT_APPLICABLE        a dimension Meta does not break spend down by (placement, landing)
 *   CURRENCY_UNAVAILABLE  spend in a currency with no marketing rate
 *   NO_SPEND              Meta delivered the range and this row spent nothing
 *   NO_SALES              spend, but no attributed sale (CMC null; ROAS may be a real 0)
 *   AVAILABLE             spend and sales
 */
export function costStatus(spendStatus: string | undefined, spend: { spendUzs: number | null; spendByCurrency: Record<string, number> }, sales: number): CostStatus {
  if (spendStatus === "NOT_INGESTED") return "NOT_INGESTED";
  if (spendStatus === "PARTIAL_RANGE") return "PENDING";
  if (spendStatus === "NOT_BROKEN_DOWN") return "NOT_APPLICABLE";
  if (spend.spendUzs === null) return Object.keys(spend.spendByCurrency).length ? "CURRENCY_UNAVAILABLE" : "NOT_INGESTED";
  if (spend.spendUzs === 0) return "NO_SPEND";
  return sales ? "AVAILABLE" : "NO_SALES";
}

export type AttributionView = {
  dealId: string;
  campaignId: string | null; campaignName: string | null;
  adsetId: string | null; adsetName: string | null;
  adId: string | null; adName: string | null;
  placement: string | null; landingPath: string | null;
  channel: string; attributionSource: string; conflict: boolean;
  icpClass: IcpClass;
};

export type SpendRow = {
  date: string; adId: string; adAccountId: string;
  campaignId: string | null; campaignName: string | null;
  adsetId: string | null; adsetName: string | null; adName: string | null;
  creativeId: string | null;
  spendMinor: number; currency: string; impressions: number; clicks: number;
};

export type DealOutcome = {
  saralangan: boolean; sql: boolean; nr: boolean; sale: boolean; lost: boolean; inPipeline: boolean;
};

export function dealOutcome(record: OutcomeRecord): DealOutcome {
  const row = record as Parameters<typeof isClassifiedLead>[0] & Parameters<typeof isSalesLost>[0];
  const sql = Boolean(record.qualified);
  const sale = record.salesStatus === "WON";
  const lost = isSalesLost(row);
  return {
    saralangan: isClassifiedLead(row),
    sql,
    nr: record.lossReasonGroup === "MARKETING",
    sale,
    lost,
    inPipeline: sql && record.salesStatus === "ACTIVE",
  };
}

/** Paid Meta attribution: any stable campaign/ad set/ad id. */
export function isMetaAttributed(view: AttributionView | undefined) {
  return Boolean(view && (view.campaignId || view.adsetId || view.adId));
}

type Totals = {
  leadCount: number; saralanganCount: number; sqlCount: number; nrCount: number; inPipelineCount: number;
  saleCount: number; lostCount: number;
  revenueByCurrency: Record<string, number>; revenueUzs: number; revenueUzsComplete: boolean;
  /** Null when the workspace has no ICP: NOT_APPLICABLE, never zeros. */
  icp: IcpCounts | null;
};

const icpOf = (view: AttributionView | undefined, icp: IcpConfig): IcpClass => (icp.enabled ? view?.icpClass ?? ICP_UNSET : ICP_NOT_APPLICABLE);

function totals(records: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>, fx: MarketingFx, icp: IcpConfig): Totals {
  const out = {
    leadCount: 0, saralanganCount: 0, sqlCount: 0, nrCount: 0, inPipelineCount: 0, saleCount: 0, lostCount: 0,
    revenueByCurrency: {} as Record<string, number>, revenueUzs: 0, revenueUzsComplete: true,
  };
  const classes: IcpClass[] = [];
  for (const record of records) {
    const outcome = dealOutcome(record);
    out.leadCount += 1;
    if (outcome.saralangan) out.saralanganCount += 1;
    if (outcome.sql) out.sqlCount += 1;
    if (outcome.nr) out.nrCount += 1;
    if (outcome.inPipeline) out.inPipelineCount += 1;
    if (outcome.lost) out.lostCount += 1;
    if (outcome.sale) {
      out.saleCount += 1;
      const currency = String(record.currencyId || "UZS").toUpperCase();
      const amount = Number(record.opportunity ?? 0) || 0;
      out.revenueByCurrency[currency] = (out.revenueByCurrency[currency] ?? 0) + amount;
      const uzs = opportunityToUzs(amount, currency, fx);
      if (uzs === null) out.revenueUzsComplete = false; else out.revenueUzs += uzs;
    }
    classes.push(icpOf(attribution.get(record.dealId), icp));
  }
  return { ...out, icp: countIcp(classes, icp) };
}

export type SpendTotals = {
  spendByCurrency: Record<string, number>; spendUzs: number | null; impressions: number; clicks: number;
};

/** Native minor units per currency, and whole UZS — null if any currency has no marketing rate. */
export function spendTotals(rows: readonly SpendRow[], fx: MarketingFx): SpendTotals {
  const spendByCurrency: Record<string, number> = {};
  let uzs: number | null = 0; let impressions = 0; let clicks = 0;
  for (const row of rows) {
    spendByCurrency[row.currency] = (spendByCurrency[row.currency] ?? 0) + row.spendMinor;
    impressions += row.impressions; clicks += row.clicks;
  }
  for (const [currency, minor] of Object.entries(spendByCurrency)) {
    const converted = minorToUzs(minor, currency, fx);
    uzs = converted === null || uzs === null ? null : uzs + converted;
  }
  return { spendByCurrency, spendUzs: rows.length ? uzs : 0, impressions, clicks };
}

export type CostMetrics = {
  cmcUzs: number | null; roas: number | null;
  cplUzs: number | null; costPerSqlUzs: number | null; costPerSaleUzs: number | null;
  /** Only where the workspace has ICP. */
  costPerIcpFitUzs?: number | null;
};

export function costMetrics(input: {
  spendUzs: number | null; leads: number; icpFit: number | null; sql: number; sales: number; revenueUzs: number | null;
}): CostMetrics {
  const cmc = ratioWhole(input.spendUzs, input.sales);
  return {
    cmcUzs: cmc,
    roas: ratio(input.revenueUzs, input.spendUzs),
    cplUzs: ratioWhole(input.spendUzs, input.leads),
    ...(input.icpFit === null ? {} : { costPerIcpFitUzs: ratioWhole(input.spendUzs, input.icpFit) }),
    costPerSqlUzs: ratioWhole(input.spendUzs, input.sql),
    costPerSaleUzs: cmc,
  };
}

/** The ICP fields of a summary/entity row, or just the NOT_APPLICABLE status. */
function icpFields(counts: IcpCounts | null) {
  if (!counts) return { icpStatus: "NOT_APPLICABLE" as const };
  return {
    icpStatus: "ENABLED" as const,
    icpEvaluatedCount: counts.evaluated, icpFitCount: counts.fit, icpOtherCount: counts.notFit,
    icpUnsetCount: counts.unset, icpFitRate: counts.fitRate, icpByTier: counts.byTier,
  };
}

export type MarketingSummary = Omit<Totals, "icp"> & SpendTotals & CostMetrics & {
  attributedLeadCount: number; attributedSaleCount: number; attributedRevenueUzs: number | null;
  icpStatus: "ENABLED" | "NOT_APPLICABLE";
  icpEvaluatedCount?: number; icpFitCount?: number; icpOtherCount?: number; icpUnsetCount?: number; icpFitRate?: number | null;
  icpByTier?: Record<string, number>;
  /** ICP evaluated ÷ Lead: how much of the cohort sellers actually classified. */
  icpEvaluationShare?: number | null;
  saralanganRate: number | null; sqlRate: number | null; saleRate: number | null;
  costStatus: CostStatus;
  coverage: { campaignIdCoverage: number | null; adsetIdCoverage: number | null; adIdCoverage: number | null };
  /** False when a placement/landing filter is active: Meta daily spend has no such breakdown. */
  spendApplies: boolean;
};

export function buildSummary(input: {
  cohort: readonly OutcomeRecord[]; attribution: ReadonlyMap<string, AttributionView>;
  spend: readonly SpendRow[]; fx: MarketingFx; spendApplies?: boolean; icp: IcpConfig;
  /** The context's Meta availability (AVAILABLE, NOT_INGESTED, PARTIAL_RANGE, NOT_BROKEN_DOWN). */
  spendStatus?: string;
}): MarketingSummary {
  const spendApplies = input.spendApplies !== false;
  const { icp: allIcp, ...all } = totals(input.cohort, input.attribution, input.fx, input.icp);
  const attributed = totals(input.cohort.filter((row) => isMetaAttributed(input.attribution.get(row.dealId))), input.attribution, input.fx, input.icp);
  const spend = spendApplies ? spendTotals(input.spend, input.fx) : { spendByCurrency: {}, spendUzs: null, impressions: 0, clicks: 0 };
  const attributedRevenueUzs = attributed.revenueUzsComplete ? attributed.revenueUzs : null;
  const share = (predicate: (view: AttributionView | undefined) => boolean) =>
    all.leadCount ? input.cohort.filter((row) => predicate(input.attribution.get(row.dealId))).length / all.leadCount : null;
  return {
    ...all,
    ...spend,
    ...costMetrics({
      spendUzs: spend.spendUzs, leads: attributed.leadCount, icpFit: attributed.icp?.fit ?? null, sql: attributed.sqlCount,
      sales: attributed.saleCount, revenueUzs: attributedRevenueUzs,
    }),
    attributedLeadCount: attributed.leadCount,
    attributedSaleCount: attributed.saleCount,
    attributedRevenueUzs,
    ...icpFields(allIcp),
    ...(allIcp ? { icpEvaluationShare: all.leadCount ? allIcp.evaluated / all.leadCount : null } : {}),
    ...funnelRates(all),
    costStatus: costStatus(input.spendStatus ?? (spendApplies ? "AVAILABLE" : "NOT_INGESTED"), spend, attributed.saleCount),
    coverage: {
      campaignIdCoverage: share((view) => Boolean(view?.campaignId)),
      adsetIdCoverage: share((view) => Boolean(view?.adsetId)),
      adIdCoverage: share((view) => Boolean(view?.adId)),
    },
    spendApplies,
  };
}

export type EntityLevel = "campaign" | "adset" | "ad" | "creative" | "placement" | "landing";
export const ENTITY_LEVELS: readonly EntityLevel[] = ["campaign", "adset", "ad", "creative", "placement", "landing"];
export const UNATTRIBUTED = "__unattributed__";

export type EntityRow = {
  id: string; name: string | null; campaignId: string | null; adsetId: string | null;
  leadCount: number; saralanganCount: number;
  icpStatus: "ENABLED" | "NOT_APPLICABLE";
  icpEvaluatedCount?: number; icpFitCount?: number; icpOtherCount?: number; icpUnsetCount?: number; icpFitRate?: number | null;
  icpByTier?: Record<string, number>;
  saralanganRate: number | null; sqlRate: number | null; saleRate: number | null;
  costStatus: CostStatus;
  sqlCount: number; inPipelineCount: number; saleCount: number;
  revenueUzs: number | null; spendUzs: number | null; spendByCurrency: Record<string, number>;
  impressions: number; clicks: number;
} & CostMetrics;

/** Spend has these levels; placement and landing come from leads only. */
const SPEND_LEVELS = new Set<EntityLevel>(["campaign", "adset", "ad", "creative"]);

export function buildEntities(input: {
  level: EntityLevel; cohort: readonly OutcomeRecord[]; attribution: ReadonlyMap<string, AttributionView>;
  spend: readonly SpendRow[]; fx: MarketingFx; spendApplies?: boolean; icp: IcpConfig; spendStatus?: string;
  /** ad_id → creative_id, from Meta daily rows. */
  creativeByAd?: ReadonlyMap<string, string>;
}): EntityRow[] {
  const { level } = input;
  const creativeByAd = input.creativeByAd ?? new Map(input.spend.filter((row) => row.creativeId).map((row) => [row.adId, row.creativeId as string]));
  const keyOfView = (view: AttributionView | undefined): string | null => {
    if (!view) return null;
    if (level === "campaign") return view.campaignId;
    if (level === "adset") return view.adsetId;
    if (level === "ad") return view.adId;
    if (level === "creative") return view.adId ? creativeByAd.get(view.adId) ?? null : null;
    if (level === "placement") return view.placement;
    return view.landingPath;
  };
  const keyOfSpend = (row: SpendRow): string | null => {
    if (level === "campaign") return row.campaignId;
    if (level === "adset") return row.adsetId;
    if (level === "ad") return row.adId;
    return row.creativeId;
  };
  const groups = new Map<string, { records: OutcomeRecord[]; spend: SpendRow[]; views: AttributionView[] }>();
  const group = (key: string) => {
    let value = groups.get(key);
    if (!value) { value = { records: [], spend: [], views: [] }; groups.set(key, value); }
    return value;
  };
  for (const record of input.cohort) {
    const view = input.attribution.get(record.dealId);
    const entry = group(keyOfView(view) ?? UNATTRIBUTED);
    entry.records.push(record);
    if (view) entry.views.push(view);
  }
  const spendApplies = input.spendApplies !== false && SPEND_LEVELS.has(level);
  if (spendApplies) for (const row of input.spend) group(keyOfSpend(row) ?? UNATTRIBUTED).spend.push(row);

  const rows: EntityRow[] = [];
  for (const [id, entry] of groups) {
    const counts = totals(entry.records, input.attribution, input.fx, input.icp);
    const spend = spendApplies ? spendTotals(entry.spend, input.fx) : { spendByCurrency: {}, spendUzs: null, impressions: 0, clicks: 0 };
    // The display name: the most recent Meta name, else the newest lead's name.
    const latestSpend = [...entry.spend].sort((a, b) => b.date.localeCompare(a.date))[0];
    const latestView = entry.views.at(-1);
    const nameFromSpend = latestSpend ? (level === "campaign" ? latestSpend.campaignName : level === "adset" ? latestSpend.adsetName : level === "ad" ? latestSpend.adName : null) : null;
    const nameFromView = latestView ? (level === "campaign" ? latestView.campaignName : level === "adset" ? latestView.adsetName : level === "ad" ? latestView.adName : null) : null;
    const parent = latestSpend ?? latestView;
    const revenueUzs = counts.revenueUzsComplete ? counts.revenueUzs : null;
    rows.push({
      id,
      name: id === UNATTRIBUTED ? null : nameFromSpend ?? nameFromView ?? (level === "placement" || level === "landing" ? id : null),
      campaignId: level === "campaign" || id === UNATTRIBUTED ? null : parent?.campaignId ?? null,
      adsetId: level === "ad" || level === "creative" ? parent?.adsetId ?? null : null,
      leadCount: counts.leadCount, saralanganCount: counts.saralanganCount,
      ...icpFields(counts.icp),
      ...funnelRates(counts),
      costStatus: costStatus(spendApplies ? input.spendStatus ?? "AVAILABLE" : input.spendStatus === "AVAILABLE" || !input.spendStatus ? "NOT_BROKEN_DOWN" : input.spendStatus, spend, counts.saleCount),
      sqlCount: counts.sqlCount, inPipelineCount: counts.inPipelineCount, saleCount: counts.saleCount,
      revenueUzs, spendUzs: spend.spendUzs, spendByCurrency: spend.spendByCurrency,
      impressions: spend.impressions, clicks: spend.clicks,
      ...costMetrics({ spendUzs: spend.spendUzs, leads: counts.leadCount, icpFit: counts.icp?.fit ?? null, sql: counts.sqlCount, sales: counts.saleCount, revenueUzs }),
    });
  }
  return rows.sort((a, b) => (b.spendUzs ?? 0) - (a.spendUzs ?? 0) || b.leadCount - a.leadCount || a.id.localeCompare(b.id));
}

export type DealMetric = "lead" | "icp_fit" | "icp_other" | "icp_unset" | "sql" | "pipeline" | "sale";
export const DEAL_METRICS: readonly DealMetric[] = ["lead", "icp_fit", "icp_other", "icp_unset", "sql", "pipeline", "sale"];

export const ICP_METRICS: readonly DealMetric[] = ["icp_fit", "icp_other", "icp_unset"];

/** The Deals behind one number. An ICP metric on a workspace without ICP is null (not applicable), never empty. */
export function dealsForMetric(metric: DealMetric, cohort: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>, icpConfig: IcpConfig) {
  if (ICP_METRICS.includes(metric) && !icpConfig.enabled) return null;
  return cohort.filter((record) => {
    const outcome = dealOutcome(record);
    const icp = icpOf(attribution.get(record.dealId), icpConfig);
    if (metric === "lead") return true;
    if (metric === "icp_fit") return isIcpFit(icp, icpConfig);
    if (metric === "icp_other") return icp === ICP_NOT_FIT;
    if (metric === "icp_unset") return icp === ICP_UNSET;
    if (metric === "sql") return outcome.sql;
    if (metric === "pipeline") return outcome.inPipeline;
    return outcome.sale;
  }).map((record) => {
    const view = attribution.get(record.dealId);
    const outcome = dealOutcome(record);
    return {
      dealId: record.dealId, title: record.title ?? null, createdAt: record.createdAt, bitrixUrl: record.bitrixUrl ?? null,
      stage: record.stage ?? null, stageId: record.stageId ?? null, assignedManagerId: record.assignedManagerId ?? null,
      assignedManager: record.assignedManager ?? null, source: record.source ?? null, wonAt: outcome.sale ? record.wonAt ?? null : null,
      ...outcome, opportunity: Number(record.opportunity ?? 0) || 0, currencyId: record.currencyId ?? null,
      icpClass: icpOf(view, icpConfig),
      campaignId: view?.campaignId ?? null, campaignName: view?.campaignName ?? null,
      adsetId: view?.adsetId ?? null, adsetName: view?.adsetName ?? null,
      adId: view?.adId ?? null, adName: view?.adName ?? null,
      channel: view?.channel ?? "UNKNOWN", attributionSource: view?.attributionSource ?? "UNKNOWN", attributionConflict: view?.conflict ?? false,
    };
  });
}

export type CoverageRow = {
  deals: number; withCampaignId: number; withAdsetId: number; withAdId: number;
  metaInstantForm: number; website: number; otherSource: number; unknown: number; conflicts: number; notYetAttributed: number;
};

export function buildCoverage(cohort: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>): CoverageRow {
  const out: CoverageRow = { deals: 0, withCampaignId: 0, withAdsetId: 0, withAdId: 0, metaInstantForm: 0, website: 0, otherSource: 0, unknown: 0, conflicts: 0, notYetAttributed: 0 };
  for (const record of cohort) {
    out.deals += 1;
    const view = attribution.get(record.dealId);
    if (!view) { out.notYetAttributed += 1; continue; }
    if (view.campaignId) out.withCampaignId += 1;
    if (view.adsetId) out.withAdsetId += 1;
    if (view.adId) out.withAdId += 1;
    if (view.channel === "META_INSTANT_FORM") out.metaInstantForm += 1;
    else if (view.channel === "WEBSITE") out.website += 1;
    else if (view.channel === "OTHER") out.otherSource += 1;
    else out.unknown += 1;
    if (view.conflict) out.conflicts += 1;
  }
  return out;
}

/** ICP per owner, for the existing Overview/Managers pages to consume later. */
export function icpByKey(cohort: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>, keyOf: (record: OutcomeRecord) => string, icp: IcpConfig) {
  if (!icp.enabled) return null;
  const groups = new Map<string, IcpClass[]>();
  for (const record of cohort) {
    const key = keyOf(record);
    const list = groups.get(key) ?? [];
    list.push(icpOf(attribution.get(record.dealId), icp));
    groups.set(key, list);
  }
  return [...groups].map(([key, classes]) => ({ key, ...(countIcp(classes, icp) as IcpCounts) })).sort((a, b) => b.evaluated - a.evaluated || a.key.localeCompare(b.key));
}

export type FilterOption = { id: string; name: string };
export type FilterOptions = {
  marketingSources: FilterOption[]; platforms: FilterOption[]; campaigns: FilterOption[]; adSets: FilterOption[];
  ads: FilterOption[]; placements: FilterOption[]; landingForms: FilterOption[];
};

/**
 * Filter catalogue from the real cohort and its assigned spend. Each child list
 * is constrained by the parent filter (Ad Sets by Campaign, Ads by Ad Set), so a
 * dropdown never offers a child of another parent. IDs are the values; names
 * are labels. Platform is not a backend dimension yet, so its list is empty.
 */
export function buildFilterOptions(input: {
  cohort: readonly OutcomeRecord[]; attribution: ReadonlyMap<string, AttributionView>; spend: readonly SpendRow[];
  filters: { campaignId?: string | null; adsetId?: string | null };
}): FilterOptions {
  const add = (map: Map<string, string>, id: string | null | undefined, name: string | null | undefined) => {
    if (!id) return;
    if (!map.has(id) || (name && map.get(id) === id)) map.set(id, name || id);
  };
  const campaigns = new Map<string, string>(); const adSets = new Map<string, string>(); const ads = new Map<string, string>();
  const placements = new Map<string, string>(); const landings = new Map<string, string>(); const sources = new Map<string, string>();
  const inCampaign = (campaignId: string | null) => !input.filters.campaignId || campaignId === input.filters.campaignId;
  const inAdset = (adsetId: string | null) => !input.filters.adsetId || adsetId === input.filters.adsetId;
  // Meta names first (latest wins over a lead's older label), then lead-side names.
  for (const row of [...input.spend].sort((a, b) => b.date.localeCompare(a.date))) {
    add(campaigns, row.campaignId, row.campaignName);
    if (inCampaign(row.campaignId)) add(adSets, row.adsetId, row.adsetName);
    if (inCampaign(row.campaignId) && inAdset(row.adsetId)) add(ads, row.adId, row.adName);
  }
  for (const record of input.cohort) {
    if (record.source) add(sources, record.source, record.source);
    const view = input.attribution.get(record.dealId);
    if (!view) continue;
    add(campaigns, view.campaignId, view.campaignName);
    if (inCampaign(view.campaignId)) add(adSets, view.adsetId, view.adsetName);
    if (inCampaign(view.campaignId) && inAdset(view.adsetId)) add(ads, view.adId, view.adName);
    add(placements, view.placement, view.placement);
    add(landings, view.landingPath, view.landingPath);
  }
  const list = (map: Map<string, string>) => [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    marketingSources: list(sources), platforms: [], campaigns: list(campaigns), adSets: list(adSets),
    ads: list(ads), placements: list(placements), landingForms: list(landings),
  };
}
