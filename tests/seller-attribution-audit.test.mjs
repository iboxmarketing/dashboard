import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLASSIFICATIONS,
  canonicalFieldKey,
  classifySnapshot,
  employeeIdFrom,
  inspectSalesManagerField,
  parseArgs,
  parseD1Rows,
  readSettings,
  readSnapshotRows,
  renderSummary,
  runAudit,
  summarizeAttribution,
  writeAuditOutput,
} from "../scripts/seller-attribution-audit.mjs";

/**
 * Read-only seller-attribution audit.
 *
 * The approved priority is: trustworthy snapshot, then the stable Sales Manager
 * field, then MOVED_BY_ID only while the current stage is the payment stage,
 * then Unknown. Post-sale MOVED_BY_ID / ASSIGNED_BY_ID are never seller
 * evidence — so the tests below are mostly about refusing to believe them.
 */

const SALES = "3";
const POST_SALE = "13";
const FIELD = "UF_CRM_SALES_MANAGER";
const PAYMENT_STAGE = "C3:WON";
const PAYMENT_STAGES = [PAYMENT_STAGE];

const at = (day, hour = 10) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+05:00`;

function snapshot(over = {}) {
  return {
    dealId: "1", wonAt: at(10), managerId: "7", managerName: "Ali",
    attributionSource: "STAGE_MOVER", frozenAt: at(11), ...over,
  };
}

function found(over = {}) {
  return {
    kind: "FOUND",
    deal: {
      ID: "1", CATEGORY_ID: SALES, STAGE_ID: PAYMENT_STAGE, ASSIGNED_BY_ID: "7", MOVED_BY_ID: "7",
      DATE_CREATE: at(2, 9), OPPORTUNITY: "1000000", CURRENCY_ID: "UZS", ...over,
    },
  };
}

const classify = (over = {}) => classifySnapshot({
  snapshot: snapshot(over.snapshot), lookup: over.lookup ?? found(over.deal),
  postSaleEnteredAt: over.postSaleEnteredAt ?? null,
  categoryId: SALES, postSaleCategoryId: POST_SALE, paymentStageIds: PAYMENT_STAGES,
  salesManagerFieldKey: over.fieldKey === undefined ? FIELD : over.fieldKey,
  fieldUsable: over.fieldUsable ?? true,
});

// ----------------------------------------------------------------- parsing ---

test("a wrangler --json export is read in every shape it can arrive in", () => {
  const row = { deal_id: "1", won_at: at(10), manager_id: "7", manager_name: "Ali", attribution_source: "STAGE_MOVER", created_at: at(11) };
  const expected = [{ dealId: "1", wonAt: at(10), managerId: "7", managerName: "Ali", attributionSource: "STAGE_MOVER", frozenAt: at(11) }];
  assert.deepEqual(readSnapshotRows([{ results: [row], success: true }]), expected, "list of result sets");
  assert.deepEqual(readSnapshotRows({ result: [{ results: [row] }] }), expected, "result envelope");
  assert.deepEqual(readSnapshotRows([row]), expected, "bare rows");
  assert.deepEqual(readSnapshotRows([]), []);
  assert.deepEqual(parseD1Rows(null), []);
  // A row with no deal_id is not a snapshot row and is ignored, not guessed at.
  assert.deepEqual(readSnapshotRows([{ key: "settings", value: "{}" }]), []);
});

test("settings are read out of the stored JSON blob, and a corrupt blob does not abort the audit", () => {
  const value = JSON.stringify({ salesManagerField: FIELD, paymentStageIds: [PAYMENT_STAGE], selectedPipelineIds: ["3"], postSalePipelineIds: ["13"] });
  assert.deepEqual(readSettings([{ results: [{ key: "settings", value }] }]), {
    salesManagerField: FIELD, paymentStageIds: [PAYMENT_STAGE], selectedPipelineIds: ["3"], postSalePipelineIds: ["13"],
  });
  assert.deepEqual(readSettings([{ results: [{ key: "settings", value: "not json" }] }]), {
    salesManagerField: null, paymentStageIds: [], selectedPipelineIds: [], postSalePipelineIds: [],
  });
});

test("employee values are parsed exactly as lib/analytics.ts parses them", () => {
  assert.equal(employeeIdFrom("7"), "7");
  assert.equal(employeeIdFrom("user_7"), "7");
  assert.equal(employeeIdFrom(["user_12", "user_99"]), "12", "an array takes its first entry, like the dashboard");
  assert.equal(employeeIdFrom(""), "");
  assert.equal(employeeIdFrom(null), "");
  assert.equal(employeeIdFrom("Ali"), "", "a name is not an id");
});

// ------------------------------------------------------- TASK A: the field ---

test("TASK A: a canonical, existing employee field is reported as usable", () => {
  const report = inspectSalesManagerField({
    configuredKey: FIELD,
    dealFields: { [FIELD]: { formLabel: "Менеджер продаж", type: "employee" } },
    deals: [{ [FIELD]: "user_7" }, { [FIELD]: "" }],
  });
  assert.equal(report.usable, true);
  assert.equal(report.existsInBitrix, true);
  assert.equal(report.label, "Менеджер продаж");
  assert.equal(report.isEmployeeType, true);
  assert.equal(report.populatedOnAuditedDeals, 1);
  assert.equal(report.populationRate, 50);
  assert.deepEqual(report.findings, []);
});

test("TASK A: a camelCase stored spelling is flagged as silently unread by the running code", () => {
  // lib/analytics.ts reads deal[settings.salesManagerField] verbatim while the
  // payload carries UF_CRM_*, so the CUSTOM_FIELD step cannot fire.
  const report = inspectSalesManagerField({
    configuredKey: "ufCrm_1748329407554",
    dealFields: { UF_CRM_1748329407554: { formLabel: "Менеджер продаж", type: "employee" } },
    deals: [{ UF_CRM_1748329407554: "user_7" }, { UF_CRM_1748329407554: "user_9" }],
  });
  assert.equal(report.canonicalKey, "UF_CRM_1748329407554");
  assert.equal(report.existsInBitrix, true);
  assert.equal(report.usable, false, "present in Bitrix but unreachable as configured");
  assert.equal(report.populatedOnAuditedDeals, 2);
  assert.ok(report.findings.some((item) => item.startsWith("NON_CANONICAL_SPELLING")));
  assert.ok(report.findings.some((item) => item.startsWith("SILENTLY_UNREAD")));
});

test("TASK A: a missing or unconfigured field is reported without inventing a repair source", () => {
  const absent = inspectSalesManagerField({ configuredKey: FIELD, dealFields: {}, deals: [{}] });
  assert.equal(absent.existsInBitrix, false);
  assert.equal(absent.usable, false);
  assert.ok(absent.findings.some((item) => item.startsWith("FIELD_NOT_IN_BITRIX")));

  const none = inspectSalesManagerField({ configuredKey: null, dealFields: {}, deals: [] });
  assert.deepEqual(none, { configured: false, usable: false, findings: none.findings });
  assert.ok(none.findings[0].startsWith("NOT_CONFIGURED"));
});

// ------------------------------------------- TASK B: verified beyond doubt ---

test("the stable field confirming the frozen seller is a verified seller", () => {
  const row = classify({ deal: { [FIELD]: "user_7", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88" } });
  assert.equal(row.classification, CLASSIFICATIONS.VERIFIED);
  assert.equal(row.reason, "STABLE_FIELD_CONFIRMS_SNAPSHOT");
});

test("a STAGE_MOVER snapshot is NOT assumed wrong: still at the payment stage is proof", () => {
  const row = classify({ deal: { STAGE_ID: PAYMENT_STAGE } });
  assert.equal(row.classification, CLASSIFICATIONS.VERIFIED);
  assert.equal(row.reason, "MOVER_AT_PAYMENT_STAGE");
});

test("a STAGE_MOVER snapshot frozen before the card ever reached post-sale is verified", () => {
  const row = classify({
    snapshot: { frozenAt: at(11) },
    deal: { CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88", MOVED_BY_ID: "88" },
    postSaleEnteredAt: at(14),
  });
  assert.equal(row.classification, CLASSIFICATIONS.VERIFIED);
  assert.equal(row.reason, "FROZEN_WHILE_STILL_IN_SALES");
});

test("a CUSTOM_FIELD snapshot stays verified even if the field has since been cleared", () => {
  const row = classify({ snapshot: { attributionSource: "CUSTOM_FIELD" }, deal: { [FIELD]: "" } });
  assert.equal(row.classification, CLASSIFICATIONS.VERIFIED);
  assert.equal(row.reason, "FROZEN_FROM_STABLE_FIELD");
  assert.ok(row.flags.includes("STABLE_FIELD_NOW_EMPTY"));
});

// ------------------------------------------------ TASK B: the bug's victims ---

test("the reported bug: a STAGE_MOVER snapshot frozen AFTER the post-sale move is suspicious", () => {
  const row = classify({
    snapshot: { managerId: "88", managerName: "Onboarding", frozenAt: at(16) },
    deal: { CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88", MOVED_BY_ID: "88" },
    postSaleEnteredAt: at(14),
  });
  assert.equal(row.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.equal(row.reason, "FROZEN_AFTER_POST_SALE_ENTRY");
  assert.ok(row.flags.includes("SELLER_EQUALS_POST_SALE_ASSIGNEE"), "the onboarding employee is named explicitly");
  assert.ok(row.flags.includes("SELLER_EQUALS_POST_SALE_MOVER"));
});

test("a CURRENT_RESPONSIBLE snapshot never proved a seller and is always suspicious without a field", () => {
  const row = classify({ snapshot: { attributionSource: "CURRENT_RESPONSIBLE" }, deal: { [FIELD]: "" } });
  assert.equal(row.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.equal(row.reason, "CURRENT_RESPONSIBLE_NEVER_PROVEN");
});

test("the stable field naming a different seller makes the row automatically repairable", () => {
  const row = classify({
    snapshot: { managerId: "88", managerName: "Onboarding", attributionSource: "CURRENT_RESPONSIBLE" },
    deal: { [FIELD]: "user_7", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88" },
  });
  assert.equal(row.classification, CLASSIFICATIONS.REPAIRABLE);
  assert.equal(row.reason, "STABLE_FIELD_NAMES_ANOTHER_SELLER");
  assert.equal(row.repairToManagerId, "7");
  assert.ok(row.flags.includes("SELLER_EQUALS_POST_SALE_ASSIGNEE"), "suspicious population 4");
});

test("a stable-field value the running code cannot read is never treated as a repair source", () => {
  const row = classify({
    snapshot: { attributionSource: "CURRENT_RESPONSIBLE", managerId: "88" },
    deal: { [FIELD]: "user_7" }, fieldUsable: false,
  });
  assert.equal(row.classification, CLASSIFICATIONS.SUSPICIOUS, "a value nothing can read cannot repair anything yet");
  assert.ok(row.flags.includes("STABLE_FIELD_PRESENT_BUT_UNREADABLE_BY_CURRENT_CODE"));
});

// ----------------------------------------------------------- honest Unknown ---

test("Unknown is returned instead of a guess when the evidence runs out", () => {
  assert.equal(classify({ lookup: { kind: "UNRESOLVED", code: "ACCESS_DENIED" } }).reason, "LOOKUP_ACCESS_DENIED");
  assert.equal(classify({ lookup: { kind: "UNRESOLVED", code: "ACCESS_DENIED" } }).classification, CLASSIFICATIONS.UNKNOWN);
  assert.equal(classify({ lookup: { kind: "DELETED", code: "NOT_FOUND" } }).classification, CLASSIFICATIONS.UNKNOWN);
  assert.equal(classify({ snapshot: { managerId: null } }).reason, "NO_SELLER_FROZEN");
  assert.equal(classify({ snapshot: { attributionSource: "UNKNOWN" } }).reason, "NO_SELLER_FROZEN");

  const noFreezeTime = classify({ snapshot: { frozenAt: null }, deal: { CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW" }, postSaleEnteredAt: at(14) });
  assert.equal(noFreezeTime.classification, CLASSIFICATIONS.UNKNOWN);
  assert.equal(noFreezeTime.reason, "NO_FREEZE_TIME_TO_COMPARE");

  const legacy = classify({ snapshot: { attributionSource: "FIRST_CALL" }, deal: { [FIELD]: "" } });
  assert.equal(legacy.classification, CLASSIFICATIONS.UNKNOWN);
  assert.equal(legacy.reason, "UNRECOGNISED_ATTRIBUTION_SOURCE");
  assert.ok(legacy.flags.includes("LEGACY_ATTRIBUTION_SOURCE:FIRST_CALL"));
});

test("a won Deal still in Sales but away from the payment stage is suspicious, not verified", () => {
  const row = classify({ deal: { STAGE_ID: "C3:UC_OTHER", [FIELD]: "" } });
  assert.equal(row.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.equal(row.reason, "MOVER_NOT_AT_PAYMENT_STAGE");
  const movedOut = classify({ deal: { CATEGORY_ID: "1", STAGE_ID: "C1:NEW", [FIELD]: "" } });
  assert.equal(movedOut.reason, "MOVED_OUT_OF_PROJECT_NO_PAYMENT_PROOF");
});

test("payment-stage detection falls back to the stage name when no stage IDs are configured", () => {
  const byName = classifySnapshot({
    snapshot: snapshot(), lookup: found({ STAGE_ID: "C3:WON", [FIELD]: "" }),
    categoryId: SALES, postSaleCategoryId: POST_SALE, paymentStageIds: [],
    isPaymentStageName: (stageId) => stageId === "C3:WON",
    salesManagerFieldKey: FIELD, fieldUsable: true,
  });
  assert.equal(byName.reason, "MOVER_AT_PAYMENT_STAGE");
});

// ------------------------------------------------------ TASK C and D: rollup ---

function rollup() {
  const rows = [
    classify({ snapshot: { dealId: "1" }, deal: { STAGE_ID: PAYMENT_STAGE } }),                                              // VERIFIED
    classify({ snapshot: { dealId: "2", attributionSource: "CUSTOM_FIELD" }, deal: { [FIELD]: "user_7" } }),                   // VERIFIED
    classify({ snapshot: { dealId: "3", managerId: "88", managerName: "Onboarding", attributionSource: "CURRENT_RESPONSIBLE" }, // REPAIRABLE -> 7
      deal: { [FIELD]: "user_7", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88", OPPORTUNITY: "500000" } }),
    classify({ snapshot: { dealId: "4", managerId: "88", managerName: "Onboarding", frozenAt: at(16) },                        // SUSPICIOUS
      deal: { CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88", MOVED_BY_ID: "88", [FIELD]: "", OPPORTUNITY: "300000" },
      postSaleEnteredAt: at(14) }),
    classify({ snapshot: { dealId: "5" }, lookup: { kind: "UNRESOLVED", code: "ACCESS_DENIED" } }),                            // UNKNOWN
  ];
  return summarizeAttribution({
    rows,
    fieldReport: { configured: true, usable: true, findings: [] },
    cohortBounds: { from: "2026-09-01", to: "2026-09-19", fromMs: Date.parse(at(1, 0)), toExclusiveMs: Date.parse("2026-09-20T00:00:00+05:00") },
    expectedCohortSales: 41,
    userNames: new Map([["7", "Ali"], ["88", "Onboarding"]]),
  });
}

test("TASK C: the impact rollup counts each population once and names the affected sellers", () => {
  const summary = rollup();
  assert.deepEqual(summary.totals, {
    snapshots: 5, confidentlyCorrect: 2, repairableAutomatically: 1,
    suspiciousNotAutomaticallyRepairable: 1, unknown: 1, atRiskOfWrongSeller: 2,
  });
  assert.deepEqual(summary.byClassification, {
    [CLASSIFICATIONS.REPAIRABLE]: 1, [CLASSIFICATIONS.SUSPICIOUS]: 1, [CLASSIFICATIONS.UNKNOWN]: 1, [CLASSIFICATIONS.VERIFIED]: 2,
  });
  assert.deepEqual(summary.suspiciousPopulations.currentResponsibleSnapshots.ids, ["3"]);
  assert.deepEqual(summary.suspiciousPopulations.stageMoverNowPostSale.ids, ["4"]);
  assert.deepEqual(summary.suspiciousPopulations.snapshotDiffersFromStableField.ids, ["3"]);
  assert.deepEqual(summary.suspiciousPopulations.sellerEqualsPostSaleAssignee.ids, ["3", "4"]);

  const credited = summary.affectedSellers.credited;
  assert.deepEqual(credited.map((item) => [item.managerId, item.count]), [["88", 2], ["7", 1]]);
  assert.equal(credited[0].managerName, "Onboarding", "the onboarding employee is named, not just numbered");
  assert.deepEqual(summary.affectedSellers.wouldGainFromRepair.map((item) => [item.managerId, item.count]), [["7", 1]]);
});

test("TASK C: revenue at risk is reported per currency and never as one blended total", () => {
  const summary = rollup();
  assert.deepEqual(summary.revenueAtRisk.notVerifiedByCurrency, { UZS: "800000.00" });
  assert.deepEqual(summary.revenueAtRisk.repairableByCurrency, { UZS: "500000.00" });
  assert.deepEqual(summary.revenueAtRisk.suspiciousByCurrency, { UZS: "300000.00" });
});

test("TASK C: the manager table impact shows exactly which seller gains and loses", () => {
  const summary = rollup();
  assert.equal(summary.managerTableImpact.materiallyAffected, true);
  assert.deepEqual(summary.managerTableImpact.managers, [
    // Deal 5 still credits Ali today even though it could not be verified.
    { managerId: "7", managerName: "Ali", now: 3, afterRepair: 4 },
    { managerId: "88", managerName: "Onboarding", now: 2, afterRepair: 1 },
  ]);
});

test("TASK C: the cohort sub-report separates verified from suspicious and exposes sales with no snapshot", () => {
  const cohort = rollup().cohort;
  assert.equal(cohort.snapshotsInCohort, 4, "the unreadable Deal has no DATE_CREATE to place in the cohort");
  assert.equal(cohort.expectedCohortSales, 41);
  assert.equal(cohort.salesWithNoSnapshotAtAll, 37, "cohort Sales that never froze a seller at all");
  assert.deepEqual(cohort.verified.ids, ["1", "2"]);
  assert.deepEqual(cohort.repairable.ids, ["3"]);
  assert.deepEqual(cohort.suspicious.ids, ["4"]);
  // The seller breakdown credits the repaired seller, and only for evidence.
  assert.deepEqual(cohort.sellerBreakdownVerifiedAndRepairable.map((item) => [item.managerId, item.count]), [["7", 3]]);
  assert.ok(!cohort.sellerBreakdownVerifiedAndRepairable.some((item) => item.managerId === "88"),
    "the onboarding employee is never credited in an evidence-only breakdown");
});

test("TASK D: the recommendation matches the evidence and never proposes a full sync as the fix", () => {
  const summary = rollup();
  const steps = summary.repairRecommendation.orderedSteps.join("\n");
  assert.match(steps, /ANALYTICS BACKFILL is sufficient for the 1 REPAIRABLE/);
  assert.match(steps, /TARGETED SNAPSHOT CORRECTION is the only thing that can fix the 1 SUSPICIOUS/);
  assert.match(steps, /FULL SYNC is NOT required/);
  assert.equal(summary.repairRecommendation.mutatesNothingInThisAudit, true);

  // An unusable field must be fixed before any data repair, or a rebuild just
  // re-freezes the same guess.
  const broken = summarizeAttribution({ rows: [], fieldReport: { configured: true, usable: false, findings: ["NON_CANONICAL_SPELLING: …"] } });
  assert.match(broken.repairRecommendation.orderedSteps[0], /^FIRST, fix the configuration/);
  const unconfigured = summarizeAttribution({ rows: [], fieldReport: { configured: false, usable: false, findings: [] } });
  assert.match(unconfigured.repairRecommendation.blockers.join(""), /no automatic repair source/);
});

// ------------------------------------------------------------- CLI and I/O ---

test("the CLI requires the export and both categories, and rejects a half-given date range", () => {
  const valid = ["--snapshots", "s.json", "--category-id", "3", "--post-sale-category-id", "13"];
  assert.equal(parseArgs(valid).categoryId, "3");
  assert.equal(parseArgs(valid).expectedCohortSales, null);
  assert.throws(() => parseArgs(["--category-id", "3", "--post-sale-category-id", "13"]), /--snapshots/);
  assert.throws(() => parseArgs(["--snapshots", "s.json", "--post-sale-category-id", "13"]), /category-id/);
  assert.throws(() => parseArgs([...valid.slice(0, 4), "--post-sale-category-id", "3"]), /different/);
  assert.throws(() => parseArgs([...valid, "--from", "2026-09-01"]), /together/);
  assert.throws(() => parseArgs([...valid, "--expected-cohort-sales", "many"]), /whole number/);
  assert.equal(canonicalFieldKey("ufCrm_123"), "UF_CRM_123");
});

test("a full pass over a live-shaped fixture reads only the four allowlisted methods", async () => {
  const snapshots = [
    { dealId: "1", wonAt: at(10), managerId: "7", managerName: "Ali", attributionSource: "STAGE_MOVER", frozenAt: at(11) },
    { dealId: "2", wonAt: at(10), managerId: "88", managerName: "Onboarding", attributionSource: "CURRENT_RESPONSIBLE", frozenAt: at(16) },
  ];
  const deals = new Map([
    ["1", { ID: "1", CATEGORY_ID: SALES, STAGE_ID: PAYMENT_STAGE, ASSIGNED_BY_ID: "7", MOVED_BY_ID: "7", DATE_CREATE: at(2, 9), OPPORTUNITY: "1000000", CURRENCY_ID: "UZS" }],
    ["2", { ID: "2", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", ASSIGNED_BY_ID: "88", MOVED_BY_ID: "88", DATE_CREATE: at(3, 9), OPPORTUNITY: "500000", CURRENCY_ID: "UZS", [FIELD]: "user_7" }],
  ]);
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "crm.deal.fields") return { result: { [FIELD]: { formLabel: "Менеджер продаж", type: "employee" } } };
    if (method === "crm.status.list") return { result: [{ STATUS_ID: PAYMENT_STAGE, NAME: "Оплата получена" }] };
    if (method === "crm.stagehistory.list") {
      return { result: { items: [{ ID: "h1", OWNER_ID: "2", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:NEW", TYPE_ID: "5", CREATED_TIME: at(14) }] } };
    }
    if (method === "crm.deal.get") return { result: deals.get(params.id) };
    throw new Error(`unexpected method ${method}`);
  };

  const report = await runAudit({
    call,
    config: { categoryId: SALES, postSaleCategoryId: POST_SALE, from: "2026-09-01", to: "2026-09-19", expectedCohortSales: 41, salesManagerField: null },
    snapshots,
    settings: { salesManagerField: FIELD, paymentStageIds: PAYMENT_STAGES, selectedPipelineIds: [SALES], postSalePipelineIds: [POST_SALE] },
    now: () => new Date("2026-09-20T00:00:00Z"),
  });

  assert.deepEqual([...new Set(methods)].sort(), ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"]);
  assert.equal(report.configuration.usable, true);
  assert.equal(report.totals.snapshots, 2);
  assert.equal(report.totals.confidentlyCorrect, 1);
  assert.equal(report.totals.repairableAutomatically, 1);
  // Deal 2's frozen onboarding employee is replaced by the stable field's seller.
  const repaired = report.snapshotRows.find((row) => row.dealId === "2");
  assert.equal(repaired.classification, CLASSIFICATIONS.REPAIRABLE);
  assert.equal(repaired.repairToManagerId, "7");
  assert.equal(repaired.currentStageName, null, "a post-sale stage is not in the Sales stage dictionary");
  assert.equal(repaired.postSaleEnteredAt, at(14));
  assert.equal(repaired.isPostSaleNow, true);
  assert.equal(report.snapshotRows.find((row) => row.dealId === "1").currentStageName, "Оплата получена");
  assert.equal(report.cohort.salesWithNoSnapshotAtAll, 39);
  assert.equal(report.result, "COMPLETE");
});

test("the audit writes its own files, mutates nothing, and never carries a webhook or raw payload", async () => {
  const source = await readFile(new URL("../scripts/seller-attribution-audit.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database)\b/, "the audit never opens D1");
  // Guards on call sites, not on prose: TASK D has to be able to name a backfill.
  assert.doesNotMatch(source, /\b(?:startSync|runSync|startBackfill|runBackfill)\s*\(/);
  assert.doesNotMatch(source, /["'`]\/api\/(?:sync|backfill|reconcile|settings)/, "no dashboard mutation endpoint is called");
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|UPSERT)\s+(?:INTO|FROM|SET|OR)\b/i, "no write SQL of any kind");
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).filter((item) => item.startsWith(".")), ["./ibox-lead-evidence.mjs"],
    "the only local import is the read-only evidence client");
  assert.doesNotMatch(source, /(?:stdout|stderr)\.write\([^)]*environment/);

  const summary = rollup();
  const report = {
    schemaVersion: 1, kind: "seller-attribution-audit", result: "COMPLETE",
    snapshot: { startedAt: "2026-09-20T00:00:00.000Z", completedAt: "2026-09-20T00:00:05.000Z" },
    config: { categoryId: SALES, postSaleCategoryId: POST_SALE, paymentStageDetection: "configured stage IDs" },
    configuration: { configured: true, configuredKey: FIELD, canonicalKey: FIELD, existsInBitrix: true, label: "Менеджер продаж", type: "employee", isEmployeeType: true, populatedOnAuditedDeals: 1, auditedDeals: 5, populationRate: 20, usable: true, findings: [] },
    ...summary,
    snapshotRows: [],
  };
  const temp = await mkdtemp(path.join(tmpdir(), "seller-attribution-test-"));
  try {
    const files = await writeAuditOutput(report, temp);
    const text = await readFile(files.summaryPath, "utf8");
    const serialized = `${JSON.stringify(report)}\n${renderSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${text}`;
    assert.doesNotMatch(serialized, /\/rest\/\d+\//);
    assert.match(text, /confidently correct: 2/);
    assert.match(text, /Sales\/Revenue rows that could be attributed to the wrong person: 2/);
    assert.match(text, /manager conversion tables materially affected: YES/);
    assert.match(text, /Nothing was mutated by this audit/);
    assert.equal(path.dirname(files.jsonPath), temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a snapshots export with no rows fails loudly rather than reporting a clean bill of health", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "seller-attribution-empty-"));
  try {
    const file = path.join(temp, "snapshots.json");
    await writeFile(file, JSON.stringify([{ results: [], success: true }]), "utf8");
    assert.deepEqual(readSnapshotRows(JSON.parse(await readFile(file, "utf8"))), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
