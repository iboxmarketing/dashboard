import { isClassifiedLead, isSalesLost } from "../sales-logic";
import { countIcp, isIcpFit, type IcpClass, type IcpCounts } from "./icp";
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
};

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
  icp: IcpCounts;
};

function totals(records: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>, fx: MarketingFx): Totals {
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
    classes.push(attribution.get(record.dealId)?.icpClass ?? "UNSET");
  }
  return { ...out, icp: countIcp(classes) };
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
  cplUzs: number | null; costPerIcpFitUzs: number | null; costPerSqlUzs: number | null; costPerSaleUzs: number | null;
};

export function costMetrics(input: {
  spendUzs: number | null; leads: number; icpFit: number; sql: number; sales: number; revenueUzs: number | null;
}): CostMetrics {
  const cmc = ratioWhole(input.spendUzs, input.sales);
  return {
    cmcUzs: cmc,
    roas: ratio(input.revenueUzs, input.spendUzs),
    cplUzs: ratioWhole(input.spendUzs, input.leads),
    costPerIcpFitUzs: ratioWhole(input.spendUzs, input.icpFit),
    costPerSqlUzs: ratioWhole(input.spendUzs, input.sql),
    costPerSaleUzs: cmc,
  };
}

export type MarketingSummary = Totals & SpendTotals & CostMetrics & {
  attributedLeadCount: number; attributedSaleCount: number; attributedRevenueUzs: number | null;
  icpEvaluatedCount: number; icpFitCount: number; icpOtherCount: number; icpUnsetCount: number; icpFitRate: number | null;
  coverage: { campaignIdCoverage: number | null; adsetIdCoverage: number | null; adIdCoverage: number | null };
  /** False when a placement/landing filter is active: Meta daily spend has no such breakdown. */
  spendApplies: boolean;
};

export function buildSummary(input: {
  cohort: readonly OutcomeRecord[]; attribution: ReadonlyMap<string, AttributionView>;
  spend: readonly SpendRow[]; fx: MarketingFx; spendApplies?: boolean;
}): MarketingSummary {
  const spendApplies = input.spendApplies !== false;
  const all = totals(input.cohort, input.attribution, input.fx);
  const attributed = totals(input.cohort.filter((row) => isMetaAttributed(input.attribution.get(row.dealId))), input.attribution, input.fx);
  const spend = spendApplies ? spendTotals(input.spend, input.fx) : { spendByCurrency: {}, spendUzs: null, impressions: 0, clicks: 0 };
  const attributedRevenueUzs = attributed.revenueUzsComplete ? attributed.revenueUzs : null;
  const share = (predicate: (view: AttributionView | undefined) => boolean) =>
    all.leadCount ? input.cohort.filter((row) => predicate(input.attribution.get(row.dealId))).length / all.leadCount : null;
  return {
    ...all,
    ...spend,
    ...costMetrics({
      spendUzs: spend.spendUzs, leads: attributed.leadCount, icpFit: attributed.icp.fit, sql: attributed.sqlCount,
      sales: attributed.saleCount, revenueUzs: attributedRevenueUzs,
    }),
    attributedLeadCount: attributed.leadCount,
    attributedSaleCount: attributed.saleCount,
    attributedRevenueUzs,
    icpEvaluatedCount: all.icp.evaluated, icpFitCount: all.icp.fit, icpOtherCount: all.icp.other,
    icpUnsetCount: all.icp.unset, icpFitRate: all.icp.fitRate,
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
  icpEvaluatedCount: number; icpFitCount: number; icpUnsetCount: number; icpFitRate: number | null;
  sqlCount: number; inPipelineCount: number; saleCount: number;
  revenueUzs: number | null; spendUzs: number | null; spendByCurrency: Record<string, number>;
  impressions: number; clicks: number;
} & CostMetrics;

/** Spend has these levels; placement and landing come from leads only. */
const SPEND_LEVELS = new Set<EntityLevel>(["campaign", "adset", "ad", "creative"]);

export function buildEntities(input: {
  level: EntityLevel; cohort: readonly OutcomeRecord[]; attribution: ReadonlyMap<string, AttributionView>;
  spend: readonly SpendRow[]; fx: MarketingFx; spendApplies?: boolean;
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
    const counts = totals(entry.records, input.attribution, input.fx);
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
      icpEvaluatedCount: counts.icp.evaluated, icpFitCount: counts.icp.fit, icpUnsetCount: counts.icp.unset, icpFitRate: counts.icp.fitRate,
      sqlCount: counts.sqlCount, inPipelineCount: counts.inPipelineCount, saleCount: counts.saleCount,
      revenueUzs, spendUzs: spend.spendUzs, spendByCurrency: spend.spendByCurrency,
      impressions: spend.impressions, clicks: spend.clicks,
      ...costMetrics({ spendUzs: spend.spendUzs, leads: counts.leadCount, icpFit: counts.icp.fit, sql: counts.sqlCount, sales: counts.saleCount, revenueUzs }),
    });
  }
  return rows.sort((a, b) => (b.spendUzs ?? 0) - (a.spendUzs ?? 0) || b.leadCount - a.leadCount || a.id.localeCompare(b.id));
}

export type DealMetric = "lead" | "icp_fit" | "icp_other" | "icp_unset" | "sql" | "pipeline" | "sale";
export const DEAL_METRICS: readonly DealMetric[] = ["lead", "icp_fit", "icp_other", "icp_unset", "sql", "pipeline", "sale"];

export function dealsForMetric(metric: DealMetric, cohort: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>) {
  return cohort.filter((record) => {
    const outcome = dealOutcome(record);
    const icp = attribution.get(record.dealId)?.icpClass ?? "UNSET";
    if (metric === "lead") return true;
    if (metric === "icp_fit") return isIcpFit(icp);
    if (metric === "icp_other") return icp === "OTHER";
    if (metric === "icp_unset") return icp === "UNSET";
    if (metric === "sql") return outcome.sql;
    if (metric === "pipeline") return outcome.inPipeline;
    return outcome.sale;
  }).map((record) => {
    const view = attribution.get(record.dealId);
    const outcome = dealOutcome(record);
    return {
      dealId: record.dealId, title: record.title ?? null, createdAt: record.createdAt, bitrixUrl: record.bitrixUrl ?? null,
      stage: record.stage ?? null, stageId: record.stageId ?? null, assignedManagerId: record.assignedManagerId ?? null,
      ...outcome, opportunity: Number(record.opportunity ?? 0) || 0, currencyId: record.currencyId ?? null,
      icpClass: view?.icpClass ?? "UNSET",
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
export function icpByKey(cohort: readonly OutcomeRecord[], attribution: ReadonlyMap<string, AttributionView>, keyOf: (record: OutcomeRecord) => string) {
  const groups = new Map<string, IcpClass[]>();
  for (const record of cohort) {
    const key = keyOf(record);
    const list = groups.get(key) ?? [];
    list.push(attribution.get(record.dealId)?.icpClass ?? "UNSET");
    groups.set(key, list);
  }
  return [...groups].map(([key, classes]) => ({ key, ...countIcp(classes) })).sort((a, b) => b.evaluated - a.evaluated || a.key.localeCompare(b.key));
}
