import { defaultSettings } from "./business-time";
import { resolveDashboardMetricIds } from "./dashboard-metrics";
import { stageIdList } from "./stage-config";
import type { DashboardSettings } from "./types";

/**
 * Guarantees every collection Settings iterates over actually exists.
 *
 * The server normalises what it stores, but a legacy row, a partial API
 * response or a hand-edited setting can still arrive with a missing array — and
 * a single `.map` on `undefined` blanks the whole React app. Normalising once
 * at the boundary means no view needs defensive guards.
 */
export function normalizeSettings(raw: Partial<DashboardSettings> | null | undefined): DashboardSettings {
  const source = raw ?? {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [String(key), String(item)]))
      : {};

  return {
    ...defaultSettings,
    ...source,
    timezone: source.timezone || defaultSettings.timezone,
    schedule: { ...defaultSettings.schedule, ...(source.schedule ?? {}) },
    holidays: strings(source.holidays),
    selectedPipelineIds: strings(source.selectedPipelineIds),
    selectedPipelineNames: strings(source.selectedPipelineNames),
    postSalePipelineIds: strings(source.postSalePipelineIds),
    postSalePipelineNames: strings(source.postSalePipelineNames),
    qualifiedStageIds: stageIdList(source.qualifiedStageIds),
    lowQualityStageIds: stageIdList(source.lowQualityStageIds),
    paymentStageIds: stageIdList(source.paymentStageIds),
    closedLostStageIds: stageIdList(source.closedLostStageIds),
    routingReasonPatterns: strings(source.routingReasonPatterns),
    failureReasonFieldByPipeline: record(source.failureReasonFieldByPipeline),
    stageLimits: Object.fromEntries(
      Object.entries(record(source.stageLimits)).map(([key, value]) => [key, Number(value) || defaultSettings.defaultStageLimitHours]),
    ),
    dashboardMetricIds: resolveDashboardMetricIds(source.dashboardMetricIds),
  };
}
