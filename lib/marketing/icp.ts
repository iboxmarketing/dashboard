/**
 * ICP fit — the "ICP ga moslik" Deal field (owner rule, 2026-10-14).
 *
 *   P1 (Оптовик), P2 (Импортер), P3 (Retail)  → P1 / P2 / P3   ICP fit
 *   Other                                      → OTHER          not fit
 *   empty                                      → UNSET          not evaluated
 *
 * Bitrix returns the enum option ID. It is resolved to its label through the
 * field's own metadata (the sync's option map) — never through hard-coded
 * numeric IDs — and the label decides the class. The raw ID is kept as evidence.
 *
 * ICP_FIT_RATE = fit / evaluated, where evaluated = P1+P2+P3+OTHER. UNSET is
 * reported but never enters the denominator.
 */
export type IcpClass = "P1" | "P2" | "P3" | "OTHER" | "UNSET";

export const ICP_FIT_CLASSES: readonly IcpClass[] = ["P1", "P2", "P3"];

export type IcpReading = { raw: string | null; label: string | null; icpClass: IcpClass };

/** A label to its class. An unrecognised non-empty label is OTHER: evaluated, not fit. */
export function icpClassFromLabel(label: string | null | undefined): IcpClass {
  const text = String(label ?? "").trim();
  if (!text) return "UNSET";
  const tier = /^p\s*([123])\b/i.exec(text);
  if (tier) return `P${tier[1]}` as IcpClass;
  return "OTHER";
}

export function readIcp(raw: unknown, options: Map<string, string> | undefined): IcpReading {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = value === null || value === undefined ? "" : String(value).trim();
  if (!id || id === "0") return { raw: null, label: null, icpClass: "UNSET" };
  const label = options?.get(id) ?? null;
  // An option ID the metadata does not know is evidence of SOMETHING chosen, but
  // not of what: it is kept raw and counted UNSET rather than guessed into a tier.
  if (!label) return { raw: id, label: null, icpClass: /^\d+$/.test(id) ? "UNSET" : icpClassFromLabel(id) };
  return { raw: id, label, icpClass: icpClassFromLabel(label) };
}

export function isIcpFit(icpClass: IcpClass | null | undefined) { return icpClass === "P1" || icpClass === "P2" || icpClass === "P3"; }
export function isIcpEvaluated(icpClass: IcpClass | null | undefined) { return isIcpFit(icpClass) || icpClass === "OTHER"; }

export type IcpCounts = { evaluated: number; fit: number; p1: number; p2: number; p3: number; other: number; unset: number; fitRate: number | null };

export function countIcp(classes: readonly (IcpClass | null | undefined)[]): IcpCounts {
  const counts = { evaluated: 0, fit: 0, p1: 0, p2: 0, p3: 0, other: 0, unset: 0 };
  for (const value of classes) {
    if (value === "P1") counts.p1 += 1;
    else if (value === "P2") counts.p2 += 1;
    else if (value === "P3") counts.p3 += 1;
    else if (value === "OTHER") counts.other += 1;
    else counts.unset += 1;
  }
  counts.fit = counts.p1 + counts.p2 + counts.p3;
  counts.evaluated = counts.fit + counts.other;
  return { ...counts, fitRate: counts.evaluated ? counts.fit / counts.evaluated : null };
}
