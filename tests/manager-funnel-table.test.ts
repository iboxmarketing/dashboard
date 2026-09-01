import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { salesManagerKey } from "../lib/sales-logic";
import { summarizeSla } from "../lib/sla";
import type { AnalyticsRecord } from "../lib/types";

const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const client = code("../app/dashboard-client.tsx");
const pct = (value: number, total: number) => (total ? Math.round((value / total) * 100) : 0);

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME",
    stage: "Распределение", currentScope: null, customerKey: null, duplicateOfDealId: null,
    salesManagerId: "7", salesManager: "Ali", assignedManagerId: "7", assignedManager: "Ali",
    stageHistoryCount: 1, ...over,
  } as unknown as AnalyticsRecord;
}

/** Mirrors buildManagers: partition by salesManagerKey, one metrics build each. */
function buildRows(cohort: AnalyticsRecord[], won: AnalyticsRecord[]) {
  const byManager = new Map<string, AnalyticsRecord[]>();
  const wonBy = new Map<string, AnalyticsRecord[]>();
  for (const r of cohort) byManager.set(salesManagerKey(r), [...(byManager.get(salesManagerKey(r)) ?? []), r]);
  for (const r of won) wonBy.set(salesManagerKey(r), [...(wonBy.get(salesManagerKey(r)) ?? []), r]);
  const ids = new Set([...byManager.keys(), ...wonBy.keys()]);
  const built = [...ids].map((id) => {
    const m = buildDashboardMetrics(byManager.get(id) ?? [], wonBy.get(id) ?? []);
    return { id, leads: m.counts.leads, classified: m.counts.classified_leads,
      classificationCoverage: m.rates.classification_coverage, sql: m.counts.sql,
      qualityAcceptedRate: m.rates.quality_accepted_rate, notRelevant: m.counts.not_relevant,
      lowQualityRate: m.rates.low_quality_rate, cohortSales: m.counts.cohort_sales,
      leadToSale: m.rates.lead_to_sale, cohortRevenue: m.money.cohort_revenue,
      sqlToSale: m.rates.sql_to_sale, salesLost: m.counts.sales_lost, salesLostRate: m.rates.sales_lost,
      periodSales: m.counts.period_sales, revenue: m.money.revenue, active: m.counts.active_cohort,
      avgProcessing: m.timing.avg_processing, overdueUnprocessed: m.sla.overdue, leadShare: 0 };
  });
  const total = built.reduce((sum, r) => sum + r.leads, 0);
  return built.map((r) => ({ ...r, leadShare: pct(r.leads, total), overdueRate: pct(r.overdueUnprocessed, r.leads) }));
}

const ALI = { salesManagerId: "7", salesManager: "Ali" };
const BOB = { salesManagerId: "9", salesManager: "Bob" };
const NOBODY = { salesManagerId: null, salesManager: null };
const COHORT = [
  deal({ dealId: "a1", ...ALI, qualified: true, stage: "ОБРАБОТКА" }),
  deal({ dealId: "a2", ...ALI, qualified: true, salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 700 }),
  deal({ dealId: "a3", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
  deal({ dealId: "a4", ...ALI, salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES" }),
  deal({ dealId: "a5", ...ALI, slaStatus: "OVERDUE_UNPROCESSED" }),
  deal({ dealId: "b1", ...BOB, qualified: true, salesStatus: "WON", wonAt: "2026-08-12T09:00:00.000Z", opportunity: 300 }),
  deal({ dealId: "b2", ...BOB }),
  deal({ dealId: "u1", ...NOBODY }),
  deal({ dealId: "r1", ...ALI, salesStatus: "LOST", lossReasonGroup: "ROUTING" }),
];
const WON = COHORT.filter((r) => r.salesStatus === "WON");
const ROWS = buildRows(COHORT, WON);
const ali = ROWS.find((r) => r.id === "7")!;
const bob = ROWS.find((r) => r.id === "9")!;
const unknown = ROWS.find((r) => r.id === "unknown")!;
const TOTAL = buildDashboardMetrics(COHORT, WON);

test("A: manager lead counts sum exactly to the dashboard Leadlar", () => {
  assert.equal(ROWS.reduce((s, r) => s + r.leads, 0), TOTAL.counts.leads);
  assert.equal(TOTAL.counts.leads, 8, "9 records minus the routed one");
  assert.ok(unknown, "the unattributed bucket is a row, so it stays in the denominator");
  assert.equal(unknown.leads, 1);
  // One deal, one manager group — no loss, no duplication.
  const grouped = ROWS.reduce((s, r) => s + r.leads, 0);
  assert.equal(grouped, COHORT.filter((r) => r.lossReasonGroup !== "ROUTING").length);
});

test("B/C: lead share divides by ALL manager rows, never a displayed slice", () => {
  assert.equal(ali.leadShare, pct(ali.leads, TOTAL.counts.leads));
  assert.equal(ali.leads, 5, "a1..a5; the routed r1 is excluded");
  assert.equal(ali.leadShare, 63);
  assert.equal(bob.leadShare, 25);
  assert.equal(unknown.leadShare, 13);
  // A top-8 slice must not change anyone's share.
  const sliced = ROWS.slice(0, 2);
  assert.equal(sliced.find((r) => r.id === "7")!.leadShare, ali.leadShare);
  // The source computes the denominator before any slicing, and the Dashboard
  // slices only at render.
  assert.match(client, /const totalLeads = built\.reduce/);
  // The Dashboard now hands over every row and lets the table sort before it
  // cuts, so the share denominator is never a displayed subset.
  assert.match(client, /rows=\{managers\} limit=\{8\}/, "the limit is applied inside the table, after sorting");
  assert.doesNotMatch(client, /managers\.slice\(0, 8\)/, "no pre-sort slice");
});

test("D/E/F: classification and quality columns are the canonical values", () => {
  assert.equal(ali.classified, 4, "3 qualified + 1 Not Relevant; a5 is unclassified");
  assert.equal(ali.classificationCoverage, pct(4, 5));
  assert.equal(ali.classificationCoverage, 80);
  assert.equal(ali.sql, 3);
  assert.equal(ali.qualityAcceptedRate, pct(ali.sql, ali.classified));
  assert.equal(ali.notRelevant, 1);
  assert.equal(ali.lowQualityRate, pct(ali.notRelevant, ali.classified));
  assert.equal(ali.qualityAcceptedRate + ali.lowQualityRate, 100);
});

test("G/H/I/J/K: cohort result and closing efficiency", () => {
  assert.equal(ali.cohortSales, 1);
  assert.equal(ali.cohortRevenue, 700, "sum over the manager's own cohort WON records");
  assert.equal(ali.leadToSale, pct(ali.cohortSales, ali.leads));
  assert.equal(ali.sqlToSale, pct(ali.cohortSales, ali.sql));
  assert.equal(ali.salesLost, 1);
  assert.equal(ali.salesLostRate, pct(ali.salesLost, ali.sql));
});

test("L/M: cohort and period sales stay different populations", () => {
  const lead = deal({ dealId: "split", ...ALI, qualified: true, salesStatus: "WON",
    createdAt: "2026-08-20T09:00:00.000Z", wonAt: "2026-09-04T09:00:00.000Z", opportunity: 500 });
  const aug = selectPeriodPopulations([lead], Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-31T23:59:59Z"));
  const sep = selectPeriodPopulations([lead], Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-30T23:59:59Z"));
  const august = buildRows(aug.cohort as AnalyticsRecord[], aug.periodSales as AnalyticsRecord[])[0];
  assert.equal(august.cohortSales, 1); assert.equal(august.cohortRevenue, 500);
  assert.equal(august.periodSales, 0); assert.equal(august.revenue, 0);
  const september = buildRows(sep.cohort as AnalyticsRecord[], sep.periodSales as AnalyticsRecord[])[0];
  assert.equal(september.periodSales, 1); assert.equal(september.revenue, 500);
  assert.equal(september.cohortSales, 0); assert.equal(september.cohortRevenue, 0);
});

test("N: active uses the canonical active_cohort, including currentScope", () => {
  const live = buildRows([deal({ dealId: "x", ...ALI })], [])[0];
  const gone = buildRows([deal({ dealId: "x", ...ALI, currentScope: "UNAVAILABLE" })], [])[0];
  assert.equal(live.active, 1);
  assert.equal(gone.active, 0, "an out-of-scope deal is not current workload");
  assert.equal(gone.leads, 1, "but it is still a historical lead");
  assert.match(client, /active: metrics\.counts\.active_cohort/);
  assert.doesNotMatch(client, /rows\.filter\(\(row\) => row\.salesStatus === "ACTIVE"\)\.length/, "no independent ACTIVE count");
});

test("O/P/Q: processing and overdue are distinct from the SLA rate", () => {
  assert.equal(ali.avgProcessing, buildDashboardMetrics(COHORT.filter((r) => salesManagerKey(r) === "7"), []).timing.avg_processing);
  assert.equal(ali.overdueUnprocessed, 1, "only OVERDUE_UNPROCESSED counts");
  const sla = summarizeSla(COHORT.filter((r) => salesManagerKey(r) === "7" && r.lossReasonGroup !== "ROUTING"));
  assert.equal(ali.overdueUnprocessed, sla.overdue);
  assert.equal(ali.overdueRate, pct(ali.overdueUnprocessed, ali.leads));
  assert.notEqual(ali.overdueRate, sla.rate, "the secondary % is not the SLA rate");
  assert.match(client, /overdueUnprocessed: metrics\.sla\.overdue/);
  assert.match(client, /leadlardan/, "the label says share of leads");
  assert.match(client, /Ishlov muddati o‘tgan/, "explicit column name");
});

test("R: the old fragmented columns are gone", () => {
  const table = client.slice(client.indexOf("function ManagerTable("), client.indexOf("function FiltersBar("));
  for (const gone of ['header("Summa"', 'header("Lead → Sotuv"', 'header("Sifatsiz lead %"', 'header("Sifatsiz"', 'header("Avg ishlov"', 'header("Muddati o‘tgan"', 'header("Lead"', 'header("Saralash qamrovi"'])
    assert.equal(table.includes(gone), false, `${gone} must be gone`);
  // And the new flow is present, in order.
  const order = ["Sotuvchi", "Leadlar", "Saralash", "SQL", "Not Relevant", "Cohort sotuv", "SQL → Sotuv", "Sotilmadi", "Davr sotuv", "Aktiv", "Avg saralash", "Ishlov muddati o‘tgan"];
  let cursor = -1;
  for (const label of order) {
    const at = table.indexOf(`header("${label}"`);
    assert.ok(at > cursor, `${label} must appear after the previous column`);
    cursor = at;
  }
  assert.match(table, /LEAD TAQSIMOTI/); assert.match(table, /SIFAT</);
  assert.match(table, /COHORT NATIJA/); assert.match(table, /DAVR NATIJA/); assert.match(table, /OPERATSIYA/);
});

test("S: every combined column sorts by its primary figure", () => {
  const table = client.slice(client.indexOf("function ManagerTable("), client.indexOf("function FiltersBar("));
  const expected: [string, string][] = [
    ["Leadlar", "leads"], ["Saralash", "classificationCoverage"], ["SQL", "sql"],
    ["Not Relevant", "notRelevant"], ["Cohort sotuv", "cohortSales"], ["SQL → Sotuv", "sqlToSale"],
    ["Sotilmadi", "salesLost"], ["Davr sotuv", "periodSales"], ["Aktiv", "active"],
    ["Avg saralash", "avgProcessing"], ["Ishlov muddati o‘tgan", "overdueUnprocessed"],
  ];
  for (const [label, key] of expected)
    assert.ok(table.includes(`header("${label}", "${key}")`), `${label} must sort by ${key}`);
  assert.match(table, /useState<keyof ManagerRow>\("periodSales"\)/, "default ranking unchanged");
  assert.match(table, /direction === "asc" \? compared : -compared/, "sort direction preserved");
});

test("T/U: row click still opens the detail, and both tables share one row model", () => {
  assert.match(client, /<tr key=\{row\.id\} onClick=\{\(\) => onSelect\(row\)\}/);
  assert.match(client, /onSelect=\{\(manager\) => \{ setSelectedManager\(manager\); setView\("managerDetail"\); \}\}/);
  // Dashboard top-8 and the Managers page build rows from the same inputs.
  // definition + Dashboard + Managers page + the profile's team benchmark
  assert.equal((client.match(/buildManagers\(/g) ?? []).length, 4);
  assert.match(client, /buildManagers\(records, salesRecords\)/);
  assert.match(client, /buildManagers\(cohortFiltered, wonFiltered\)/);
});

test("the manager row reuses canonical metrics rather than re-deriving them", () => {
  const fn = client.slice(client.indexOf("function buildManagers("), client.indexOf("function ManagerTable("));
  assert.match(fn, /buildDashboardMetrics\(cohort, won\)/, "one canonical build per manager");
  for (const forbidden = [/countSalesLost\(/, /isClassifiedLead\(/, /summarizeSla\(/][Symbol.iterator](); ;) {
    const next = forbidden.next(); if (next.done) break;
    assert.doesNotMatch(fn, next.value, `${next.value} must not be re-derived in buildManagers`);
  }
});

test("ManagerDetailView still exists and reads from the canonical profile", () => {
  assert.match(client, /function ManagerDetailView\(/);
  assert.match(client, /INDIVIDUAL PERFORMANCE/);
  // Redesigned in its own sprint: it now builds from buildManagerProfile
  // rather than deriving its own populations.
  assert.match(client, /buildManagerProfile\(cohortRecords, salesRecords, manager\.id\)/);
  assert.doesNotMatch(client, /Yangi lead/, "the old ambiguous card label is gone");
});

// ---------------------------------------------- sorting before the limit ---

/** The ordering ManagerTable applies: sort every row, then cut to `limit`. */
function visibleRows<T extends Record<string, unknown>>(rows: T[], sort: keyof T, direction: "asc" | "desc", limit?: number) {
  const sorted = [...rows].sort((a, b) => {
    const aValue = a[sort]; const bValue = b[sort];
    const compared = typeof aValue === "string" ? aValue.localeCompare(String(bValue)) : Number(aValue ?? Infinity) - Number(bValue ?? Infinity);
    return direction === "asc" ? compared : -compared;
  });
  return limit ? sorted.slice(0, limit) : sorted;
}

/**
 * Twelve managers. `sleeper` is deliberately last on periodSales and first on
 * SQL — the exact shape that made the old slice-then-sort ordering lie.
 */
const MANY = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `m${i}`, name: `M${i}`,
    periodSales: 20 - i,       // m0 highest … m10 lowest
    sql: i,                    // m0 lowest … m10 second-highest
    leads: 100 - i, leadShare: 0, sqlToSale: i * 2, overdueUnprocessed: i,
  })),
  { id: "sleeper", name: "Sleeper", periodSales: 0, sql: 999, leads: 5, leadShare: 0, sqlToSale: 99, overdueUnprocessed: 99 },
];

test("A/B: the Dashboard limit shows the real top 8 by the default column", () => {
  assert.equal(MANY.length, 12, "more managers than the Dashboard shows");
  const top = visibleRows(MANY, "periodSales", "desc", 8);
  assert.equal(top.length, 8);
  assert.deepEqual(top.map((r) => r.id), ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.equal(top.some((r) => r.id === "sleeper"), false, "lowest periodSales is not in the top 8");
});

test("C/D: sorting happens before slicing, so a hidden manager can enter the top 8", () => {
  // The bug: slicing first, then sorting, keeps the periodSales top-8 forever.
  const buggy = visibleRows(visibleRows(MANY, "periodSales", "desc", 8), "sql", "desc");
  assert.equal(buggy.some((r) => r.id === "sleeper"), false, "the old order could never surface it");
  assert.equal(buggy[0].id, "m7", "it would have called m7 the SQL leader");

  // Fixed: sort all twelve, then cut.
  const fixed = visibleRows(MANY, "sql", "desc", 8);
  assert.equal(fixed[0].id, "sleeper", "the actual SQL leader is shown");
  assert.equal(fixed.length, 8);
  assert.deepEqual(fixed.map((r) => r.id), ["sleeper", "m10", "m9", "m8", "m7", "m6", "m5", "m4"]);
  // And m0, top by periodSales, correctly drops out of an SQL ranking.
  assert.equal(fixed.some((r) => r.id === "m0"), false);

  // Ascending selects the genuine lowest 8.
  const lowest = visibleRows(MANY, "sql", "asc", 8);
  assert.deepEqual(lowest.map((r) => r.id), ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  assert.equal(lowest.some((r) => r.id === "sleeper"), false);

  // Same for the other columns the Dashboard offers.
  assert.equal(visibleRows(MANY, "sqlToSale", "desc", 8)[0].id, "sleeper");
  assert.equal(visibleRows(MANY, "overdueUnprocessed", "desc", 8)[0].id, "sleeper");
  assert.equal(visibleRows(MANY, "leads", "desc", 8)[0].id, "m0");
});

test("E/F: lead shares are computed over all managers and never re-derived after slicing", () => {
  const rows = buildRows(COHORT, WON);
  const shown = visibleRows(rows, "periodSales", "desc", 8);
  for (const row of shown) {
    const full = rows.find((r) => r.id === row.id)!;
    assert.equal(row.leadShare, full.leadShare, `${row.id} share unchanged by the limit`);
  }
  // The denominator is every row, so shares still reconcile to the whole team.
  assert.equal(rows.reduce((sum, r) => sum + r.leads, 0), TOTAL.counts.leads);
  // The component slices rendered rows only; it does not touch leadShare.
  const table = client.slice(client.indexOf("function ManagerTable("), client.indexOf("function FiltersBar("));
  assert.doesNotMatch(table, /leadShare\s*[:=]/, "ManagerTable must not recompute shares");
  assert.match(client, /const totalLeads = built\.reduce/, "the denominator still comes from buildManagers");
});

test("G: the Managers page passes no limit and shows every manager", () => {
  assert.equal(visibleRows(MANY, "periodSales", "desc").length, MANY.length);
  assert.equal(visibleRows(MANY, "periodSales", "desc", undefined).length, 12);
  assert.match(client, /<ManagerTable rows=\{managers\} limit=\{8\} onSelect=\{onManager\} \/>/, "Dashboard limits to 8");
  assert.match(client, /<ManagerTable rows=\{buildManagers\(cohortFiltered, wonFiltered\)\} onSelect=/, "Managers page has no limit");
  assert.doesNotMatch(client, /managers\.slice\(0, 8\)/, "the pre-sort slice is gone");
});

test("D: the component sorts, then slices, then renders", () => {
  const table = client.slice(client.indexOf("function ManagerTable("), client.indexOf("function FiltersBar("));
  const sortAt = table.indexOf("const sorted = useMemo");
  const sliceAt = table.indexOf("const visibleRows = useMemo");
  const renderAt = table.indexOf("visibleRows.map");
  assert.ok(sortAt > -1 && sliceAt > sortAt, "the slice derives from the sorted list");
  assert.ok(renderAt > sliceAt, "and the body renders the sliced list");
  assert.match(table, /limit \? sorted\.slice\(0, limit\) : sorted/);
  assert.doesNotMatch(table, /\{sorted\.map/, "the unsliced list must not be rendered");
});
