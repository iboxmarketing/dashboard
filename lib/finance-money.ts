import { CURRENCIES, CURRENCY_MINOR_UNITS, type Currency, type MoneyByCurrency } from "./finance-types";

/**
 * Per-currency money arithmetic.
 *
 * The one place amounts are added. Every function here is keyed by currency and
 * there is deliberately no "grand total" helper: a single number across UZS and
 * USD would be arithmetic on incompatible units, and showing one to an owner
 * would be worse than showing nothing. `formatMoney` renders one currency at a
 * time for the same reason.
 *
 * Sums run in integer minor units so 0.1 + 0.2 cannot drift.
 */

const minor = (currency: Currency) => CURRENCY_MINOR_UNITS[currency] ?? 100;

export function addMoney(into: MoneyByCurrency, currency: Currency, amount: number): MoneyByCurrency {
  if (!Number.isFinite(amount)) return into;
  const units = minor(currency);
  const cents = Math.round((into[currency] ?? 0) * units) + Math.round(amount * units);
  return { ...into, [currency]: cents / units };
}

/** Folds `{amount, currency}` rows into a per-currency map. */
export function sumByCurrency<T>(rows: readonly T[], pick: (row: T) => { amount: number; currency: Currency } | null): MoneyByCurrency {
  let total: MoneyByCurrency = {};
  for (const row of rows) {
    const value = pick(row);
    if (!value) continue;
    total = addMoney(total, value.currency, value.amount);
  }
  return total;
}

/** `left - right`, per currency, keeping any currency present in either side. */
export function subtractByCurrency(left: MoneyByCurrency, right: MoneyByCurrency): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const currency of currenciesIn(left, right)) {
    const units = minor(currency);
    const cents = Math.round((left[currency] ?? 0) * units) - Math.round((right[currency] ?? 0) * units);
    out[currency] = cents / units;
  }
  return out;
}

/** Currencies present across the given maps, in the canonical display order. */
export function currenciesIn(...maps: readonly MoneyByCurrency[]): Currency[] {
  const present = new Set<Currency>();
  for (const map of maps) for (const currency of Object.keys(map) as Currency[]) present.add(currency);
  return CURRENCIES.filter((currency) => present.has(currency));
}

/** Drops zero entries so an untouched currency does not render as "0". */
export function nonZero(map: MoneyByCurrency): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const [currency, amount] of Object.entries(map) as [Currency, number][]) if (amount !== 0) out[currency] = amount;
  return out;
}

/**
 * One currency, one string. UZS has no meaningful minor unit in daily use, so it
 * renders whole; the others keep two decimals.
 */
export function formatMoney(amount: number, currency: Currency): string {
  const fractionDigits = currency === "UZS" ? 0 : 2;
  const shown = new Intl.NumberFormat("uz-UZ", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })
    .format(Number.isFinite(amount) ? amount : 0)
    .replace(/ /g, " ");
  return `${shown} ${currency}`;
}

/** Ordered `[currency, amount]` pairs for rendering one line per currency. */
export function moneyLines(map: MoneyByCurrency, { includeZero = false } = {}): { currency: Currency; amount: number; formatted: string }[] {
  const source = includeZero ? map : nonZero(map);
  return currenciesIn(source).map((currency) => ({
    currency, amount: source[currency] ?? 0, formatted: formatMoney(source[currency] ?? 0, currency),
  }));
}
