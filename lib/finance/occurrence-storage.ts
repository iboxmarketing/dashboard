/**
 * The occurrence lifecycle against D1.
 *
 * All decisions live in `occurrences.ts` (pure) and all statements in
 * `occurrence-sql.ts` (idempotent by construction). This module only binds them:
 * read the state, compute with the pure helpers, write with the guarded SQL.
 */
import { getD1 } from "@/db";
import { FinanceError, financeAccountActiveDeltaMinor, getFinanceAccount, getFinanceSubscription, listFinanceSubscriptions } from "./storage";
import { projectedAccountBalanceMinor } from "./account-rules";
import {
  OCCURRENCE_CONFIRM, OCCURRENCE_EXPENSE_INSERT, OCCURRENCE_INSERT, OCCURRENCE_KEEP_PENDING,
  OCCURRENCE_RETRY_INSUFFICIENT, OCCURRENCE_RETRY_SUFFICIENT, OCCURRENCE_SELECT, OCCURRENCE_SKIP,
  SUBSCRIPTION_ADVANCE_DUE_DATE,
} from "./occurrence-sql";
import {
  balanceVerdict, isUnresolvedOccurrence, nextOccurrenceDate, occurrenceId, occurrenceTransactionId,
  subscriptionsDueOn, type OccurrenceStatus, type SubscriptionOccurrence,
} from "./occurrences";

const nullableNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const nullableText = (value: unknown) => (value === null || value === undefined ? null : String(value));

const occurrenceRow = (row: Record<string, unknown>): SubscriptionOccurrence => ({
  id: String(row.id), subscriptionId: String(row.subscription_id), dueDate: String(row.due_date),
  status: String(row.status) as OccurrenceStatus, direction: String(row.direction) as "INCOME" | "EXPENSE",
  accountId: String(row.account_id), categoryId: String(row.category_id), projectId: nullableText(row.project_id),
  amountMinor: Number(row.amount_minor), currencyCode: String(row.currency_code),
  availableBalanceMinor: nullableNumber(row.available_balance_minor),
  missingAmountMinor: nullableNumber(row.missing_amount_minor),
  balanceCheckedAt: nullableText(row.balance_checked_at), transactionId: nullableText(row.transaction_id),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at), resolvedAt: nullableText(row.resolved_at),
});

export async function listSubscriptionOccurrences(filters: { status?: OccurrenceStatus[]; subscriptionId?: string } = {}) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.subscriptionId) { clauses.push("subscription_id = ?"); values.push(filters.subscriptionId); }
  if (filters.status?.length) {
    clauses.push(`status IN (${filters.status.map(() => "?").join(", ")})`);
    values.push(...filters.status);
  }
  const sql = `${OCCURRENCE_SELECT} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY due_date DESC, subscription_id`;
  const result = await getD1().prepare(sql).bind(...values).all<Record<string, unknown>>();
  return (result.results ?? []).map(occurrenceRow);
}

export const getSubscriptionOccurrence = async (id: string) => {
  const row = await getD1().prepare(`${OCCURRENCE_SELECT} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return row ? occurrenceRow(row) : null;
};

/** The account's balance right now: its opening balance plus every active record. */
async function accountBalance(accountId: string) {
  const account = await getFinanceAccount(accountId);
  if (!account) throw new FinanceError("Account was not found", 404, "FINANCE_NOT_FOUND");
  const projected = projectedAccountBalanceMinor(account.openingBalanceMinor, await financeAccountActiveDeltaMinor(accountId));
  if (projected === null) throw new FinanceError("Account balance exceeds the safe integer range", 409, "ACCOUNT_BALANCE_UNSAFE");
  return { account, balanceMinor: projected };
}

export type SweepResult = {
  checked: number;
  created: number;
  reviewRequired: number;
  insufficientFunds: number;
  skippedBecauseUnresolved: number;
};

/**
 * One scheduler pass. Creates the missing occurrence for each due subscription and
 * checks its balance ONCE.
 *
 * A subscription whose current occurrence already exists is left completely alone
 * — no second occurrence, and above all NO second balance check: an
 * INSUFFICIENT_FUNDS occurrence is rechecked only by the owner's manual retry.
 * Running this twice in a row therefore changes nothing.
 */
export async function sweepDueSubscriptions(today: string, now = new Date().toISOString()): Promise<SweepResult> {
  const subscriptions = subscriptionsDueOn(await listFinanceSubscriptions(true), today);
  const result: SweepResult = { checked: subscriptions.length, created: 0, reviewRequired: 0, insufficientFunds: 0, skippedBecauseUnresolved: 0 };
  for (const subscription of subscriptions) {
    const id = occurrenceId(subscription.id, subscription.nextDueDate);
    const existing = await getSubscriptionOccurrence(id);
    if (existing) { if (isUnresolvedOccurrence(existing.status)) result.skippedBecauseUnresolved += 1; continue; }
    const { account, balanceMinor } = await accountBalance(subscription.accountId);
    // No automatic FX: a subscription is charged from an account in its own currency.
    if (account.currencyCode !== subscription.currencyCode) {
      throw new FinanceError("Subscription currency must match Account currency", 409, "SUBSCRIPTION_CURRENCY_MISMATCH");
    }
    const verdict = balanceVerdict(subscription.amountMinor, balanceMinor);
    await getD1().prepare(OCCURRENCE_INSERT).bind(
      id, subscription.id, subscription.nextDueDate, verdict.status, subscription.direction,
      subscription.accountId, subscription.categoryId, subscription.projectId,
      subscription.amountMinor, subscription.currencyCode,
      balanceMinor, verdict.missingMinor, now, now, now,
    ).run();
    result.created += 1;
    if (verdict.status === "REVIEW_REQUIRED") result.reviewRequired += 1; else result.insufficientFunds += 1;
  }
  return result;
}

function requireOccurrence(occurrence: SubscriptionOccurrence | null) {
  if (!occurrence) throw new FinanceError("Subscription occurrence was not found", 404, "FINANCE_NOT_FOUND");
  return occurrence;
}

/**
 * *Qayta urinish* — the only balance recheck an INSUFFICIENT_FUNDS occurrence ever
 * gets. Sufficient funds move the SAME occurrence to the draft state; still
 * insufficient only refreshes what the account is short by. Repeats are no-ops
 * because both statements are guarded by the status they must come from.
 */
export async function retrySubscriptionOccurrence(id: string, now = new Date().toISOString()) {
  const occurrence = requireOccurrence(await getSubscriptionOccurrence(id));
  if (occurrence.status !== "INSUFFICIENT_FUNDS") return { occurrence, changed: false };
  const { balanceMinor } = await accountBalance(occurrence.accountId);
  const verdict = balanceVerdict(occurrence.amountMinor, balanceMinor);
  const statement = verdict.sufficient
    ? getD1().prepare(OCCURRENCE_RETRY_SUFFICIENT).bind(balanceMinor, now, now, id)
    : getD1().prepare(OCCURRENCE_RETRY_INSUFFICIENT).bind(balanceMinor, verdict.missingMinor, now, now, id);
  await statement.run();
  return { occurrence: requireOccurrence(await getSubscriptionOccurrence(id)), changed: verdict.sufficient };
}

/** "Hali yechilmadi": the owner checked the card and nothing was charged yet. */
export async function keepOccurrencePending(id: string, now = new Date().toISOString()) {
  const occurrence = requireOccurrence(await getSubscriptionOccurrence(id));
  if (occurrence.status !== "REVIEW_REQUIRED") return { occurrence, changed: false };
  await getD1().prepare(OCCURRENCE_KEEP_PENDING).bind(now, now, id).run();
  return { occurrence: requireOccurrence(await getSubscriptionOccurrence(id)), changed: false };
}

/**
 * *Tasdiqlash* — the money really left the account.
 *
 * One batch, which D1 runs atomically: post the Expense under the id derived from
 * this occurrence, mark the occurrence CONFIRMED from REVIEW_REQUIRED, and
 * advance the subscription from exactly the due date that was resolved. Every
 * statement is guarded, so a double click or a retried request posts nothing more.
 */
export async function confirmSubscriptionOccurrence(id: string, now = new Date().toISOString()) {
  const occurrence = requireOccurrence(await getSubscriptionOccurrence(id));
  if (occurrence.status !== "REVIEW_REQUIRED") return { occurrence, posted: false };
  const subscription = await getFinanceSubscription(occurrence.subscriptionId);
  if (!subscription) throw new FinanceError("Subscription was not found", 404, "FINANCE_NOT_FOUND");
  const transactionId = occurrenceTransactionId(occurrence);
  const db = getD1();
  await db.batch([
    db.prepare(OCCURRENCE_EXPENSE_INSERT).bind(
      transactionId, occurrence.dueDate, subscription.name, occurrence.projectId, occurrence.accountId,
      occurrence.amountMinor, occurrence.currencyCode, occurrence.categoryId, now, now,
    ),
    db.prepare(OCCURRENCE_CONFIRM).bind(transactionId, now, now, id),
    db.prepare(SUBSCRIPTION_ADVANCE_DUE_DATE).bind(
      nextOccurrenceDate(subscription, occurrence.dueDate), now, occurrence.subscriptionId, occurrence.dueDate,
    ),
  ]);
  return { occurrence: requireOccurrence(await getSubscriptionOccurrence(id)), posted: true };
}

/** *Bu safar o‘tkazib yuborish* — no Expense, no balance change, next period due. */
export async function skipSubscriptionOccurrence(id: string, now = new Date().toISOString()) {
  const occurrence = requireOccurrence(await getSubscriptionOccurrence(id));
  if (!isUnresolvedOccurrence(occurrence.status)) return { occurrence, changed: false };
  const subscription = await getFinanceSubscription(occurrence.subscriptionId);
  if (!subscription) throw new FinanceError("Subscription was not found", 404, "FINANCE_NOT_FOUND");
  const db = getD1();
  await db.batch([
    db.prepare(OCCURRENCE_SKIP).bind(now, now, id),
    db.prepare(SUBSCRIPTION_ADVANCE_DUE_DATE).bind(
      nextOccurrenceDate(subscription, occurrence.dueDate), now, occurrence.subscriptionId, occurrence.dueDate,
    ),
  ]);
  return { occurrence: requireOccurrence(await getSubscriptionOccurrence(id)), changed: true };
}
