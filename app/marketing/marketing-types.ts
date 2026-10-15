import type { MarketingWorkspaceKey } from "./marketing-workspaces";
import type { ProjectKey } from "@/lib/sales-projects";

/**
 * UI-side Marketing contract. Counts, rates, money and outcome membership are
 * supplied by an adapter. Components only format, sort and select these values.
 */
export type MarketingEntityLevel = "campaign" | "adset" | "ad" | "creative" | "placement" | "landing";
export type MarketingCostStatus =
  | "AVAILABLE"
  | "NO_SALES"
  | "NO_SPEND"
  | "META_NOT_CONNECTED"
  | "NOT_INGESTED"
  | "PENDING"
  | "CURRENCY_UNAVAILABLE"
  | "NOT_APPLICABLE";
export type MarketingCapabilities = { icp: boolean };
export type IcpSegment = "P1" | "P2" | "P3" | "OTHER" | "UNSET" | string;
export type MarketingMetric = "lead" | "icp_fit" | "icp_other" | "icp_unset" | "sql" | "pipeline" | "sale";
export type CreativeRankingMetric = "SALES" | "ICP_FIT_RATE" | "SQL" | "ROAS" | "CMC";

export type MarketingFilters = {
  range: "7" | "30" | "month" | "lastMonth" | "custom";
  startDate: string;
  endDate: string;
  source: string;
  /** UI-only until the backend contract accepts a platform dimension. */
  platform: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  placement: string;
  landing: string;
};

export type MarketingQueryContext = {
  workspace: MarketingWorkspaceKey;
  filters: MarketingFilters;
  /**
   * meta (default): the Marketing page — Meta-attributed Deals of this workspace, the
   * population its spend comes from. workspace: every CRM Lead (Overview, Managers), no cost ratios.
   */
  scope?: "meta" | "workspace";
};

export type MarketingOption = { id: string; name: string };
export type MarketingFilterOptions = {
  marketingSources: MarketingOption[];
  platforms: MarketingOption[];
  campaigns: MarketingOption[];
  adSets: MarketingOption[];
  ads: MarketingOption[];
  placements: MarketingOption[];
  landingForms: MarketingOption[];
};

export const EMPTY_MARKETING_OPTIONS: MarketingFilterOptions = {
  marketingSources: [], platforms: [], campaigns: [], adSets: [], ads: [], placements: [], landingForms: [],
};

export type MarketingCosts = {
  status: MarketingCostStatus;
  message: string | null;
  currency: string;
  spend: number | null;
  cpl: number | null;
  costPerIcp: number | null;
  costPerSql: number | null;
  cmc: number | null;
  roas: number | null;
};

export type MarketingFunnelMetrics = {
  leadCount: number;
  classifiedCount: number;
  /** Saralangan ÷ Lead, 0..1, supplied by the API. */
  classifiedRate: number | null;
  /** ICP evaluated ÷ Lead, 0..1, supplied by the API where ICP applies. */
  icpEvaluationShare: number | null;
  icpEvaluatedCount: number | null;
  icpFitCount: number | null;
  icpOtherCount: number | null;
  icpUnsetCount: number | null;
  /** Ratio in the 0..1 range. */
  icpFitRate: number | null;
  sqlCount: number;
  /** SQL ÷ Saralangan, 0..1, supplied by the API. */
  sqlRate: number | null;
  pipelineCount: number;
  saleCount: number;
  /** Sale ÷ SQL, 0..1, supplied by the API. */
  sqlToSaleRate: number | null;
  revenue: number | null;
};

export type IcpBreakdownRow = {
  segment: IcpSegment;
  metric: Extract<MarketingMetric, "icp_fit" | "icp_other" | "icp_unset">;
  label: string;
  meaning: "Mos" | "Mos emas" | "Belgilanmagan";
  count: number;
};

export type IcpBreakdown = {
  icpEvaluatedCount: number;
  icpFitCount: number;
  icpOtherCount: number;
  icpUnsetCount: number;
  /** Ratio in the 0..1 range. */
  icpFitRate: number | null;
  rows: IcpBreakdownRow[];
};

export type MarketingSummary = MarketingFunnelMetrics & {
  workspace: MarketingWorkspaceKey;
  costs: MarketingCosts;
  coverage: { campaignIdCoverage: number | null; adsetIdCoverage: number | null; adIdCoverage: number | null };
};

export type MarketingEntityRow = MarketingFunnelMetrics & {
  id: string;
  level: MarketingEntityLevel;
  parentId: string | null;
  name: string;
  secondary: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  adId: string | null;
  platform: string;
  placement: string | null;
  landingId: string | null;
  landingLabel: string | null;
  landingType: "WEBSITE" | "INSTANT_FORM" | "UNKNOWN" | null;
  marketingSource: string;
  costs: MarketingCosts;
};

export type MarketingDealRow = {
  dealId: string;
  title: string;
  manager: string;
  currentStage: string;
  quality: string;
  icp: IcpSegment | "NOT_APPLICABLE";
  crmSource: string;
  marketingSource: string;
  platform: string;
  campaign: string;
  adSet: string;
  ad: string;
  createdAt: string;
  saleAt: string | null;
  revenue: number;
  currency: string;
  attributionConflict?: boolean;
  bitrixUrl?: string | null;
};

export type MarketingDealRequest = MarketingQueryContext & {
  metric: MarketingMetric;
  metricLabel: string;
  expectedCount?: number;
  entity: MarketingEntityRow | null;
};

export type MarketingManagerIcpRow = {
  managerId: string;
  managerName: string;
  evaluatedCount: number;
  fitCount: number;
  fitRate: number | null;
  unsetCount: number;
};

/** One spend bucket of the selected range (native minor units and whole UZS). */
export type MarketingSpendBucket = { ads: number; adDays: number; spendByCurrency: Record<string, number>; spendUzs: number | null };
export type MarketingSpendAttribution = {
  /** Spend reliably assigned to this workspace — the only spend in its CMC/ROAS. */
  assigned: MarketingSpendBucket; otherWorkspaces: MarketingSpendBucket;
  mixed: MarketingSpendBucket; unassigned: MarketingSpendBucket; nonDashboard: MarketingSpendBucket;
};
export type MarketingMetaStatus = {
  status: "AVAILABLE" | "NOT_INGESTED" | "PARTIAL_RANGE" | "NOT_BROKEN_DOWN";
  since: string | null; until: string | null; updatedAt: string | null; accounts: number;
};

/** How the workspace's CRM cohort splits into the Meta population and the rest (API-supplied). */
export type MarketingPopulation = {
  workspaceLeads: number; metaAttributedLeads: number; coverage: number | null;
  excluded: Record<"NO_META_IDS" | "CAMPAIGN_ONLY" | "CONFLICT" | "MIXED_AD" | "OTHER_WORKSPACE_AD" | "NON_DASHBOARD_AD" | "UNASSIGNED_AD", number>;
};

export type MarketingSummaryResponse = {
  scope: "meta" | "workspace";
  population: MarketingPopulation | null;
  workspace: MarketingWorkspaceKey;
  workspaceName: string;
  /** CRM (Bitrix) sync time — not the Meta data time. */
  dataAsOf: string | null;
  meta: MarketingMetaStatus | null;
  /** The Marketing reporting rate, never Finance FX. */
  usdToUzs: number | null;
  spendAttribution: MarketingSpendAttribution | null;
  fixture: boolean;
  capabilities: MarketingCapabilities;
  summary: MarketingSummary;
  options: MarketingFilterOptions;
};

export type MarketingEntitiesRequest = MarketingQueryContext & { level: MarketingEntityLevel };
export type MarketingEntitiesResponse = { workspace: MarketingWorkspaceKey; level: MarketingEntityLevel; rows: MarketingEntityRow[] };
export type MarketingDealsResponse = { workspace: MarketingWorkspaceKey; metric: MarketingMetric; count: number; deals: MarketingDealRow[]; truncated: boolean };

export type MarketingIcpResponse =
  | { status: "ENABLED"; workspace: MarketingWorkspaceKey; breakdown: IcpBreakdown; byManager: MarketingManagerIcpRow[] }
  | { status: "ICP_NOT_APPLICABLE"; workspace: MarketingWorkspaceKey };

export type MarketingCoverage = {
  deals: number;
  withCampaignId: number;
  withAdsetId: number;
  withAdId: number;
  metaInstantForm: number;
  website: number;
  otherSource: number;
  unknown: number;
  conflicts: number;
  notYetAttributed: number;
};

export type MarketingCoverageResponse = { workspace: MarketingWorkspaceKey; coverage: MarketingCoverage };

export interface MarketingDataAdapter {
  readonly source: "fixtures" | "http";
  getSummary(request: MarketingQueryContext, signal?: AbortSignal): Promise<MarketingSummaryResponse>;
  getEntities(request: MarketingEntitiesRequest, signal?: AbortSignal): Promise<MarketingEntitiesResponse>;
  getDeals(request: MarketingDealRequest, signal?: AbortSignal): Promise<MarketingDealsResponse>;
  getIcp(request: MarketingQueryContext, signal?: AbortSignal): Promise<MarketingIcpResponse>;
  getCoverage(request: MarketingQueryContext, signal?: AbortSignal): Promise<MarketingCoverageResponse>;
}

/** Legacy V1 fixture shapes. They stay behind FixtureMarketingAdapter only. */
export type FixtureMarketingFunnelMetrics = {
  leadCount: number; classifiedCount: number; icpEvaluatedCount: number; icpFitCount: number;
  icpOtherCount: number; icpUnsetCount: number; icpFitRate: number; sqlCount: number;
  sqlRate: number; pipelineCount: number; saleCount: number; sqlToSaleRate: number; revenue: number;
};
export type FixtureIcpBreakdownRow = { segment: "P1" | "P2" | "P3" | "OTHER" | "UNSET"; label: string; meaning: "Mos" | "Mos emas" | "Belgilanmagan"; count: number; share: number };
export type FixtureIcpBreakdown = Omit<IcpBreakdown, "icpFitRate" | "rows"> & { icpFitRate: number; rows: FixtureIcpBreakdownRow[] };
export type FixtureMarketingSummary = FixtureMarketingFunnelMetrics & { project: ProjectKey; costs: MarketingCosts; icp: FixtureIcpBreakdown };
export type FixtureMarketingEntityRow = FixtureMarketingFunnelMetrics & {
  id: string; level: "CAMPAIGN" | "AD_SET" | "AD" | "PLACEMENT" | "LANDING_FORM"; parentId: string | null;
  name: string; secondary: string | null; campaignId: string | null; campaignName: string | null;
  adSetId: string | null; adSetName: string | null; adId: string | null; platform: string;
  placement: string | null; landingId: string | null; landingLabel: string | null;
  landingType: "WEBSITE" | "INSTANT_FORM" | "UNKNOWN" | null; marketingSource: string; costs: MarketingCosts;
};
export type FixtureMarketingDealRow = Omit<MarketingDealRow, "icp"> & { icp: "P1" | "P2" | "P3" | "OTHER" | "UNSET" };
export type FixtureCreativeRankingRow = { adId: string; adName: string; campaignName: string; sales: number; icpFitRate: number; sql: number; roas: number | null; cmc: number | null; costStatus: MarketingCostStatus; currency: string };
export type FixtureMarketingManagerIcpRow = { managerId: string; managerName: string; evaluatedCount: number; fitCount: number; fitRate: number; unsetCount: number };
