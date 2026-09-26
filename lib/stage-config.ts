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
  /**
   * The stage a Deal lands in when it is distributed to a seller — "РАСПРЕДЕЛЁННЫЕ
   * СДЕЛКИ" on production. The SLA clock starts when a Deal enters it and stops on
   * the first move out of it. Left empty, the funnel's own first stage (lowest
   * Bitrix SORT) is used, so a new funnel needs no configuration.
   */
  distributionStageIds?: string[];
  /**
   * Stages whose closure means "the client is real, our programme does not fit"
   * — neither a marketing-quality rejection nor a seller's failure to close
   * (owner decision, 2026-09-24). Configured per stage id only: a product-fit
   * outcome is a business judgement about a stage, never guessed from its name.
   */
  productFitStageIds?: string[];
};

/**
 * The stage the owner classified as a product-fit outcome (2026-09-24):
 * "Klient lekin programma nepodxodit". Named here so the default configuration
 * and the tests refer to one constant instead of repeating the id.
 */
export const PRODUCT_FIT_STAGE = "C3:UC_FKITQ2";

/** Normalises a stored/posted stage-id list: strings, de-duplicated, no blanks. */
export function stageIdList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
}

export function hasConfiguredStage(ids: string[] | undefined, stageId: string) {
  return Boolean(stageId) && Boolean(ids?.includes(stageId));
}

/** The semantics every funnel must configure; readiness is measured against these. */
export const STAGE_SEMANTIC_GROUPS = [
  { key: "lowQualityStageIds", label: "Not Relevant" },
  { key: "paymentStageIds", label: "Sotuv / To‘lov" },
  { key: "closedLostStageIds", label: "Sotilmadi" },
  { key: "qualifiedStageIds", label: "SQL" },
] as const;

/**
 * Optional semantics: a funnel may simply not have such a stage, so an empty list
 * is a valid configuration and never counts as "not ready". They still take part
 * in conflict detection, because one stage id may only mean one thing.
 */
export const OPTIONAL_STAGE_SEMANTIC_GROUPS = [
  { key: "productFitStageIds", label: "Programma mos emas" },
  { key: "distributionStageIds", label: "Taqsimlangan (SLA boshlanishi)" },
] as const;

/**
 * The stage where the SLA clock starts for one funnel.
 *
 * Configuration wins; otherwise it is the funnel's first stage by Bitrix SORT,
 * which is what "distributed" means in every Bitrix Sales funnel. Never a name
 * match: the label is editable, the id and the SORT are not.
 */
export function distributionStageId(
  categoryId: string,
  stageMeta: Map<string, StageMeta> | undefined,
  config: StageSemantics = {},
) {
  const configured = stageIdList(config.distributionStageIds)
    .find((stageId) => !stageMeta || (stageMeta.get(stageId)?.categoryId ?? categoryId) === categoryId);
  if (configured) return configured;
  if (!stageMeta) return "";
  let best = ""; let bestSort = Number.POSITIVE_INFINITY;
  for (const [stageId, meta] of stageMeta) {
    if (meta.categoryId !== categoryId) continue;
    if (meta.sort < bestSort) { best = stageId; bestSort = meta.sort; }
  }
  return best;
}

/**
 * Stage ids configured into more than one semantic group. Classification still
 * resolves them deterministically (LOW_QUALITY wins), but the configuration is
 * almost certainly a mistake and is surfaced in Settings.
 */
export function stageConfigConflicts(config: StageSemantics) {
  const groupsByStage = new Map<string, string[]>();
  for (const group of [...STAGE_SEMANTIC_GROUPS, ...OPTIONAL_STAGE_SEMANTIC_GROUPS]) {
    for (const stageId of stageIdList(config[group.key])) {
      groupsByStage.set(stageId, [...(groupsByStage.get(stageId) ?? []), group.label]);
    }
  }
  return [...groupsByStage.entries()]
    .filter(([, groups]) => groups.length > 1)
    .map(([stageId, groups]) => ({ stageId, groups }));
}

/**
 * Live stage dictionary entry: Bitrix SORT, the pipeline it belongs to, and
 * Bitrix's own SEMANTICS (`S` won, `F` failed, empty for a process stage).
 * The semantics travel with the stage so a caller walking a stage timeline — which
 * carries no semantics of its own — can still tell a failure stage apart.
 */
export type StageMeta = { sort: number; categoryId: string; semantics?: string };

/**
 * Lowest configured SQL-stage SORT per pipeline — the qualification threshold.
 *
 * Any stage at or beyond it, in the same pipeline, proves the lead was accepted:
 * a seller does not have to physically pass through Обработка. Thresholds are
 * per pipeline because IBOX and SD order their stages independently.
 */
export function sqlThresholdsByCategory(
  qualifiedStageIds: string[] | undefined,
  stageMeta: Map<string, StageMeta> | undefined,
) {
  const thresholds = new Map<string, number>();
  if (!stageMeta) return thresholds;
  for (const stageId of stageIdList(qualifiedStageIds)) {
    const meta = stageMeta.get(stageId);
    if (!meta) continue;
    const current = thresholds.get(meta.categoryId);
    if (current === undefined || meta.sort < current) thresholds.set(meta.categoryId, meta.sort);
  }
  return thresholds;
}
