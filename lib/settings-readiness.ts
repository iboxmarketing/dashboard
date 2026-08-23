import { stageConfigConflicts, type StageSemantics } from "./stage-config";
import type { DashboardSettings } from "./types";

/**
 * Settings readiness and Full Sync gating.
 *
 * Full Sync rebuilds a funnel's whole cohort, so it must not run while the
 * configuration that drives classification is incomplete or self-contradictory.
 * Kept pure so the gate is testable without a browser or a Cloudflare binding.
 *
 * This module reports on configuration only — it never changes what a metric
 * means.
 */

export type ReadinessTone = "ok" | "warning";

export type SettingsReadiness = {
  stages: { configured: number; total: number; missing: string[]; complete: boolean };
  conflicts: { count: number; stageIds: string[] };
  failureReason: { configured: number; total: number; missing: string[]; complete: boolean };
  pairing: { selected: number; paired: number; valid: boolean };
  historyDays: number;
  autoSync: { minutes: number; enabled: boolean };
  tone: ReadinessTone;
};

const STAGE_KEYS: { key: keyof StageSemantics; label: string }[] = [
  { key: "qualifiedStageIds", label: "SQL" },
  { key: "lowQualityStageIds", label: "Not Relevant" },
  { key: "paymentStageIds", label: "To‘lov / WON" },
  { key: "closedLostStageIds", label: "Sotilmadi" },
];

/**
 * @param pairedCount how many selected Sales funnels resolved a post-sale pair
 */
export function settingsReadiness(settings: DashboardSettings, pairedCount: number): SettingsReadiness {
  const missingStages = STAGE_KEYS.filter(({ key }) => !(settings[key] ?? []).length).map(({ label }) => label);
  const conflicts = stageConfigConflicts(settings);

  const selectedIds = settings.selectedPipelineIds ?? [];
  const names = settings.selectedPipelineNames ?? [];
  const missingReason = selectedIds
    .filter((id) => !settings.failureReasonFieldByPipeline?.[id])
    .map((id) => names[selectedIds.indexOf(id)] ?? id);

  const stages = {
    configured: STAGE_KEYS.length - missingStages.length,
    total: STAGE_KEYS.length,
    missing: missingStages,
    complete: missingStages.length === 0,
  };
  const failureReason = {
    configured: selectedIds.length - missingReason.length,
    total: selectedIds.length,
    missing: missingReason,
    complete: selectedIds.length > 0 && missingReason.length === 0,
  };
  const pairing = { selected: selectedIds.length, paired: pairedCount, valid: selectedIds.length >= 1 && pairedCount === selectedIds.length };

  return {
    stages,
    conflicts: { count: conflicts.length, stageIds: conflicts.map((conflict) => conflict.stageId) },
    failureReason,
    pairing,
    historyDays: settings.historyDays,
    autoSync: { minutes: settings.autoSyncMinutes, enabled: settings.autoSyncMinutes > 0 },
    tone: stages.complete && conflicts.length === 0 && failureReason.complete && pairing.valid ? "ok" : "warning",
  };
}

/**
 * Every condition that must hold before a Full Sync may be offered. Returned as
 * a list so the UI can say *why* the button is disabled rather than just
 * greying it out.
 */
export function fullSyncBlockers(readiness: SettingsReadiness): string[] {
  const blockers: string[] = [];
  if (!readiness.pairing.valid) blockers.push("Sales loyiha va post-sale funnel juftligi to‘liq emas");
  if (!readiness.stages.complete) blockers.push(`Bosqich ma’nolari to‘liq emas: ${readiness.stages.missing.join(", ")}`);
  if (readiness.conflicts.count > 0) blockers.push(`Bosqich konflikti: ${readiness.conflicts.count} ta bosqich bir nechta ma’noda`);
  if (!readiness.failureReason.complete) blockers.push("Proval sababi fieldi tanlanmagan");
  return blockers;
}

export function canFullSync(readiness: SettingsReadiness): boolean {
  return fullSyncBlockers(readiness).length === 0;
}

/** Confirmation text shown before a Full Sync — names what will be rebuilt. */
export function fullSyncConfirmation(funnelName: string, historyDays: number): string {
  return `${funnelName} uchun to‘liq qayta yuklash (full sync).\n\n`
    + `Oraliq: oxirgi ${historyDays} kun.\n`
    + "Bu funnel’ning shu oraliqdagi barcha ma’lumotlari Bitrix’dan qayta o‘qiladi va qayta hisoblanadi.\n\n"
    + "Davom etilsinmi?";
}

/** True when the user has edits that are not yet saved. */
export function isSettingsDirty(saved: DashboardSettings, draft: DashboardSettings): boolean {
  return JSON.stringify(sortDeep(saved)) !== JSON.stringify(sortDeep(draft));
}

/** Key order must not register as a change. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortDeep(item)]));
  }
  return value;
}
