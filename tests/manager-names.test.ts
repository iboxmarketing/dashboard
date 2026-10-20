import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultSettings } from "../lib/business-time";
import type { DashboardRecord } from "../lib/dashboard-record";
import { buildKpiDetail, parseKpiParams } from "../lib/kpi-detail";
import {
  canonicalizeManagerNames, isPlaceholderManagerName, managerNameDirectory, resolveManagerDisplayName, resolveManagerName,
  type ManagerNameDirectory,
} from "../lib/manager-identity";
import { SALES_DOCTOR_ROSTER } from "../lib/sales-projects";
import { buildManagers, dashboardSection, filterOptions, prepareSalesRecords, salesPopulations, type SalesQuery } from "../lib/sales-sections";
import type { DashboardSettings } from "../lib/types";

/**
 * Manager NAME resolution (hotfix 2026-10-20). Production held the same stable
 * ids under both their real name and "Menejer #<id>" — every placeholder row was
 * written by one sync batch (2026-10-20 06:35 UTC) whose user directory was
 * empty. The id, and so every count, was always right; only the label was not.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const SELLERS: [string, string][] = [["25", "Abdulaziz Abdurahmonov"], ["207", "Soxib Bazaraliyev"], ["1911", "Rahmatullo Orifjonov"], ["17", "Po'latxon Ashuraliyev"], ["4151", "Sanjar Juraev"]];
const IBOX: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX Sales"], postSalePipelineIds: ["13"], postSalePipelineNames: ["Post"],
  salesStaffIds: SELLERS.map(([id]) => id),
};
const SD: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: ["5"], selectedPipelineNames: ["SD Sales"], postSalePipelineIds: ["17"], postSalePipelineNames: ["SD Post"],
  salesStaffIds: SALES_DOCTOR_ROSTER.map((seller) => seller.id),
};
const QUERY = { from: "2026-10-01", to: "2026-10-31", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" } as SalesQuery;
const NOW = new Date("2026-10-20T12:00:00Z");

function record(over: Partial<DashboardRecord>): DashboardRecord {
  return {
    dealId: "1", title: "Deal", createdAt: "2026-10-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
    categoryId: "3", originCategoryId: "3", pipeline: "IBOX Sales", originPipeline: "IBOX Sales",
    projectLeadMembership: "INCLUDED", stage: "ОБРАБОТКА", stageHistoryCount: 1,
    processingBusinessMinutes: 10, slaStatus: "ON_TIME", source: "CRM-форма",
    salesManagerId: null, salesManager: null, salesManagerAttribution: "UNKNOWN",
    ...over,
  } as unknown as DashboardRecord;
}

/**
 * Production's shape: for each seller, Deals written by the 06:35 batch carry
 * "Menejer #<id>" and come FIRST (newest first, as the loader reads them); the
 * older Deals carry the real name. `placeholdersOnly` keeps every name a placeholder.
 */
function population(options: { placeholdersOnly?: boolean; realOnly?: boolean } = {}) {
  const rows: DashboardRecord[] = [];
  for (const [index, [id, name]] of SELLERS.entries()) {
    for (let copy = 0; copy < 3; copy += 1) {
      const placeholder = !options.realOnly && (options.placeholdersOnly || copy === 0);
      const label = placeholder ? `Menejer #${id}` : name;
      rows.push(record({
        dealId: `${id}-${copy}`, qualified: copy !== 2, assignedManagerId: id, assignedManager: label,
        createdAt: `2026-10-${String(10 - copy).padStart(2, "0")}T09:0${index}:00.000Z`,
        ...(copy === 1 ? { salesStatus: "WON", wonAt: "2026-10-12T09:00:00.000Z", opportunity: 100_000 + index, categoryId: "13",
          salesManagerId: id, salesManager: label, salesManagerAttribution: "SALES_OWNER_AT_WON", sellerCertification: "CERTIFIED", sellerEvidenceReason: "SALES_OWNER_AT_WON_FIELD" } : {}),
      }));
    }
  }
  return rows;
}

const ROSTER_ENTRIES = SELLERS.map(([userId, providedName]) => ({ userId, providedName, status: "RESOLVED" }));
const USER_ROWS = SELLERS.map(([ID, full]) => ({ ID, NAME: full.split(" ")[0], LAST_NAME: full.split(" ").slice(1).join(" ") }));
const IBOX_DIRECTORY = managerNameDirectory({ rosterEntries: ROSTER_ENTRIES, userRows: USER_ROWS });
const prepared = (rows: DashboardRecord[], directory?: ManagerNameDirectory, settings = IBOX, project: "IBOX" | "SALES_DOCTOR" = "IBOX") => prepareSalesRecords(rows, settings, NOW, project, directory);
const managers = (rows: DashboardRecord[], settings = IBOX) => {
  const pop = salesPopulations(rows, QUERY);
  return buildManagers(pop.cohort, pop.won, new Set(settings.salesStaffIds));
};

test("A. one id under both 'Rahmatullo Orifjonov' and 'Menejer #1911' → one row named Rahmatullo Orifjonov", () => {
  const raw = population();
  assert.equal(raw[6].assignedManager, "Menejer #1911", "the placeholder row comes first, as in production");
  // Even with no directory at all, a real stored name beats the placeholder.
  for (const directory of [undefined, IBOX_DIRECTORY]) {
    const rows = managers(prepared(raw, directory));
    const rahmatullo = rows.filter((row) => row.id === "1911");
    assert.equal(rahmatullo.length, 1);
    assert.equal(rahmatullo[0].name, "Rahmatullo Orifjonov");
    for (const [id, name] of SELLERS) assert.equal(rows.find((row) => row.id === id)?.name, name, id);
    assert.ok(!rows.some((row) => /^Menejer #/.test(row.name)), "no placeholder reaches the Managers table");
  }
  // The raw resolver: bound to the id, placeholder skipped, order irrelevant.
  assert.equal(resolveManagerName("1911", [{ assignedManagerId: "1911", assignedManager: "Menejer #1911" }, { assignedManagerId: "1911", assignedManager: "Rahmatullo Orifjonov" }]), "Rahmatullo Orifjonov");
});

test("B. the project's roster name beats a placeholder — and the users directory and a stored name", () => {
  const sdDirectory = managerNameDirectory({ staticRoster: SALES_DOCTOR_ROSTER, userRows: [{ ID: "12565", NAME: "Abubakir", LAST_NAME: "Rahimov" }] });
  const rows = [{ assignedManagerId: "12565", assignedManager: "Menejer #12565" }, { assignedManagerId: "12565", assignedManager: "Abubakir Rahimov" }];
  assert.equal(resolveManagerDisplayName("12565", { directory: sdDirectory, rows }), "Abubakr Rahimov", "the owner's roster spelling");
  const placeholdersOnly = managers(prepared(population({ placeholdersOnly: true }), managerNameDirectory({ rosterEntries: ROSTER_ENTRIES })));
  assert.equal(placeholdersOnly.find((row) => row.id === "4151")?.name, "Sanjar Juraev");
  // Only RESOLVED roster entries count; an unresolved one cannot name anyone.
  const review = managerNameDirectory({ rosterEntries: [{ userId: "4151", providedName: "Sanjar", status: "ROSTER_MAPPING_REVIEW" }] });
  assert.equal(review.roster.has("4151"), false);
});

test("C. the users directory beats a placeholder when the roster has no name", () => {
  const directory = managerNameDirectory({ userRows: USER_ROWS });
  const rows = managers(prepared(population({ placeholdersOnly: true }), directory));
  for (const [id, name] of SELLERS) assert.equal(rows.find((row) => row.id === id)?.name, name, id);
  // A directory row without a name never becomes a placeholder entry.
  assert.equal(managerNameDirectory({ userRows: [{ ID: "9", NAME: "", LAST_NAME: "" }] }).users.has("9"), false);
});

test("D. with no canonical source the label stays 'Menejer #ID' — honest, never borrowed", () => {
  const rows = managers(prepared(population({ placeholdersOnly: true })));
  for (const [id] of SELLERS) assert.equal(rows.find((row) => row.id === id)?.name, `Menejer #${id}`);
  assert.equal(resolveManagerDisplayName("77", { rows: [{ assignedManagerId: "78", assignedManager: "Someone Else" }] }), "Menejer #77", "another id's name is never used");
  assert.ok(isPlaceholderManagerName("Menejer #1911") && isPlaceholderManagerName("") && isPlaceholderManagerName("Aniqlanmagan"));
  assert.ok(!isPlaceholderManagerName("Rahmatullo Orifjonov"));
});

test("E + F. counts, KPI values and rows are unchanged — only the labels move; no duplicate rows", () => {
  const strip = <T extends { name?: string }>(rows: T[]) => rows.map((row) => ({ ...row, name: undefined }));
  const variants = [prepared(population()), prepared(population(), IBOX_DIRECTORY), prepared(population({ placeholdersOnly: true }), IBOX_DIRECTORY), prepared(population({ realOnly: true }))];
  const baseline = managers(variants[3]);
  const context = { can: () => true, settings: IBOX, dataAsOf: null };
  const dashboard = dashboardSection(variants[3], QUERY, context);
  for (const rows of variants) {
    const built = managers(rows);
    assert.deepEqual(strip(built), strip(baseline), "every manager number is identical");
    assert.equal(new Set(built.map((row) => row.id)).size, built.length, "one row per id");
    const section = dashboardSection(rows, QUERY, context);
    assert.deepEqual(section.metrics, dashboard.metrics);
    assert.deepEqual(section.leadCount, dashboard.leadCount);
  }
  // Ids and attribution fields are untouched; only the three display names are rewritten.
  const raw = population();
  const fixed = canonicalizeManagerNames(raw, IBOX_DIRECTORY);
  for (const [index, row] of fixed.entries()) {
    const { assignedManager: a1, salesManager: s1, ...rest1 } = row;
    const { assignedManager: a2, salesManager: s2, ...rest2 } = raw[index];
    void a1; void s1; void a2; void s2;
    assert.deepEqual(rest1, rest2);
  }
});

test("filters and KPI Detail breakdowns read the same canonical names", () => {
  const rows = prepared(population(), IBOX_DIRECTORY);
  const options = filterOptions(rows, () => true).managers;
  for (const [id, name] of SELLERS) assert.equal(options.find((option) => option.id === id)?.name, name, `filter ${id}`);
  assert.ok(!options.some((option) => /^Menejer #/.test(option.name)));
  const kpi = parseKpiParams(new URLSearchParams("metric=leads"));
  assert.ok(kpi.ok);
  const detail = buildKpiDetail(rows, { ...QUERY, ...kpi.params }, { project: "IBOX", can: () => true, settings: IBOX });
  assert.equal(detail.status, "OK");
  const owners = detail.status === "OK" ? detail.breakdowns.find((breakdown) => breakdown.dimension === "owner") : undefined;
  assert.ok(owners);
  for (const [id, name] of SELLERS) assert.equal(owners!.rows.find((row) => row.key === id)?.label, name, `KPI ${id}`);
});

test("G. project-safe: each project's roster names only its own sellers", () => {
  const sdDirectory = managerNameDirectory({ staticRoster: SALES_DOCTOR_ROSTER, userRows: [{ ID: "12565", NAME: "Abubakir", LAST_NAME: "Rahimov" }] });
  const iboxDirectory = managerNameDirectory({ rosterEntries: ROSTER_ENTRIES, userRows: [{ ID: "12565", NAME: "Abubakir", LAST_NAME: "Rahimov" }] });
  const sdRow = record({ dealId: "sd-1", categoryId: "5", originCategoryId: "5", pipeline: "SD Sales", originPipeline: "SD Sales", projectKey: "SALES_DOCTOR", assignedManagerId: "12565", assignedManager: "Menejer #12565" } as Partial<DashboardRecord>);
  const iboxRow = record({ dealId: "ibox-1", assignedManagerId: "12565", assignedManager: "Menejer #12565", projectKey: "IBOX" } as Partial<DashboardRecord>);
  const inSd = prepared([sdRow, iboxRow], sdDirectory, SD, "SALES_DOCTOR");
  const inIbox = prepared([sdRow, iboxRow], iboxDirectory, IBOX, "IBOX");
  assert.deepEqual(inSd.map((row) => [row.dealId, row.assignedManager]), [["sd-1", "Abubakr Rahimov"]], "SD: its own roster spelling, its own Deal only");
  assert.deepEqual(inIbox.map((row) => [row.dealId, row.assignedManager]), [["ibox-1", "Abubakir Rahimov"]], "IBOX: no SD roster spelling — the users directory");
  // The loader builds each project's directory from that project's roster only.
  const http = read("lib/sales-http.ts");
  assert.match(http, /getDictionary<RosterResolution\[\]>\(rosterDictionaryKey\(project\), \[\]\)/);
  assert.match(http, /staticRoster: project === "SALES_DOCTOR" \? SALES_DOCTOR_ROSTER : \[\]/);
});

test("one rule everywhere: the Sales base, Stage funnel and live Stage Control use the shared resolver", () => {
  assert.match(read("lib/sales-sections.ts"), /markDuplicates\(canonicalizeManagerNames\(projectScopedRecords\(rows\.map\(hydrateRecord\), settings, project\), directory\)\)/);
  assert.match(read("lib/sales-http.ts"), /base = prepareSalesBase\(fresh\.rows\.map\(\(row\) => JSON\.parse\(row\) as DashboardRecord\), settings, project, directory\);/);
  assert.match(read("app/api/stage-funnel/route.ts"), /canonicalizeManagerNames\(projectScopedRecords\(/);
  const live = read("app/api/current-stages/route.ts");
  assert.match(live, /loadManagerDirectory\(scoped\.project\)/);
  assert.match(live, /const users = new Map\(\[\.\.\.directory\.users, \.\.\.directory\.roster\]\);/, "roster wins over the directory");
});

test("writer hardening: a failed or empty user lookup never replaces the last good directory", () => {
  const sync = read("lib/sync.ts");
  assert.match(sync, /if \(users\.length\) await saveDictionary\("users", users\);/);
  assert.match(sync, /if \(statuses\.length\) await saveDictionary\("statuses", statuses\);/);
  assert.doesNotMatch(sync, /^\s*await saveDictionary\("users", users\);/m);
  assert.match(sync, /catch \{ permissions\.managers = "error"; \}/, "the failure is still reported");
});
