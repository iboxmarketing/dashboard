import assert from "node:assert/strict";
import test from "node:test";

import { ANALYTICS_VERSION, buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { buildQualityAnalytics } from "../lib/quality-analytics";
import {
  classifyLossReasonGroup, dealOutcomeLabel, isClassifiedLead, isEligibleCohortDeal, isPreSqlClosed,
  isProductFitOutcome, isProductFitStage, isSalesLost, isSqlOrDownstreamStage, isUnclassifiedLead,
} from "../lib/sales-logic";
import { PRODUCT_FIT_STAGE } from "../lib/stage-config";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";
import type { StageMeta } from "../lib/stage-config";

/**
 * The product-fit outcome: a real client our programme does not fit.
 *
 * Owner decision, 2026-09-24. It is a Lead and it is Saralanmagan, it is NOT SQL,
 * NOT Not Relevant and NOT Sotilmadi, and it blames nobody — so it may never
 * reach a seller's Lost score. Alongside it, the defect that produced the
 * discrepancy: a Bitrix failure stage was read as "downstream of SQL" evidence
 * purely because of its SORT.
 */

const MAIN = "3";
const SQL_STAGE = "C3:UC_9SUEMM";
const LOSE_STAGE = "C3:LOSE";
const FIT_STAGE = PRODUCT_FIT_STAGE; // C3:UC_FKITQ2
const FIRST_TOUCH = "C3:UC_L52PGZ";

/** The real category-3 catalogue, including SORT and Bitrix SEMANTICS. */
const STAGE_META = new Map<string, StageMeta>([
  ["C3:NEW", { sort: 10, categoryId: MAIN, semantics: "" }],
  [FIRST_TOUCH, { sort: 40, categoryId: MAIN, semantics: "" }],
  [SQL_STAGE, { sort: 50, categoryId: MAIN, semantics: "" }],
  ["C3:WON", { sort: 100, categoryId: MAIN, semantics: "S" }],
  [LOSE_STAGE, { sort: 110, categoryId: MAIN, semantics: "F" }],
  ["C3:UC_C0725V", { sort: 120, categoryId: MAIN, semantics: "F" }],
  [FIT_STAGE, { sort: 130, categoryId: MAIN, semantics: "F" }],
  ["C3:UC_NEWLOSS", { sort: 140, categoryId: MAIN, semantics: "F" }],
]);
const STAGES = new Map<string, string>([
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"], [FIRST_TOUCH, "Первое касаниe"], [SQL_STAGE, "ОБРАБОТКА"],
  ["C3:WON", "Оплата получена"], [LOSE_STAGE, "Сделка провалена"], ["C3:UC_C0725V", "Not relevant"],
  [FIT_STAGE, "Klient lekin programma nepodxodit"], ["C3:UC_NEWLOSS", "Boshqa yopilish"],
]);

const SETTINGS: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: [MAIN], selectedPipelineNames: ["IBOX Sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["Post"],
  qualifiedStageIds: [SQL_STAGE], lowQualityStageIds: ["C3:UC_C0725V"],
  closedLostStageIds: [LOSE_STAGE], paymentStageIds: ["C3:WON"],
  productFitStageIds: [FIT_STAGE],
  failureReasonField: "UF_CRM_REASON",
};

/** Deal 43293's real path: NEW → Первое касаниe → the product-fit stage. */
function build(stageId: string, options: { history?: string[]; reason?: string; settings?: DashboardSettings } = {}) {
  const path = options.history ?? ["C3:NEW", FIRST_TOUCH, stageId];
  const [record] = buildAnalyticsRecords({
    deals: [{
      ID: "43293", TITLE: "Ishlab chiqarish", DATE_CREATE: "2026-09-09T05:02:24+03:00",
      DATE_MODIFY: "2026-09-21T15:14:56+03:00", CLOSEDATE: "2026-09-21T03:00:00+03:00", CLOSED: "Y",
      CATEGORY_ID: MAIN, STAGE_ID: stageId, MOVED_TIME: "2026-09-21T15:14:56+03:00",
      ASSIGNED_BY_ID: "17", OPPORTUNITY: 0, CURRENCY_ID: "UZS", SOURCE_ID: "CALL",
      UF_CRM_REASON: options.reason ?? "программа не подходит",
    }],
    stageHistories: path.map((stage, index) => ({
      // `crm.stagehistory.list` keys its rows by OWNER_ID — the analytics builder
      // groups on exactly that.
      ID: String(index + 1), OWNER_ID: "43293", CATEGORY_ID: MAIN, STAGE_ID: stage,
      STAGE_SEMANTIC_ID: STAGE_META.get(stage)?.semantics || "P", TYPE_ID: String(index + 1),
      CREATED_TIME: `2026-09-${String(9 + index * 6).padStart(2, "0")}T09:00:00+03:00`,
    })) as never,
    settings: options.settings ?? SETTINGS,
    users: new Map([["17", "Po'latxon Ashuraliyev"]]),
    pipelines: new Map([[MAIN, "IBOX Sales"], ["13", "Post"]]),
    stages: STAGES, sources: new Map([["CALL", "Call"]]), stageMeta: STAGE_META,
    domain: null, stageHistoryAvailable: true,
  });
  return record;
}

test("1. a product-fit closure is a Lead and Saralanmagan, and nothing else", () => {
  const record = build(FIT_STAGE);
  assert.equal(record.analyticsVersion, ANALYTICS_VERSION);
  assert.equal(record.lossReasonGroup, "PRODUCT_FIT");
  assert.equal(record.salesStatus, "LOST", "it is still a closed Deal in Bitrix");
  assert.equal(record.qualified, false, "SQL = NO");
  assert.equal(record.qualifiedStageId, null, "no fabricated qualification evidence");
  assert.equal(record.qualifiedAt, null);

  const row = record as unknown as DashboardRecord;
  assert.ok(isEligibleCohortDeal(row), "Lead = YES");
  assert.ok(isUnclassifiedLead(row), "Saralanmagan = YES");
  assert.equal(isClassifiedLead(row), false, "Saralangan = NO");
  assert.equal(isSalesLost(row), false, "Sales Lost = NO");
  assert.equal(row.lossReasonGroup === "MARKETING", false, "Not Relevant = NO");
  assert.ok(isProductFitOutcome(row), "Product Fit = YES");
  assert.equal(isPreSqlClosed(row), false, "preSqlClosed stays false — its definition requires a SALES loss");
  assert.deepEqual(dealOutcomeLabel(row), { label: "Programma mos emas", tone: "neutral" });
});

test("2. the same Deal in the ordinary lost stage is still SQL + Sotilmadi", () => {
  const record = build(LOSE_STAGE) as unknown as DashboardRecord;
  assert.equal(record.lossReasonGroup, "SALES");
  assert.ok(record.qualified, "the approved direct-close rule still applies");
  assert.ok(isSalesLost(record));
  assert.ok(isClassifiedLead(record));
  assert.equal(isProductFitOutcome(record), false);
  assert.ok(isPreSqlClosed(record), "and the missing evidence trail is still flagged");
});

test("3. a Bitrix failure stage is never downstream-SQL evidence, configured or not", () => {
  const thresholds = new Map([[MAIN, 50]]);
  const ask = (stageId: string) => isSqlOrDownstreamStage({
    stageId, stage: STAGES.get(stageId) ?? stageId, categoryId: MAIN,
    thresholds, stageMeta: STAGE_META, config: SETTINGS,
  });
  assert.equal(ask(FIT_STAGE), false, "the product-fit stage");
  assert.equal(ask(LOSE_STAGE), false, "the configured lost stage");
  assert.equal(ask("C3:UC_C0725V"), false, "the configured Not Relevant stage");
  // The defect: an UNCONFIGURED new failure stage whose SORT sits after Обработка.
  assert.equal(ask("C3:UC_NEWLOSS"), false, "an unconfigured semantics=F stage");
  assert.ok(ask("C3:WON"), "a won stage still proves qualification");
  assert.ok(ask(SQL_STAGE), "and so does the configured SQL stage itself");
  // Semantics passed explicitly must behave the same way.
  assert.equal(isSqlOrDownstreamStage({
    stageId: "C3:UNKNOWN", stage: "Boshqa", categoryId: MAIN, semantic: "F",
    thresholds, stageMeta: new Map([["C3:UNKNOWN", { sort: 200, categoryId: MAIN }]]), config: SETTINGS,
  }), false);
});

test("4. an unconfigured failure stage is NOT silently treated as product fit", () => {
  const record = build("C3:UC_NEWLOSS") as unknown as DashboardRecord;
  assert.equal(record.lossReasonGroup, "SALES", "it stays an ordinary Sales loss until the owner classifies it");
  assert.equal(isProductFitOutcome(record), false);
  assert.equal(isProductFitStage("C3:UC_NEWLOSS", SETTINGS), false);
  assert.ok(isProductFitStage(FIT_STAGE, SETTINGS));
  // …and with no configured list at all, nothing is product fit.
  assert.equal(isProductFitStage(FIT_STAGE, {}), false);
});

test("5. the classifier reads the stage, never the reason text", () => {
  const group = (stageId: string, reason: string) => classifyLossReasonGroup({
    status: "LOST", reason, stageId, config: SETTINGS, routingPatterns: ["idoko", "sd"],
  });
  assert.equal(group(FIT_STAGE, "программа не подходит"), "PRODUCT_FIT");
  assert.equal(group(FIT_STAGE, ""), "PRODUCT_FIT", "an empty reason does not change the stage's meaning");
  assert.equal(group(LOSE_STAGE, "программа не подходит"), "SALES", "the same reason elsewhere is an ordinary loss");
  assert.equal(group(FIT_STAGE, "idoko"), "PRODUCT_FIT", "a product-fit stage outranks a routing reason");
  assert.equal(classifyLossReasonGroup({ status: "LOW_QUALITY", reason: "x", stageId: FIT_STAGE, config: SETTINGS }), "MARKETING");
});

test("6. the KPI partition: +1 Saralanmagan, -1 Sotilmadi, -1 SQL, +1 Product Fit", () => {
  const asRow = (record: ReturnType<typeof build>) => record as unknown as DashboardRecord;
  const others = [
    { ...asRow(build(LOSE_STAGE)), dealId: "1" },
    { ...asRow(build(SQL_STAGE, { history: ["C3:NEW", SQL_STAGE] })), dealId: "2" },
  ] as DashboardRecord[];
  const asProductFit = [...others, { ...asRow(build(FIT_STAGE)), dealId: "3" }];
  const asSalesLost = [...others, { ...asRow(build(LOSE_STAGE)), dealId: "3" }];

  const fit = buildDashboardMetrics(asProductFit, []);
  const lost = buildDashboardMetrics(asSalesLost, []);
  assert.equal(fit.counts.leads, lost.counts.leads, "Lead is unchanged either way");
  assert.equal(fit.counts.unclassified_leads, lost.counts.unclassified_leads + 1);
  assert.equal(fit.counts.sales_lost, lost.counts.sales_lost - 1);
  assert.equal(fit.counts.sql, lost.counts.sql - 1);
  assert.equal(fit.counts.not_relevant, lost.counts.not_relevant, "Not Relevant never moves");
  assert.equal(fit.counts.product_fit, 1);
  assert.equal(lost.counts.product_fit, 0);
  // The partition still adds up: Saralangan + Saralanmagan = Lead.
  assert.equal(fit.counts.classified_leads + fit.counts.unclassified_leads, fit.counts.leads);
});

test("7. Quality reports it on its own line, out of Marketing and Sales reasons", () => {
  const rows = [
    build(FIT_STAGE) as unknown as DashboardRecord,
    // A distinct reason, so the assertions below prove where each reason landed
    // rather than matching the same text twice.
    { ...(build(LOSE_STAGE, { reason: "Dorogo" }) as unknown as DashboardRecord), dealId: "2" },
  ];
  const analytics = buildQualityAnalytics(rows);
  assert.equal(analytics.summary.productFit, 1);
  assert.equal(analytics.summary.salesLost, 1, "the product-fit Deal is not a Sales loss");
  assert.equal(analytics.summary.notRelevant, 0);
  assert.equal(analytics.summary.productFitReasons[0]?.reason, "программа не подходит");
  assert.equal(analytics.marketingReasons.some((row) => row.reason === "программа не подходит"), false);
  assert.equal(analytics.salesReasons.some((row) => row.reason === "программа не подходит"), false);
  // Nobody is blamed: the Deal contributes to no manager's Sotilmadi.
  assert.equal(analytics.salesManagers.reduce((sum, row) => sum + row.salesLost, 0), 1);
});
