import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  boundsFromKeys, dateKey, pageRangeBounds as periodBounds, pageRangeKeys,
  pageRangeLabel, validateCustomRange,
} from "../lib/period";
import {
  filterPages, pageRangeBounds, resolveWidgetCustomRange, resolveWidgetRange,
  validatePageInput, validateWidgetConfig, type CustomPage,
} from "../lib/custom-pages";
import { buildSharePayload } from "../lib/share-model";
import { renderSharePage } from "../lib/share-render";
import type { AnalyticsRecord } from "../lib/types";

/**
 * Sprint 25 — Custom Pages builder.
 *
 * Two real product bugs are covered here: archived pages could not be found or
 * restored, and the "custom" range silently behaved as 30 days.
 */

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");

const page = (over: Partial<CustomPage> = {}): CustomPage => ({
  id: "p1", name: "CEO Overview", description: "", audience: "CEO",
  defaultRange: "30", defaultFrom: null, defaultTo: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", archivedAt: null, ...over,
});

// ------------------------------------------------------------- archive -----

test("an archived page can be rediscovered and restored", () => {
  const live = page({ id: "live", name: "Live" });
  const archived = page({ id: "gone", name: "Archived", archivedAt: "2026-05-01T00:00:00.000Z" });

  assert.deepEqual(filterPages([live, archived]).map((p) => p.id), ["live"], "hidden by default");
  assert.deepEqual(filterPages([live, archived], { includeArchived: true }).map((p) => p.id).sort(), ["gone", "live"],
    "discoverable with the archive toggle");
  assert.deepEqual(filterPages([live, archived], { includeArchived: true, search: "Archived" }).map((p) => p.id), ["gone"],
    "and still searchable");

  // Restoring clears archivedAt, returning it to the normal list.
  const restored = { ...archived, archivedAt: null };
  assert.deepEqual(filterPages([live, restored]).map((p) => p.id).sort(), ["gone", "live"]);
});

test("the Pages list exposes the archive toggle and a restore path", () => {
  const view = client.slice(client.indexOf("function PagesListView"), client.indexOf("function SharePanel"));
  assert.match(view, /filterPages\(pages, \{ search, includeArchived \}\)/, "the toggle feeds filterPages");
  assert.match(client, /includeArchived=\{pageIncludeArchived\}/, "the list is wired to page-level state");
  assert.match(view, /Arxiv bilan/);
  assert.match(view, /Arxivlangan/, "archived pages are labelled in the list");
  assert.doesNotMatch(view, /filterPages\(pages, \{ search: pageSearch \}\)/, "the old archived-blind call is gone");
  assert.match(client, /Arxivdan chiqarish/, "restore action exists on the page");
});

// -------------------------------------------------------- custom range -----

test("a custom page range persists real dates and is validated", () => {
  const ok = validatePageInput({ name: "Q3", defaultRange: "custom", defaultFrom: "2026-07-01", defaultTo: "2026-09-30" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.defaultFrom, "2026-07-01");
    assert.equal(ok.value.defaultTo, "2026-09-30");
  }
  // Incomplete or inverted ranges are refused rather than silently becoming 30 days.
  assert.equal(validatePageInput({ name: "X", defaultRange: "custom" }).ok, false);
  assert.equal(validatePageInput({ name: "X", defaultRange: "custom", defaultFrom: "2026-07-01" }).ok, false);
  const inverted = validatePageInput({ name: "X", defaultRange: "custom", defaultFrom: "2026-09-30", defaultTo: "2026-07-01" });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.match(inverted.error, /keyin bo‘lishi mumkin emas/);

  // Non-custom ranges leave the columns null, so old pages stay valid.
  const thirty = validatePageInput({ name: "X", defaultRange: "30" });
  assert.equal(thirty.ok, true);
  if (thirty.ok) assert.deepEqual([thirty.value.defaultFrom, thirty.value.defaultTo], [null, null]);
});

test("a custom range actually selects its own window, not 30 days", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const custom = pageRangeBounds("custom", now, { from: "2026-07-01", to: "2026-07-31" });
  const thirty = pageRangeBounds("30", now);
  assert.notDeepEqual(custom, thirty, "custom must not behave as 30 days");
  assert.equal(new Date(custom.from).toISOString(), "2026-06-30T19:00:00.000Z", "01 Jul 00:00 Tashkent");
  assert.equal(new Date(custom.to).toISOString(), "2026-07-31T18:59:59.999Z", "31 Jul 23:59 Tashkent");
});

test("an incomplete custom range falls back rather than rendering nothing", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  assert.deepEqual(pageRangeBounds("custom", now, { from: "2026-07-01" }), pageRangeBounds("30", now));
  assert.deepEqual(pageRangeBounds("custom", now, {}), pageRangeBounds("30", now));
});

// --------------------------------------------- canonical Tashkent periods ---

test("page ranges use Tashkent calendar days, matching the dashboard", () => {
  // 2026-08-23T19:30Z is 00:30 on the 24th in Tashkent.
  const afterMidnight = new Date("2026-08-23T19:30:00.000Z");
  assert.equal(dateKey(afterMidnight), "2026-08-24");
  assert.deepEqual(pageRangeKeys("7", afterMidnight), { from: "2026-08-18", to: "2026-08-24" },
    "today plus the previous six Tashkent days");
  assert.deepEqual(pageRangeKeys("30", afterMidnight), { from: "2026-07-26", to: "2026-08-24" });
  assert.deepEqual(pageRangeKeys("month", afterMidnight), { from: "2026-08-01", to: "2026-08-24" });

  // Bounds land on Tashkent midnight, not UTC midnight.
  const bounds = boundsFromKeys({ from: "2026-08-24", to: "2026-08-24" });
  assert.equal(new Date(bounds.from).toISOString(), "2026-08-23T19:00:00.000Z");
  assert.equal(new Date(bounds.to).toISOString(), "2026-08-24T18:59:59.999Z");
});

test("the old rolling-millisecond window is gone", () => {
  const customPages = readFileSync(new URL("../lib/custom-pages.ts", import.meta.url), "utf8");
  assert.doesNotMatch(customPages, /now\.getTime\(\) - \d+ \* 86_400_000/,
    "page selection must not subtract milliseconds from the current instant");
  assert.match(customPages, /periodBounds\(range, now, custom\)/, "delegates to the canonical helper");
});

test("the builder and the public renderer resolve ranges through one helper", () => {
  const shareModel = readFileSync(new URL("../lib/share-model.ts", import.meta.url), "utf8");
  assert.match(shareModel, /pageRangeBounds\(range, now, custom\)/);
  assert.match(shareModel, /resolveWidgetCustomRange\(config, input\.page\)/);
  assert.match(client, /pageRangeBounds\(range, new Date\(\), custom\)/);
  assert.match(client, /resolveWidgetCustomRange\(widget\.config, page\)/);
});

// ------------------------------------------------------- widget config -----

test("a widget may override the range, including a real custom one", () => {
  assert.equal(resolveWidgetRange({ range: "" }, "30"), "30", "empty inherits the page range");
  assert.equal(resolveWidgetRange({ range: "7" }, "30"), "7");

  const parsed = validateWidgetConfig("SALES_KPI", { metricId: "leads", range: "custom", from: "2026-07-01", to: "2026-07-31" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual([parsed.value.from, parsed.value.to], ["2026-07-01", "2026-07-31"]);
  assert.equal(validateWidgetConfig("SALES_KPI", { metricId: "leads", range: "custom" }).ok, false,
    "a widget custom range needs both dates");
  assert.equal(validateWidgetConfig("SALES_KPI", { metricId: "leads", range: "custom", from: "2026-08-01", to: "2026-07-01" }).ok, false);

  // Inheriting means the page's custom dates apply; overriding means its own.
  const p = page({ defaultRange: "custom", defaultFrom: "2026-01-01", defaultTo: "2026-01-31" });
  assert.deepEqual(resolveWidgetCustomRange({ range: "" }, p), { from: "2026-01-01", to: "2026-01-31" });
  assert.deepEqual(resolveWidgetCustomRange({ range: "custom", from: "2026-03-01", to: "2026-03-31" }, p), { from: "2026-03-01", to: "2026-03-31" });
  assert.deepEqual(resolveWidgetCustomRange({ range: "7" }, p), {}, "a non-custom override ignores the page dates");
});

test("every configurable field has an editor control", () => {
  const drawer = client.slice(client.indexOf('<Drawer open={Boolean(widgetDraft)}'), client.indexOf("<footer><span>Bitrix24"));
  // PROJECTS_LIST: includeArchived was missing from the editor entirely.
  assert.match(drawer, /Arxivlanganlarni ham ko‘rsatish/);
  assert.match(drawer, /includeArchived: checked/);
  // LATEST_UPDATES: status was missing too.
  const latest = drawer.slice(drawer.indexOf('type === "LATEST_UPDATES"'));
  assert.match(latest.slice(0, 900), /StatusCombobox value=\{String\(config\.status/);
  assert.match(latest.slice(0, 900), /Loyiha/);
  assert.match(latest.slice(0, 900), /Limit/);
  // Metric labels, never ids.
  assert.match(drawer, /\{metric\.label\}<\/option>/);
  assert.doesNotMatch(drawer, /\{metric\.id\}<\/option>/);
  // Manual formats are shown in Uzbek, not as raw enum ids.
  assert.match(client, /MANUAL_FORMAT_LABELS\[format\]/);
  assert.match(client, /text: "Matn", integer: "Butun son"/);
  // Widgets with nothing to configure explain themselves instead of showing an empty form.
  assert.match(drawer, /Bu blokda sozlanadigan parametr yo‘q/);
});

// ------------------------------------------------------------- builder -----

test("the builder has a palette grouped by source and a canvas", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.builder-shell \{ display: grid; grid-template-columns: 250px minmax\(0, 1fr\)/,
    "palette and canvas sit side by side on desktop");
  assert.match(client, /className=\{pageEditing \? "builder-shell" : ""\}/, "only edit mode gets the two-column shell");
  assert.match(client, /function WidgetPalette/);
  assert.match(client, /PALETTE_GROUPS/);
  assert.match(client, /\{ source: "BITRIX", title: "Bitrix’dan avtomatik" \}/);
  assert.match(client, /\{ source: "PROJECTS", title: "Loyihalar" \}/);
  assert.match(client, /\{ source: "MANUAL", title: "Qo‘lda kiritiladigan" \}/);
  assert.match(client, /<SourceBadge source=\{entry\.source\} \/>/, "palette items carry a source badge");
  // Raw registry type names must not surface in normal UI.
  const palette = client.slice(client.indexOf("function WidgetPalette"), client.indexOf("function WidgetShell"));
  assert.doesNotMatch(palette, /\{entry\.type\}<\//, "technical widget type is never rendered as a label");
});

test("builder controls exist in edit mode and vanish in viewer mode", () => {
  const shell = client.slice(client.indexOf("function WidgetShell"), client.indexOf("function PagesListView"));
  assert.match(shell, /if \(!editing\) return <div className="canvas-widget">\{children\}<\/div>;/,
    "viewer mode renders the widget alone");
  for (const control of ["Sozlash", "O‘chirish", "yuqoriga", "pastga"]) {
    assert.ok(shell.includes(control), `edit mode has ${control}`);
  }
  assert.match(shell, /aria-label=\{`\$\{label\} — yuqoriga`\}/, "icon-only reorder buttons are labelled");
  assert.match(client, /Ko‘rish rejimi/);
  assert.match(client, /window\.confirm\(`"\$\{widget\.title \|\| widget\.widgetType\}" widgeti o‘chirilsinmi\?`\)/,
    "delete confirms");
});

test("an empty page guides instead of showing a blank canvas", () => {
  assert.match(client, /Sahifada hali widget yo‘q/);
  assert.match(client, /Chap tomondagi bloklardan birini qo‘shing\./);
  assert.match(client, /\["SALES_KPI", "PROJECT_SUMMARY", "MANUAL_KPI", "TEXT_NOTE"\]/, "quick adds offered");
});

test("widgets have useful empty states", () => {
  assert.match(client, /widget-empty">Loyiha topilmadi</);
  assert.match(client, /widget-empty">Update topilmadi</);
  assert.match(client, /widget-empty">Status ma’lumoti yo‘q</);
});

test("pages list and templates have distinct empty states and hierarchy", () => {
  assert.match(client, /Sahifalar hali yo‘q/);
  assert.match(client, /CEO, Marketing, Sales yoki boshqa auditoriya uchun dashboard yarating\./);
  assert.match(client, /Filtrga mos sahifa topilmadi/);
  assert.match(client, /Tez boshlash/);
  assert.match(client, /Shablondan yaratish/, "templates confirm before creating");
});

// -------------------------------------------------- share security intact ---

const record = (id: string, createdAt: string): AnalyticsRecord => ({
  dealId: id, createdAt, wonAt: null, opportunity: 0, currencyId: "UZS",
  salesStatus: "ACTIVE", qualified: true, lossReasonGroup: null,
  processingBusinessMinutes: 10, slaStatus: "ON_TIME", salesCycleHours: null,
} as unknown as AnalyticsRecord);

test("the public share payload still leaks nothing after the builder refactor", () => {
  const widgets = [
    { id: "w1", pageId: "p1", widgetType: "SALES_KPI" as const, title: "Leadlar", position: 0,
      config: { metricId: "leads", range: "custom", from: "2026-08-01", to: "2026-08-23" },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "w2", pageId: "p1", widgetType: "TEXT_NOTE" as const, title: "Ichki", position: 1,
      config: { body: "INTERNAL SECRET" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const payload = buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["w1"],
    records: [record("1", "2026-08-10T00:00:00.000Z")], projects: [], updates: [],
    now: new Date("2026-08-23T12:00:00.000Z"),
  });
  const html = renderSharePage(payload);
  for (const leak of ["INTERNAL SECRET", "config_json", "w1", "w2", "p1", "metricId", "defaultFrom"]) {
    assert.equal(html.includes(leak), false, `HTML must not contain ${leak}`);
    assert.equal(JSON.stringify(payload).includes(leak), false, `payload must not contain ${leak}`);
  }
  assert.doesNotMatch(html, /<script/i, "still no client JS");
  assert.equal(payload.widgets.length, 1, "unselected widget excluded");
});

test("a shared custom-range KPI resolves the same window as the builder", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const custom = { from: "2026-08-01", to: "2026-08-10" };
  assert.deepEqual(periodBounds("custom", now, custom), pageRangeBounds("custom", now, custom));
  assert.equal(pageRangeLabel("custom", custom), "2026-08-01 — 2026-08-10");
});

test("share security contract is unchanged", () => {
  const shareStore = readFileSync(new URL("../lib/share-store.ts", import.meta.url), "utf8");
  assert.match(shareStore, /hashShareToken\(token\)/);
  assert.doesNotMatch(shareStore, /token_hash.*SELECT \*/);
  assert.match(client, /Bu havola qayta ko‘rsatilmaydi\. Hozir nusxalang\./);
  assert.match(client, /Havola bekor qilinsinmi\?/, "revoke confirms");
});

test("custom range validation helper rejects what the API rejects", () => {
  assert.equal(validateCustomRange("2026-01-01", "2026-01-31").ok, true);
  assert.equal(validateCustomRange("", "2026-01-31").ok, false);
  assert.equal(validateCustomRange("2026-01-31", "2026-01-01").ok, false);
  assert.equal(validateCustomRange("nonsense", "2026-01-31").ok, false);
});
