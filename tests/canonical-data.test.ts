import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { isEligibleCohortDeal, isPreSqlClosed, isSalesLost, resolveProjectMembership } from "../lib/sales-logic";
import {
  buildSalesSection, diagnosticsDataSection, membershipDiagnostics, prepareSalesBase, prepareSalesRecords, projectScopedRecords,
  marketingChannelDiagnostics, type SalesQuery,
} from "../lib/sales-sections";
import { notRelevantRecords, salesLostRecords } from "../lib/manager-profile";
import { nextDealDiscoveryScope } from "../lib/period-sales-coverage";
import {
  REFRESH_BATCH_SIZE, REFRESH_CANDIDATES_SQL, classifyRefreshStep, currentRefreshAudit, refreshMisses,
} from "../lib/known-deal-refresh";
import { LOOKUP_BATCH_LIMIT } from "../lib/deal-snapshot";
import { isSnapshotCandidate } from "../lib/sales-snapshots";
import { resolveDealSource, validMarketingChannelField } from "../lib/source-authority";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/*
 * Production data canonicalization.
 *
 *  - IBOX Sales = 3, its post-sale = 13. A Deal is a Lead once it legitimately
 *    entered 3; it stays one while it sits in 3 or 13 and is excluded while it
 *    sits in any other project's funnel.
 *  - A record older than persisted membership must never become a Lead just
 *    because the legacy fallback ("everything except routing") says so.
 *  - A Full Sync re-reads every Deal it knows about, not only the scoped funnels.
 *  - Source is the configured Marketing channel, else SOURCE_ID.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const SETTINGS: DashboardSettings = { ...defaultSettings, selectedPipelineIds: ["3"], postSalePipelineIds: ["13"] };
const PROJECT = new Set(["3", "13"]);
const QUERY: SalesQuery = { from: "2026-09-01", to: "2026-09-19", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" } as SalesQuery;

function row(over: Partial<DashboardRecord> & { dealId: string }): DashboardRecord {
  return {
    analyticsVersion: 11, title: "t", createdAt: "2026-09-05T06:00:00.000Z", creationPeriod: "WORK_HOURS", slaStart: "2026-09-05T06:00:00.000Z",
    assignedManagerId: "7", assignedManager: "M", categoryId: "3", pipeline: "IBOX sales", originCategoryId: "3", originPipeline: "IBOX sales",
    operationalPipeline: true, projectLeadMembership: "INCLUDED", stageId: "C3:NEW", stage: "New", stageEnteredAt: "2026-09-05T06:00:00.000Z",
    stageAgeHours: 1, stageLimitHours: 24, stageOverdue: false, sourceId: "WEBFORM", source: "CRM-форма", salesStatus: "ACTIVE",
    qualified: false, qualifiedAt: null, qualifiedStageId: null, qualifiedStage: null, wonAt: null, salesCycleHours: null,
    opportunity: 0, currencyId: "UZS", lossReason: "", lossReasonGroup: "NONE", contactId: null, companyId: null, customerKey: null,
    duplicateOfDealId: null, salesManagerId: "7", salesManager: "M", salesManagerAttribution: "CUSTOM_FIELD",
    processingBusinessMinutes: 5, processingSource: "QUALIFICATION_STAGE", slaStatus: "ON_TIME", stageHistoryCount: 2,
    ...over,
  } as DashboardRecord;
}

const IBOX = [
  row({ dealId: "100", qualified: true, qualifiedStageId: "C3:SQL" }),
  row({ dealId: "101", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
  row({ dealId: "102", salesStatus: "WON", qualified: true, wonAt: "2026-09-10T06:00:00.000Z", opportunity: 559_000, categoryId: "13" }),
  row({ dealId: "103" }),
];
// Stale version-7 rows: no persisted membership, last seen outside the project.
const STALE = [
  row({ dealId: "900", analyticsVersion: 7, projectLeadMembership: undefined, categoryId: "5", originCategoryId: "3", qualified: true, salesStatus: "WON", wonAt: "2026-09-11T06:00:00.000Z", opportunity: 1_000_000 }),
  row({ dealId: "901", analyticsVersion: 7, projectLeadMembership: undefined, categoryId: "31", originCategoryId: "3", qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES" }),
  row({ dealId: "902", analyticsVersion: 7, projectLeadMembership: undefined, categoryId: "17", originCategoryId: "5" }),
];

test("a stale record from another project's funnel is never a Lead, whatever the legacy fallback would say", () => {
  assert.deepEqual(resolveProjectMembership({ categoryId: "5", lossReasonGroup: "SALES" }, PROJECT), { membership: "EXCLUDED", basis: "LEGACY_OTHER_PROJECT" });
  assert.deepEqual(resolveProjectMembership({ categoryId: "31", lossReasonGroup: "NONE" }, PROJECT), { membership: "EXCLUDED", basis: "LEGACY_OTHER_PROJECT" });
  // The legacy fallback alone would have counted both:
  assert.equal(isEligibleCohortDeal({ lossReasonGroup: "SALES" }), true);

  const now = new Date("2026-09-22T08:00:00Z");
  const context = { can: () => true, settings: SETTINGS, dataAsOf: null };
  const leadOnly = STALE.filter((r) => r.salesStatus !== "WON");
  const withStale = prepareSalesRecords([...IBOX, ...leadOnly], SETTINGS, now);
  const without = prepareSalesRecords(IBOX, SETTINGS, now);
  for (const section of ["dashboard", "managers", "leadFlow", "quality"] as const) {
    assert.equal(
      JSON.stringify(buildSalesSection(section, withStale, QUERY, context)),
      JSON.stringify(buildSalesSection(section, without, QUERY, context)),
      `${section}: stale other-project rows add no Lead, SQL, Sales Lost or quality figure`,
    );
  }

  // A sale proven in IBOX and moved elsewhere afterwards leaves Leadlar and
  // cohort Sales but keeps its Period Sale (docs/BUSINESS_RULES.md §4). The
  // stale row is not a Lead; its sale is judged by the documented Period rule.
  const all = prepareSalesRecords([...IBOX, ...STALE], SETTINGS, now);
  const cohort = all.filter((r) => r.createdAt >= "2026-08-31T19:00:00Z");
  const metrics = buildDashboardMetrics(cohort, all.filter((r) => r.salesStatus === "WON"));
  assert.equal(metrics.counts.leads, 4, "900 and 901 are not Leads");
  assert.equal(metrics.counts.cohort_sales, 1, "the moved sale is not a cohort Sale");
  assert.equal(metrics.counts.sales_lost, 0, "901's closure is not Sales Lost");

  // The reason breakdowns under those cards must use the same population.
  assert.deepEqual(salesLostRecords(cohort).map((r) => r.dealId), [], "an excluded closure is not in the Sales Lost list");
  assert.deepEqual(notRelevantRecords(cohort).map((r) => r.dealId), ["101"]);
});

test("an older in-project record with no decision is kept as UNRESOLVED and counted as needing refresh", () => {
  const legacy = [
    row({ dealId: "700", analyticsVersion: 7, projectLeadMembership: undefined, categoryId: "3" }),
    row({ dealId: "701", analyticsVersion: 7, projectLeadMembership: undefined, categoryId: "3", salesStatus: "LOST", lossReasonGroup: "ROUTING" }),
    row({ dealId: "702", analyticsVersion: 7, projectLeadMembership: undefined, categoryId: "17", originCategoryId: "3" }),
  ];
  const prepared = prepareSalesBase([...IBOX, ...legacy], SETTINGS);
  const byId = new Map(prepared.map((r) => [r.dealId, r]));
  assert.equal(byId.get("700")?.projectLeadMembership, "UNRESOLVED");
  assert.equal(isEligibleCohortDeal(byId.get("700")!), true, "never silently excluded");
  assert.equal(byId.get("701")?.projectLeadMembership, "EXCLUDED", "legacy transfer evidence still excludes, as before");
  assert.equal(byId.get("702")?.projectLeadMembership, "EXCLUDED");
  assert.equal(byId.get("100")?.membershipBasis, "RECORD", "a decided record keeps its decision");
  assert.deepEqual(membershipDiagnostics(prepared), { needsRefresh: 1, legacyOtherProject: 1, legacyRouting: 1 });
  assert.deepEqual(diagnosticsDataSection(prepared).membership, { needsRefresh: 1, legacyOtherProject: 1, legacyRouting: 1 });
});

test("public shares and the Stage funnel read records through the same project scope as the dashboard", () => {
  const share = code("../app/share/[token]/route.ts");
  assert.match(share, /loadSalesRecords\(\)\.then\(\(loaded\) => loaded\.records\)/);
  assert.doesNotMatch(share, /listAnalyticsRecords/, "no raw-table path of its own");
  const funnel = code("../app/api/stage-funnel/route.ts");
  assert.match(funnel, /projectScopedRecords\(rows\.map\(\(row\) => JSON\.parse\(row\) as StageFunnelRecord\), settings\)/);
  const scoped = projectScopedRecords([...IBOX, ...STALE], SETTINGS);
  assert.deepEqual(scoped.map((r) => [r.dealId, r.projectLeadMembership]), [
    ["100", "INCLUDED"], ["101", "INCLUDED"], ["102", "INCLUDED"], ["103", "INCLUDED"], ["900", "EXCLUDED"], ["901", "EXCLUDED"],
  ], "902 started and sits outside the project and is not even carried");
});

test("a Full Sync ends with a refresh of every known Deal; an incremental sync never does", () => {
  const full = { hasPaymentStages: true, hasPostSale: true, refreshKnown: true };
  assert.equal(nextDealDiscoveryScope("postSale", full), "refresh");
  assert.equal(nextDealDiscoveryScope("refresh", full), null);
  assert.equal(nextDealDiscoveryScope("currentPayment", { ...full, hasPostSale: false }), "refresh");
  assert.equal(nextDealDiscoveryScope("postSale", { ...full, refreshKnown: false }), null);
  assert.equal(nextDealDiscoveryScope("main", full), "paymentHistory", "event streams still come first");

  const sync = code("../lib/sync.ts");
  assert.match(sync, /refreshKnown: job\.mode === "full"/);
  assert.match(sync, /if \(job\.dealScope === "refresh"\) return await refreshKnownStep\(/);
  // Only a definitive NOT_FOUND may change a stored record — and only its scope.
  assert.match(sync, /if \(entry\.outcome === "NOT_FOUND"\) await setAnalyticsCurrentScope\(entry\.dealId, "DELETED"\)/);
  const refreshStep = sync.slice(sync.indexOf("async function refreshKnownStep"), sync.indexOf("async function stageStep"));
  assert.doesNotMatch(refreshStep, /DELETE\s+FROM|\bdelete\(/i, "the refresh deletes nothing — a gone Deal is marked, never erased");
  assert.match(refreshStep, /setAnalyticsCurrentScope\(entry\.dealId, "DELETED"\)/);
  // Refreshed Deals take the ordinary path: written under the run id.
  assert.match(sync, /upsertRaw\("raw_deals", deals\.map\(\(deal\) => \[value\(deal, "ID"\), value\(deal, "CATEGORY_ID"\) \|\| "0", value\(deal, "DATE_CREATE"\), JSON\.stringify\(deal\), job\.runId\]\)\);\n\n  const listed/);

  assert.match(REFRESH_CANDIDATES_SQL, /FROM raw_deals WHERE synced_at <> \?1/);
  assert.match(REFRESH_CANDIDATES_SQL, /FROM deal_sales_snapshots s\s+WHERE NOT EXISTS \(SELECT 1 FROM raw_deals r WHERE r\.deal_id = s\.deal_id\)/, "orphan sale snapshots are refreshed too");
  assert.match(REFRESH_CANDIDATES_SQL, /ORDER BY deal_id\s+LIMIT \?2 OFFSET \?3/);
  assert.ok(REFRESH_BATCH_SIZE <= LOOKUP_BATCH_LIMIT, "every miss in a step can be looked up in the same step");
});

test("refresh outcomes: only Bitrix's definitive answer is NOT_FOUND; everything else is kept for a human", () => {
  const entries = classifyRefreshStep({
    candidates: [
      { dealId: "1", origin: "RAW" }, { dealId: "2", origin: "SNAPSHOT" }, { dealId: "3", origin: "RAW" },
      { dealId: "4", origin: "SNAPSHOT" }, { dealId: "5", origin: "RAW" },
    ],
    listed: new Map([["1", { categoryId: "5", stageId: "C5:WON" }]]),
    lookups: new Map([
      ["2", { found: false, reason: "NOT_FOUND", code: "EMPTY_RESULT" }],
      ["3", { found: false, reason: "LOOKUP_ERROR", code: "HTTP_503" }],
      ["4", { found: true, deal: { id: "4", title: "", categoryId: "3", stageId: "C3:WON", closed: true, closeDate: null, createdAt: null, modifiedAt: null, movedAt: null, assignedById: null, opportunity: 0, currencyId: "UZS" } }],
    ]),
  });
  assert.deepEqual(entries.map((e) => [e.dealId, e.outcome, e.categoryId, e.code]), [
    ["1", "REFRESHED", "5", null], ["2", "NOT_FOUND", null, "EMPTY_RESULT"], ["3", "LOOKUP_ERROR", null, "HTTP_503"],
    ["4", "FOUND_NOT_LISTED", "3", null], ["5", "LOOKUP_ERROR", null, "NOT_ATTEMPTED"],
  ]);
  assert.equal(refreshMisses(entries), 4, "misses stay in the candidate set, so the offset advances by them");
  assert.deepEqual(currentRefreshAudit({ runId: "old", entries }, "new"), { runId: "new", entries: [] }, "an audit never mixes runs");
});

test("a rebuilt Deal from another project never freezes a seller snapshot", () => {
  assert.equal(isSnapshotCandidate({ salesStatus: "WON", wonAt: "2026-08-10T00:00:00Z", projectLeadMembership: "INCLUDED" }), true);
  assert.equal(isSnapshotCandidate({ salesStatus: "WON", wonAt: "2026-08-10T00:00:00Z", projectLeadMembership: "UNRESOLVED" }), true);
  assert.equal(isSnapshotCandidate({ salesStatus: "WON", wonAt: "2026-08-10T00:00:00Z", projectLeadMembership: "EXCLUDED" }), false);
  assert.equal(isSnapshotCandidate({ salesStatus: "WON", wonAt: null, projectLeadMembership: "INCLUDED" }), false);
  assert.match(code("../lib/storage.ts"), /const won = records\.filter\(isSnapshotCandidate\);/);
});

test("SQL rule: an ordinary direct Sales Lost is SQL and Sales Lost; Not Relevant is never SQL", () => {
  const stages = new Map([["C3:NEW", "New"], ["C3:SQL", "ОБРАБОТКА"], ["C3:NR", "Not relevant"], ["C3:LOSE", "Сделка провалена"]]);
  const settings: DashboardSettings = { ...SETTINGS, qualifiedStageIds: ["C3:SQL"], lowQualityStageIds: ["C3:NR"], closedLostStageIds: ["C3:LOSE"], failureReasonField: "UF_CRM_R" };
  const build = (stageId: string, path: string[], reason = "") => buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: "2026-09-05T11:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: "3", STAGE_ID: stageId, MOVED_TIME: "2026-09-06T11:00:00+05:00", UF_CRM_R: reason }],
    activities: [], callStats: [], providerRules: {}, settings, users: new Map([["7", "A"]]),
    stageHistories: path.map((id, index) => ({ OWNER_ID: "1", CATEGORY_ID: "3", STAGE_ID: id, CREATED_TIME: `2026-09-05T1${index + 1}:00:00+05:00` })),
    pipelines: new Map([["3", "IBOX"]]), stages, sources: new Map(), domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
  const direct = build("C3:LOSE", ["C3:NEW", "C3:LOSE"], "qimmat");
  assert.equal(direct.qualified, true, "direct ordinary close is SQL");
  assert.equal(isSalesLost(direct), true, "and Sales Lost");
  assert.equal(isPreSqlClosed(direct), true, "kept only as a diagnostic");
  const nrAfterSql = build("C3:NR", ["C3:NEW", "C3:SQL", "C3:NR"]);
  assert.equal(nrAfterSql.qualified, false, "Not Relevant is not SQL even after an SQL stage");
  assert.equal(nrAfterSql.lossReasonGroup, "MARKETING");
});

test("source is SOURCE_ID only; the Marketing channel is a separate dimension", () => {
  const options = new Map([["UF_CRM_1784823646", new Map([["101", "Instagram"], ["102", "Telegram"]])]]);
  const sources = new Map([["WEBFORM", "CRM-форма"]]);
  const resolve = (deal: Record<string, unknown>, field: string | null = "UF_CRM_1784823646") =>
    resolveDealSource({ deal, marketingChannelField: field, fieldOptions: options, sources });

  // Source is SOURCE_ID's label, whatever the channel says (owner decision).
  assert.deepEqual(resolve({ SOURCE_ID: "WEBFORM", UF_CRM_1784823646: "101" }),
    { source: "CRM-форма", rawSource: "CRM-форма", marketingChannel: "Instagram" });
  assert.deepEqual(resolve({ SOURCE_ID: "WEBFORM", UF_CRM_1784823646: "" }),
    { source: "CRM-форма", rawSource: "CRM-форма", marketingChannel: null });
  assert.equal(resolve({ SOURCE_ID: "WEBFORM", UF_CRM_1784823646: "999" }).marketingChannel, null, "an option Bitrix no longer lists is not a label");
  assert.equal(resolve({ SOURCE_ID: "WEBFORM", UF_CRM_1784823646: "101" }, "ufCrm_1784823646").marketingChannel, "Instagram", "a camelCase configuration reads the same field");
  assert.equal(resolve({ SOURCE_ID: "WEBFORM", UF_CRM_1784823646: "101" }, null).marketingChannel, null, "no configured field, no channel");
  assert.equal(resolve({ SOURCE_ID: "" }).source, "Aniqlanmagan", "a Deal with no SOURCE_ID is unknown, never invented");

  const known = new Set(["UF_CRM_1784823646", "SOURCE_ID"]);
  assert.equal(validMarketingChannelField("UF_CRM_1784823646", known), "UF_CRM_1784823646");
  assert.equal(validMarketingChannelField("ufCrm_1784823646", known), "ufCrm_1784823646");
  assert.equal(validMarketingChannelField("UF_CRM_404", known), null, "a field Bitrix no longer lists is dropped");
  assert.equal(validMarketingChannelField("UF_CRM_404", new Set()), "UF_CRM_404", "an unreadable field list keeps the configuration");

  const sync = code("../lib/sync.ts");
  assert.doesNotMatch(sync, /marketing\.\*channel|маркет\.\*канал/, "the field is never detected by name");
  assert.match(sync, /marketingChannelField: validMarketingChannelField\(settings\.marketingChannelField, knownFieldKeys\)/);
  assert.match(sync, /normalizeSafeStableSellerField\(settings\.salesManagerField\),[\s\S]{0,400}?settings\.marketingChannelField,\n  \]\)\]/, "the Full Sync selects the configured field");
  assert.match(sync, /normalizeSalesOwnerAtWonField\(settings\.salesOwnerAtWonField\),/, "and the canonical seller field");

  const records = buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: "2026-09-05T11:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: "3", STAGE_ID: "C3:NEW", SOURCE_ID: "WEBFORM", UF_CRM_1784823646: "102" }],
    activities: [], callStats: [], providerRules: {}, settings: { ...SETTINGS, marketingChannelField: "UF_CRM_1784823646" }, users: new Map(),
    stageHistories: [], pipelines: new Map([["3", "IBOX"]]), stages: new Map(), sources, fieldOptions: options, domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  });
  assert.equal(records[0].source, "CRM-форма", "Source never comes from the channel");
  assert.equal(records[0].sourceId, "WEBFORM", "the raw SOURCE_ID is preserved");
  assert.equal(records[0].rawSource, "CRM-форма");
  assert.equal(records[0].marketingChannel, "Telegram", "the channel stays available as its own dimension");
  assert.deepEqual(marketingChannelDiagnostics([records[0], { marketingChannel: null }, {}]), { withChannel: 1, withoutChannel: 2 });
});
