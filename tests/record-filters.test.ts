import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  UNASSIGNED_MANAGER_KEY,
  activeFilterCount,
  dedupeByDealId,
  filterCurrentStageRecords,
  filterHistoricalRecords,
  filterStageHistoryRecords,
  historicalManagerKey,
  historicalManagerOptions,
  liveManagerOptions,
  matchesSelection,
  normalizeSelection,
  selectionSummary,
  toggleSelection,
} from "../lib/record-filters";
import { MultiSelect, MultiSelectPanel } from "../app/ui/multi-select";

/**
 * Multi-value Manager and Source filters.
 *
 * OR inside a dimension, AND across dimensions, empty selection = all. Manager
 * identity for historical analytics is `salesManagerId` only; the live
 * open-stage view keeps using the current assignee.
 */

const CRM = "CRM-форма";
const SARAFAN = "Сарафан";
const COLD = "Холодный звонок";
const OTHER = "Instagram";

type Row = {
  dealId: string;
  title: string;
  salesManagerId: string | null;
  salesManager: string | null;
  assignedManagerId: string;
  assignedManager: string;
  source: string;
  originPipeline: string;
  stage: string;
  creationPeriod: string;
  slaStatus: string;
  processingSource: string;
  salesStatus: string;
};

function row(dealId: string, over: Partial<Row> = {}): Row {
  return {
    dealId, title: `Deal ${dealId}`,
    salesManagerId: "ali", salesManager: "Ali",
    assignedManagerId: "ali", assignedManager: "Ali",
    source: CRM, originPipeline: "IBOX Sales", stage: "ОБРАБОТКА",
    creationPeriod: "WORK_HOURS", slaStatus: "ON_TIME", processingSource: "QUALIFICATION_STAGE",
    salesStatus: "ACTIVE", ...over,
  };
}

const ali = (id: string, over: Partial<Row> = {}) => row(id, { salesManagerId: "ali", salesManager: "Ali", assignedManagerId: "ali", assignedManager: "Ali", ...over });
const sanjar = (id: string, over: Partial<Row> = {}) => row(id, { salesManagerId: "sanjar", salesManager: "Sanjar", assignedManagerId: "sanjar", assignedManager: "Sanjar", ...over });
const dilnoza = (id: string, over: Partial<Row> = {}) => row(id, { salesManagerId: "dilnoza", salesManager: "Dilnoza", assignedManagerId: "dilnoza", assignedManager: "Dilnoza", ...over });

const ids = (rows: { dealId: string }[]) => rows.map((item) => item.dealId).sort();

// ------------------------------------------------------- required scenarios ---

test("1: CRM + Сарафан gives the union of both sources and nothing else", () => {
  const rows = [
    ali("1", { source: CRM }), sanjar("2", { source: SARAFAN }), ali("3", { source: COLD }),
    dilnoza("4", { source: OTHER }), sanjar("5", { source: CRM }),
  ];
  const filtered = filterHistoricalRecords(rows, { sources: [CRM, SARAFAN] });
  assert.deepEqual(ids(filtered), ["1", "2", "5"]);
  assert.ok(filtered.every((item) => [CRM, SARAFAN].includes(item.source)));
  assert.equal(filtered.length, 3, "a record is returned once, not once per matching source");
});

test("2: CRM + Сарафан + Холодный звонок gives the union of all three", () => {
  const rows = [
    ali("1", { source: CRM }), sanjar("2", { source: SARAFAN }), ali("3", { source: COLD }),
    dilnoza("4", { source: OTHER }),
  ];
  assert.deepEqual(ids(filterHistoricalRecords(rows, { sources: [CRM, SARAFAN, COLD] })), ["1", "2", "3"]);
});

test("3: Ali + Sanjar gives the union of both sellers", () => {
  const rows = [ali("1"), sanjar("2"), dilnoza("3"), ali("4"), row("5", { salesManagerId: null, salesManager: null })];
  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: ["ali", "sanjar"] })), ["1", "2", "4"]);
});

test("4: (Ali + Sanjar) AND (CRM + Сарафан) intersects across dimensions", () => {
  const rows = [
    ali("1", { source: CRM }),          // both match
    sanjar("2", { source: SARAFAN }),   // both match
    ali("3", { source: COLD }),         // manager matches, source does not
    dilnoza("4", { source: CRM }),      // source matches, manager does not
    dilnoza("5", { source: OTHER }),    // neither
  ];
  const filtered = filterHistoricalRecords(rows, { managers: ["ali", "sanjar"], sources: [CRM, SARAFAN] });
  assert.deepEqual(ids(filtered), ["1", "2"]);
});

test("5: a single selection behaves exactly like the old single-select filter", () => {
  const rows = [ali("1", { source: CRM }), sanjar("2", { source: CRM }), ali("3", { source: SARAFAN })];
  const legacyManager = rows.filter((item) => item.salesManagerId === "ali");
  const legacySource = rows.filter((item) => item.source === CRM);
  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: ["ali"] })), ids(legacyManager));
  assert.deepEqual(ids(filterHistoricalRecords(rows, { sources: [CRM] })), ids(legacySource));
  // And a scalar that reaches the state from an older bundle still works.
  assert.deepEqual(normalizeSelection("ali"), ["ali"]);
  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: normalizeSelection("ali") })), ids(legacyManager));
});

test("6: no selection means all, and clearing a filter widens the view back to all", () => {
  const rows = [ali("1", { source: CRM }), sanjar("2", { source: SARAFAN }), dilnoza("3", { source: COLD })];
  assert.deepEqual(ids(filterHistoricalRecords(rows, {})), ["1", "2", "3"]);
  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: [], sources: [] })), ["1", "2", "3"]);
  assert.equal(matchesSelection([], "anything"), true);
  assert.equal(matchesSelection([], null), true, "an empty selection matches a record with no value at all");
  // Narrow, then clear: back to everything.
  const narrowed = filterHistoricalRecords(rows, { managers: ["ali"], sources: [CRM] });
  assert.deepEqual(ids(narrowed), ["1"]);
  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: toggleSelection(["ali"], "ali"), sources: [] })), ["1", "2", "3"]);
});

test("7: a post-sale assignee who is not the salesManagerId does not match the historical manager filter", () => {
  // Sold by Ali, card now held by a customer-care assignee.
  const handedOver = row("1", {
    salesManagerId: "ali", salesManager: "Ali",
    assignedManagerId: "support", assignedManager: "Support",
  });
  const rows = [handedOver, sanjar("2")];

  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: ["support"] })), [],
    "the current assignee is never an alternative seller identity");
  assert.deepEqual(ids(filterHistoricalRecords(rows, { managers: ["ali"] })), ["1"],
    "the seller who actually closed it still matches");
  assert.deepEqual(ids(filterStageHistoryRecords(rows, { managers: ["support"] })), [],
    "the historical stage funnel uses the same rule");
  assert.deepEqual(ids(filterStageHistoryRecords(rows, { managers: ["ali"] })), ["1"]);
  assert.deepEqual(ids(filterStageHistoryRecords(rows, { managers: ["ali"], sources: [CRM] })), ["1"],
    "the historical stage funnel applies Manager AND Source");
  assert.deepEqual(ids(filterStageHistoryRecords(rows, { managers: ["ali"], sources: [SARAFAN] })), [],
    "a non-matching Source excludes the historical row");

  // The live open-stage view is the one place the assignee is the right key.
  assert.deepEqual(ids(filterCurrentStageRecords([{ dealId: "1", title: "t", assignedManagerId: "support" }], { managers: ["support"] })), ["1"]);
});

// ------------------------------------------- cross-view and safety guarantees ---

test("cohort and period-sales populations receive identical manager/source filtering", () => {
  const rows = [
    ali("1", { source: CRM, salesStatus: "WON" }),
    sanjar("2", { source: SARAFAN, salesStatus: "WON" }),
    dilnoza("3", { source: CRM, salesStatus: "WON" }),
    ali("4", { source: CRM, salesStatus: "ACTIVE" }),
  ];
  const filters = { managers: ["ali", "sanjar"], sources: [CRM, SARAFAN] };
  const base = filterHistoricalRecords(rows, filters);
  // Both populations are derived from the same filtered base; only the date key
  // differs, which is what the client does.
  const cohort = base;
  const periodSales = base.filter((item) => item.salesStatus === "WON");
  assert.deepEqual(ids(cohort), ["1", "2", "4"]);
  assert.deepEqual(ids(periodSales), ["1", "2"]);
  assert.ok(periodSales.every((sale) => cohort.some((item) => item.dealId === sale.dealId)),
    "no sale can appear in period sales while being filtered out of the cohort");
});

test("combining cohort and period rows never duplicates a Deal", () => {
  const won = ali("1", { salesStatus: "WON" });
  const active = sanjar("2");
  assert.deepEqual(ids(dedupeByDealId([won, active], [won])), ["1", "2"]);
  assert.equal(dedupeByDealId([won], [won], [won]).length, 1);
});

test("the other filter dimensions keep working alongside a multi-value selection", () => {
  const rows = [
    ali("1", { source: CRM, originPipeline: "IBOX Sales", stage: "ОБРАБОТКА", creationPeriod: "WORK_HOURS", slaStatus: "ON_TIME", processingSource: "QUALIFICATION_STAGE" }),
    ali("2", { source: CRM, originPipeline: "SD Sales" }),
    ali("3", { source: CRM, stage: "Not relevant" }),
    ali("4", { source: CRM, creationPeriod: "AFTER_HOURS" }),
    ali("5", { source: CRM, slaStatus: "LATE" }),
    ali("6", { source: CRM, processingSource: "NO_PROCESSING" }),
    ali("7", { source: CRM, originPipeline: "SD Sales", title: "Alpha corp" }),
  ];
  const filters = {
    managers: ["ali", "sanjar"], sources: [CRM],
    pipeline: "IBOX Sales", stage: "ОБРАБОТКА", period: "WORK_HOURS", sla: "ON_TIME", processing: "QUALIFICATION_STAGE",
  };
  assert.deepEqual(ids(filterHistoricalRecords(rows, filters)), ["1"]);
  assert.deepEqual(ids(filterHistoricalRecords(rows, { sources: [CRM], search: "alpha" })), ["7"], "search matches the title");
  assert.deepEqual(ids(filterHistoricalRecords(rows, { sources: [CRM], search: "3" })), ["3"], "search matches the Deal ID");
});

test("a record with no seller falls into one Aniqlanmagan bucket that is selectable", () => {
  const unassigned = row("1", { salesManagerId: null, salesManager: null });
  assert.equal(historicalManagerKey(unassigned), UNASSIGNED_MANAGER_KEY);
  assert.deepEqual(ids(filterHistoricalRecords([unassigned, ali("2")], { managers: [UNASSIGNED_MANAGER_KEY] })), ["1"]);
  assert.deepEqual(ids(filterHistoricalRecords([unassigned, ali("2")], { managers: [UNASSIGNED_MANAGER_KEY, "ali"] })), ["1", "2"]);
});

test("manager options are the keys the filter compares against, per mode", () => {
  const rows = [
    row("1", { salesManagerId: "ali", salesManager: "Ali", assignedManagerId: "support", assignedManager: "Support" }),
    row("2", { salesManagerId: null, salesManager: null, assignedManagerId: "sanjar", assignedManager: "Sanjar" }),
  ];
  assert.deepEqual(historicalManagerOptions(rows), [
    { id: "ali", name: "Ali" },
    { id: UNASSIGNED_MANAGER_KEY, name: "Aniqlanmagan" },
  ], "history offers sellers only — never the current assignee");
  assert.deepEqual(liveManagerOptions(rows), [
    { id: "sanjar", name: "Sanjar" },
    { id: "support", name: "Support" },
  ]);
  // Every offered option matches at least one record, in both directions.
  for (const option of historicalManagerOptions(rows)) {
    assert.ok(filterHistoricalRecords(rows, { managers: [option.id] }).length > 0, `${option.id} matches nothing`);
  }
});

test("normalizeSelection accepts arrays, a bare scalar and junk without crashing", () => {
  assert.deepEqual(normalizeSelection(["a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeSelection("a"), ["a"]);
  assert.deepEqual(normalizeSelection(""), [], "the old 'all' sentinel becomes an empty selection");
  assert.deepEqual(normalizeSelection(undefined), []);
  assert.deepEqual(normalizeSelection(null), []);
  assert.deepEqual(normalizeSelection(["a", "a", ""]), ["a"], "de-duplicated, blanks dropped");
  assert.deepEqual(normalizeSelection([1, { a: 1 }, "b"]), ["b"]);
});

test("toggleSelection adds and removes without mutating the original", () => {
  const start = ["ali"];
  assert.deepEqual(toggleSelection(start, "sanjar"), ["ali", "sanjar"]);
  assert.deepEqual(toggleSelection(start, "ali"), []);
  assert.deepEqual(start, ["ali"], "the input array is untouched");
});

test("the active-filter badge counts a multi-value dimension once, however many values it holds", () => {
  assert.equal(activeFilterCount({}), 0);
  assert.equal(activeFilterCount({ managers: [], sources: [] }), 0);
  assert.equal(activeFilterCount({ managers: ["ali", "sanjar", "dilnoza"] }), 1);
  assert.equal(activeFilterCount({ managers: ["ali"], sources: [CRM, SARAFAN] }), 2);
  assert.equal(activeFilterCount({ managers: ["ali"], sources: [CRM], pipeline: "IBOX Sales", stage: "x", period: "WORK_HOURS", sla: "LATE", processing: "NO_PROCESSING" }), 7);
  assert.equal(activeFilterCount({ search: "alpha" }), 0, "search has its own indicator");
});

test("the button text names one selection and counts several", () => {
  const labelOf = (value: string) => ({ ali: "Ali", sanjar: "Sanjar" }[value] ?? value);
  assert.equal(selectionSummary([], "Barcha menejerlar", labelOf), "Barcha menejerlar");
  assert.equal(selectionSummary(["ali"], "Barcha menejerlar", labelOf), "Ali");
  assert.equal(selectionSummary(["ali", "sanjar"], "Barcha menejerlar", labelOf), "2 tanlandi");
});

// ------------------------------------------------------------ UI contract ---

test("MultiSelect renders the selection summary and a labelled, accessible trigger", () => {
  const html = renderToStaticMarkup(createElement(MultiSelect, {
    label: "Menejer", allLabel: "Barcha menejerlar",
    options: [{ id: "ali", name: "Ali" }, { id: "sanjar", name: "Sanjar" }],
    selected: ["ali", "sanjar"], onChange: () => {},
  }));
  assert.match(html, /aria-label="Menejer"/);
  assert.match(html, /aria-expanded="false"/, "the panel starts closed");
  assert.match(html, /2 tanlandi/, "the selected count is visible without opening the panel");
  assert.match(html, /has-selection/, "an active filter is visually distinct");
  assert.doesNotMatch(html, /type="checkbox"/, "options are not rendered until the panel opens");

  const empty = renderToStaticMarkup(createElement(MultiSelect, {
    label: "Manba", allLabel: "Barcha manbalar", options: [{ id: CRM, name: CRM }], selected: [], onChange: () => {},
  }));
  assert.match(empty, /Barcha manbalar/, "an empty selection reads as 'all', not as an empty state");
  assert.doesNotMatch(empty, /has-selection/);
});

test("the open panel renders one checkbox per option, checked for the current selection", () => {
  const html = renderToStaticMarkup(createElement(MultiSelectPanel, {
    label: "Manba", query: "", onQuery: () => {}, onChange: () => {},
    options: [{ id: CRM, name: CRM }, { id: SARAFAN, name: SARAFAN }, { id: COLD, name: COLD }],
    selected: [CRM, SARAFAN],
  }));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3, "every option is a checkbox, not a single-choice row");
  assert.equal((html.match(/checked=""/g) ?? []).length, 2, "exactly the two selected options are checked");
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Manba"/);
  assert.match(html, /Tozalash/, "a selection can be cleared from inside the panel");
  assert.match(html, /2 tanlandi — birlashtirilgan natija/, "the panel says the result is combined");
  assert.ok(html.includes(CRM) && html.includes(SARAFAN) && html.includes(COLD));
});

test("the empty panel offers no clear action and says an empty selection means all", () => {
  const html = renderToStaticMarkup(createElement(MultiSelectPanel, {
    label: "Menejer", query: "", onQuery: () => {}, onChange: () => {},
    options: [{ id: "ali", name: "Ali" }], selected: [],
  }));
  assert.doesNotMatch(html, /Tozalash/, "nothing to clear yet");
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /Hech biri tanlanmagan — barchasi/);
});

test("the panel search appears only for long lists and narrows the options shown", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, name: `Menejer ${index}` }));
  const short = renderToStaticMarkup(createElement(MultiSelectPanel, {
    label: "Menejer", query: "", onQuery: () => {}, onChange: () => {}, options: many.slice(0, 3), selected: [],
  }));
  assert.doesNotMatch(short, /multi-select-search/, "a short list needs no search box");

  const long = renderToStaticMarkup(createElement(MultiSelectPanel, {
    label: "Menejer", query: "", onQuery: () => {}, onChange: () => {}, options: many, selected: [],
  }));
  assert.match(long, /multi-select-search/);

  const searched = renderToStaticMarkup(createElement(MultiSelectPanel, {
    label: "Menejer", query: "menejer 1", onQuery: () => {}, onChange: () => {}, options: many, selected: [],
  }));
  // "Menejer 1", 10 and 11 — case-insensitive substring, selection untouched.
  assert.equal((searched.match(/type="checkbox"/g) ?? []).length, 3);

  const noMatch = renderToStaticMarkup(createElement(MultiSelectPanel, {
    label: "Menejer", query: "zzz", onQuery: () => {}, onChange: () => {}, options: many, selected: [],
  }));
  assert.match(noMatch, /Natija topilmadi/);
});

test("the client wires both dimensions to the shared multi-select semantics", () => {
  const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(client, /managers: \[\], sources: \[\]/, "empty filters start as empty selections");
  assert.doesNotMatch(client, /filters\.manager\b/, "no scalar manager filter survives");
  assert.doesNotMatch(client, /filters\.source\b/, "no scalar source filter survives");
  assert.equal((client.match(/<MultiSelect/g) ?? []).length, 4, "manager in both modes, plus historical Source in both bars");

  // Every view derives from the shared predicates, so none can drift.
  // Historical Sales sections filter on the server with the same predicate.
  const sections = readFileSync(new URL("../lib/sales-sections.ts", import.meta.url), "utf8");
  assert.match(sections, /filterHistoricalRecords\(records, query\)/);
  assert.match(client, /for \(const manager of filters\.managers\) params\.append\("manager", manager\)/, "every selected seller is sent");
  assert.match(client, /for \(const source of filters\.sources\) params\.append\("source", source\)/, "every selected source is sent");
  assert.match(client, /filterCurrentStageRecords\(effectiveCurrentStages, filters\)/);
  assert.match(client, /filterStageHistoryRecords\(stageFunnelRecords, filters\)/);
  assert.match(sections, /dedupeByDealId\(cohort, won\)/, "the Deals view cannot show a Deal twice");
  // Opening Stage Control preserves Source for its historical funnel and clears
  // only dimensions the projection cannot filter on.
  assert.match(client, /\{ \.\.\.current, period: "", sla: "", processing: "" \}/);
  assert.doesNotMatch(client, /if \(item\.id === "stages"\)[^\n]*sources: \[\]/);
  assert.match(css, /\.multi-select-panel/, "the panel is styled, not unstyled browser default");
});
