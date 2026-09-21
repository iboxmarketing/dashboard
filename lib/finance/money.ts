/**
 * Finance money is persisted only as safe integer minor units.
 * Floating point is used only by the final display formatter, never for input,
 * validation, storage, balance movement, or aggregation.
 */
export const FINANCE_CURRENCIES = [
  { code: "UZS", name: "Uzbekistani som", minorUnit: 2, symbol: "so‘m" },
  { code: "USD", name: "US dollar", minorUnit: 2, symbol: "$" },
  { code: "EUR", name: "Euro", minorUnit: 2, symbol: "€" },
  { code: "KZT", name: "Kazakhstani tenge", minorUnit: 2, symbol: "₸" },
] as const;

export type SupportedCurrencyCode = (typeof FINANCE_CURRENCIES)[number]["code"];

const currencyByCode = new Map<string, (typeof FINANCE_CURRENCIES)[number]>(
  FINANCE_CURRENCIES.map((currency) => [currency.code, currency]),
);

export function normalizeCurrencyCode(value: unknown): SupportedCurrencyCode | null {
  const code = String(value ?? "").trim().toUpperCase();
  return currencyByCode.has(code) ? code as SupportedCurrencyCode : null;
}

export function currencyDefinition(value: unknown) {
  const code = normalizeCurrencyCode(value);
  return code ? currencyByCode.get(code)! : null;
}

export function isSafeMinor(value: unknown, options: { positive?: boolean } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return options.positive ? value > 0 : true;
}

export function addMinor(left: number, right: number) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error("Money must use safe integer minor units");
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("Money total exceeds safe integer range");
  return result;
}

export type FinanceMoneyDefinition = { code: string; minorUnit: number };

function validMinorUnit(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

/** Exact decimal-string parser. Commas are rejected because their meaning is locale-ambiguous. */
export function parseMinorAmount(value: unknown, minorUnit: unknown): number | null {
  if (!validMinorUnit(minorUnit)) return null;
  const raw = String(value ?? "").trim().replace(/[ _]/g, "");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > minorUnit) return null;
  const digits = `${match[2]}${fraction.padEnd(minorUnit, "0")}`.replace(/^0+(?=\d)/, "");
  const absoluteMinor = Number(digits || "0");
  if (!Number.isSafeInteger(absoluteMinor)) return null;
  return match[1] === "-" ? -absoluteMinor : absoluteMinor;
}

export function parseCurrencyAmount(value: unknown, currencyCode: unknown): number | null {
  const currency = currencyDefinition(currencyCode);
  return currency ? parseMinorAmount(value, currency.minorUnit) : null;
}

export function formatMinorAmount(amountMinor: number, currency: FinanceMoneyDefinition, locale = "uz-UZ") {
  if (!validMinorUnit(currency.minorUnit) || !Number.isSafeInteger(amountMinor)) return "—";
  const scale = 10 ** currency.minorUnit;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.code,
    minimumFractionDigits: currency.minorUnit,
    maximumFractionDigits: currency.minorUnit,
  }).format(amountMinor / scale);
}

export function formatCurrencyAmount(amountMinor: number, currencyCode: unknown, locale = "uz-UZ") {
  const currency = currencyDefinition(currencyCode);
  if (!currency || !Number.isSafeInteger(amountMinor)) return "—";
  return formatMinorAmount(amountMinor, currency, locale);
}
