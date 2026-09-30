/**
 * Subscription occurrences: recurring expenses that wait for the owner's word.
 *
 * A subscription is a template. When its due date arrives, the scheduler creates
 * exactly ONE occurrence for that date and checks the linked account's balance
 * exactly ONCE:
 *
 *   enough money  -> REVIEW_REQUIRED, carrying the draft
 *   not enough    -> INSUFFICIENT_FUNDS, and the system stops
 *
 * Nothing retries by itself. An INSUFFICIENT_FUNDS occurrence is re-checked only
 * when the owner presses *Qayta urinish* (owner decision, 2026-09-30): a machine
 * that keeps polling would either charge at a moment nobody chose, or bury the
 * real problem in noise.
 *
 * REVIEW_REQUIRED is a DRAFT: the system thinks the card may have been charged,
 * the owner has not confirmed it. It affects no balance and no total — the
 * occurrence row is the whole draft, and a canonical Expense exists only after
 * *Tasdiqlash*. That is structural, not a rule to remember: until then there is
 * no transaction row to affect anything.
 *
 * Everything here is pure, so the state machine is testable without a database.
 */
import { sumMinor } from "./money";
import type { FinanceSubscription } from "./types";

export const OCCURRENCE_STATUSES = ["REVIEW_REQUIRED", "INSUFFICIENT_FUNDS", "CONFIRMED", "SKIPPED"] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Still waiting for the owner: no next occurrence may be created yet. */
export const UNRESOLVED_STATUSES: readonly OccurrenceStatus[] = ["REVIEW_REQUIRED", "INSUFFICIENT_FUNDS"];
export const isUnresolvedOccurrence = (status: string) => UNRESOLVED_STATUSES.includes(status as OccurrenceStatus);

export type SubscriptionOccurrence = {
  id: string;
  subscriptionId: string;
  dueDate: string;
  status: OccurrenceStatus;
  direction: "INCOME" | "EXPENSE";
  accountId: string;
  categoryId: string;
  projectId: string | null;
  amountMinor: number;
  currencyCode: string;
  availableBalanceMinor: number | null;
  missingAmountMinor: number | null;
  balanceCheckedAt: string | null;
  transactionId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

/**
 * The durable identity the owner named: subscription + due date. Used as the
 * primary key, so every write is naturally idempotent — a rerun, a double click
 * or a retried request addresses the same row.
 */
export const occurrenceId = (subscriptionId: string, dueDate: string) => `${subscriptionId}::${dueDate}`;

/** The posted Expense's id is derived from the occurrence, so Confirm cannot post twice. */
export const occurrenceTransactionId = (occurrence: { id: string }) => `subocc::${occurrence.id}`;

export const OCCURRENCE_LABELS: Record<OccurrenceStatus, string> = {
  REVIEW_REQUIRED: "Tasdiqlash kutilmoqda",
  INSUFFICIENT_FUNDS: "Mablag‘ yetarli emas",
  CONFIRMED: "Tasdiqlangan",
  SKIPPED: "O‘tkazib yuborilgan",
};

/** What a subscription row reads as: one state, in the owner's words. */
export function subscriptionStateLabel(
  subscription: Pick<FinanceSubscription, "archived">,
  occurrence?: { status: OccurrenceStatus } | null,
) {
  if (subscription.archived) return "Pauzada";
  if (occurrence && isUnresolvedOccurrence(occurrence.status)) return OCCURRENCE_LABELS[occurrence.status];
  return "Faol";
}

/**
 * The balance check, made once when an occurrence becomes due and again only on a
 * manual retry. `missingMinor` is what the account is short by, for the row that
 * asks the owner to add funds.
 */
export function balanceVerdict(amountMinor: number, availableBalanceMinor: number) {
  const sufficient = availableBalanceMinor >= amountMinor;
  const missing = sumMinor(amountMinor, -availableBalanceMinor);
  return {
    sufficient,
    missingMinor: sufficient ? 0 : missing === null ? null : Math.max(0, missing),
    status: (sufficient ? "REVIEW_REQUIRED" : "INSUFFICIENT_FUNDS") as OccurrenceStatus,
  };
}

const LAST_DAY_OF = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * The intended billing day, taken from the subscription's start date.
 *
 * Anchoring on the start date is what makes a 31st subscription behave: February
 * uses its last valid day, and March returns to the 31st. Advancing from the
 * previous *due* date instead would drift permanently to the 28th after one
 * February.
 */
export function billingAnchorDay(subscription: Pick<FinanceSubscription, "startDate">) {
  const day = Number(String(subscription.startDate).slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
}

export const CADENCE_MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

export function cadenceMonthCount(subscription: Pick<FinanceSubscription, "cadence" | "intervalMonths">) {
  if (subscription.cadence === "CUSTOM_MONTHS") {
    const months = Number(subscription.intervalMonths);
    return Number.isInteger(months) && months > 0 ? months : null;
  }
  return CADENCE_MONTHS[subscription.cadence] ?? null;
}

/**
 * The due date after `fromDueDate`, on the intended billing day, clamped to the
 * length of the target month. Returns `fromDueDate` unchanged when the cadence
 * cannot be read, so a malformed subscription never silently skips a period.
 */
export function nextOccurrenceDate(
  subscription: Pick<FinanceSubscription, "cadence" | "intervalMonths" | "startDate">,
  fromDueDate: string,
) {
  const months = cadenceMonthCount(subscription);
  if (months === null) return fromDueDate;
  const year = Number(fromDueDate.slice(0, 4));
  const month = Number(fromDueDate.slice(5, 7)) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(month)) return fromDueDate;
  const target = new Date(Date.UTC(year, month + months, 1));
  const anchor = billingAnchorDay(subscription);
  const day = Math.min(anchor, LAST_DAY_OF(target.getUTCFullYear(), target.getUTCMonth()));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The subscriptions whose current due date needs an occurrence today.
 *
 * Only active EXPENSE subscriptions take part: a paused (archived) one generates
 * nothing, and an income subscription has no balance to check, so it stays the
 * template it has always been. Exactly one occurrence per due date is considered
 * — missed earlier periods are never backfilled, because `nextDueDate` only
 * advances when the owner confirms or skips.
 */
export function subscriptionsDueOn(subscriptions: readonly FinanceSubscription[], today: string) {
  return subscriptions.filter((subscription) => !subscription.archived
    && subscription.direction === "EXPENSE"
    && subscription.startDate <= today
    && subscription.nextDueDate <= today
    && (!subscription.endDate || subscription.nextDueDate <= subscription.endDate));
}
