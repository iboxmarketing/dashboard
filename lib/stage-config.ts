/**
 * Stage-ID based semantic configuration.
 *
 * Bitrix STAGE_IDs are stable while stage NAMES are editable, so an id is the
 * only trustworthy signal for what a stage means. Name matching is kept as a
 * backward-compatible fallback: an empty list means "behave exactly as before".
 *
 * No production stage id is ever hard-coded here — the lists are configured by
 * the product owner in Settings and stored as JSON in `app_settings`.
 */
export type StageSemantics = {
  lowQualityStageIds?: string[];
  paymentStageIds?: string[];
  closedLostStageIds?: string[];
  qualifiedStageIds?: string[];
};

/** Normalises a stored/posted stage-id list: strings, de-duplicated, no blanks. */
export function stageIdList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
}

export function hasConfiguredStage(ids: string[] | undefined, stageId: string) {
  return Boolean(stageId) && Boolean(ids?.includes(stageId));
}

export const STAGE_SEMANTIC_GROUPS = [
  { key: "lowQualityStageIds", label: "Not Relevant" },
  { key: "paymentStageIds", label: "Sotuv / To‘lov" },
  { key: "closedLostStageIds", label: "Sotilmadi" },
  { key: "qualifiedStageIds", label: "SQL" },
] as const;

/**
 * Stage ids configured into more than one semantic group. Classification still
 * resolves them deterministically (LOW_QUALITY wins), but the configuration is
 * almost certainly a mistake and is surfaced in Settings.
 */
export function stageConfigConflicts(config: StageSemantics) {
  const groupsByStage = new Map<string, string[]>();
  for (const group of STAGE_SEMANTIC_GROUPS) {
    for (const stageId of stageIdList(config[group.key])) {
      groupsByStage.set(stageId, [...(groupsByStage.get(stageId) ?? []), group.label]);
    }
  }
  return [...groupsByStage.entries()]
    .filter(([, groups]) => groups.length > 1)
    .map(([stageId, groups]) => ({ stageId, groups }));
}
