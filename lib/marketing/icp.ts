/**
 * ICP fit — a per-workspace capability (owner rules, 2026-10-14/15).
 *
 * A workspace may define ICP: the Bitrix enum field, the option labels that are
 * a fit, and those that are not. Today only IBOX_UZ does:
 *
 *   field UF_CRM_1787725980192 "ICP ga moslik"
 *   P1 (Оптовик), P2 (Импортер), P3 (Retail)  → P1 / P2 / P3   FIT
 *   Other                                      → OTHER          NOT FIT
 *   empty                                      → UNSET          not evaluated
 *
 * Everywhere else ICP is NOT_APPLICABLE: no class, no rate, no "0%".
 *
 * Bitrix returns the enum option ID; it is resolved to its label through the
 * field's own metadata — never through hard-coded numeric IDs — and the label
 * decides the class. The raw ID is kept as evidence.
 *
 * ICP_FIT_RATE = fit / evaluated, evaluated = fit + not fit. UNSET is reported
 * separately and never enters the denominator.
 */
export type IcpConfig =
  | { enabled: true; fieldId: string; fitValues: readonly string[]; notFitValues: readonly string[] }
  | { enabled: false };

/** A fit tier (one of the config's fitValues, e.g. "P1"), OTHER (not fit), UNSET, or NOT_APPLICABLE. */
export type IcpClass = string;
export const ICP_NOT_FIT = "OTHER";
export const ICP_UNSET = "UNSET";
export const ICP_NOT_APPLICABLE = "NOT_APPLICABLE";

export type IcpReading = { raw: string | null; label: string | null; icpClass: IcpClass };

const normal = (text: string) => text.normalize("NFKC").trim().toLowerCase();

/** A label to its class under a config. An unlisted non-empty label is NOT FIT: evaluated, not fit. */
export function icpClassFromLabel(label: string | null | undefined, config: IcpConfig): IcpClass {
  if (!config.enabled) return ICP_NOT_APPLICABLE;
  const text = normal(String(label ?? ""));
  if (!text) return ICP_UNSET;
  // "P1 (Оптовик)" matches the fit value "P1"; the boundary stops "P10" matching "P1".
  const fit = config.fitValues.find((value) => text === normal(value) || new RegExp(`^${escape(normal(value))}(?![\\p{L}\\p{N}])`, "u").test(text));
  return fit ?? ICP_NOT_FIT;
}

function escape(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function readIcp(raw: unknown, options: Map<string, string> | undefined, config: IcpConfig): IcpReading {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = value === null || value === undefined ? "" : String(value).trim();
  if (!config.enabled) return { raw: id && id !== "0" ? id : null, label: null, icpClass: ICP_NOT_APPLICABLE };
  if (!id || id === "0") return { raw: null, label: null, icpClass: ICP_UNSET };
  const label = options?.get(id) ?? null;
  // An option ID the metadata does not know is evidence of SOMETHING chosen, but
  // not of what: it is kept raw and counted UNSET rather than guessed into a tier.
  if (!label) return { raw: id, label: null, icpClass: /^\d+$/.test(id) ? ICP_UNSET : icpClassFromLabel(id, config) };
  return { raw: id, label, icpClass: icpClassFromLabel(label, config) };
}

export function isIcpFit(icpClass: IcpClass | null | undefined, config: IcpConfig) {
  return config.enabled && Boolean(icpClass) && config.fitValues.includes(icpClass as string);
}

export type IcpCounts = { evaluated: number; fit: number; notFit: number; unset: number; byTier: Record<string, number>; fitRate: number | null };

/** Counts under an enabled config; null when ICP is not applicable — never zeros. */
export function countIcp(classes: readonly (IcpClass | null | undefined)[], config: IcpConfig): IcpCounts | null {
  if (!config.enabled) return null;
  const byTier = Object.fromEntries(config.fitValues.map((value) => [value, 0])) as Record<string, number>;
  let notFit = 0; let unset = 0;
  for (const value of classes) {
    if (value && value in byTier) byTier[value] += 1;
    else if (value === ICP_NOT_FIT) notFit += 1;
    else unset += 1;
  }
  const fit = Object.values(byTier).reduce((sum, count) => sum + count, 0);
  const evaluated = fit + notFit;
  return { evaluated, fit, notFit, unset, byTier, fitRate: evaluated ? fit / evaluated : null };
}
