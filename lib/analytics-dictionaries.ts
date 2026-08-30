/**
 * Turns cached Bitrix dictionary rows into the lookup maps
 * `buildAnalyticsRecords` expects.
 *
 * Shared by the sync's analytics step and the analytics-only backfill so both
 * feed the record builder byte-identical inputs — a rebuild that derived stage
 * ordering or source names differently would silently produce different
 * `qualified` values from the same raw data.
 *
 * Pure: no D1, no Bitrix, no `cloudflare:workers` import, so it is directly
 * testable.
 */

export type CrmFieldOptionLike = { key: string; options: { id: string; value: string }[] };

function value(row: Record<string, unknown>, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined ? "" : String(raw);
}

export function buildUserMap(userRows: Record<string, unknown>[]) {
  return new Map(userRows.map((row) => [
    value(row, "ID"),
    [value(row, "NAME"), value(row, "LAST_NAME")].filter(Boolean).join(" ") || `Menejer #${value(row, "ID")}`,
  ]));
}

/**
 * Stage display names, source names, and the stage SORT plus its pipeline —
 * the last is what lets qualification recognise any stage downstream of the
 * configured SQL stage without ever reading a display name.
 */
export function buildStatusMaps(statusRows: Record<string, unknown>[]) {
  const stages = new Map<string, string>();
  const sources = new Map<string, string>();
  const stageMeta = new Map<string, { sort: number; categoryId: string }>();
  for (const status of statusRows) {
    const id = value(status, "STATUS_ID");
    const name = value(status, "NAME") || id;
    const entity = value(status, "ENTITY_ID");
    if (entity.startsWith("DEAL_STAGE")) {
      stages.set(id, name);
      stageMeta.set(id, { sort: Number(status.SORT ?? 0), categoryId: entity === "DEAL_STAGE" ? "0" : entity.replace("DEAL_STAGE_", "") });
    }
    if (entity === "SOURCE") sources.set(id, name);
  }
  return { stages, sources, stageMeta };
}

export function buildFieldOptionMap(crmFields: CrmFieldOptionLike[]) {
  return new Map(crmFields.map((field) => [field.key, new Map(field.options.map((option) => [option.id, option.value]))]));
}
