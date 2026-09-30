/**
 * When an account may be archived.
 *
 * Archiving hides an account from every active screen, so money left on it would
 * vanish from the totals people read: an account may only be archived while its
 * balance is exactly zero.
 *
 * The decision is made on the **projected** state — the opening balance the
 * request will leave behind plus the account's active transaction deltas — not on
 * the balance the account happens to have now. A single PATCH can raise the
 * opening balance and archive at the same time, and judging the old balance let
 * exactly that through: the check saw 0, the new opening balance was written
 * afterwards, and a non-zero account ended up hidden.
 *
 * Pure, so the invariant can be tested without a database, and shared with
 * `lib/finance/storage.ts` so there is only one definition of it.
 */
import { sumMinor } from "./money";

/** The wording the owner asked for, shown by the UI as-is. */
export const ACCOUNT_BALANCE_NOT_ZERO_MESSAGE = "Hisobda qoldiq mavjud. Arxivlashdan oldin qoldiqni 0 ga tushiring.";
export const ACCOUNT_BALANCE_UNSAFE_MESSAGE = "Account balance exceeds the safe integer range";

export type AccountArchiveRefusal =
  | { code: "ACCOUNT_BALANCE_NOT_ZERO"; message: string; projectedBalanceMinor: number }
  | { code: "ACCOUNT_BALANCE_UNSAFE"; message: string; projectedBalanceMinor: null };

/**
 * The balance the account will have once this request is applied, or `null` when
 * that total cannot be represented exactly. Uses the checked helper — never
 * unchecked arithmetic.
 */
export function projectedAccountBalanceMinor(openingBalanceMinor: number, activeDeltaMinor: number) {
  return sumMinor(openingBalanceMinor, activeDeltaMinor);
}

/**
 * Why this account may not be archived, or `null` when it may.
 *
 * `next` is the merged post-patch state; `current` is what is stored today.
 * Restoring (archived → active) and any request that leaves `archived` unchanged
 * are never blocked, and an opening-balance edit on its own is never blocked.
 */
export function accountArchiveRefusal(
  next: { archived: boolean; openingBalanceMinor: number },
  current: { archived: boolean },
  activeDeltaMinor: number,
): AccountArchiveRefusal | null {
  if (!next.archived || current.archived) return null;
  const projectedBalanceMinor = projectedAccountBalanceMinor(next.openingBalanceMinor, activeDeltaMinor);
  if (projectedBalanceMinor === null) {
    return { code: "ACCOUNT_BALANCE_UNSAFE", message: ACCOUNT_BALANCE_UNSAFE_MESSAGE, projectedBalanceMinor: null };
  }
  if (projectedBalanceMinor !== 0) {
    return { code: "ACCOUNT_BALANCE_NOT_ZERO", message: ACCOUNT_BALANCE_NOT_ZERO_MESSAGE, projectedBalanceMinor };
  }
  return null;
}
