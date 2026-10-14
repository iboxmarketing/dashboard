import type { ProjectKey } from "@/lib/sales-projects";

/**
 * Marketing UI contract.
 *
 * Every count and rate is supplied by the adapter. Presentation components may
 * format these values, but must not derive funnel membership or business rates.
 */
export type MarketingEntityLevel = "CAMPAIGN" | "AD_SET" | "AD" | "PLACEMENT" | "LANDING_FORM";
export type MarketingCostStatus = "AVAILABLE" | "META_NOT_CONNECTED" | "PENDING" | "CURRENCY_UNAVAILABLE";
export type IcpSegment = "P1" | "P2" | "P3" | "OTHER" | "UNSET";
export type MarketingMetric = "LEAD" | "CLASSIFIED" | "ICP_FIT" | "SQL" | "PIPELINE" | "SALE";
export type CreativeRankingMetric = "SALES" | "ICP_FIT_RATE" | "SQL" | "ROAS" | "CMC";

export type MarketingFilters = {
  range: "7" | "30" | "month" | "lastMonth" | "custom";
  from: string;
  to: string;
  marketingSource: string;
  platform: string;
  campaignId: string;
  adSetId: string;
  adId: string;
  placement: string;
  landingId: string;
};

export const EMPTY_MARKETING_FILTERS: MarketingFilters = {
  range: "30",
  from: "",
  to: "",
  marketingSource: "",
  platform: "",
  campaignId: "",
  adSetId: "",
  adId: "",
  placement: "",
  landingId: "",
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
  icpEvaluatedCount: number;
  icpFitCount: number;
  icpOtherCount: number;
  icpUnsetCount: number;
  icpFitRate: number;
  sqlCount: number;
  sqlRate: number;
  pipelineCount: number;
  saleCount: number;
  sqlToSaleRate: number;
  revenue: number;
};

export type IcpBreakdownRow = {
  segment: IcpSegment;
  label: string;
  meaning: "Mos" | "Mos emas" | "Belgilanmagan";
  count: number;
  share: number;
};

export type IcpBreakdown = {
  icpEvaluatedCount: number;
  icpFitCount: number;
  icpOtherCount: number;
  icpUnsetCount: number;
  icpFitRate: number;
  rows: IcpBreakdownRow[];
};

export type MarketingSummary = MarketingFunnelMetrics & {
  project: ProjectKey;
  costs: MarketingCosts;
  icp: IcpBreakdown;
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
  icp: IcpSegment;
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
};

export type MarketingDealRequest = {
  project: ProjectKey;
  metric: MarketingMetric | "ICP_SEGMENT";
  metricLabel: string;
  expectedCount: number;
  filters: MarketingFilters;
  entity: MarketingEntityRow | null;
  icpSegment?: IcpSegment;
};

export type CreativeRankingRow = {
  adId: string;
  adName: string;
  campaignName: string;
  sales: number;
  icpFitRate: number;
  sql: number;
  roas: number | null;
  cmc: number | null;
  costStatus: MarketingCostStatus;
  currency: string;
};

export type MarketingManagerIcpRow = {
  managerId: string;
  managerName: string;
  evaluatedCount: number;
  fitCount: number;
  fitRate: number;
  unsetCount: number;
};

export type MarketingSnapshot = {
  project: ProjectKey;
  projectName: string;
  dataAsOf: string;
  fixture: boolean;
  summary: MarketingSummary;
  options: MarketingFilterOptions;
  rows: MarketingEntityRow[];
};

export type MarketingSnapshotRequest = {
  project: ProjectKey;
  filters: MarketingFilters;
  level: MarketingEntityLevel;
  parentId: string | null;
};

export interface MarketingDataAdapter {
  getSnapshot(request: MarketingSnapshotRequest): MarketingSnapshot;
  getDeals(request: MarketingDealRequest): MarketingDealRow[];
  getCreativeRanking(project: ProjectKey, metric: CreativeRankingMetric): CreativeRankingRow[];
  getManagerIcp(project: ProjectKey): MarketingManagerIcpRow[];
}
