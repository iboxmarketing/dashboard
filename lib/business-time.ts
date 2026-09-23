import type { DashboardSettings } from "./types";

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string) {
  if (!formatters.has(timezone)) {
    formatters.set(
      timezone,
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      }),
    );
  }
  return formatters.get(timezone)!;
}

export function getZonedParts(value: Date | string, timezone: string): LocalParts {
  const date = value instanceof Date ? value : new Date(value);
  const pieces = Object.fromEntries(
    formatter(timezone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(pieces.year),
    month: Number(pieces.month),
    day: Number(pieces.day),
    hour: Number(pieces.hour),
    minute: Number(pieces.minute),
    second: Number(pieces.second),
    weekday: weekdays[pieces.weekday] ?? 0,
  };
}

function localToUtc(
  local: Pick<LocalParts, "year" | "month" | "day" | "hour" | "minute">,
  timezone: string,
) {
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const parts = getZonedParts(new Date(guess), timezone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    guess += desired - represented;
  }
  return new Date(guess);
}

function parseClock(clock: string) {
  const [hour, minute] = clock.split(":").map(Number);
  return { hour, minute };
}

function dateKey(parts: Pick<LocalParts, "year" | "month" | "day">) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addLocalDays(parts: Pick<LocalParts, "year" | "month" | "day">, days: number) {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
    weekday: cursor.getUTCDay(),
  };
}

/**
 * One settings object's working period per local day, as epoch milliseconds.
 * `localToUtc` costs several `Intl` conversions per day, and every lead's
 * business-time span revisits the same days, so the Sales dataset recomputed
 * identical periods thousands of times per request. Keyed by the settings
 * object — settings are rebuilt, never mutated in place — and handed out as
 * fresh `Date`s so no caller can alter a cached value.
 */
const periodCache = new WeakMap<DashboardSettings, Map<string, [number, number] | null>>();

function periodForDay(
  day: Pick<LocalParts, "year" | "month" | "day" | "weekday">,
  settings: DashboardSettings,
) {
  let days = periodCache.get(settings);
  if (!days) { days = new Map(); periodCache.set(settings, days); }
  const key = dateKey(day);
  let span = days.get(key);
  if (span === undefined) {
    span = computePeriodForDay(day, settings);
    days.set(key, span);
  }
  return span ? { start: new Date(span[0]), end: new Date(span[1]) } : null;
}

function computePeriodForDay(
  day: Pick<LocalParts, "year" | "month" | "day" | "weekday">,
  settings: DashboardSettings,
): [number, number] | null {
  const workDay = settings.schedule[day.weekday];
  if (!workDay?.enabled || settings.holidays.includes(dateKey(day))) return null;
  const start = parseClock(workDay.start);
  const end = parseClock(workDay.end);
  return [
    localToUtc({ ...day, ...start }, settings.timezone).getTime(),
    localToUtc({ ...day, ...end }, settings.timezone).getTime(),
  ];
}

export function isInsideWorkingTime(value: Date | string, settings: DashboardSettings) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = getZonedParts(date, settings.timezone);
  const period = periodForDay(parts, settings);
  return Boolean(period && date >= period.start && date < period.end);
}

export function getSlaStart(value: Date | string, settings: DashboardSettings) {
  const date = value instanceof Date ? value : new Date(value);
  const local = getZonedParts(date, settings.timezone);
  const todayPeriod = periodForDay(local, settings);
  if (todayPeriod && date >= todayPeriod.start && date < todayPeriod.end) return date;
  if (todayPeriod && date < todayPeriod.start) return todayPeriod.start;

  for (let offset = 1; offset <= 370; offset += 1) {
    const day = addLocalDays(local, offset);
    const period = periodForDay(day, settings);
    if (period) return period.start;
  }
  throw new Error("Ish jadvalidan keyingi ish davri topilmadi");
}

/**
 * Working milliseconds between two instants, walking the local days in order.
 * `stopAboveMinutes` ends the walk once the floored total exceeds that many
 * minutes; the running total never decreases, so a caller that only compares
 * against a limit gets the same answer as the full walk.
 */
function businessMilliseconds(
  startValue: Date | string,
  endValue: Date | string,
  settings: DashboardSettings,
  stopAboveMinutes = Infinity,
) {
  const start = startValue instanceof Date ? startValue : new Date(startValue);
  const end = endValue instanceof Date ? endValue : new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;

  const localStart = getZonedParts(start, settings.timezone);
  const localEnd = getZonedParts(end, settings.timezone);
  const startNoon = Date.UTC(localStart.year, localStart.month - 1, localStart.day, 12);
  const endNoon = Date.UTC(localEnd.year, localEnd.month - 1, localEnd.day, 12);
  const dayCount = Math.max(0, Math.round((endNoon - startNoon) / 86_400_000));
  let milliseconds = 0;

  for (let offset = 0; offset <= dayCount; offset += 1) {
    const day = addLocalDays(localStart, offset);
    const period = periodForDay(day, settings);
    if (!period) continue;
    const overlapStart = new Date(Math.max(start.getTime(), period.start.getTime()));
    const overlapEnd = new Date(Math.min(end.getTime(), period.end.getTime()));
    if (overlapEnd > overlapStart) milliseconds += overlapEnd.getTime() - overlapStart.getTime();
    if (Math.floor(milliseconds / 60_000) > stopAboveMinutes) break;
  }

  return milliseconds;
}

export function calculateBusinessMinutes(
  startValue: Date | string,
  endValue: Date | string,
  settings: DashboardSettings,
) {
  return Math.max(0, Math.floor(businessMilliseconds(startValue, endValue, settings) / 60_000));
}

/**
 * `calculateBusinessMinutes(start, end, settings) > limitMinutes`, without
 * walking the rest of a months-long span once the limit is already passed.
 * An unprocessed lead's SLA check asks only this question.
 */
export function businessMinutesExceed(
  startValue: Date | string,
  endValue: Date | string,
  settings: DashboardSettings,
  limitMinutes: number,
) {
  return Math.max(0, Math.floor(businessMilliseconds(startValue, endValue, settings, limitMinutes) / 60_000)) > limitMinutes;
}

export const defaultSettings: DashboardSettings = {
  timezone: "Asia/Tashkent",
  schedule: {
    0: { enabled: false, start: "09:00", end: "18:00" },
    1: { enabled: true, start: "09:00", end: "18:00" },
    2: { enabled: true, start: "09:00", end: "18:00" },
    3: { enabled: true, start: "09:00", end: "18:00" },
    4: { enabled: true, start: "09:00", end: "18:00" },
    5: { enabled: true, start: "09:00", end: "18:00" },
    6: { enabled: false, start: "09:00", end: "18:00" },
  },
  holidays: [],
  slaMinutes: 10,
  historyDays: 90,
  selectedPipelineIds: [],
  selectedPipelineNames: ["IBOX Sales"],
  postSalePipelineIds: [],
  postSalePipelineNames: ["IBOX Обучение Сопровождение"],
  failureReasonField: null,
  failureReasonFieldByPipeline: {},
  marketingChannelField: null,
  salesManagerField: null,
  defaultStageLimitHours: 24,
  stageLimits: {},
  qualifiedStageIds: [],
  lowQualityStageIds: [],
  paymentStageIds: [],
  closedLostStageIds: [],
  routingReasonPatterns: ["idoko", "sd", "передан", "перевод", "routing", "yo'naltir", "yo‘naltir", "o'tkaz", "o‘tkaz"],
  salesStaffIds: [],
  autoSyncMinutes: 15,
  // Mirrors DEFAULT_DASHBOARD_METRIC_IDS in lib/dashboard-metrics.ts, which cannot
  // be imported here without a cycle (it pulls in the SLA helper). A test asserts
  // the two stay identical.
  dashboardMetricIds: ["leads", "sql", "not_relevant", "sales_lost", "cohort_sales", "period_sales", "revenue", "avg_processing", "sla"],
};
