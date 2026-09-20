import {
  addMinor, currencyDefinition, formatMinorAmount, parseMinorAmount,
  type FinanceMoneyDefinition,
} from "./finance/money";
import { CURRENCIES, type Currency, type FinanceCurrency, type MoneyByCurrency } from "./finance-types";

export type UiMoneyDefinition = Pick<FinanceCurrency, "code" | "minorUnit">;

function definition(value: Currency | UiMoneyDefinition): FinanceMoneyDefinition | null {
  const resolved = typeof value === "string" ? currencyDefinition(value) : value;
  return resolved && Number.isSafeInteger(resolved.minorUnit) && resolved.minorUnit >= 0 && resolved.minorUnit <= 6
    ? resolved
    : null;
}

/** UI money helpers; every number passed here is integer minor units. */
export function addMoney(into: MoneyByCurrency, currency: Currency, amountMinor: number): MoneyByCurrency {
  if (!Number.isSafeInteger(amountMinor)) return into;
  return { ...into, [currency]: addMinor(into[currency] ?? 0, amountMinor) };
}

export function sumByCurrency<T>(rows: readonly T[], pick: (row: T) => { amountMinor: number; currencyCode: Currency } | null): MoneyByCurrency {
  let total: MoneyByCurrency = {};
  for (const row of rows) {
    const value = pick(row);
    if (value) total = addMoney(total, value.currencyCode, value.amountMinor);
  }
  return total;
}

export function subtractByCurrency(left: MoneyByCurrency, right: MoneyByCurrency): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const currency of currenciesIn(left, right)) out[currency] = addMinor(left[currency] ?? 0, -(right[currency] ?? 0));
  return out;
}

export function currenciesIn(...maps: readonly MoneyByCurrency[]): Currency[] {
  const present = new Set<Currency>();
  for (const map of maps) for (const currency of Object.keys(map) as Currency[]) present.add(currency);
  return CURRENCIES.filter((currency) => present.has(currency));
}

export function nonZero(map: MoneyByCurrency): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const [currency, amountMinor] of Object.entries(map) as [Currency, number][]) if (amountMinor !== 0) out[currency] = amountMinor;
  return out;
}

export const parseMoneyInput = (value: unknown, currency: Currency | UiMoneyDefinition) => {
  const resolved = definition(currency);
  return resolved ? parseMinorAmount(value, resolved.minorUnit) : null;
};

export const formatMoney = (amountMinor: number, currency: Currency | UiMoneyDefinition) => {
  const resolved = definition(currency);
  return resolved ? formatMinorAmount(amountMinor, resolved) : "—";
};

export function moneyInputValue(amountMinor: number, currency: Currency | UiMoneyDefinition) {
  const resolved = definition(currency);
  if (!resolved || !Number.isSafeInteger(amountMinor)) return "";
  const sign = amountMinor < 0 ? "-" : "";
  const digits = String(Math.abs(amountMinor)).padStart(resolved.minorUnit + 1, "0");
  const minorUnit = Number(resolved.minorUnit);
  if (minorUnit === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`;
}

export function moneyInputStep(currency: Currency | UiMoneyDefinition) {
  const resolved = definition(currency);
  if (!resolved) return "any";
  if (resolved.minorUnit === 0) return "1";
  return `0.${"0".repeat(resolved.minorUnit - 1)}1`;
}

export function moneyLines(map: MoneyByCurrency, { includeZero = false } = {}) {
  const source = includeZero ? map : nonZero(map);
  return currenciesIn(source).map((currency) => ({
    currency,
    amountMinor: source[currency] ?? 0,
  }));
}
