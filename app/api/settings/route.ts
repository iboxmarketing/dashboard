import { defaultSettings } from "@/lib/business-time";
import { getSettings, saveSettings } from "@/lib/storage";
import { stageIdList } from "@/lib/stage-config";
import type { DashboardSettings } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const current = await getSettings();
    const payload = (await request.json()) as Partial<DashboardSettings>;
    const next: DashboardSettings = {
      ...defaultSettings,
      ...current,
      ...payload,
      schedule: { ...current.schedule, ...(payload.schedule ?? {}) },
      timezone: "Asia/Tashkent",
      slaMinutes: Math.min(240, Math.max(1, Number(payload.slaMinutes ?? current.slaMinutes))),
      historyDays: Math.min(365, Math.max(1, Number(payload.historyDays ?? current.historyDays))),
      holidays: Array.isArray(payload.holidays) ? payload.holidays.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) : current.holidays,
      selectedPipelineIds: Array.isArray(payload.selectedPipelineIds) ? [...new Set(payload.selectedPipelineIds.map(String))].slice(0, 2) : current.selectedPipelineIds,
      selectedPipelineNames: Array.isArray(payload.selectedPipelineNames) ? [...new Set(payload.selectedPipelineNames.map(String))].slice(0, 2) : current.selectedPipelineNames,
      postSalePipelineIds: Array.isArray(payload.postSalePipelineIds) ? [...new Set(payload.postSalePipelineIds.map(String))].slice(0, 2) : current.postSalePipelineIds,
      postSalePipelineNames: Array.isArray(payload.postSalePipelineNames) ? [...new Set(payload.postSalePipelineNames.map(String))].slice(0, 2) : current.postSalePipelineNames,
      failureReasonField: typeof payload.failureReasonField === "string" && payload.failureReasonField ? payload.failureReasonField : null,
      marketingChannelField: typeof payload.marketingChannelField === "string" && payload.marketingChannelField ? payload.marketingChannelField : null,
      salesManagerField: typeof payload.salesManagerField === "string" && payload.salesManagerField ? payload.salesManagerField : null,
      defaultStageLimitHours: Math.min(720, Math.max(1, Number(payload.defaultStageLimitHours ?? current.defaultStageLimitHours))),
      stageLimits: payload.stageLimits && typeof payload.stageLimits === "object" ? Object.fromEntries(Object.entries(payload.stageLimits).map(([key, value]) => [key, Math.min(720, Math.max(1, Number(value))) ])) : current.stageLimits,
      qualifiedStageIds: Array.isArray(payload.qualifiedStageIds) ? stageIdList(payload.qualifiedStageIds) : current.qualifiedStageIds,
      lowQualityStageIds: Array.isArray(payload.lowQualityStageIds) ? stageIdList(payload.lowQualityStageIds) : current.lowQualityStageIds,
      paymentStageIds: Array.isArray(payload.paymentStageIds) ? stageIdList(payload.paymentStageIds) : current.paymentStageIds,
      closedLostStageIds: Array.isArray(payload.closedLostStageIds) ? stageIdList(payload.closedLostStageIds) : current.closedLostStageIds,
      routingReasonPatterns: Array.isArray(payload.routingReasonPatterns) ? [...new Set(payload.routingReasonPatterns.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 30) : current.routingReasonPatterns,
      autoSyncMinutes: [0, 10, 15, 30, 60].includes(Number(payload.autoSyncMinutes)) ? Number(payload.autoSyncMinutes) : current.autoSyncMinutes,
    };
    await saveSettings(next);
    return Response.json({ settings: next });
  } catch {
    return Response.json({ error: "Sozlamalarni saqlab bo‘lmadi" }, { status: 400 });
  }
}
