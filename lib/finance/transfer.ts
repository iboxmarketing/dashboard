/**
 * The canonical transfer model: two explicit amounts, an optional commission,
 * and a rate that is only ever derived for display.
 *
 * A transfer is neither Income nor Expense — money changes accounts, it does not
 * enter or leave the business. The commission IS an expense, denominated in the
 * SOURCE account's currency, and it is carried on the transfer row itself rather
 * than as a second transaction: the fee can then never be double-counted, never
 * orphaned from its transfer, and never edited out of step with it.
 *
 * Balance movement:
 *   source      -(sourceAmountMinor + feeAmountMinor)
 *   destination  +destinationAmountMinor
 *
 * The commission is never subtracted from the destination amount: what arrived
 * is what the receiving bank credited, and that is entered as its own number.
 */
import { FINANCE_CURRENCIES } from "./money";
import type { FinanceTransaction } from "./types";

/**
 * Transfer fees report under one deterministic, system-owned expense bucket.
 *
 * It is NOT a row in `finance_categories`: nobody can rename it, archive it,
 * pick it for an ordinary expense, or make a transfer point at a user category.
 * The id is namespaced so it can never collide with a generated UUID.
 */
export const TRANSFER_FEE_CATEGORY_ID = "system:transfer-fee";
export const TRANSFER_FEE_CATEGORY_NAME = "Bank komissiyasi";

type TransferLike = Pick<
  FinanceTransaction,
  "type" | "sourceAmountMinor" | "sourceCurrencyCode" | "destinationAmountMinor" | "destinationCurrencyCode"
> & { feeAmountMinor?: number | null };

/** The commission actually charged: 0 for a transfer without one, and for anything that is not a transfer. */
export function transferFeeMinor(transaction: TransferLike): number {
  if (transaction.type !== "TRANSFER") return 0;
  const fee = transaction.feeAmountMinor;
  return typeof fee === "number" && Number.isSafeInteger(fee) && fee > 0 ? fee : 0;
}

export type TransferSettlement = {
  sourceCurrencyCode: string;
  destinationCurrencyCode: string;
  sourceAmountMinor: number;
  destinationAmountMinor: number;
  feeMinor: number;
  /** What leaves the source account: the amount sent plus the commission. */
  sourceDeltaMinor: number;
  /** What the destination account receives: exactly the amount entered as received. */
  destinationDeltaMinor: number;
  crossCurrency: boolean;
};

/** The settlement a transfer produces, or `null` when the row is not a complete transfer. */
export function transferSettlement(transaction: TransferLike): TransferSettlement | null {
  if (transaction.type !== "TRANSFER") return null;
  const { sourceAmountMinor, destinationAmountMinor, sourceCurrencyCode, destinationCurrencyCode } = transaction;
  if (!Number.isSafeInteger(sourceAmountMinor) || !Number.isSafeInteger(destinationAmountMinor)) return null;
  if (!sourceCurrencyCode || !destinationCurrencyCode) return null;
  const feeMinor = transferFeeMinor(transaction);
  return {
    sourceCurrencyCode, destinationCurrencyCode,
    sourceAmountMinor: sourceAmountMinor as number, destinationAmountMinor: destinationAmountMinor as number,
    feeMinor,
    sourceDeltaMinor: -((sourceAmountMinor as number) + feeMinor),
    destinationDeltaMinor: destinationAmountMinor as number,
    crossCurrency: sourceCurrencyCode !== destinationCurrencyCode,
  };
}

export type MinorUnitSource = readonly { code: string; minorUnit: number }[];

function minorUnitOf(code: string, currencies?: MinorUnitSource): number | null {
  const runtime = currencies?.find((currency) => currency.code === code);
  if (runtime && Number.isInteger(runtime.minorUnit) && runtime.minorUnit >= 0 && runtime.minorUnit <= 6) return runtime.minorUnit;
  const fallback = FINANCE_CURRENCIES.find((currency) => currency.code === code);
  return fallback ? fallback.minorUnit : null;
}

/** Display precision for a derived rate. Trailing zeros are trimmed, so `12500` stays `12 500`. */
const RATE_SCALE = 6;
/** uz-UZ groups thousands with a non-breaking space, as every money figure in Finance already does. */
const GROUP_SEPARATOR = " ";

function group(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
}

/**
 * Exact `quote / base` as a decimal string, computed in integers.
 *
 * No binary floating point takes part: the two persisted minor amounts and the
 * currencies' minor units are scaled with BigInt and divided once, with the last
 * digit rounded half-up. The result is display data — it never moves money.
 */
function exactRatio(quoteMinor: number, quoteUnit: number, baseMinor: number, baseUnit: number): string | null {
  if (baseMinor <= 0 || quoteMinor <= 0) return null;
  // `BigInt(10)` rather than a `10n` literal: the build targets ES2017, where
  // BigInt literals are not available but the constructor and `**` are.
  const two = BigInt(2);
  const pow10 = (exponent: number) => BigInt(10) ** BigInt(exponent);
  const numerator = BigInt(quoteMinor) * pow10(baseUnit) * pow10(RATE_SCALE);
  const denominator = BigInt(baseMinor) * pow10(quoteUnit);
  const scaled = (numerator * two + denominator) / (denominator * two);
  const text = scaled.toString().padStart(RATE_SCALE + 1, "0");
  const whole = text.slice(0, text.length - RATE_SCALE);
  const fraction = text.slice(text.length - RATE_SCALE).replace(/0+$/, "");
  return fraction ? `${group(whole)}.${fraction}` : group(whole);
}

export type TransferRate = {
  /** The currency one unit of which the rate quotes. */
  baseCode: string;
  /** The currency the rate is expressed in. */
  quoteCode: string;
  /** `12 500`, `1.08` — exact, derived from the two entered amounts. */
  rate: string;
  /** `1 USD = 12 500 UZS`. */
  label: string;
};

/**
 * The rate a cross-currency transfer implies, derived from the two exact amounts.
 *
 * Convention, documented in docs/FINANCE.md and locked by tests:
 *  - when UZS is one side of the pair the rate always reads `1 <foreign> = X UZS`,
 *    whichever direction the money moved, because that is the number people here
 *    quote to each other;
 *  - otherwise it reads `1 <source> = X <destination>`.
 *
 * `null` for a same-currency transfer (there is no rate to show), and for any
 * row whose amounts or currencies are incomplete.
 */
export function transferRate(transaction: TransferLike, currencies?: MinorUnitSource): TransferRate | null {
  const settlement = transferSettlement(transaction);
  if (!settlement || !settlement.crossCurrency) return null;
  const { sourceCurrencyCode, destinationCurrencyCode, sourceAmountMinor, destinationAmountMinor } = settlement;
  const uzsIsDestination = destinationCurrencyCode === "UZS";
  const uzsIsSource = sourceCurrencyCode === "UZS";
  const invert = uzsIsSource && !uzsIsDestination;
  const base = invert
    ? { code: destinationCurrencyCode, minor: destinationAmountMinor }
    : { code: sourceCurrencyCode, minor: sourceAmountMinor };
  const quote = invert
    ? { code: sourceCurrencyCode, minor: sourceAmountMinor }
    : { code: destinationCurrencyCode, minor: destinationAmountMinor };
  const baseUnit = minorUnitOf(base.code, currencies);
  const quoteUnit = minorUnitOf(quote.code, currencies);
  if (baseUnit === null || quoteUnit === null) return null;
  const rate = exactRatio(quote.minor, quoteUnit, base.minor, baseUnit);
  if (!rate) return null;
  return { baseCode: base.code, quoteCode: quote.code, rate, label: `1 ${base.code} = ${rate} ${quote.code}` };
}
