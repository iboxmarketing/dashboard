/**
 * Marketing money: integers only.
 *
 * Meta reports spend as a decimal STRING in the ad account's currency ("12.34").
 * It is parsed digit by digit into minor units (ISO 4217 exponent) — never
 * through a float — and stored as `spend_minor` + `currency`.
 *
 * The UZS view uses the owner's MARKETING rate (2026-10-14: 1 USD = 11,800 UZS),
 * a reporting setting, not Finance/accounting FX. Results are whole UZS (sum).
 * A currency without a rate is never converted: it stays native, and every
 * UZS-based ratio built on it is unavailable (null).
 */
const EXPONENT: Record<string, number> = { USD: 2, EUR: 2, UZS: 2, KZT: 2, RUB: 2, JPY: 0, KRW: 0 };

export function currencyExponent(currency: string) {
  return EXPONENT[currency.toUpperCase()] ?? 2;
}

/** "12.345" USD → 1235 (half-up at the exponent). Throws on anything but a plain decimal. */
export function decimalToMinor(amount: string | number, currency: string): number {
  const text = String(amount).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Not a decimal amount: ${JSON.stringify(text)}`);
  const exponent = currencyExponent(currency);
  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2];
  const fraction = (match[3] ?? "").padEnd(exponent + 1, "0");
  const kept = fraction.slice(0, exponent);
  const next = Number(fraction[exponent] ?? "0");
  let minor = BigInt(whole) * BigInt(10) ** BigInt(exponent) + BigInt(kept || "0");
  if (next >= 5) minor += BigInt(1);
  const value = Number(minor) * sign;
  if (!Number.isSafeInteger(value)) throw new Error("Amount exceeds the safe integer range");
  return value;
}

export type MarketingFx = { usdToUzs: number };

/** Owner decision 2026-10-14; read from the Marketing setting, never inlined in a metric. */
export const DEFAULT_MARKETING_USD_TO_UZS = 11_800;

/**
 * Minor units of `currency` → whole UZS, or null when no marketing rate exists.
 * USD: cents × rate / 100, exact in integers for an integer rate; half-up otherwise.
 */
export function minorToUzs(minor: number, currency: string, fx: MarketingFx): number | null {
  const code = currency.toUpperCase();
  const exponent = currencyExponent(code);
  let numerator: bigint;
  if (code === "UZS") numerator = BigInt(minor);
  else if (code === "USD" && Number.isSafeInteger(fx.usdToUzs) && fx.usdToUzs > 0) numerator = BigInt(minor) * BigInt(fx.usdToUzs);
  else return null;
  const divisor = BigInt(10) ** BigInt(exponent);
  const negative = numerator < BigInt(0);
  const magnitude = negative ? -numerator : numerator;
  let whole = magnitude / divisor;
  if ((magnitude % divisor) * BigInt(2) >= divisor) whole += BigInt(1);
  const value = Number(negative ? -whole : whole);
  if (!Number.isSafeInteger(value)) throw new Error("UZS amount exceeds the safe integer range");
  return value;
}

/** Whole UZS of a Deal's Opportunity: UZS as is, USD at the marketing rate, otherwise null. */
export function opportunityToUzs(opportunity: number, currency: string | null | undefined, fx: MarketingFx): number | null {
  const code = String(currency || "UZS").toUpperCase();
  if (!Number.isFinite(opportunity)) return null;
  const minor = decimalToMinor(opportunity.toFixed(currencyExponent(code)), code);
  return minorToUzs(minor, code, fx);
}

/** Integer division, half-up; null when the denominator is zero or anything is missing. */
export function ratioWhole(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || !denominator) return null;
  return Math.round(numerator / denominator);
}

/** A plain ratio (ROAS): null when the denominator is zero or missing. */
export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || !denominator) return null;
  return numerator / denominator;
}
