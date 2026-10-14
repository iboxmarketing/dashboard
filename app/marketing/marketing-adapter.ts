import { SALES_PROJECTS } from "@/lib/sales-projects";
import {
  MARKETING_MANAGER_ICP, MARKETING_OPTIONS, MARKETING_ROWS, MARKETING_SUMMARIES,
  buildMarketingDealFixtures, creativeRows,
} from "./marketing-fixtures";
import type {
  CreativeRankingMetric, CreativeRankingRow, MarketingDataAdapter, MarketingDealRequest,
  MarketingEntityRow, MarketingSnapshotRequest,
} from "./marketing-types";

const rankValue = (row: CreativeRankingRow, metric: CreativeRankingMetric) => {
  if (metric === "SALES") return row.sales;
  if (metric === "ICP_FIT_RATE") return row.icpFitRate;
  if (metric === "SQL") return row.sql;
  if (metric === "ROAS") return row.roas ?? -1;
  return row.cmc ?? Number.POSITIVE_INFINITY;
};

/**
 * The only data dependency used by the Marketing UI in V1.
 * Replace this object with an HTTP implementation once the backend contract is
 * available; presentation components do not import fixture files directly.
 */
export const fixtureMarketingAdapter: MarketingDataAdapter = {
  getSnapshot(request: MarketingSnapshotRequest) {
    const allRows = MARKETING_ROWS[request.project];
    const rows = allRows.filter((item) => item.level === request.level && (!request.parentId || item.parentId === request.parentId));
    return {
      project: request.project,
      projectName: SALES_PROJECTS[request.project].name,
      dataAsOf: "2026-10-14T09:00:00+05:00",
      fixture: true,
      summary: MARKETING_SUMMARIES[request.project],
      options: MARKETING_OPTIONS[request.project],
      rows,
    };
  },

  getDeals(request: MarketingDealRequest) {
    const seed: Partial<ReturnType<typeof buildMarketingDealFixtures>[number]> = {
      campaign: request.entity?.campaignName ?? request.entity?.name,
      adSet: request.entity?.adSetName ?? undefined,
      ad: request.entity?.level === "AD" ? request.entity.name : undefined,
      platform: request.entity?.platform,
      marketingSource: request.entity?.marketingSource,
      icp: request.icpSegment,
    };
    const defined = Object.fromEntries(Object.entries(seed).filter(([, value]) => value !== undefined));
    return buildMarketingDealFixtures(request.project, request.expectedCount, defined);
  },

  getCreativeRanking(project, metric) {
    const rows = creativeRows(project);
    return [...rows].sort((left, right) => metric === "CMC"
      ? rankValue(left, metric) - rankValue(right, metric)
      : rankValue(right, metric) - rankValue(left, metric));
  },

  getManagerIcp(project) {
    return MARKETING_MANAGER_ICP[project];
  },
};

export const marketingOverviewSummary = (project: MarketingSnapshotRequest["project"]) => MARKETING_SUMMARIES[project];

export function nextMarketingLevel(row: MarketingEntityRow) {
  if (row.level === "CAMPAIGN") return "AD_SET" as const;
  if (row.level === "AD_SET") return "AD" as const;
  return null;
}
