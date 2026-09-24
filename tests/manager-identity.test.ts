import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultSettings } from "../lib/business-time";
import { FUNNEL_OWNER_LABELS, FUNNEL_REVIEW_KEY } from "../lib/funnel-owner";
import { managerFallbackLabel, resolveManagerName, unboundManagerNames } from "../lib/manager-identity";
import { historicalManagerOptions, liveManagerOptions } from "../lib/record-filters";
import { activeRoster, buildManagers, managerSection, prepareSalesRecords, salesPopulations, type SalesQuery } from "../lib/sales-sections";
import { buildQualityAnalytics } from "../lib/quality-analytics";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/**
 * Manager identity is the Bitrix user ID — for aggregation, for the displayed
 * name and for the click target alike.
 *
 * The defect these tests lock out: a row's name came from an unbound lookup ("the
 * first row carrying a seller name"), so two different IDs rendered the same name
 * and the duplicate row opened a third person's profile.
 */

/** The nine active sellers, with the names Bitrix actually holds. */
const SELLERS: [string, string][] = [
  ["25", "Abdulaziz Abdurahmonov"],
  ["207", "Soxib Bazaraliyev"],
  ["561", "Abdulloh Tolanov"],
  ["1911", "Rahmatullo Orifjonov"],
  ["17", "Po'latxon Ashuraliyev"],
  ["7893", "Jamoliddin Kamarov"],
  ["4151", "Sanjar Juraev"],
  ["13059", "Rahmatulloh Ahmadjonov"],
  ["95", "Muhamadrasul Dadaxonov"],
];
const OPERATOR = ["12961", "Sarvar Tuychiyev"] as const;

const SETTINGS: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX Sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["Post"],
  salesStaffIds: SELLERS.map(([id]) => id),
};
const QUERY = {
  from: "2026-09-01", to: "2026-09-30", managers: [], sources: [], pipeline: "", stage: "",
  period: "", sla: "", processing: "", search: "",
} as SalesQuery;
const CONTEXT = { can: () => true, settings: SETTINGS, dataAsOf: null };

function record(over: Partial<DashboardRecord>): DashboardRecord {
  return {
    dealId: "1", title: "Deal", createdAt: "2026-09-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
    categoryId: "3", originCategoryId: "3", pipeline: "IBOX Sales", originPipeline: "IBOX Sales",
    projectLeadMembership: "INCLUDED", stage: "ОБРАБОТКА", stageHistoryCount: 1,
    processingBusinessMinutes: 10, slaStatus: "ON_TIME", source: "CRM-форма",
    salesManagerId: null, salesManager: null, salesManagerAttribution: "UNKNOWN",
    ...over,
  } as unknown as DashboardRecord;
}

/** One open lead per seller, plus one proven sale per seller. */
function population() {
  const rows: DashboardRecord[] = [];
  for (const [index, [id, name]] of SELLERS.entries()) {
    rows.push(record({
      dealId: `open-${id}`, qualified: true, assignedManagerId: id, assignedManager: name,
      createdAt: `2026-09-0${(index % 9) + 1}T09:00:00.000Z`,
    }));
    rows.push(record({
      dealId: `won-${id}`, qualified: true, salesStatus: "WON", wonAt: "2026-09-15T09:00:00.000Z",
      opportunity: 100_000 + index, categoryId: "13",
      salesManagerId: id, salesManager: name, salesManagerAttribution: "SALES_OWNER_AT_WON",
      sellerCertification: "CERTIFIED", sellerEvidenceReason: "SALES_OWNER_AT_WON_FIELD",
      assignedManagerId: OPERATOR[0], assignedManager: OPERATOR[1],
    }));
  }
  // An operator's open lead: it belongs to nobody, and must not lend its name to
  // any seller's row.
  rows.push(record({ dealId: "open-operator", qualified: true, assignedManagerId: OPERATOR[0], assignedManager: OPERATOR[1] }));
  return prepareSalesRecords(rows, SETTINGS, new Date("2026-09-30T00:00:00Z"));
}

test("1. one manager ID renders exactly one row", () => {
  const pop = salesPopulations(population(), QUERY);
  const managers = buildManagers(pop.cohort, pop.won, activeRoster(SETTINGS));
  const ids = managers.map((row) => row.id);
  assert.deepEqual([...new Set(ids)].length, ids.length, "no id appears twice");
  for (const [id] of SELLERS) {
    assert.equal(managers.filter((row) => row.id === id).length, 1, `id ${id} renders one row`);
  }
  // …and no duplicate DISPLAY NAME either, which is how the defect surfaced.
  const names = managers.map((row) => row.name);
  assert.deepEqual([...new Set(names)].length, names.length, `duplicate names: ${names.join(", ")}`);
});

test("2. the displayed name belongs to that ID", () => {
  const pop = salesPopulations(population(), QUERY);
  const managers = buildManagers(pop.cohort, pop.won, activeRoster(SETTINGS));
  const byId = new Map(managers.map((row) => [row.id, row.name]));
  for (const [id, name] of SELLERS) assert.equal(byId.get(id), name, `id ${id} must read ${name}`);
  assert.equal(byId.get(OPERATOR[0]), undefined, "an operator gets no row of their own");
  assert.equal(byId.get(FUNNEL_REVIEW_KEY), FUNNEL_OWNER_LABELS[FUNNEL_REVIEW_KEY], "the bucket keeps its label");
  // The whole table is bound: no row carries a name the data does not give its id.
  assert.deepEqual(unboundManagerNames(managers, [...pop.cohort, ...pop.won], FUNNEL_OWNER_LABELS), []);
});

test("3. the click target ID equals the row's manager ID", () => {
  const pop = salesPopulations(population(), QUERY);
  const managers = buildManagers(pop.cohort, pop.won, activeRoster(SETTINGS));
  for (const row of managers) {
    if (FUNNEL_OWNER_LABELS[row.id]) continue;
    // What the UI sends on click is `row.id`; the profile then resolves from it.
    const profile = managerSection(population(), { ...QUERY, managerId: row.id }, CONTEXT);
    assert.equal(profile.manager.id, row.id, "the profile opens the clicked id");
    assert.equal(profile.manager.name, row.name, `and shows ${row.name}, not somebody else`);
    assert.equal(profile.metrics.counts.period_sales, row.periodSales, "with that id's own figures");
  }
  const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  assert.match(client, /onSelect=\{\(manager\) => \{ setSelectedManager\(\{ id: manager\.id, name: manager\.name \}\)/,
    "navigation carries the row's own id");
  assert.match(client, /onClick=\{\(\) => onSelect\(row\.id\)\}/, "the quality tables send the row id too");
  assert.doesNotMatch(client, /onSelect\(row\.name\)|setSelectedManager\(\{ id: manager\.name/, "never a name as identity");
});

test("4. sorting and filtering cannot break the name/id/target alignment", () => {
  const pop = salesPopulations(population(), QUERY);
  const managers = buildManagers(pop.cohort, pop.won, activeRoster(SETTINGS));
  const pairs = new Map(managers.map((row) => [row.id, row.name]));
  for (const sort of ["periodSales", "leads", "name", "revenue"] as const) {
    for (const direction of [1, -1]) {
      const sorted = [...managers].sort((a, b) => {
        const left = a[sort]; const right = b[sort];
        const compared = typeof left === "string" ? left.localeCompare(String(right)) : Number(left) - Number(right);
        return direction * compared;
      });
      for (const row of sorted) assert.equal(row.name, pairs.get(row.id), `${sort}/${direction} kept ${row.id} bound`);
    }
  }
  // Filtering to one manager narrows the rows without renaming anybody.
  const filtered = salesPopulations(population(), { ...QUERY, managers: ["207"] });
  const one = buildManagers(filtered.cohort, filtered.won, activeRoster(SETTINGS));
  assert.deepEqual(one.map((row) => row.id), ["207"]);
  assert.equal(one[0].name, "Soxib Bazaraliyev");
});

test("5. similar names stay separate, and an id never borrows another's name", () => {
  const rows = [
    record({ dealId: "a", qualified: true, assignedManagerId: "4151", assignedManager: "Sanjar Juraev" }),
    record({ dealId: "b", qualified: true, assignedManagerId: "239", assignedManager: "Sardor Juraev" }),
    record({ dealId: "c", qualified: true, assignedManagerId: "17", assignedManager: "Po'latxon Ashuraliyev" }),
    record({ dealId: "d", qualified: true, assignedManagerId: "35", assignedManager: "Hoshimxon Ashuraliyev" }),
  ];
  const settings = { ...SETTINGS, salesStaffIds: ["4151", "239", "17", "35"] };
  const prepared = prepareSalesRecords(rows, settings, new Date("2026-09-30T00:00:00Z"));
  const pop = salesPopulations(prepared, QUERY);
  const managers = buildManagers(pop.cohort, pop.won, activeRoster(settings));
  assert.deepEqual(
    managers.map((row) => `${row.id}=${row.name}`).sort(),
    ["17=Po'latxon Ashuraliyev", "239=Sardor Juraev", "35=Hoshimxon Ashuraliyev", "4151=Sanjar Juraev"],
  );
  // The resolver itself: an id with no name in the data names the id, never a
  // neighbour, and a wrong-id lookup never returns a real person's name.
  assert.equal(resolveManagerName("9999", pop.cohort), managerFallbackLabel("9999"));
  assert.equal(resolveManagerName("4151", [{ salesManagerId: "207", salesManager: "Soxib Bazaraliyev" }]), managerFallbackLabel("4151"));
  assert.equal(resolveManagerName("207", [{ salesManagerId: "207", salesManager: "Soxib Bazaraliyev" }]), "Soxib Bazaraliyev");
  // The funnel owner's own name wins over any other field on the same row.
  assert.equal(resolveManagerName("17", [{
    funnelOwnerId: "17", funnelOwnerName: "Po'latxon Ashuraliyev",
    salesManagerId: "207", salesManager: "Soxib Bazaraliyev",
  }]), "Po'latxon Ashuraliyev");
});

test("every manager surface resolves identity by id: quality tables and filters", () => {
  const pop = salesPopulations(population(), QUERY);
  const analytics = buildQualityAnalytics(pop.cohort);
  for (const row of [...analytics.marketingManagers, ...analytics.salesManagers]) {
    const expected = SELLERS.find(([id]) => id === row.id)?.[1]
      ?? FUNNEL_OWNER_LABELS[row.id] ?? managerFallbackLabel(row.id);
    assert.equal(row.name, expected, `Lead sifati row ${row.id} must read ${expected}`);
  }
  assert.deepEqual(unboundManagerNames([...analytics.marketingManagers, ...analytics.salesManagers], pop.cohort, FUNNEL_OWNER_LABELS), []);

  // Filter options are already id-keyed; prove they cannot merge two people.
  const options = historicalManagerOptions([
    { salesManagerId: "4151", salesManager: "Sanjar Juraev" },
    { salesManagerId: "239", salesManager: "Sardor Juraev" },
    { salesManagerId: "4151", salesManager: "Sanjar Juraev" },
  ]);
  // Options are sorted by name for the picker; identity stays the id.
  assert.deepEqual(options, [{ id: "4151", name: "Sanjar Juraev" }, { id: "239", name: "Sardor Juraev" }]);
  const live = liveManagerOptions([
    { assignedManagerId: "17", assignedManager: "Po'latxon Ashuraliyev" },
    { assignedManagerId: "35", assignedManager: "Hoshimxon Ashuraliyev" },
  ]);
  assert.deepEqual(live.map((option) => option.id).sort(), ["17", "35"]);
});
