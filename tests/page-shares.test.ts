import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildSharePayload, shareDataNeeds, visibleWidgets } from "../lib/share-model";
import { esc, renderSharePage, renderShareUnavailable } from "../lib/share-render";
import { SHARE_RESPONSE_HEADERS, sharePageResponse, shareUnavailableResponse } from "../lib/share-http";
import {
  DEFAULT_SHARED_WIDGET_TYPES, SHARE_UNAVAILABLE_MESSAGE, defaultVisibleWidgetIds,
  generateShareToken, hashShareToken, normalizeShareToken, normalizeShareExpiry,
  shareStatus, shareUrl, validateShareInput,
} from "../lib/share-tokens";
import * as store from "../lib/share-store";
import type { ShareDb, ShareStatement } from "../lib/share-store";
import { pageRangeBounds, type CustomPage, type PageWidget, type WidgetType } from "../lib/custom-pages";
import { buildDashboardMetrics, resolveDashboardMetric, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { summarizeProjects, type Project, type ProjectUpdate } from "../lib/projects";
import type { AnalyticsRecord } from "../lib/types";

/**
 * Sprint 21 — secure read-only shared pages.
 *
 * The storage half runs against a real SQL engine (`node:sqlite`) seeded with
 * the actual migration files, so "the raw token is not persisted" and "the
 * hash lookup works" are observed facts about a database rather than claims
 * about the source.
 */

// ---------------------------------------------------------------- test D1 ---

/** The slice of D1 that `share-store` uses, backed by in-memory SQLite. */
function testDb(): ShareDb & { dump: (table: string) => Record<string, unknown>[] } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["drizzle/0003_projects_and_updates.sql", "drizzle/0004_custom_pages.sql", "drizzle/0005_page_shares.sql"]) {
    for (const statement of readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  const statement = (sql: string, bound: unknown[]): ShareStatement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    run: async () => sqlite.prepare(sql).run(...(bound as never[])),
    first: async <T,>() => (sqlite.prepare(sql).all(...(bound as never[]))[0] ?? null) as T | null,
    all: async <T,>() => ({ results: sqlite.prepare(sql).all(...(bound as never[])) as T[] }),
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: ShareStatement[]) => { for (const each of statements) await each.run(); },
    dump: (table: string) => sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
  };
}

const NOW = new Date("2026-06-15T12:00:00.000Z");
const iso = (value: string) => new Date(value).toISOString();

const page = (over: Partial<CustomPage> = {}): CustomPage => ({
  id: "page-1", name: "CEO Overview", description: "Haftalik ko‘rinish", audience: "CEO",
  defaultRange: "30", createdAt: iso("2026-01-01"), updatedAt: iso("2026-06-14T09:30:00Z"),
  archivedAt: null, ...over,
});

let widgetSeq = 0;
const widget = (type: WidgetType, title: string, config: Record<string, unknown> = {}, over: Partial<PageWidget> = {}): PageWidget => {
  widgetSeq += 1;
  return {
    id: over.id ?? `w${widgetSeq}`, pageId: "page-1", widgetType: type, title,
    position: over.position ?? widgetSeq, config,
    createdAt: iso("2026-01-01"), updatedAt: iso("2026-01-01"), ...over,
  };
};

const seedPage = (db: ReturnType<typeof testDb>, row: CustomPage) =>
  db.prepare("INSERT INTO custom_pages(id, name, description, audience, default_range, created_at, updated_at, archived_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.name, row.description, row.audience, row.defaultRange, row.createdAt, row.updatedAt, row.archivedAt).run();

const seedWidget = (db: ReturnType<typeof testDb>, row: PageWidget) =>
  db.prepare("INSERT INTO custom_page_widgets(id, page_id, widget_type, title, position, config_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.pageId, row.widgetType, row.title, row.position, JSON.stringify(row.config), row.createdAt, row.updatedAt).run();

/** Two deals, both created and won inside every range the tests use. */
const record = (id: string, createdAt: string, wonAt: string | null, opportunity: number): AnalyticsRecord => ({
  dealId: id, createdAt, wonAt, opportunity, currencyId: "UZS",
  salesStatus: wonAt ? "WON" : "ACTIVE", qualified: true, lossReasonGroup: null,
  processingBusinessMinutes: 30, slaStatus: "ON_TIME", salesCycleHours: 24,
} as unknown as AnalyticsRecord);

const project = (id: string, name: string, status: string, deadline: string | null): Project => ({
  id, name, description: `${name} ichki tafsiloti`, status, deadline,
  createdAt: iso("2026-05-01"), updatedAt: iso("2026-06-10"), archivedAt: null,
});

const update = (id: string, projectId: string, title: string): ProjectUpdate => ({
  id, projectId, title, description: "ichki update matni", status: "Jarayonda",
  deadline: null, createdAt: iso("2026-06-12"), updatedAt: iso("2026-06-12"),
});

// ------------------------------------------------------------------ tokens ---

test("share token carries at least 256 bits of entropy and is URL-safe", () => {
  const token = generateShareToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/, "URL-safe alphabet only");
  assert.equal(token.length, 43, "43 base64url chars == 32 bytes == 256 bits");
  assert.equal(Buffer.from(token, "base64url").length, 32);

  const seen = new Set(Array.from({ length: 500 }, () => generateShareToken()));
  assert.equal(seen.size, 500, "no collisions across 500 tokens");
});

test("token hashing is stable, one-way in shape, and rejects junk shapes", async () => {
  const token = generateShareToken();
  const hash = await hashShareToken(token);
  assert.equal(hash.length, 64, "SHA-256 hex");
  assert.equal(hash, await hashShareToken(token), "deterministic");
  assert.notEqual(hash, token);
  assert.notEqual(hash, await hashShareToken(generateShareToken()));

  assert.equal(normalizeShareToken(token), token);
  for (const junk of ["", "  ", "short", "has spaces here", "../../etc/passwd", "a".repeat(200), null, undefined, 42]) {
    assert.equal(normalizeShareToken(junk), "", `rejected: ${String(junk)}`);
  }
});

test("share status distinguishes active, revoked and expired", () => {
  const base = { expiresAt: null as string | null, revokedAt: null as string | null };
  assert.equal(shareStatus(base, NOW), "ACTIVE");
  assert.equal(shareStatus({ ...base, expiresAt: iso("2026-12-31") }, NOW), "ACTIVE");
  assert.equal(shareStatus({ ...base, expiresAt: iso("2026-01-01") }, NOW), "EXPIRED");
  assert.equal(shareStatus({ ...base, revokedAt: iso("2026-02-01") }, NOW), "REVOKED");
  // Revocation wins even before the expiry date.
  assert.equal(shareStatus({ expiresAt: iso("2026-12-31"), revokedAt: iso("2026-02-01") }, NOW), "REVOKED");

  assert.equal(normalizeShareExpiry("2026-09-01"), "2026-09-01T23:59:59.999Z", "a bare date lasts through that day");
  assert.equal(normalizeShareExpiry(""), null);
  assert.equal(normalizeShareExpiry("not a date"), null);
  assert.equal(shareUrl("https://example.com/", "abc"), "https://example.com/share/abc");
});

test("default widget visibility is conservative", () => {
  const widgets = [
    widget("SECTION_HEADER", "Sales"), widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }),
    widget("PROJECT_SUMMARY", "Xulosa"), widget("PROJECT_STATUS_BREAKDOWN", "Statuslar"),
    widget("MANUAL_KPI", "Spend", { label: "Spend", value: "10", format: "integer" }),
    widget("PROJECTS_LIST", "Loyihalar"), widget("LATEST_UPDATES", "Updatelar"), widget("TEXT_NOTE", "Izoh", { body: "x" }),
  ];
  const selected = new Set(defaultVisibleWidgetIds(widgets));
  const byType = (type: WidgetType) => selected.has(widgets.find((each) => each.widgetType === type)!.id);

  for (const type of ["SECTION_HEADER", "SALES_KPI", "PROJECT_SUMMARY", "PROJECT_STATUS_BREAKDOWN", "MANUAL_KPI"] as WidgetType[]) {
    assert.equal(byType(type), true, `${type} selected by default`);
  }
  for (const type of ["PROJECTS_LIST", "LATEST_UPDATES", "TEXT_NOTE"] as WidgetType[]) {
    assert.equal(byType(type), false, `${type} must NOT be selected by default`);
    assert.equal(DEFAULT_SHARED_WIDGET_TYPES.includes(type), false);
  }
});

test("share input validation confines a share to its own page's widgets", () => {
  const ids = ["w1", "w2"];
  assert.equal(validateShareInput({ widgetIds: [] }, ids).ok, false, "an empty share is refused");
  assert.equal(validateShareInput({ widgetIds: ["other-page-widget"] }, ids).ok, false, "foreign ids leave nothing behind");

  const parsed = validateShareInput({ label: " CEO ", expiresAt: "2026-09-01", widgetIds: ["w2", "w2", "w1", "nope"] }, ids);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.label, "CEO");
  assert.equal(parsed.value.expiresAt, "2026-09-01T23:59:59.999Z");
  assert.deepEqual(parsed.value.widgetIds, ["w2", "w1"], "deduplicated, foreign id dropped");
});

// ----------------------------------------------------------------- storage ---

test("the raw token never reaches the database, and its hash resolves the share", async () => {
  const db = testDb();
  seedPage(db, page());
  await seedWidget(db, widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "w1" }));

  const { id, token } = await store.createShare(db, { pageId: "page-1", label: "CEO", expiresAt: null, widgetIds: ["w1"] });

  const stored = [...db.dump("page_share_tokens"), ...db.dump("page_share_widgets")]
    .flatMap((row) => Object.values(row)).map(String);
  assert.equal(stored.includes(token), false, "raw token absent from every column of every share row");
  assert.equal(stored.some((value) => value.includes(token)), false, "not embedded in another column either");
  assert.equal(db.dump("page_share_tokens")[0].token_hash, await hashShareToken(token), "the hash is what is stored");

  const resolved = await store.resolveShareByToken(db, token, NOW);
  assert.ok(resolved, "hash lookup finds the share");
  assert.equal(resolved.share.id, id);
  assert.deepEqual(resolved.share.widgetIds, ["w1"]);
  assert.equal(resolved.page.name, "CEO Overview");
});

test("unknown, revoked, expired and archived shares are all equally unavailable", async () => {
  const db = testDb();
  seedPage(db, page());
  await seedWidget(db, widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "w1" }));
  const make = () => store.createShare(db, { pageId: "page-1", label: "", expiresAt: null, widgetIds: ["w1"] });

  assert.equal(await store.resolveShareByToken(db, generateShareToken(), NOW), null, "unknown token");
  assert.equal(await store.resolveShareByToken(db, "not-a-token", NOW), null, "malformed token");
  assert.equal(await store.resolveShareByToken(db, "", NOW), null, "empty token");

  const revoked = await make();
  await store.revokeShare(db, revoked.id, iso("2026-03-01"));
  assert.equal(await store.resolveShareByToken(db, revoked.token, NOW), null, "revoked token");

  const expired = await store.createShare(db, { pageId: "page-1", label: "", expiresAt: iso("2026-01-05"), widgetIds: ["w1"] });
  assert.equal(await store.resolveShareByToken(db, expired.token, NOW), null, "expired token");
  assert.ok(await store.resolveShareByToken(db, expired.token, new Date("2026-01-04T00:00:00Z")), "…but valid before expiry");

  const live = await make();
  assert.ok(await store.resolveShareByToken(db, live.token, NOW), "active token resolves");
  await db.prepare("UPDATE custom_pages SET archived_at = ? WHERE id = ?").bind(iso("2026-06-01"), "page-1").run();
  assert.equal(await store.resolveShareByToken(db, live.token, NOW), null, "archived page takes its links down");
});

test("listShares exposes metadata only — never a token or a hash", async () => {
  const db = testDb();
  seedPage(db, page());
  await seedWidget(db, widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "w1" }));
  const { token } = await store.createShare(db, { pageId: "page-1", label: "Board weekly", expiresAt: null, widgetIds: ["w1"] });
  const hash = await hashShareToken(token);

  const shares = await store.listShares(db);
  assert.equal(shares.length, 1);
  const serialized = JSON.stringify(shares);
  assert.equal(serialized.includes(token), false, "no raw token");
  assert.equal(serialized.includes(hash), false, "no hash");
  assert.deepEqual(Object.keys(shares[0]).sort(),
    ["createdAt", "expiresAt", "id", "label", "lastAccessedAt", "pageId", "revokedAt", "widgetIds"],
    "the shape itself has no room for a credential");

  const single = await store.getShare(db, shares[0].id);
  assert.equal(JSON.stringify(single).includes(token), false);
  assert.equal(JSON.stringify(single).includes(hash), false);
});

test("two shares of one page can expose different widget sets", async () => {
  const db = testDb();
  seedPage(db, page());
  await seedWidget(db, widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "w1" }));
  await seedWidget(db, widget("TEXT_NOTE", "Ichki izoh", { body: "maxfiy" }, { id: "w2" }));

  const board = await store.createShare(db, { pageId: "page-1", label: "Board", expiresAt: null, widgetIds: ["w1"] });
  const inner = await store.createShare(db, { pageId: "page-1", label: "Ichki", expiresAt: null, widgetIds: ["w1", "w2"] });

  assert.deepEqual((await store.resolveShareByToken(db, board.token, NOW))!.share.widgetIds, ["w1"]);
  assert.deepEqual((await store.resolveShareByToken(db, inner.token, NOW))!.share.widgetIds.slice().sort(), ["w1", "w2"]);

  // Editing one share must not touch the other.
  await store.updateShare(db, board.id, { label: "Board", expiresAt: null, widgetIds: ["w1", "w2"] });
  assert.equal((await store.resolveShareByToken(db, board.token, NOW))!.share.widgetIds.length, 2);
  assert.equal((await store.resolveShareByToken(db, inner.token, NOW))!.share.widgetIds.length, 2);
  await store.updateShare(db, inner.id, { label: "Ichki", expiresAt: null, widgetIds: ["w1"] });
  assert.equal((await store.resolveShareByToken(db, board.token, NOW))!.share.widgetIds.length, 2);
  assert.deepEqual((await store.resolveShareByToken(db, inner.token, NOW))!.share.widgetIds, ["w1"]);
});

test("access stamping and cleanup never disturb the token or the page", async () => {
  const db = testDb();
  seedPage(db, page());
  await seedWidget(db, widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "w1" }));
  const { id, token } = await store.createShare(db, { pageId: "page-1", label: "", expiresAt: null, widgetIds: ["w1"] });

  await store.touchShareAccess(db, id, iso("2026-06-15T12:00:00Z"));
  assert.equal(db.dump("page_share_tokens")[0].last_accessed_at, "2026-06-15T12:00:00.000Z");
  assert.equal(db.dump("page_share_tokens")[0].token_hash, await hashShareToken(token), "hash untouched");

  await store.deleteShareWidgetLinks(db, "w1");
  assert.equal(db.dump("page_share_widgets").length, 0);
  await store.deleteSharesForPage(db, "page-1");
  assert.equal(db.dump("page_share_tokens").length, 0);
  assert.equal(db.dump("custom_pages").length, 1, "the page itself survives");
});

// ------------------------------------------------------------------- model ---

const salesFixture = () => {
  const records = [
    record("1", iso("2026-06-10"), iso("2026-06-11"), 1_000_000),
    record("2", iso("2026-06-12"), null, 0),
    record("3", iso("2026-02-01"), iso("2026-02-02"), 5_000_000),
    // Inside the 30-day window but outside the 7-day one, so the two ranges
    // cannot silently agree.
    record("4", iso("2026-05-25"), iso("2026-05-26"), 2_000_000),
  ];
  return records;
};

test("shared SALES_KPI reads the canonical metric helper, not a copy", () => {
  const records = salesFixture();
  const widgets = [widget("SALES_KPI", "", { metricId: "leads", range: "" }, { id: "k1", position: 0 })];
  const payload = buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["k1"], records, projects: [], updates: [], now: NOW,
  });

  const bounds = pageRangeBounds("30", NOW);
  const populations = selectPeriodPopulations(records, bounds.from, bounds.to);
  const expected = resolveDashboardMetric(buildDashboardMetrics(populations.cohort, populations.periodSales), "leads");

  assert.equal(payload.widgets.length, 1);
  const kpi = payload.widgets[0];
  assert.equal(kpi.kind, "KPI");
  if (kpi.kind !== "KPI") return;
  assert.equal(kpi.value, expected.value, "identical to the authenticated dashboard");
  assert.equal(kpi.title, expected.label, "falls back to the canonical label");
  assert.equal(kpi.source, "BITRIX");
});

test("page range applies, and a widget range overrides it", () => {
  const records = salesFixture();
  const widgets = [
    widget("SALES_KPI", "Inherited", { metricId: "leads", range: "" }, { id: "a", position: 0 }),
    widget("SALES_KPI", "Overridden", { metricId: "leads", range: "7" }, { id: "b", position: 1 }),
  ];
  const payload = buildSharePayload({
    page: page({ defaultRange: "30" }), widgets, allowedWidgetIds: ["a", "b"], records, projects: [], updates: [], now: NOW,
  });

  const value = (index: number) => {
    const each = payload.widgets[index];
    return each.kind === "KPI" ? each : null;
  };
  const at = (range: string) => {
    const bounds = pageRangeBounds(range, NOW);
    const populations = selectPeriodPopulations(records, bounds.from, bounds.to);
    return resolveDashboardMetric(buildDashboardMetrics(populations.cohort, populations.periodSales), "leads").value;
  };

  assert.equal(value(0)!.value, at("30"));
  assert.equal(value(0)!.detail, "Oxirgi 30 kun");
  assert.equal(value(1)!.value, at("7"));
  assert.equal(value(1)!.detail, "Oxirgi 7 kun");
  assert.notEqual(at("30"), at("7"), "the fixture actually separates the two windows");
});

test("project widgets reuse the Sprint 19 helpers and render only their own columns", () => {
  const projects = [project("p1", "Yashirin migratsiya", "Jarayonda", "2026-01-01")];
  const updates = [update("u1", "p1", "Birinchi bosqich")];
  const widgets = [
    widget("PROJECT_SUMMARY", "Xulosa", {}, { id: "s1", position: 0 }),
    widget("PROJECTS_LIST", "Loyihalar", { limit: 10 }, { id: "l1", position: 1 }),
  ];
  const payload = buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["s1", "l1"], records: [], projects, updates, now: NOW,
  });

  const summary = payload.widgets[0];
  assert.equal(summary.kind, "SUMMARY");
  if (summary.kind !== "SUMMARY") return;
  const expected = summarizeProjects(projects, NOW);
  assert.equal(summary.items.find((item) => item.label === "Jami loyihalar")!.value, String(expected.total));
  assert.equal(summary.items.find((item) => item.label === "Deadline o‘tgan")!.value, String(expected.overdue));

  const table = payload.widgets[1];
  assert.equal(table.kind, "TABLE");
  if (table.kind !== "TABLE") return;
  assert.deepEqual(table.columns, ["Loyiha", "Status", "Deadline", "Oxirgi update"]);
  assert.deepEqual(table.rows[0].cells, ["Yashirin migratsiya", "Jarayonda", "2026-01-01", "Birinchi bosqich"]);
  assert.equal(table.rows[0].alert, true, "an overdue project is still flagged");
  assert.equal(JSON.stringify(table).includes("ichki tafsiloti"), false, "description is not a rendered column");
});

test("the allowlist governs the payload, and widget order stays deterministic", () => {
  const widgets = [
    widget("SECTION_HEADER", "Sales", {}, { id: "h", position: 0 }),
    widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "k", position: 1 }),
    widget("TEXT_NOTE", "Ichki", { body: "maxfiy" }, { id: "n", position: 2 }),
    widget("MANUAL_KPI", "Spend", { label: "Spend", value: "500", format: "integer" }, { id: "m", position: 3 }),
  ];
  const build = (allowed: string[]) => buildSharePayload({
    page: page(), widgets, allowedWidgetIds: allowed, records: [], projects: [], updates: [], now: NOW,
  });

  assert.deepEqual(build(["h", "k", "n", "m"]).widgets.map((each) => each.kind),
    ["SECTION_HEADER", "KPI", "NOTE", "KPI"]);
  assert.deepEqual(build(["m", "h"]).widgets.map((each) => each.kind),
    ["SECTION_HEADER", "KPI"], "page order wins over the order ids were listed in");
  assert.deepEqual(build([]).widgets, [], "an empty allowlist renders nothing");

  // Shuffled input, same output: order comes from position, not from arrival.
  const shuffled = [widgets[3], widgets[1], widgets[0], widgets[2]];
  assert.deepEqual(visibleWidgets(shuffled, ["h", "k", "n", "m"]).map((each) => each.id), ["h", "k", "n", "m"]);

  // A widget belonging to another page can never ride along.
  const foreign = widget("TEXT_NOTE", "Boshqa sahifa", { body: "sirlar" }, { id: "x", pageId: "page-2", position: 0 });
  const smuggled = buildSharePayload({
    page: page(), widgets: [...widgets, foreign], allowedWidgetIds: ["h", "x"], records: [], projects: [], updates: [], now: NOW,
  });
  assert.equal(JSON.stringify(smuggled).includes("sirlar"), false);
});

test("only the datasets the visible widgets need are ever loaded", () => {
  const widgets = [
    widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "k", position: 0 }),
    widget("PROJECTS_LIST", "Loyihalar", {}, { id: "l", position: 1 }),
    widget("TEXT_NOTE", "Izoh", { body: "" }, { id: "n", position: 2 }),
  ];
  assert.deepEqual(shareDataNeeds(widgets, ["k"]), { analytics: true, projects: false });
  assert.deepEqual(shareDataNeeds(widgets, ["l"]), { analytics: false, projects: true });
  assert.deepEqual(shareDataNeeds(widgets, ["n"]), { analytics: false, projects: false },
    "a note-only share never touches the analytics cache");
});

// ------------------------------------------------------------------ render ---

test("an active share renders real content in the initial response, with no client boot", () => {
  const widgets = [
    widget("SECTION_HEADER", "Sales", { subtitle: "Bitrix’dan" }, { id: "h", position: 0 }),
    widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "k", position: 1 }),
    widget("MANUAL_KPI", "Spend", { label: "Spend", value: "12500", unit: "UZS", format: "currency", note: "Marketing" }, { id: "m", position: 2 }),
  ];
  const html = renderSharePage(buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["h", "k", "m"], records: salesFixture(), projects: [], updates: [], now: NOW,
  }));

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>CEO Overview<\/title>/, "the real page title, server-rendered");
  assert.match(html, /CEO Overview<\/h1>/);
  assert.match(html, /Haftalik ko‘rinish/, "description");
  assert.match(html, /Sales<\/h2>/, "section header content");
  assert.match(html, /Leadlar/, "KPI label");
  assert.match(html, /Spend/, "manual KPI");
  assert.match(html, /Yangilangan: 2026-06-14 09:30/, "freshness stamp");

  // No JavaScript at all: the recipient cannot be waiting on a bundle.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /\bsrc=/i);
  assert.doesNotMatch(html, /\bon[a-z]+=/i, "no inline event handlers");
});

test("the public render carries no editor or navigation controls", () => {
  const widgets = [
    widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "k", position: 0 }),
    widget("PROJECTS_LIST", "Loyihalar", {}, { id: "l", position: 1 }),
    widget("TEXT_NOTE", "Izoh", { body: "matn" }, { id: "n", position: 2 }),
  ];
  const html = renderSharePage(buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["k", "l", "n"],
    records: salesFixture(), projects: [project("p1", "Loyiha", "Jarayonda", null)], updates: [], now: NOW,
  }));

  for (const control of ["<button", "<form", "<input", "<select", "<textarea", "contenteditable"]) {
    assert.equal(html.includes(control), false, `no ${control} in a read-only page`);
  }
  for (const label of ["Tahrirlash", "O‘chirish", "Sozlamalar", "Widget qo‘shish", "Yangi loyiha", "Ulashish", "Sinxronizatsiya"]) {
    assert.equal(html.includes(label), false, `no "${label}" control leaks into the share`);
  }
  assert.equal(html.includes("/api/"), false, "no API surface is advertised");
});

test("user text is escaped, so page content cannot inject markup", () => {
  const evil = '<script>alert("xss")</script>';
  const widgets = [
    widget("TEXT_NOTE", evil, { body: `${evil} & "quoted"` }, { id: "n", position: 0 }),
    widget("PROJECTS_LIST", "Loyihalar", {}, { id: "l", position: 1 }),
  ];
  const html = renderSharePage(buildSharePayload({
    page: page({ name: evil, description: evil }), widgets, allowedWidgetIds: ["n", "l"],
    records: [], projects: [project("p1", evil, evil, null)], updates: [], now: NOW,
  }));

  assert.doesNotMatch(html, /<script/i, "no executable markup survives");
  assert.ok(html.includes("&lt;script&gt;"), "it is present, but escaped");
  assert.equal(esc('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("the unavailable page is generic and reveals nothing", () => {
  const html = renderShareUnavailable();
  assert.ok(html.includes(SHARE_UNAVAILABLE_MESSAGE));
  assert.doesNotMatch(html, /revoked|expired|archived|token|bekor|muddat/i,
    "the reason is never disclosed");
  assert.doesNotMatch(html, /<script/i);
});

// ------------------------------------------------------------------- http ---

test("share responses forbid indexing and caching, and unavailable is a 404", async () => {
  const ok = sharePageResponse("<!doctype html><html></html>");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
  assert.match(ok.headers.get("Cache-Control") ?? "", /no-store/);
  assert.match(ok.headers.get("Cache-Control") ?? "", /private/);
  assert.equal(ok.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(ok.headers.get("X-Frame-Options"), "DENY");
  assert.equal(ok.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(ok.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);

  const missing = shareUnavailableResponse();
  assert.equal(missing.status, 404, "404 keeps token enumeration uninformative");
  assert.equal(missing.headers.get("X-Robots-Tag"), SHARE_RESPONSE_HEADERS["X-Robots-Tag"]);
  assert.ok((await missing.text()).includes(SHARE_UNAVAILABLE_MESSAGE));
});

// ------------------------------------------------- security regression test ---

test("REGRESSION: a share exposing only the public KPI leaks nothing else", () => {
  const INTERNAL_NOTE = "INTERNAL SECRET NOTE — board only, do not distribute";
  const INTERNAL_PROJECT = "Project Nightingale (confidential acquisition)";

  const widgets = [
    widget("SALES_KPI", "PUBLIC KPI", { metricId: "leads", range: "" }, { id: "public", position: 0 }),
    widget("TEXT_NOTE", "Internal note", { body: INTERNAL_NOTE }, { id: "note", position: 1 }),
    widget("PROJECTS_LIST", "Internal projects", { status: "", deadline: "", includeArchived: false, limit: 50 }, { id: "list", position: 2 }),
    widget("LATEST_UPDATES", "Internal updates", { projectId: "", status: "", limit: 20 }, { id: "updates", position: 3 }),
  ];
  const projects = [project("p1", INTERNAL_PROJECT, "Yashirin", "2026-12-01")];
  const updates = [update("u1", "p1", "Nightingale term sheet signed")];

  const payload = buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["public"],
    records: salesFixture(), projects, updates, now: NOW,
  });
  const html = renderSharePage(payload);

  // The PUBLIC KPI is there…
  assert.equal(payload.widgets.length, 1);
  assert.ok(html.includes("PUBLIC KPI"));

  // …and nothing else is, in the payload or in the document.
  for (const secret of [
    INTERNAL_NOTE, INTERNAL_PROJECT, "Nightingale term sheet signed",
    "Internal note", "Internal projects", "Internal updates",
    "Yashirin", "ichki update matni", "2026-12-01",
  ]) {
    assert.equal(html.includes(secret), false, `HTML must not contain: ${secret}`);
    assert.equal(JSON.stringify(payload).includes(secret), false, `payload must not contain: ${secret}`);
  }

  // No config_json for unselected widgets, and no internal identifiers at all.
  for (const leak of ["config_json", "widgetId", "\"note\"", "\"list\"", "\"updates\"", "page-1", "p1", "u1"]) {
    assert.equal(html.includes(leak), false, `HTML must not contain: ${leak}`);
  }
  assert.equal(JSON.stringify(payload).includes("config"), false, "raw widget config never reaches the payload");
});

test("no settings, credentials or raw analytics reach a shared payload", () => {
  const widgets = [
    widget("SALES_KPI", "Leadlar", { metricId: "leads", range: "" }, { id: "k", position: 0 }),
    widget("PROJECT_SUMMARY", "Xulosa", {}, { id: "s", position: 1 }),
  ];
  const records = salesFixture();
  const payload = buildSharePayload({
    page: page(), widgets, allowedWidgetIds: ["k", "s"],
    records, projects: [project("p1", "Loyiha", "Jarayonda", null)], updates: [], now: NOW,
  });
  const serialized = JSON.stringify(payload);
  const html = renderSharePage(payload);

  for (const forbidden of ["webhook", "bitrix24", "rest/", "token", "settings", "dealId", "opportunity", "lossReason", "slaStatus"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `payload leaks: ${forbidden}`);
    assert.equal(html.toLowerCase().includes(forbidden.toLowerCase()), false, `HTML leaks: ${forbidden}`);
  }
  // Individual deals never appear — only the aggregate.
  for (const each of records) assert.equal(html.includes(`"${each.dealId}"`), false);
});
