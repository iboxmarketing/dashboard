import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAnalyticsRecords, type RawDeal, type RawStageHistory } from "../lib/analytics";
import { buildStatusMaps } from "../lib/analytics-dictionaries";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { classifyLegacySalesOwner } from "../lib/legacy-seller-autoconfirm";
import { groupDealsByProject } from "../lib/project-records";
import { responseMatchesProject, withProject } from "../lib/project-url";
import { buildManagers, prepareSalesRecords, projectScopedRecords, salesPopulations, type SalesQuery } from "../lib/sales-sections";
import { createSalesBaseCache, salesCacheKey } from "../lib/sales-cache";
import {
  DEFAULT_PROJECT, PROJECT_KEYS, SALES_DOCTOR_OWNER_AT_WON_FIELD, SALES_DOCTOR_ROSTER, SALES_DOCTOR_STAGES, SALES_PROJECTS,
  dealProjectFamily, parseProjectKey, projectBySlug, projectForCategory, recordProject, scopeSettingsToProject,
  PROJECT_SELLER_IDENTITY, canonicalSellerId, currentStageQuality, historicalSellerIds,
  seedSalesDoctorSettings, stageBelongsToProject, withProjectPipelines, type ProjectKey,
} from "../lib/sales-projects";
import { OWNER_OVERRIDES } from "../lib/seller-overrides";
import { PROJECT_SELLER_NAMES, directoryUsers, resolveRoster } from "../lib/seller-roster";
import { distributionStageId } from "../lib/stage-config";
import { SALES_OWNER_AT_WON_FIELD } from "../lib/stable-seller-field";
import { isSalesLost } from "../lib/sales-logic";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/**
 * IBOX and Sales Doctor as isolated analytics workspaces.
 *
 * One Bitrix portal, one raw Deal truth, two interpretations. These tests pin the
 * boundary: which project a Deal belongs to, which rules interpret it, which
 * stages, roster, seller field and SLA stage each project sees, and that nothing
 * of one project — a stage, a seller, a cached answer, a setting — reaches the
 * other. The Sales Doctor facts are the live Bitrix ones (DEAL_STAGE_5/17,
 * user directory) as synced on 2026-10-01.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---- the real stage dictionary, both projects -------------------------------

const STATUS_ROWS = [
  ["DEAL_STAGE_3", "C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10, null], ["DEAL_STAGE_3", "C3:UC_05P04E", "НЕТ ОТВЕТА", 20, null],
  ["DEAL_STAGE_3", "C3:UC_9SUEMM", "ОБРАБОТКА", 50, null], ["DEAL_STAGE_3", "C3:WON", "Оплата получена", 100, "S"],
  ["DEAL_STAGE_3", "C3:LOSE", "Сделка провалена", 110, "F"], ["DEAL_STAGE_3", "C3:UC_C0725V", "Not relevant", 120, "F"],
  ["DEAL_STAGE_3", "C3:UC_FKITQ2", "Klient lekin programma nepodxodit", 130, "F"],
  ["DEAL_STAGE_13", "C13:NEW", "Обучение", 10, null],
  ["DEAL_STAGE_5", "C5:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10, null], ["DEAL_STAGE_5", "C5:PREPARATION", "НЕ ОТВЕЧАЕТ", 20, null],
  ["DEAL_STAGE_5", "C5:PREPAYMENT_INVOICE", "ОБРАБОТКА", 30, null], ["DEAL_STAGE_5", "C5:EXECUTING", "ВСТРЕЧА НАЗНАЧЕНА", 40, null],
  ["DEAL_STAGE_5", "C5:WON", "ЕСТЬ ЗАПУСК!", 100, "S"], ["DEAL_STAGE_5", "C5:LOSE", "ЗАКРЫТО И НЕ РЕАЛИЗОВАНО", 110, "F"],
  ["DEAL_STAGE_5", "C5:UC_X51N7T", "Not Relevant (Marketing)", 120, "F"],
  ["DEAL_STAGE_17", "C17:UC_99W1TL", "Неразобранное", 10, null], ["DEAL_STAGE_17", "C17:NEW", "Mentor bricktirildi", 20, null],
].map(([entity, id, name, sort, semantics]) => ({ ENTITY_ID: entity, STATUS_ID: id, NAME: name, SORT: sort, SEMANTICS: semantics }));
const { stages, sources, stageMeta } = buildStatusMaps([...STATUS_ROWS, { ENTITY_ID: "SOURCE", STATUS_ID: "WEB", NAME: "Veb-sayt" }]);

// ---- people -------------------------------------------------------------------

const IBOX_SELLER = "4151"; // Sanjar Juraev
const SD_SELLER = "235"; // Abdulla Norboyev
const SD_SELLER_2 = "13121"; // Behruz Abdulazizov
const CUSTOMER_CARE = "209"; // Sanjar Sattarov, Customer Care Specialist
const USERS = new Map([[IBOX_SELLER, "Sanjar Juraev"], [SD_SELLER, "Abdulla Norboyev"], [SD_SELLER_2, "Behruz Abdulazizov"], [CUSTOMER_CARE, "Sanjar Sattarov"],
  ["223", "Abubakir Rahimov"], ["12565", "Abubakir Rahimov"], ["199", "Otabek Sulaymonov"]]);

// ---- each project's settings, exactly as the app derives them -----------------

const IBOX_SETTINGS: DashboardSettings = withProjectPipelines({
  ...defaultSettings,
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"], paymentStageIds: ["C3:WON"],
  closedLostStageIds: ["C3:LOSE"], productFitStageIds: ["C3:UC_FKITQ2"], distributionStageIds: ["C3:NEW"],
  salesStaffIds: [IBOX_SELLER], salesOwnerAtWonField: SALES_OWNER_AT_WON_FIELD, slaMinutes: 240,
}, "IBOX");
const SD_SETTINGS: DashboardSettings = withProjectPipelines(seedSalesDoctorSettings(IBOX_SETTINGS), "SALES_DOCTOR");
const SETTINGS: Record<ProjectKey, DashboardSettings> = { IBOX: IBOX_SETTINGS, SALES_DOCTOR: SD_SETTINGS };

const DAY = "2026-09-15";
const at = (clock: string, day = DAY) => `${day}T${clock}:00+05:00`;

type DealCase = {
  id: string; categoryId: string; stageId: string; responsible: string;
  history: [string, string][]; fields?: Record<string, unknown>; observers?: number[]; opportunity?: number;
};

/** Build Deals the way the sync does: grouped by project family, each with its own rules. */
function buildRecords(cases: DealCase[], fallback: ProjectKey = "IBOX") {
  const deals: RawDeal[] = cases.map((c) => ({
    ID: c.id, TITLE: `Deal ${c.id}`, DATE_CREATE: at("10:01"), ASSIGNED_BY_ID: c.responsible, CATEGORY_ID: c.categoryId,
    STAGE_ID: c.stageId, MOVED_TIME: at("17:00"), SOURCE_ID: "WEB", OPPORTUNITY: String(c.opportunity ?? 1_000_000),
    CURRENCY_ID: "UZS", observers: c.observers ?? [], ...c.fields,
  } as RawDeal));
  const histories: RawStageHistory[] = cases.flatMap((c) => c.history.map(([stageId, clock]) => ({
    OWNER_ID: c.id, CATEGORY_ID: /^C(\d+):/.exec(stageId)![1], STAGE_ID: stageId, CREATED_TIME: at(clock),
  } as RawStageHistory)));
  const pipelines = new Map(PROJECT_KEYS.flatMap((key) => [
    [SALES_PROJECTS[key].salesCategoryId, SALES_PROJECTS[key].salesCategoryName],
    [SALES_PROJECTS[key].postSaleCategoryId, SALES_PROJECTS[key].postSaleCategoryName],
  ] as [string, string][]));
  const records = [];
  for (const [project, group] of groupDealsByProject(deals, histories, fallback)) {
    records.push(...buildAnalyticsRecords({
      deals: group.deals, stageHistories: group.histories, settings: SETTINGS[project], projectKey: project,
      users: USERS, pipelines, stages, sources, stageMeta, domain: null, stageHistoryAvailable: true,
    }));
  }
  return records as unknown as DashboardRecord[];
}

const NOW = new Date("2026-09-30T12:00:00Z");
const QUERY = { from: "2026-09-01", to: "2026-09-30", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" } as SalesQuery;
const population = (records: DashboardRecord[], project: ProjectKey) => prepareSalesRecords(records, SETTINGS[project], NOW, project);

// A small, realistic mixed dataset: IBOX and Sales Doctor Deals side by side.
const MIXED: DealCase[] = [
  { id: "3001", categoryId: "3", stageId: "C3:UC_9SUEMM", responsible: IBOX_SELLER, history: [["C3:NEW", "10:01"], ["C3:UC_9SUEMM", "10:30"]] },
  { id: "3002", categoryId: "13", stageId: "C13:NEW", responsible: CUSTOMER_CARE, history: [["C3:NEW", "10:01"], ["C3:WON", "12:00"], ["C13:NEW", "13:00"]],
    fields: { [SALES_OWNER_AT_WON_FIELD]: IBOX_SELLER }, opportunity: 7_000_000 },
  { id: "5001", categoryId: "5", stageId: "C5:PREPAYMENT_INVOICE", responsible: SD_SELLER, history: [["C5:NEW", "10:01"], ["C5:PREPAYMENT_INVOICE", "10:20"]] },
  { id: "5002", categoryId: "17", stageId: "C17:NEW", responsible: CUSTOMER_CARE, history: [["C5:NEW", "10:01"], ["C5:WON", "12:00"], ["C17:NEW", "13:00"]],
    fields: { [SALES_DOCTOR_OWNER_AT_WON_FIELD]: SD_SELLER }, opportunity: 3_000_000 },
];

// ---- A / B / C ---------------------------------------------------------------

test("A. the IBOX workspace holds only category 3/13 Deals and IBOX stages", () => {
  const records = population(buildRecords(MIXED), "IBOX");
  assert.deepEqual(records.map((row) => row.dealId).sort(), ["3001", "3002"]);
  assert.ok(records.every((row) => ["3", "13"].includes(String(row.categoryId))));
  assert.ok(records.every((row) => !String(row.stage).includes("ЕСТЬ ЗАПУСК")), "no Sales Doctor stage");
});

test("B. the Sales Doctor workspace holds only category 5/17 Deals", () => {
  const records = population(buildRecords(MIXED), "SALES_DOCTOR");
  assert.deepEqual(records.map((row) => row.dealId).sort(), ["5001", "5002"]);
  assert.ok(records.every((row) => ["5", "17"].includes(String(row.categoryId))));
});

test("C. Sales Doctor's funnel, stage options and settings name no category-3 stage", () => {
  const records = population(buildRecords(MIXED), "SALES_DOCTOR");
  const section = { options: salesPopulations(records, QUERY) };
  assert.ok(section.options.cohort.every((row) => !String(row.stageId ?? "").startsWith("C3:")));
  // The stage-funnel projection goes through the same gate.
  const funnel = projectScopedRecords(buildRecords(MIXED), SD_SETTINGS, "SALES_DOCTOR");
  assert.deepEqual(funnel.map((row) => row.dealId).sort(), ["5001", "5002"]);
  // Settings are scoped on save: an IBOX stage can never land in Sales Doctor's rules.
  const polluted = scopeSettingsToProject({ ...SD_SETTINGS, qualifiedStageIds: ["C3:UC_9SUEMM", "C5:PREPAYMENT_INVOICE"], lowQualityStageIds: ["C3:UC_C0725V", "C5:UC_X51N7T"] }, "SALES_DOCTOR");
  assert.deepEqual(polluted.qualifiedStageIds, ["C5:PREPAYMENT_INVOICE"]);
  assert.deepEqual(polluted.lowQualityStageIds, ["C5:UC_X51N7T"]);
  // The pipelines route offers the project's own two funnels only.
  const route = read("app/api/pipelines/route.ts");
  assert.match(route, /const categoryIds = projectCategoryIds\(scoped\.project\);/);
  assert.match(route, /listPipelineStages\(categoryIds\)/);
  assert.equal(stageBelongsToProject("C3:NEW", "SALES_DOCTOR"), false);
  assert.equal(stageBelongsToProject("C17:NEW", "SALES_DOCTOR"), true);
});

test("D. Stage Control reads LIVE category-5 Deals for Sales Doctor, and only its cached records", () => {
  assert.deepEqual(SD_SETTINGS.selectedPipelineIds, ["5"], "the live query's category list");
  assert.deepEqual(IBOX_SETTINGS.selectedPipelineIds, ["3"]);
  const route = read("app/api/current-stages/route.ts");
  assert.match(route, /const settings = await getSettings\(scoped\.project\);/);
  assert.match(route, /const categoryIds = \[\.\.\.new Set\(settings\.selectedPipelineIds/);
  assert.match(route, /listAnalyticsRecords\(\)\.then\(\(rows\) => rows\.filter\(\(row\) => recordProject\(row\) === scoped\.project\)\)/);
});

// ---- E. switching projects -------------------------------------------------------

test("E. IBOX -> Sales Doctor -> IBOX leaves nothing stale behind", () => {
  // A workspace is its own route and a fresh mount: no state survives a switch.
  const client = read("app/dashboard-client.tsx");
  assert.match(client, /<DashboardApp key=\{project\} session=\{session\} project=\{project\} \/>/);
  assert.match(read("app/ibox/page.tsx"), /<DashboardClient project="IBOX" \/>/);
  assert.match(read("app/sales-doctor/page.tsx"), /<DashboardClient project="SALES_DOCTOR" \/>/);
  // Every section read carries the project, and an answer for the other one is refused.
  assert.equal(withProject("/api/sales/managers?from=2026-09-01", "SALES_DOCTOR"), "/api/sales/managers?from=2026-09-01&project=SALES_DOCTOR");
  assert.equal(responseMatchesProject({ project: "IBOX" }, "SALES_DOCTOR"), false);
  assert.equal(responseMatchesProject({ project: "SALES_DOCTOR" }, "SALES_DOCTOR"), true);
  assert.match(read("app/sales-data.tsx"), /if \(project && !responseMatchesProject\(payload, project\)\)/);
  // The server cache keeps one slot per project, keyed by the project too.
  const cache = createSalesBaseCache();
  const fingerprint = { rowCount: 1, syncedAt: "x", dictionariesAt: null, syncStateAt: null, syncJobAt: null };
  const ibox = population(buildRecords(MIXED), "IBOX");
  const sd = population(buildRecords(MIXED), "SALES_DOCTOR");
  cache.set(salesCacheKey(fingerprint, IBOX_SETTINGS, "IBOX"), ibox, 0, "IBOX");
  cache.set(salesCacheKey(fingerprint, SD_SETTINGS, "SALES_DOCTOR"), sd, 0, "SALES_DOCTOR");
  assert.equal(cache.get(salesCacheKey(fingerprint, IBOX_SETTINGS, "IBOX"), 1, "IBOX"), ibox);
  assert.equal(cache.get(salesCacheKey(fingerprint, SD_SETTINGS, "SALES_DOCTOR"), 1, "SALES_DOCTOR"), sd);
  assert.equal(cache.get(salesCacheKey(fingerprint, IBOX_SETTINGS, "IBOX"), 1, "SALES_DOCTOR"), null, "an IBOX key never answers Sales Doctor");
  assert.notEqual(salesCacheKey(fingerprint, IBOX_SETTINGS, "IBOX"), salesCacheKey(fingerprint, IBOX_SETTINGS, "SALES_DOCTOR"));
});

// ---- F / G. transfers between products --------------------------------------------

test("F. a Deal moved 3 -> 5 leaves IBOX and joins Sales Doctor, interpreted by Sales Doctor's rules", () => {
  const records = buildRecords([{ id: "7001", categoryId: "5", stageId: "C5:PREPAYMENT_INVOICE", responsible: SD_SELLER,
    history: [["C3:NEW", "10:01"], ["C3:UC_05P04E", "10:10"], ["C5:NEW", "11:00"], ["C5:PREPAYMENT_INVOICE", "11:20"]] }]);
  assert.equal(records[0].projectKey, "SALES_DOCTOR");
  assert.equal(records[0].interpretedBy, "SALES_DOCTOR");
  assert.equal(records[0].originCategoryId, "5", "its Sales Doctor origin, not its IBOX past");
  assert.deepEqual(population(records, "IBOX").map((row) => row.dealId), []);
  assert.deepEqual(population(records, "SALES_DOCTOR").map((row) => row.dealId), ["7001"]);
  assert.equal(records[0].slaStartAt, new Date(at("11:00")).toISOString(), "the SLA clock starts at C5:NEW, not at C3:NEW");
});

test("G. a Deal moved 5 -> 3 leaves Sales Doctor and joins IBOX", () => {
  const records = buildRecords([{ id: "7002", categoryId: "3", stageId: "C3:UC_9SUEMM", responsible: IBOX_SELLER,
    history: [["C5:NEW", "10:01"], ["C3:NEW", "11:00"], ["C3:UC_9SUEMM", "11:30"]] }]);
  assert.equal(records[0].projectKey, "IBOX");
  assert.deepEqual(population(records, "SALES_DOCTOR").map((row) => row.dealId), []);
  assert.deepEqual(population(records, "IBOX").map((row) => row.dealId), ["7002"]);
  // Never both at once, whatever the history holds.
  assert.equal(dealProjectFamily("3", "5"), "IBOX");
  assert.equal(dealProjectFamily("5", "3"), "SALES_DOCTOR");
  // A Deal that left both families stays with the family it came from.
  assert.equal(dealProjectFamily("31", "3"), "IBOX");
  assert.equal(dealProjectFamily("31", "5"), "SALES_DOCTOR");
  assert.equal(dealProjectFamily("31", "31"), null);
});

// ---- H / I / J / K. Sales Doctor quality ----------------------------------------

test("H. Sales Doctor Not Relevant (Marketing): NR yes, SQL no", () => {
  const [record] = buildRecords([{ id: "8001", categoryId: "5", stageId: SALES_DOCTOR_STAGES.notRelevant, responsible: SD_SELLER,
    history: [["C5:NEW", "10:01"], [SALES_DOCTOR_STAGES.notRelevant, "10:40"]] }]);
  assert.equal(record.lossReasonGroup, "MARKETING");
  assert.equal(record.qualified, false);
});

test("I. an ordinary Sales Doctor loss is SQL AND Sales Lost, even closed directly", () => {
  const [record] = buildRecords([{ id: "8002", categoryId: "5", stageId: SALES_DOCTOR_STAGES.salesLost, responsible: SD_SELLER,
    history: [["C5:NEW", "10:01"], [SALES_DOCTOR_STAGES.salesLost, "10:40"]] }]);
  assert.equal(record.lossReasonGroup, "SALES");
  assert.equal(record.qualified, true, "a real client who was not sold");
  assert.equal(isSalesLost(record), true);
});

test("J. ЕСТЬ ЗАПУСК! is a Sales Doctor sale and SQL", () => {
  const [record] = buildRecords([{ id: "8003", categoryId: "5", stageId: SALES_DOCTOR_STAGES.won, responsible: SD_SELLER,
    history: [["C5:NEW", "10:01"], ["C5:PREPAYMENT_INVOICE", "10:20"], [SALES_DOCTOR_STAGES.won, "15:00"]],
    fields: { [SALES_DOCTOR_OWNER_AT_WON_FIELD]: SD_SELLER } }]);
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.qualified, true);
  assert.equal(record.wonAt, new Date(at("15:00")).toISOString());
  assert.equal(record.salesManagerId, SD_SELLER);
  assert.equal(record.sellerCertification, "CERTIFIED");
  // ОБРАБОТКА (SORT 30) and later are SQL; НЕ ОТВЕЧАЕТ (SORT 20) is not.
  const [notAnswering] = buildRecords([{ id: "8004", categoryId: "5", stageId: "C5:PREPARATION", responsible: SD_SELLER,
    history: [["C5:NEW", "10:01"], ["C5:PREPARATION", "10:15"]] }]);
  assert.equal(notAnswering.qualified, false);
  const [processing] = buildRecords([{ id: "8005", categoryId: "5", stageId: "C5:EXECUTING", responsible: SD_SELLER,
    history: [["C5:NEW", "10:01"], ["C5:EXECUTING", "11:00"]] }]);
  assert.equal(processing.qualified, true);
});

test("K. in category 17 it stays a Sales Doctor sale, and onboarding never takes the credit", () => {
  const [withField] = buildRecords([MIXED[3]]);
  assert.equal(withField.projectKey, "SALES_DOCTOR");
  assert.equal(withField.salesStatus, "WON");
  assert.equal(withField.salesManagerId, SD_SELLER, "the SD Sales Owner at Won field, not the category-17 Responsible");
  assert.equal(withField.salesManagerAttribution, "SALES_OWNER_AT_WON");
  assert.notEqual(withField.salesManagerId, CUSTOMER_CARE);
  // Without the field, the onboarding Responsible is still never the seller.
  const [withoutField] = buildRecords([{ ...MIXED[3], id: "5003", fields: {} }]);
  assert.notEqual(withoutField.sellerCertification === "CERTIFIED" ? withoutField.salesManagerId : null, CUSTOMER_CARE);
  assert.notEqual(withoutField.sellerCertification, "CERTIFIED", "no certified seller without evidence");
  // IBOX's seller field is never read for a Sales Doctor Deal.
  const [ibox] = buildRecords([{ ...MIXED[3], id: "5004", fields: { [SALES_OWNER_AT_WON_FIELD]: IBOX_SELLER } }]);
  assert.notEqual(ibox.salesManagerId, IBOX_SELLER, "UF_CRM_1790230512 is IBOX's field only");
  assert.equal(SD_SETTINGS.salesOwnerAtWonField, "UF_CRM_1790786031");
});

// ---- L. rosters ----------------------------------------------------------------------

test("L. only Sales Doctor's approved sellers own Sales Doctor's current workload", () => {
  const records = population(buildRecords([
    MIXED[2],
    { id: "5010", categoryId: "5", stageId: "C5:PREPAYMENT_INVOICE", responsible: IBOX_SELLER, history: [["C5:NEW", "10:01"], ["C5:PREPAYMENT_INVOICE", "10:20"]] },
    { id: "5011", categoryId: "5", stageId: "C5:PREPAYMENT_INVOICE", responsible: CUSTOMER_CARE, history: [["C5:NEW", "10:01"], ["C5:PREPAYMENT_INVOICE", "10:20"]] },
  ]), "SALES_DOCTOR");
  const byId = new Map(records.map((row) => [row.dealId, row]));
  assert.equal(byId.get("5001")?.funnelOwnerId, SD_SELLER);
  assert.notEqual(byId.get("5010")?.funnelOwnerId, IBOX_SELLER, "an IBOX seller is not credited in Sales Doctor");
  assert.notEqual(byId.get("5011")?.funnelOwnerId, CUSTOMER_CARE);
  const managers = buildManagers(salesPopulations(records, QUERY).cohort, [], new Set(SD_SETTINGS.salesStaffIds));
  assert.ok(!managers.some((row) => row.id === IBOX_SELLER));
  // The roster is resolved from Sales Doctor's own names, by id, conservatively.
  const directory = directoryUsers([
    { ID: "235", NAME: "Abdulla", LAST_NAME: "Norboyev", ACTIVE: true }, { ID: "225", NAME: "Jasur", LAST_NAME: "Shadieev", ACTIVE: true },
    { ID: "229", NAME: "Ikrom", LAST_NAME: "Tojiyev", ACTIVE: true }, { ID: "203", NAME: "Humoyun", LAST_NAME: "Toirjonov", ACTIVE: true },
    { ID: "13121", NAME: "Behruz", LAST_NAME: "Abdulazizov", ACTIVE: true },
    { ID: "223", NAME: "Abubakir", LAST_NAME: "Rahimov", ACTIVE: true }, { ID: "12565", NAME: "Abubakir", LAST_NAME: "Rahimov", ACTIVE: true },
    { ID: "4151", NAME: "Sanjar", LAST_NAME: "Juraev", ACTIVE: true },
  ]);
  // Unpinned, two "Abubakir Rahimov" accounts are never a guess.
  const unpinned = resolveRoster(PROJECT_SELLER_NAMES.SALES_DOCTOR, directory);
  const ambiguous = unpinned.entries.find((entry) => entry.providedName === "Abubakr Rahimov")!;
  assert.equal(ambiguous.status, "ROSTER_MAPPING_REVIEW", "two candidates is never a guess");
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.id).sort(), ["12565", "223"]);
  // The owner pinned his current account (2026-10-01).
  const roster = resolveRoster(PROJECT_SELLER_NAMES.SALES_DOCTOR, directory, PROJECT_SELLER_IDENTITY.SALES_DOCTOR.pinnedIds);
  assert.deepEqual([...roster.approvedSellerIds].sort(), SALES_DOCTOR_ROSTER.map((seller) => seller.id).sort(),
    "the matcher plus the owner's pin reproduce exactly the hand-verified ids");
  const abubakr = roster.entries.find((entry) => entry.providedName === "Abubakr Rahimov")!;
  assert.equal(abubakr.status, "RESOLVED");
  assert.equal(abubakr.userId, "12565");
  assert.equal(abubakr.matchKind, "OWNER_PINNED");
  assert.equal(roster.approvedSellerIds.has("223"), false, "the old account is an alias, never a second roster row");
  assert.equal(roster.approvedSellerIds.has("199"), false, "a historical seller is never on the current roster");
  assert.equal(roster.approvedSellerIds.has("4151"), false, "IBOX's roster never leaks in");
  // A pin can only choose among the name's own candidates.
  const stray = resolveRoster(["Abubakr Rahimov"], directory, { "Abubakr Rahimov": "4151" });
  assert.equal(stray.entries[0].status, "ROSTER_MAPPING_REVIEW");
  // And the sync resolves ONLY the running project's names into ONLY its settings.
  assert.match(read("lib/sync.ts"), /resolveRoster\(PROJECT_SELLER_NAMES\[project\], directoryUsers\(users\), PROJECT_SELLER_IDENTITY\[project\]\.pinnedIds\);\n\s+await saveSettings\(\{ \.\.\.\(await getSettings\(project\)\), salesStaffIds: \[\.\.\.roster\.approvedSellerIds\] \}, project\);/);
});

// ---- N. Owner-confirmed seller identity (2026-10-01) ------------------------------------

test("Abubakr's two accounts are one seller, and Otabek is historical only", () => {
  const identity = PROJECT_SELLER_IDENTITY.SALES_DOCTOR;
  const sale = { dealId: "9", wonAt: "2026-02-01T10:00:00Z", salesStatus: "WON", projectLeadMembership: "INCLUDED", salesOwnerAtWonId: null, categoryId: "17", assignedManagerId: CUSTOMER_CARE };
  const context = {
    approvedSellerIds: new Set(SALES_DOCTOR_ROSTER.map((seller) => seller.id)),
    responsibleCategoryIds: new Set(["5"]),
    aliases: identity.aliases,
    historicalSellerIds: historicalSellerIds("SALES_DOCTOR"),
    ownerConfirmed: new Map([["31", "199"]]),
  };
  // The old account is read as the current one; the raw id stays in the decision.
  const old = classifyLegacySalesOwner({ ...sale, observerIds: ["223"] }, context);
  assert.equal(old.status, "AUTO_CONFIRM_OBSERVER");
  assert.equal(old.chosenSellerId, "12565", "the field is written with his current account");
  assert.deepEqual(old.observerIds, ["223"]);
  // Both accounts on one Deal are one person, not two sellers.
  assert.equal(classifyLegacySalesOwner({ ...sale, observerIds: ["223", "12565"] }, context).chosenSellerId, "12565");
  // A former seller beside a current one is ambiguous, never resolved to the current one.
  assert.equal(classifyLegacySalesOwner({ ...sale, observerIds: ["199", "223"] }, context).status, "REVIEW_REQUIRED_MULTIPLE_SELLERS");
  // A former seller alone is not auto-credited from observers...
  const alone = classifyLegacySalesOwner({ ...sale, observerIds: ["199"] }, context);
  assert.equal(alone.reason, "HISTORICAL_SELLER_NEEDS_OWNER");
  assert.equal(alone.chosenSellerId, null);
  // ...only by the owner's per-Deal confirmation, and only into an empty field.
  const confirmed = classifyLegacySalesOwner({ ...sale, dealId: "31", observerIds: ["199"] }, context);
  assert.equal(confirmed.status, "AUTO_CONFIRM_OWNER_CONFIRMED");
  assert.equal(confirmed.chosenSellerId, "199");
  const filled = classifyLegacySalesOwner({ ...sale, dealId: "31", observerIds: ["199"], salesOwnerAtWonId: "235" }, context);
  assert.equal(filled.status, "CERTIFIED_EXISTING_FIELD", "a populated field is never overwritten");
  assert.equal(filled.existingOwnerId, "235");
  assert.equal(classifyLegacySalesOwner({ ...sale, dealId: "31", salesOwnerAtWonId: "199" }, context).status, "CERTIFIED_EXISTING_FIELD");
  assert.equal(classifyLegacySalesOwner({ ...sale, salesOwnerAtWonId: "223" }, context).status, "CERTIFIED_EXISTING_FIELD");
  assert.equal(canonicalSellerId("SALES_DOCTOR", "223"), "12565");
  assert.equal(canonicalSellerId("IBOX", "223"), "223", "the alias is Sales Doctor's decision only");

  // Every owner-confirmed Otabek sale names 199, and the ambiguous Deal is absent.
  const otabek = [...OWNER_OVERRIDES.values()].filter((entry) => entry.sellerId === "199");
  assert.equal(otabek.length, 31);
  assert.ok(otabek.every((entry) => entry.attributionSource === "OWNER_CONFIRMED" && entry.sellerName === "Otabek Sulaymonov"));
  assert.equal(OWNER_OVERRIDES.has("28565"), false);
});

test("an aliased seller reports under one identity, with the raw account kept", () => {
  const records = buildRecords([{
    id: "7001", categoryId: "17", stageId: "C17:NEW", responsible: CUSTOMER_CARE,
    history: [["C5:NEW", "10:01"], ["C5:WON", "12:00"], ["C17:NEW", "13:00"]],
    fields: { [SALES_DOCTOR_OWNER_AT_WON_FIELD]: "223" },
  }]);
  const record = records.find((row) => row.dealId === "7001")! as unknown as { salesManagerId: string; salesManagerAccountId?: string; salesManagerAttribution: string; salesManager: string };
  assert.equal(record.salesManagerId, "12565");
  assert.equal(record.salesManagerAccountId, "223");
  assert.equal(record.salesManagerAttribution, "SALES_OWNER_AT_WON");
  // An IBOX Deal is never touched by a Sales Doctor alias.
  const ibox = buildRecords([{
    id: "7002", categoryId: "13", stageId: "C13:NEW", responsible: CUSTOMER_CARE,
    history: [["C3:NEW", "10:01"], ["C3:WON", "12:00"], ["C13:NEW", "13:00"]], fields: { [SALES_OWNER_AT_WON_FIELD]: "223" },
  }]).find((row) => row.dealId === "7002")! as unknown as { salesManagerId: string; salesManagerAccountId?: string };
  assert.equal(ibox.salesManagerId, "223");
  assert.equal(ibox.salesManagerAccountId, undefined);
});

// ---- O. Sales Doctor quality from the current stage (owner rule, 2026-10-01) -------------

const REASON_FIELD = "UF_CRM_1748329407554";
const ROUTING_TEXT = "это уже клиент SD (Not Relevant)";

/** Builds with a failure-reason field configured, and the IBOX routing patterns that match "SD". */
function buildWithReasons(cases: DealCase[]) {
  const reasonSettings = (project: ProjectKey) => ({
    ...SETTINGS[project], failureReasonField: REASON_FIELD, routingReasonPatterns: ["sd", "передан"],
  });
  const deals: RawDeal[] = cases.map((c) => ({
    ID: c.id, TITLE: `Deal ${c.id}`, DATE_CREATE: at("10:01"), ASSIGNED_BY_ID: c.responsible, CATEGORY_ID: c.categoryId,
    STAGE_ID: c.stageId, MOVED_TIME: at("17:00"), SOURCE_ID: "WEB", OPPORTUNITY: "1000000", CURRENCY_ID: "UZS",
    observers: c.observers ?? [], ...c.fields,
  } as RawDeal));
  const histories: RawStageHistory[] = cases.flatMap((c) => c.history.map(([stageId, clock]) => ({
    OWNER_ID: c.id, CATEGORY_ID: /^C(\d+):/.exec(stageId)![1], STAGE_ID: stageId, CREATED_TIME: at(clock),
  } as RawStageHistory)));
  const pipelines = new Map(PROJECT_KEYS.flatMap((key) => [
    [SALES_PROJECTS[key].salesCategoryId, SALES_PROJECTS[key].salesCategoryName],
    [SALES_PROJECTS[key].postSaleCategoryId, SALES_PROJECTS[key].postSaleCategoryName],
  ] as [string, string][]));
  const records = [];
  for (const [project, group] of groupDealsByProject(deals, histories, "IBOX")) {
    records.push(...buildAnalyticsRecords({
      deals: group.deals, stageHistories: group.histories, settings: reasonSettings(project), projectKey: project,
      users: USERS, pipelines, stages, sources, stageMeta, domain: null, stageHistoryAvailable: true,
    }));
  }
  return new Map((records as unknown as DashboardRecord[]).map((row) => [row.dealId, row]));
}

test("Sales Doctor quality is the current stage, never the failure reason", () => {
  const reason = { [REASON_FIELD]: ROUTING_TEXT };
  const byId = buildWithReasons([
    { id: "6001", categoryId: "5", stageId: "C5:NEW", responsible: SD_SELLER, history: [["C5:NEW", "10:01"]] },
    { id: "6002", categoryId: "5", stageId: "C5:PREPARATION", responsible: SD_SELLER, history: [["C5:NEW", "10:01"], ["C5:PREPARATION", "11:00"]] },
    // A direct close from distribution, with a "routing" reason: still SQL and Sales Lost.
    { id: "6003", categoryId: "5", stageId: "C5:LOSE", responsible: SD_SELLER, history: [["C5:NEW", "10:01"], ["C5:LOSE", "11:00"]], fields: reason },
    // Not Relevant even after an SQL visit, whatever the reason says.
    { id: "6004", categoryId: "5", stageId: "C5:UC_X51N7T", responsible: SD_SELLER,
      history: [["C5:NEW", "10:01"], ["C5:PREPAYMENT_INVOICE", "10:30"], ["C5:UC_X51N7T", "11:00"]], fields: { [REASON_FIELD]: "Отсрочка (Сделка провалена)" } },
    // An open stage that never visited ОБРАБОТКА is SQL; Saralangan needs no threshold.
    { id: "6005", categoryId: "5", stageId: "C5:EXECUTING", responsible: SD_SELLER, history: [["C5:NEW", "10:01"], ["C5:EXECUTING", "11:00"]] },
    // A Won visit the Deal has since left is not a sale (Deal 43523).
    { id: "6006", categoryId: "5", stageId: "C5:PREPAYMENT_INVOICE", responsible: SD_SELLER,
      history: [["C5:NEW", "10:01"], ["C5:WON", "11:00"], ["C5:PREPAYMENT_INVOICE", "11:00"]] },
    { id: "6007", categoryId: "17", stageId: "C17:NEW", responsible: CUSTOMER_CARE, history: [["C5:NEW", "10:01"], ["C5:WON", "12:00"], ["C17:NEW", "13:00"]] },
    { id: "6008", categoryId: "5", stageId: "C5:WON", responsible: SD_SELLER, history: [["C5:NEW", "10:01"], ["C5:WON", "12:00"]] },
    // IBOX keeps its rule: the same reason text still routes an IBOX close.
    { id: "3101", categoryId: "3", stageId: "C3:LOSE", responsible: IBOX_SELLER, history: [["C3:NEW", "10:01"], ["C3:LOSE", "11:00"]], fields: reason },
  ]);
  const verdict = (id: string) => {
    const row = byId.get(id)!;
    return { status: row.salesStatus, group: row.lossReasonGroup, sql: Boolean(row.qualified), lost: isSalesLost(row) };
  };
  assert.deepEqual(verdict("6001"), { status: "ACTIVE", group: "NONE", sql: false, lost: false });
  assert.deepEqual(verdict("6002"), { status: "ACTIVE", group: "NONE", sql: false, lost: false });
  assert.deepEqual(verdict("6003"), { status: "LOST", group: "SALES", sql: true, lost: true });
  assert.equal(byId.get("6003")!.lossReason, ROUTING_TEXT, "the reason is kept as a diagnostic");
  assert.deepEqual(verdict("6004"), { status: "LOW_QUALITY", group: "MARKETING", sql: false, lost: false });
  assert.deepEqual(verdict("6005"), { status: "ACTIVE", group: "NONE", sql: true, lost: false });
  assert.deepEqual(verdict("6006"), { status: "ACTIVE", group: "NONE", sql: true, lost: false });
  assert.deepEqual(verdict("6007"), { status: "WON", group: "NONE", sql: true, lost: false });
  assert.deepEqual(verdict("6008"), { status: "WON", group: "NONE", sql: true, lost: false });
  assert.equal(byId.get("3101")!.lossReasonGroup, "ROUTING", "IBOX quality logic is unchanged");
  assert.equal(Boolean(byId.get("3101")!.qualified), false);

  // The partition the owner reconciles: Saralangan = SQL + NR; Lost and Sale are inside SQL.
  const sd = population([...byId.values()], "SALES_DOCTOR");
  const metrics = buildDashboardMetrics(sd, sd.filter((row) => row.salesStatus === "WON"));
  assert.equal(metrics.counts.leads, 8);
  assert.equal(metrics.counts.unclassified_leads, 2);
  assert.equal(metrics.counts.classified_leads, 6);
  assert.equal(metrics.counts.classified_leads, metrics.counts.sql + metrics.counts.not_relevant);
  assert.equal(metrics.counts.sales_lost, 1);
  assert.equal(metrics.counts.cohort_sales, 2);
  assert.equal(metrics.classificationConflicts, 0);
});

test("the current-stage rule is Sales Doctor's alone", () => {
  assert.equal(currentStageQuality("IBOX", "3", "C3:LOSE"), null);
  assert.equal(currentStageQuality(undefined, "5", "C5:LOSE"), null, "a project-unaware build keeps the general rules");
  assert.equal(currentStageQuality("SALES_DOCTOR", "31", "C31:NEW"), null, "a Deal outside both funnels keeps its came-from rules");
  assert.deepEqual(currentStageQuality("SALES_DOCTOR", "17", "C17:UC_0ZP82L"), { salesStatus: "WON", lossReasonGroup: "NONE", qualified: true });
});

// ---- M. SLA ----------------------------------------------------------------------------

test("M. Sales Doctor's SLA starts at its own distribution stage only", () => {
  assert.equal(distributionStageId("5", stageMeta, SD_SETTINGS), "C5:NEW");
  assert.equal(distributionStageId("3", stageMeta, IBOX_SETTINGS), "C3:NEW");
  const [record] = buildRecords([MIXED[2]]);
  assert.equal(record.slaStartAt, new Date(at("10:01")).toISOString());
  assert.equal(record.slaStopStage, "ОБРАБОТКА");
  assert.equal(record.slaBusinessMinutes, 19);
  // Sales Doctor's calendar is its own: Mon–Fri 10:00–18:00 Asia/Tashkent.
  assert.equal(SD_SETTINGS.timezone, "Asia/Tashkent");
  assert.deepEqual([0, 6].map((day) => SD_SETTINGS.schedule[day].enabled), [false, false]);
  assert.deepEqual([1, 2, 3, 4, 5].map((day) => [SD_SETTINGS.schedule[day].start, SD_SETTINGS.schedule[day].end]),
    Array(5).fill(["10:00", "18:00"]));
});

// ---- N. settings independence -------------------------------------------------------

test("N. changing Sales Doctor's SLA target does not change IBOX's", () => {
  const sdChanged = { ...SD_SETTINGS, slaMinutes: 60 };
  assert.equal(IBOX_SETTINGS.slaMinutes, 240);
  assert.equal(sdChanged.slaMinutes, 60);
  // They live in separate rows; IBOX keeps the key it has always used.
  assert.equal(SALES_PROJECTS.IBOX.settingsKey, "dashboard");
  assert.equal(SALES_PROJECTS.SALES_DOCTOR.settingsKey, "dashboard:SALES_DOCTOR");
  const storage = read("lib/storage.ts");
  assert.match(storage, /\.bind\(SALES_PROJECTS\[project\]\.settingsKey, JSON\.stringify/);
  assert.match(storage, /INSERT OR IGNORE INTO app_settings/, "seeding never overwrites");
  const route = read("app/api/settings/route.ts");
  assert.match(route, /const current = await getSettings\(scoped\.project\);/);
  assert.match(route, /await saveSettings\(next, scoped\.project\);/);
  // Seeding copies only company-wide facts, once.
  const seeded = seedSalesDoctorSettings({ ...IBOX_SETTINGS, holidays: ["2026-10-01"] });
  assert.deepEqual(seeded.holidays, ["2026-10-01"]);
  assert.deepEqual(seeded.productFitStageIds, [], "no product-fit outcome for Sales Doctor");
  assert.equal(SALES_PROJECTS.SALES_DOCTOR.hasProductFit, false);
  assert.equal(SALES_PROJECTS.IBOX.hasProductFit, true);
});

// ---- O / P. Source and revenue --------------------------------------------------------

test("O. Source is SOURCE_ID in both projects", () => {
  const records = buildRecords(MIXED);
  for (const record of records) {
    // The SOURCE_ID label, in either project; the Marketing channel is separate.
    assert.equal(record.source, "Veb-sayt");
    assert.equal(record.rawSource, "Veb-sayt");
  }
  const withChannel = buildRecords([{ ...MIXED[2], id: "5020", fields: { UF_CRM_CHANNEL: "Instagram" } }]);
  assert.equal(withChannel[0].source, "Veb-sayt", "a Marketing channel never replaces the Source");
});

test("P. Sales Doctor revenue is its own Opportunity in UZS, never mixed with IBOX", () => {
  const records = buildRecords(MIXED);
  const revenue = (project: ProjectKey) => {
    const pop = salesPopulations(population(records, project), QUERY);
    return buildDashboardMetrics(pop.cohort, pop.won).money;
  };
  assert.equal(revenue("SALES_DOCTOR").revenue, 3_000_000);
  assert.equal(revenue("SALES_DOCTOR").currency, "UZS");
  assert.equal(revenue("IBOX").revenue, 7_000_000, "IBOX's sale only; category 17 revenue stays out");
});

// ---- Q. Full Sync ---------------------------------------------------------------------

test("Q. a Sales Doctor Full Sync never regenerates with IBOX's settings", () => {
  const sync = read("lib/sync.ts");
  assert.match(sync, /const project = options\.project \?\? projectForCategory\(options\.pipelineId\) \?\? DEFAULT_PROJECT;/);
  assert.match(sync, /const scopedMain = pipelines\.find\(\(pipeline\) => pipeline\.id === registry\.salesCategoryId\);/);
  assert.match(sync, /await saveSettings\(\{ \.\.\.settings, selectedPipelineNames: \[scopedMain\.name\], postSalePipelineNames: \[scopedPostSale\.name\] \}, project\);/);
  assert.match(sync, /groupDealsByProject\(parseRows<RawDeal>\(batchDeals\), parseRows<RawStageHistory>\(selectedHistories\), jobProject\(job\)\)/);
  assert.match(sync, /settings: await getSettings\(project\), projectKey: project,/);
  assert.match(read("lib/analytics-backfill.ts"), /groupDealsByProject\(deals, stageHistories, DEFAULT_PROJECT\)/);
  assert.equal(projectForCategory("5"), "SALES_DOCTOR");
  assert.equal(projectForCategory("17"), "SALES_DOCTOR");
  assert.equal(projectForCategory("3"), "IBOX");
  assert.equal(projectForCategory("31"), null);
});

// ---- R / S. routing -------------------------------------------------------------------------

test("R. a refresh restores the workspace from its route; storage only highlights", () => {
  assert.equal(projectBySlug("sales-doctor")?.key, "SALES_DOCTOR");
  assert.equal(projectBySlug("ibox")?.key, "IBOX");
  const context = read("app/project-context.tsx");
  assert.match(context, /Best effort only: the URL is the authority/);
  assert.match(read("app/page.tsx"), /<DashboardClient \/>/, "the bare route asks, never guesses");
});

test("S. a direct Sales Doctor route cannot render IBOX, not even for one frame", () => {
  const client = read("app/dashboard-client.tsx");
  // The project is a prop from the route, fixed before the first fetch.
  assert.match(client, /const scoped = useCallback\(\(url: string\) => withProject\(url, project\), \[project\]\);/);
  for (const endpoint of ["/api/bootstrap", "/api/current-stages", "/api/stage-funnel", "/api/settings", "/api/sync"]) {
    assert.match(client, new RegExp(`authFetch\\(scoped\\("${endpoint.replace(/\//g, "\\/")}"\\)`), `${endpoint} is scoped`);
  }
  assert.doesNotMatch(client, /authFetch\("\/api\/(bootstrap|current-stages|stage-funnel|settings|sync)"/, "no unscoped project read remains");
  assert.equal(parseProjectKey("sales-doctor"), "SALES_DOCTOR");
  assert.equal(parseProjectKey(null), DEFAULT_PROJECT);
  assert.equal(parseProjectKey("OTHER"), null, "an unknown project is refused, never read as IBOX");
});

// ---- T. export ----------------------------------------------------------------------------------

test("T. the export names its project and carries only that project's population", () => {
  const client = read("app/dashboard-client.tsx");
  assert.match(client, /const headers = \["Loyiha", "Deal ID", "Joriy kategoriya", "SQL", "Not Relevant", "Sotilmadi", "Sotuv",/);
  assert.match(client, /\[SALES_PROJECTS\[project\]\.name, row\.dealId, row\.categoryId,/);
  assert.match(read("lib/sales-http.ts"), /return Response\.json\(\{ \.\.\.body, project: scoped\.project \}/, "every Sales answer names its project");
  const records = population(buildRecords(MIXED), "SALES_DOCTOR");
  assert.deepEqual(salesPopulations(records, QUERY).detail.map((row) => row.dealId).sort(), ["5001", "5002"]);
});

// ---- the boundaries that matter most -----------------------------------------------------

test("legacy records built with IBOX's rules never enter Sales Doctor", () => {
  const legacy = { dealId: "1", categoryId: "5", originCategoryId: "5" } as never;
  assert.equal(recordProject(legacy), null, "a pre-project Sales Doctor record awaits its own rebuild");
  assert.equal(recordProject({ categoryId: "3" }), "IBOX");
  assert.equal(recordProject({ categoryId: "31", originCategoryId: "3" }), "IBOX");
  assert.equal(recordProject({ projectKey: "SALES_DOCTOR", categoryId: "5" }), "SALES_DOCTOR");
  assert.equal(recordProject({ projectKey: null, categoryId: "5" }), null);
});

test("the seller-attribution route writes only the named project's field, and refuses no project", () => {
  const route = read("app/api/admin/seller-attribution/route.ts");
  assert.match(route, /if \(!project\) return Response\.json\(\{ error: "Loyiha noto‘g‘ri" \}, \{ status: 400 \}\);/);
  assert.match(route, /getSettings\(project\), projectRecords\(project\)/);
  assert.match(route, /listAnalyticsRecords\(\)\.then\(\(rows\) => rows\.filter\(\(row\) => recordProject\(row\) === project\)\)/);
  assert.doesNotMatch(route, /getSettings\(\)/, "no global settings read remains");
});

test("Sales Doctor never credits the category-17 Responsible in the legacy backfill", () => {
  const sale = { dealId: "9", wonAt: "2026-09-01T10:00:00Z", salesStatus: "WON", projectLeadMembership: "INCLUDED", observerIds: [], salesOwnerAtWonId: null };
  const sdContext = { approvedSellerIds: new Set([SD_SELLER]), responsibleCategoryIds: new Set(["5"]) };
  // After the handoff, even a roster member as Responsible is not evidence.
  assert.equal(classifyLegacySalesOwner({ ...sale, categoryId: "17", assignedManagerId: SD_SELLER }, sdContext).status, "REVIEW_REQUIRED_NON_SALES_RESPONSIBLE");
  assert.equal(classifyLegacySalesOwner({ ...sale, categoryId: "17", assignedManagerId: SD_SELLER }, sdContext).reason, "NO_OBSERVER_RESPONSIBLE_AFTER_HANDOFF");
  // Still in the Sales funnel with no reassignment: the roster Responsible is the seller.
  assert.equal(classifyLegacySalesOwner({ ...sale, categoryId: "5", assignedManagerId: SD_SELLER }, sdContext).status, "AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER");
  // A single roster observer remains the reliable handoff evidence.
  assert.equal(classifyLegacySalesOwner({ ...sale, categoryId: "17", assignedManagerId: CUSTOMER_CARE, observerIds: [SD_SELLER] }, sdContext).chosenSellerId, SD_SELLER);
  // IBOX keeps its accepted Rule 3 unchanged.
  assert.equal(classifyLegacySalesOwner({ ...sale, categoryId: "13", assignedManagerId: IBOX_SELLER }, { approvedSellerIds: new Set([IBOX_SELLER]) }).status,
    "AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER");
});
