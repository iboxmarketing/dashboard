/**
 * The daily subscription pass, driven by the Worker's cron.
 *
 * Deliberately once per Tashkent day: the sweep's only job is to notice a NEW due
 * occurrence, and the owner's manual *Qayta urinish* is the only thing that ever
 * rechecks an insufficient balance. Running it more often would change nothing —
 * every write is keyed on (subscription, due date) — so the daily marker exists to
 * save the database work, not to make the result correct.
 *
 * Never throws: a cron tick that rejects gives no better outcome than one that
 * records the day it last ran.
 */
import { getDictionary, saveDictionary } from "../storage";
import { sweepDueSubscriptions, type SweepResult } from "./occurrence-storage";

const STATE_KEY = "financeSubscriptionSweep";
const tashkentDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
});

type SweepState = { lastRunDay: string | null; lastResult: SweepResult | null; lastError: string | null };

export type SubscriptionSweepOutcome =
  | { ran: false; reason: "ALREADY_RAN_TODAY" | "FAILED" }
  | { ran: true; day: string; result: SweepResult };

export async function runDailySubscriptionSweep(now: Date = new Date()): Promise<SubscriptionSweepOutcome> {
  const day = tashkentDay.format(now);
  try {
    const state = await getDictionary<SweepState | null>(STATE_KEY, null);
    if (state?.lastRunDay === day) return { ran: false, reason: "ALREADY_RAN_TODAY" };
    const result = await sweepDueSubscriptions(day, now.toISOString());
    await saveDictionary(STATE_KEY, { lastRunDay: day, lastResult: result, lastError: null } satisfies SweepState);
    return { ran: true, day, result };
  } catch {
    // Fixed text only, and the day is NOT recorded, so the next tick retries.
    await saveDictionary(STATE_KEY, { lastRunDay: null, lastResult: null, lastError: "Obuna tekshiruvi bajarilmadi" } satisfies SweepState)
      .catch(() => undefined);
    return { ran: false, reason: "FAILED" };
  }
}
