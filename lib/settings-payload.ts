import { defaultSettings } from "./business-time";
import { resolveDashboardMetricIds } from "./dashboard-metrics";
import { canonicalDealFieldKey } from "./crm-fields";
import { stageIdList } from "./stage-config";
import type { DashboardSettings } from "./types";

/**
 * Merge contract for PATCH-style settings writes.
 *
 * A production incident proved the old route treated an *absent* property as
 * an instruction to clear: `POST /api/settings {}` nulled `salesManagerField`,
 * `failureReasonField` and `marketingChannelField` in one call.
 *
 * The contract is now explicit and uniform:
 *
 *   absent / undefined  -> preserve the stored value
 *   null                -> clear, but only where the field is nullable
 *   value               -> validate, normalize, store
 *
 * An empty payload is therefore a safe no-op. Kept free of Cloudflare imports
 * so the whole merge is testable.
 */

const has = (payload: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(payload, key);

/** Nullable text field: absent preserves, explicit null clears, "" also clears. */
function nullableText(
  payload: Record<string, unknown>,
  key: string,
  current: string | null,
  normalize: (value: string) => string = (value) => value,
): string | null {
  if (!has(payload, key)) return current;
  const value = payload[key];
  if (value === null) return null;
  if (typeof value !== "string") return current;
  const trimmed = value.trim();
  return trimmed ? normalize(trimmed) : null;
}

/**
 * Numeric field clamped to a range. Absent, null or unparseable preserves —
 * these fields are not nullable, so `null` must not coerce to 0 and clamp.
 */
function boundedNumber(payload: Record<string, unknown>, key: string, current: number, min: number, max: number): number {
  if (!has(payload, key)) return current;
  const raw = payload[key];
  if (raw === null || raw === undefined || raw === "") return current;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : current;
}

/** Enumerated numeric choice; anything not on the list preserves. */
function enumeratedNumber(payload: Record<string, unknown>, key: string, current: number, allowed: number[]): number {
  if (!has(payload, key)) return current;
  const raw = payload[key];
  if (raw === null || raw === undefined || raw === "") return current;
  const value = Number(raw);
  return Number.isFinite(value) && allowed.includes(value) ? value : current;
}

function stringArray(payload: Record<string, unknown>, key: string, current: string[], limit = 2): string[] {
  if (!has(payload, key) || !Array.isArray(payload[key])) return current;
  return [...new Set((payload[key] as unknown[]).map(String))].slice(0, limit);
}

/**
 * @param current the stored settings; every field not named in `payload`
 *   survives this call unchanged.
 */
export function mergeSettingsPayload(current: DashboardSettings, raw: unknown): DashboardSettings {
  const payload = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const base: DashboardSettings = { ...defaultSettings, ...current };

  const schedule = has(payload, "schedule") && payload.schedule && typeof payload.schedule === "object" && !Array.isArray(payload.schedule)
    ? { ...base.schedule, ...(payload.schedule as DashboardSettings["schedule"]) }
    : base.schedule;

  return {
    ...base,
    schedule,
    // Fixed by product decision, never client-controlled.
    timezone: "Asia/Tashkent",

    slaMinutes: boundedNumber(payload, "slaMinutes", base.slaMinutes, 1, 240),
    historyDays: boundedNumber(payload, "historyDays", base.historyDays, 1, 365),
    defaultStageLimitHours: boundedNumber(payload, "defaultStageLimitHours", base.defaultStageLimitHours, 1, 720),

    holidays: has(payload, "holidays") && Array.isArray(payload.holidays)
      ? (payload.holidays as unknown[]).map(String).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      : base.holidays,

    selectedPipelineIds: stringArray(payload, "selectedPipelineIds", base.selectedPipelineIds),
    selectedPipelineNames: stringArray(payload, "selectedPipelineNames", base.selectedPipelineNames),
    postSalePipelineIds: stringArray(payload, "postSalePipelineIds", base.postSalePipelineIds),
    postSalePipelineNames: stringArray(payload, "postSalePipelineNames", base.postSalePipelineNames),

    // The three fields the incident cleared. Absent now preserves.
    failureReasonField: nullableText(payload, "failureReasonField", base.failureReasonField),
    marketingChannelField: nullableText(payload, "marketingChannelField", base.marketingChannelField),
    salesManagerField: nullableText(payload, "salesManagerField", base.salesManagerField),

    failureReasonFieldByPipeline: has(payload, "failureReasonFieldByPipeline")
      && payload.failureReasonFieldByPipeline && typeof payload.failureReasonFieldByPipeline === "object"
      ? Object.fromEntries(Object.entries(payload.failureReasonFieldByPipeline as Record<string, unknown>)
        .map(([key, value]) => [String(key), canonicalDealFieldKey(String(value))])
        .filter(([, value]) => Boolean(value)))
      : base.failureReasonFieldByPipeline,

    stageLimits: has(payload, "stageLimits") && payload.stageLimits && typeof payload.stageLimits === "object"
      ? Object.fromEntries(Object.entries(payload.stageLimits as Record<string, unknown>)
        .map(([key, value]) => [key, Math.min(720, Math.max(1, Number(value) || 1))]))
      : base.stageLimits,

    qualifiedStageIds: has(payload, "qualifiedStageIds") && Array.isArray(payload.qualifiedStageIds) ? stageIdList(payload.qualifiedStageIds) : base.qualifiedStageIds,
    lowQualityStageIds: has(payload, "lowQualityStageIds") && Array.isArray(payload.lowQualityStageIds) ? stageIdList(payload.lowQualityStageIds) : base.lowQualityStageIds,
    paymentStageIds: has(payload, "paymentStageIds") && Array.isArray(payload.paymentStageIds) ? stageIdList(payload.paymentStageIds) : base.paymentStageIds,
    closedLostStageIds: has(payload, "closedLostStageIds") && Array.isArray(payload.closedLostStageIds) ? stageIdList(payload.closedLostStageIds) : base.closedLostStageIds,

    routingReasonPatterns: has(payload, "routingReasonPatterns") && Array.isArray(payload.routingReasonPatterns)
      ? [...new Set((payload.routingReasonPatterns as unknown[]).map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 30)
      : base.routingReasonPatterns,

    autoSyncMinutes: enumeratedNumber(payload, "autoSyncMinutes", base.autoSyncMinutes, [0, 10, 15, 30, 60]),

    dashboardMetricIds: has(payload, "dashboardMetricIds") && Array.isArray(payload.dashboardMetricIds)
      ? resolveDashboardMetricIds(payload.dashboardMetricIds)
      : base.dashboardMetricIds,
  };
}
