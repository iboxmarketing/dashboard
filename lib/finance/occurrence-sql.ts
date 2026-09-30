/**
 * The exact statements the occurrence lifecycle runs.
 *
 * Kept out of `occurrence-storage.ts` (which imports the Worker-only D1 binding)
 * so the tests can execute THESE statements against a real SQLite built from the
 * migrations. Every idempotency guarantee lives in the SQL itself rather than in
 * application checks:
 *
 *  - `INSERT OR IGNORE` on the (subscription, due date) primary key: a scheduler
 *    rerun cannot create a second occurrence;
 *  - `INSERT OR IGNORE` on the derived transaction id: Confirm cannot post a
 *    second Expense;
 *  - every status change is guarded by the status it must come from, so a double
 *    click is a no-op rather than a second transition;
 *  - the due-date advance is guarded by the date it replaces, so it moves once.
 */

/** One occurrence for one due date. Ignored if that identity already exists. */
export const OCCURRENCE_INSERT = `INSERT OR IGNORE INTO finance_subscription_occurrences(
  id, subscription_id, due_date, status, direction, account_id, category_id, project_id,
  amount_minor, currency_code, available_balance_minor, missing_amount_minor, balance_checked_at,
  transaction_id, created_at, updated_at, resolved_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`;

/** A manual retry that found enough money: the SAME occurrence becomes the draft. */
export const OCCURRENCE_RETRY_SUFFICIENT = `UPDATE finance_subscription_occurrences
  SET status = 'REVIEW_REQUIRED', available_balance_minor = ?, missing_amount_minor = 0,
      balance_checked_at = ?, updated_at = ?
  WHERE id = ? AND status = 'INSUFFICIENT_FUNDS'`;

/** A manual retry that still found too little: the occurrence stays put. */
export const OCCURRENCE_RETRY_INSUFFICIENT = `UPDATE finance_subscription_occurrences
  SET available_balance_minor = ?, missing_amount_minor = ?, balance_checked_at = ?, updated_at = ?
  WHERE id = ? AND status = 'INSUFFICIENT_FUNDS'`;

/** "Hali yechilmadi": the owner looked, nothing was charged. Records the look only. */
export const OCCURRENCE_KEEP_PENDING = `UPDATE finance_subscription_occurrences
  SET balance_checked_at = ?, updated_at = ?
  WHERE id = ? AND status = 'REVIEW_REQUIRED'`;

/** The posted Expense. Its id is derived from the occurrence, so this runs once. */
export const OCCURRENCE_EXPENSE_INSERT = `INSERT OR IGNORE INTO finance_transactions(
  id, date, type, note, project_id, account_id, amount_minor, currency_code, category_id,
  from_account_id, to_account_id, source_amount_minor, source_currency_code,
  destination_amount_minor, destination_currency_code, fee_amount_minor, archived, created_at, updated_at
) VALUES(?, ?, 'EXPENSE', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`;

export const OCCURRENCE_CONFIRM = `UPDATE finance_subscription_occurrences
  SET status = 'CONFIRMED', transaction_id = ?, resolved_at = ?, updated_at = ?
  WHERE id = ? AND status = 'REVIEW_REQUIRED'`;

export const OCCURRENCE_SKIP = `UPDATE finance_subscription_occurrences
  SET status = 'SKIPPED', resolved_at = ?, updated_at = ?
  WHERE id = ? AND status IN ('REVIEW_REQUIRED', 'INSUFFICIENT_FUNDS')`;

/**
 * The due date advances only on CONFIRMED or SKIPPED, and only from the date the
 * resolved occurrence belongs to — so it moves exactly one period, once.
 */
export const SUBSCRIPTION_ADVANCE_DUE_DATE = `UPDATE finance_subscriptions
  SET next_due_date = ?, updated_at = ?
  WHERE id = ? AND next_due_date = ?`;

export const OCCURRENCE_SELECT = `SELECT id, subscription_id, due_date, status, direction, account_id, category_id,
    project_id, amount_minor, currency_code, available_balance_minor, missing_amount_minor, balance_checked_at,
    transaction_id, created_at, updated_at, resolved_at
  FROM finance_subscription_occurrences`;
