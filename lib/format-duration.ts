/**
 * One duration format for the whole product.
 *
 * Durations are stored as minutes everywhere, and the dashboard reads them in
 * Uzbek: `42 min`, `1 s 18 min`, `1 kun 3 s 20 min`. A zero remainder is dropped
 * rather than printed (`2 s`, not `2 s 0 min`), and nothing is ever shown as a
 * raw minute count or with a seconds field the data does not have.
 *
 * Lives in `lib/` so the format is testable on its own and cannot drift between
 * the dashboard, a manager profile and a Custom Page.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** `—` for a missing value: no duration is invented for a Deal that has none. */
export const NO_DURATION = "—";

export function formatDurationMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DURATION;
  const total = Math.max(0, Math.round(value));
  if (total < MINUTES_PER_HOUR) return `${total} min`;
  const days = Math.floor(total / MINUTES_PER_DAY);
  const hours = Math.floor((total % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const minutes = total % MINUTES_PER_HOUR;
  const parts: string[] = [];
  if (days) parts.push(`${days} kun`);
  if (hours) parts.push(`${hours} s`);
  if (minutes) parts.push(`${minutes} min`);
  return parts.join(" ");
}

/**
 * Signed gap between two durations, for a single comparison line:
 * `{ minutes: 37, faster: true }` means 37 minutes faster than the reference.
 * `null` when either side is missing — an absent comparison is not a tie.
 */
export function durationGap(value: number | null | undefined, reference: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (reference === null || reference === undefined || !Number.isFinite(reference)) return null;
  const difference = Math.round(reference) - Math.round(value);
  return { minutes: Math.abs(difference), faster: difference >= 0 };
}

/** `Jamoa avg: 3 s 53 min · 37 min tezroq` — one line, never a paragraph. */
export function teamComparisonLabel(value: number | null | undefined, teamAverage: number | null | undefined) {
  const gap = durationGap(value, teamAverage);
  if (!gap) return null;
  const direction = gap.minutes === 0 ? "jamoa darajasida" : gap.faster ? "tezroq" : "sekinroq";
  const amount = gap.minutes === 0 ? "" : `${formatDurationMinutes(gap.minutes)} `;
  return `Jamoa avg: ${formatDurationMinutes(teamAverage)} · ${amount}${direction}`;
}
