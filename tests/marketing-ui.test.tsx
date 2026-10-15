import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ATTRIBUTED_SPEND_HELP, drillMarketingEntity, marketingDealRequest, MarketingView, reconcileMarketingFilters } from "../app/marketing/marketing-view";
import { CostValue } from "../app/marketing/marketing-shared";
import {
  FixtureMarketingAdapter, HttpMarketingAdapter, MARKETING_ENDPOINTS, MarketingAdapterError,
  resolveMarketingCosts,
} from "../app/marketing/marketing-adapter";
import { MarketingResourceNotice, loadMarketingResource } from "../app/marketing/marketing-resource";
import {
  EMPTY_MARKETING_FILTERS, parseMarketingUrlState, serializeMarketingUrlState,
} from "../app/marketing/marketing-url-state";
import { MARKETING_WORKSPACES } from "../app/marketing/marketing-workspaces";
import { EMPTY_MARKETING_OPTIONS as EMPTY_MARKETING_FILTERS_OPTIONS, type MarketingDealRequest, type MarketingFilters } from "../app/marketing/marketing-types";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixture = new FixtureMarketingAdapter();
const context = { workspace: "IBOX_UZ" as const, filters: { ...EMPTY_MARKETING_FILTERS } };

const common = (workspace = "IBOX_UZ", icpStatus: "ENABLED" | "NOT_APPLICABLE" = "ENABLED") => ({
  project: workspace === "SD_UZ" ? "SALES_DOCTOR" : "IBOX",
  workspace,
  icpStatus,
  range: { startDate: "2026-10-01", endDate: "2026-10-15" },
  filters: {},
  fx: { usdToUzs: 11_800 },
  dataAsOf: "2026-10-15T09:00:00+05:00",
});

const cost = {
  spendByCurrency: { UZS: 1_180_000_000 }, spendUzs: 11_800_000,
  cmcUzs: 1_180_000, roas: 4, cplUzs: 93_651, costPerIcpFitUzs: 142_169,
  costPerSqlUzs: 256_522, costPerSaleUzs: 1_180_000,
};

const summaryPayload = {
  ...common(),
  summary: {
    leadCount: 126, saralanganCount: 112, sqlCount: 46, inPipelineCount: 29, saleCount: 10,
    revenueUzs: 47_200_000, icpStatus: "ENABLED" as const, icpEvaluatedCount: 112,
    icpFitCount: 83, icpOtherCount: 29, icpUnsetCount: 14, icpFitRate: 0.74,
    ...cost, spendApplies: true,
    coverage: { campaignIdCoverage: 0.94, adsetIdCoverage: 0.9, adIdCoverage: 0.92 },
  },
};

const entity = {
  id: "120200000000000001", name: "Campaign A", campaignId: null, adsetId: null,
  leadCount: 12, saralanganCount: 10, sqlCount: 5, inPipelineCount: 3, saleCount: 2,
  revenueUzs: 8_400_000, icpStatus: "ENABLED" as const, icpEvaluatedCount: 10,
  icpFitCount: 7, icpOtherCount: 3, icpUnsetCount: 2, icpFitRate: 0.7, ...cost,
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("Marketing components depend on the adapter interface, with fixture and HTTP implementations", () => {
  assert.equal(fixture.source, "fixtures");
  assert.equal(new HttpMarketingAdapter(async () => json({}) as never).source, "http");
  const components = read("app/marketing/marketing-view.tsx") + read("app/marketing/marketing-additions.tsx") + read("app/marketing/marketing-shared.tsx");
  assert.doesNotMatch(components, /fixtureMarketingAdapter|MARKETING_SUMMARIES|MARKETING_ROWS/);
  // Integration (V1): the runtime composition root is the real HTTP adapter; fixtures are test/demo only.
  const client = read("app/dashboard-client.tsx");
  assert.match(client, /const marketingAdapter = new HttpMarketingAdapter\(\);/);
  assert.doesNotMatch(client, /FixtureMarketingAdapter|marketing-fixtures/, "no fixture adapter in runtime");
  for (const path of ["app/marketing/marketing-view.tsx", "app/marketing/marketing-additions.tsx", "app/marketing/marketing-shared.tsx", "app/marketing/marketing-url-state.ts"]) {
    assert.doesNotMatch(read(path), /marketing-fixtures|FixtureMarketingAdapter/, path);
  }
});

test("HttpMarketingAdapter binds the five agreed GET endpoints and maps response names without calculating metrics", async () => {
  const calls: URL[] = [];
  const fetchMock = async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://dashboard.test");
    calls.push(url);
    if (url.pathname === MARKETING_ENDPOINTS.summary) return json(summaryPayload);
    if (url.pathname === MARKETING_ENDPOINTS.entities) return json({ ...common(), level: url.searchParams.get("level"), rows: [entity] });
    if (url.pathname === MARKETING_ENDPOINTS.deals) return json({ ...common(), metric: "sql", count: 1, truncated: false, deals: [{
      dealId: "43001", title: "Lead", createdAt: "2026-10-01T09:00:00+05:00", bitrixUrl: null,
      stage: "ОБРАБОТКА", assignedManagerId: "235", saralangan: true, sql: true, nr: false, sale: false,
      opportunity: 0, currencyId: "UZS", icpClass: "P1", campaignId: "120200000000000001",
      campaignName: "Campaign A", adsetId: "120200000000000101", adsetName: "Adset A",
      adId: "120200000000001001", adName: "Ad A", channel: "META_INSTANT_FORM", attributionConflict: false,
    }] });
    if (url.pathname === MARKETING_ENDPOINTS.icp) return json({ ...common(), icp: { evaluated: 3, fit: 2, notFit: 1, unset: 1, byTier: { P1: 1, P2: 1, P3: 0 }, fitRate: 2 / 3 }, byManager: [] });
    if (url.pathname === MARKETING_ENDPOINTS.coverage) return json({ ...common(), coverage: { deals: 3, withCampaignId: 2, withAdsetId: 2, withAdId: 1, metaInstantForm: 1, website: 1, otherSource: 0, unknown: 1, conflicts: 1, notYetAttributed: 1 } });
    return json({ error: "missing" }, 404);
  };
  const adapter = new HttpMarketingAdapter(fetchMock as typeof fetch);
  const summary = await adapter.getSummary(context);
  const entities = await adapter.getEntities({ ...context, level: "campaign" });
  const deals = await adapter.getDeals({ ...context, metric: "sql", metricLabel: "SQL", entity: null });
  const icp = await adapter.getIcp(context);
  const coverage = await adapter.getCoverage(context);

  assert.deepEqual(calls.map((call) => call.pathname), Object.values(MARKETING_ENDPOINTS));
  assert.equal(summary.summary.classifiedCount, 112);
  assert.equal(summary.summary.pipelineCount, 29);
  assert.equal(summary.summary.sqlRate, null, "the UI does not derive a rate absent from the API");
  assert.equal(entities.rows[0].leadCount, 12);
  assert.equal(deals.deals[0].dealId, "43001");
  assert.equal(icp.status, "ENABLED");
  assert.equal(coverage.coverage.conflicts, 1);
});

test("Campaign → Ad Set → Ad drilldown preserves URL filter context", async () => {
  const filters: MarketingFilters = {
    ...EMPTY_MARKETING_FILTERS,
    startDate: "2026-10-01", endDate: "2026-10-15", source: "CRM forma", placement: "Instagram Reels",
  };
  const campaign = (await fixture.getEntities({ workspace: "IBOX_UZ", filters, level: "campaign" })).rows.find((row) => row.id === "cmp-leadgen")!;
  const atAdsets = drillMarketingEntity({ workspace: "IBOX_UZ", filters, level: "campaign" }, campaign);
  const adset = (await fixture.getEntities({ workspace: "IBOX_UZ", filters: atAdsets.filters, level: "adset" })).rows.find((row) => row.id === "set-broad")!;
  const atAds = drillMarketingEntity(atAdsets, adset);
  assert.equal(atAdsets.level, "adset");
  assert.equal(atAds.level, "ad");
  assert.equal(atAds.filters.campaignId, "cmp-leadgen");
  assert.equal(atAds.filters.adsetId, "set-broad");
  assert.equal(atAds.filters.source, "CRM forma");
  assert.equal(atAds.filters.placement, "Instagram Reels");
  const query = new URLSearchParams(serializeMarketingUrlState(atAds));
  assert.deepEqual([query.get("workspace"), query.get("campaignId"), query.get("adsetId"), query.get("level")], ["IBOX_UZ", "cmp-leadgen", "set-broad", "ad"]);
});

test("Marketing URL state round-trips filters and reserved KZ workspace keys", () => {
  const parsed = parseMarketingUrlState("?workspace=IBOX_KZ&startDate=2026-09-01&endDate=2026-09-30&source=WEB&campaignId=12345&adsetId=23456&adId=34567&placement=Feed&landing=%2Fkz&level=ad", "IBOX_UZ", new Date("2026-10-15T00:00:00Z"));
  assert.equal(parsed.workspace, "IBOX_KZ");
  assert.equal(parsed.filters.startDate, "2026-09-01");
  assert.equal(parsed.filters.landing, "/kz");
  const roundTrip = parseMarketingUrlState(serializeMarketingUrlState(parsed), "IBOX_UZ", new Date("2026-10-15T00:00:00Z"));
  assert.deepEqual(roundTrip, parsed);
});

test("resource state exposes bounded errors, Retry and empty state", async () => {
  let attempts = 0;
  const retryingAdapter = new HttpMarketingAdapter((async () => {
    attempts += 1;
    if (attempts === 1) return json({ error: "Temporary failure" }, 503) as never;
    return json({ ...common(), coverage: { deals: 1, withCampaignId: 1, withAdsetId: 1, withAdId: 1, metaInstantForm: 1, website: 0, otherSource: 0, unknown: 0, conflicts: 0, notYetAttributed: 0 } }) as never;
  }) as typeof fetch);
  const load = () => retryingAdapter.getCoverage(context);
  const failed = await loadMarketingResource(load);
  const retried = await loadMarketingResource(load, (response) => response.coverage.deals === 0);
  assert.deepEqual(failed, { status: "error", message: "Temporary failure" });
  assert.equal(retried.status, "ready");
  const errorHtml = renderToStaticMarkup(<MarketingResourceNotice state={failed} onRetry={() => undefined} />);
  assert.match(errorHtml, /Qayta urinish/);
  assert.match(renderToStaticMarkup(<MarketingResourceNotice state={{ status: "empty", data: [] }} />), /ma’lumot yo‘q/);
  const icpNotApplicable = new HttpMarketingAdapter(async () => json({ error: "ICP bu loyiha uchun qo‘llanilmaydi", code: "ICP_NOT_APPLICABLE" }, 400) as never);
  assert.deepEqual(
    await loadMarketingResource(() => icpNotApplicable.getIcp(context)),
    { status: "not_applicable", message: "ICP bu loyiha uchun qo‘llanilmaydi" },
  );
  const workspaceNotActivated = new HttpMarketingAdapter(async () => json({ error: "Bu workspace hali faollashtirilmagan", code: "WORKSPACE_NOT_ACTIVATED" }, 409) as never);
  assert.deepEqual(
    await loadMarketingResource(() => workspaceNotActivated.getSummary({ workspace: "IBOX_KZ", filters: { ...EMPTY_MARKETING_FILTERS } })),
    { status: "not_applicable", message: "Bu workspace hali faollashtirilmagan" },
  );
  const page = renderToStaticMarkup(<MarketingView workspace="IBOX_UZ" adapter={fixture} />);
  assert.match(page, /Marketing ma’lumotlari yuklanmoqda/);
});

test("cost availability distinguishes values, no sales, no spend, disconnected, pending and currency", async () => {
  const base = { ...cost, spendApplies: true, saleCount: 1 };
  assert.equal(resolveMarketingCosts(base).status, "AVAILABLE");
  const noSales = resolveMarketingCosts({ ...base, saleCount: 0, cmcUzs: null });
  assert.equal(noSales.status, "NO_SALES");
  assert.match(renderToStaticMarkup(<CostValue costs={noSales} metric="cmc" />), /Sotuv yo‘q/);
  const noSpend = resolveMarketingCosts({ ...base, spendUzs: 0, spendByCurrency: {}, cmcUzs: null, roas: null });
  assert.equal(noSpend.status, "NO_SPEND");
  assert.match(renderToStaticMarkup(<CostValue costs={noSpend} metric="roas" />), /Spend yo‘q/);
  assert.doesNotMatch(renderToStaticMarkup(<CostValue costs={noSpend} metric="roas" />), /0x/);
  assert.equal(resolveMarketingCosts({ ...base, metaStatus: "DISCONNECTED" }).status, "META_NOT_CONNECTED");
  assert.equal(resolveMarketingCosts({ ...base, metaStatus: "PENDING" }).status, "PENDING");
  assert.equal(resolveMarketingCosts({ ...base, spendUzs: null, spendByCurrency: { EUR: 1200 } }).status, "CURRENCY_UNAVAILABLE");
  const disconnected = resolveMarketingCosts({ ...base, metaStatus: "DISCONNECTED" });
  const pending = resolveMarketingCosts({ ...base, metaStatus: "PENDING" });
  const currencyUnavailable = resolveMarketingCosts({ ...base, spendUzs: null, spendByCurrency: { EUR: 1200 } });
  assert.match(renderToStaticMarkup(<CostValue costs={disconnected} metric="cmc" />), /Meta Insights ulanmagan/);
  assert.match(renderToStaticMarkup(<CostValue costs={pending} metric="roas" />), /Spend ma’lumoti kutilmoqda/);
  assert.match(renderToStaticMarkup(<CostValue costs={currencyUnavailable} metric="cmc" />), /Currency rate unavailable/);
  assert.doesNotMatch(renderToStaticMarkup(<CostValue costs={disconnected} metric="cmc" />), />0</);
  const ads = await fixture.getEntities({ ...context, level: "ad" });
  assert.equal(ads.rows.find((row) => row.id === "ad-organic-04")?.costs.status, "NO_SPEND");
  const campaigns = await fixture.getEntities({ ...context, level: "campaign" });
  assert.equal(campaigns.rows.find((row) => row.id === "cmp-webinar")?.costs.status, "NO_SALES");
});

test("ICP is enabled only for IBOX_UZ and NOT_APPLICABLE is an expected state", async () => {
  assert.deepEqual(MARKETING_WORKSPACES.map((workspace) => [workspace.key, workspace.navigationEnabled, workspace.capabilities.icp]), [
    ["IBOX_UZ", true, true], ["SD_UZ", true, false], ["IBOX_KZ", false, false], ["SD_KZ", false, false],
  ]);
  assert.equal((await fixture.getSummary(context)).capabilities.icp, true);
  assert.equal((await fixture.getIcp(context)).status, "ENABLED");
  const sdContext = { workspace: "SD_UZ" as const, filters: { ...EMPTY_MARKETING_FILTERS } };
  assert.equal((await fixture.getSummary(sdContext)).capabilities.icp, false);
  assert.equal((await fixture.getIcp(sdContext)).status, "ICP_NOT_APPLICABLE");
  await assert.rejects(() => fixture.getSummary({ workspace: "IBOX_KZ", filters: { ...EMPTY_MARKETING_FILTERS } }), (error: unknown) => error instanceof MarketingAdapterError && error.code === "WORKSPACE_NOT_ACTIVATED");
});

test("Deal drilldown sends exact inherited workspace, date and entity context", async () => {
  let captured: URL | null = null;
  const fetchMock = async (input: RequestInfo | URL) => {
    captured = new URL(String(input), "https://dashboard.test");
    return json({ ...common(), metric: "sale", count: 0, deals: [], truncated: false });
  };
  const adapter = new HttpMarketingAdapter(fetchMock as typeof fetch);
  const filters: MarketingFilters = {
      ...EMPTY_MARKETING_FILTERS,
      startDate: "2026-10-01", endDate: "2026-10-15", source: "CRM forma",
      placement: "Instagram Reels", landing: "/uz/form",
  };
  const adRow = {
    ...(await fixture.getEntities({ workspace: "IBOX_UZ", filters, level: "ad" })).rows[0],
    campaignId: "120200000000000001",
    adSetId: "120200000000000101",
    adId: "120200000000001001",
  };
  const request: MarketingDealRequest = marketingDealRequest(
    { workspace: "IBOX_UZ", filters }, "sale", "Sotuv", adRow.saleCount, adRow,
  );
  await adapter.getDeals(request);
  assert.ok(captured);
  const params = (captured as URL).searchParams;
  assert.deepEqual(Object.fromEntries(["workspace", "startDate", "endDate", "source", "campaignId", "adsetId", "adId", "placement", "landing", "metric"].map((key) => [key, params.get(key)])), {
    workspace: "IBOX_UZ", startDate: "2026-10-01", endDate: "2026-10-15", source: "CRM forma",
    campaignId: "120200000000000001", adsetId: "120200000000000101", adId: "120200000000001001",
    placement: "Instagram Reels", landing: "/uz/form", metric: "sale",
  });
});

test("coverage stays behind a compact details affordance and UI performs no metric division", () => {
  const view = read("app/marketing/marketing-view.tsx");
  assert.match(view, /<details className="marketing-coverage">/);
  assert.match(view, /Unknown attribution/);
  assert.match(view, /Conflicts/);
  const ui = view + read("app/marketing/marketing-additions.tsx") + read("app/marketing/marketing-shared.tsx");
  assert.doesNotMatch(ui, /icpFitCount\s*\/|spend\s*\/|revenue\s*\/|saleCount\s*\/|sqlCount\s*\//);
});

test("Overview and Managers keep their existing placement with adapter-only Marketing blocks", () => {
  const client = read("app/dashboard-client.tsx");
  // Same placement; the additions now follow the host page's own date range.
  assert.match(client, /<MarketingOverviewAdditions workspace=\{marketingWorkspaceForProject\(project\)\} adapter=\{marketingAdapter\} range=\{marketingRange\} \/>/);
  assert.match(client, /<ManagerIcpAdditions workspace=\{marketingWorkspaceForProject\(project\)\} adapter=\{marketingAdapter\} range=\{rangeBounds\(filters\)\} \/>/);
  assert.match(client, /<MarketingView workspace=\{marketingWorkspaceForProject\(project\)\} adapter=\{marketingAdapter\} \/>/);
});

/* ---------- Marketing V1 integration: real HTTP contract ---------- */

test("integration: the HTTP adapter binds backend costStatus, funnel rates, spend attribution and Meta status", async () => {
  const bucket = (spendUzs: number, ads: number) => ({ ads, adDays: ads * 2, spendByCurrency: { USD: Math.round(spendUzs / 118) }, spendUzs });
  const payload = {
    ...common(),
    spendStatus: "AVAILABLE",
    meta: { status: "AVAILABLE", since: "2025-10-15", until: "2026-10-15", updatedAt: "2026-10-15T10:05:00Z", accounts: 4 },
    spendAttribution: { assigned: bucket(39_201_960, 70), otherWorkspaces: bucket(19_899_402, 84), mixed: bucket(3_176_324, 1), unassigned: bucket(44_551_844, 498), nonDashboard: bucket(4_180_976, 8) },
    options: { marketingSources: [], platforms: [], campaigns: [{ id: "120258774035960093", name: "CBO 150$" }], adSets: [], ads: [], placements: [], landingForms: [] },
    summary: { ...summaryPayload.summary, costStatus: "NOT_INGESTED", spendUzs: null, cmcUzs: null, roas: null, cplUzs: null, costPerSqlUzs: null, costPerIcpFitUzs: null,
      saralanganRate: 0.85, sqlRate: 0.3, saleRate: 0.25, icpEvaluationShare: 0.27 },
  };
  const adapter = new HttpMarketingAdapter((async () => json(payload)) as never);
  const response = await adapter.getSummary(context);
  assert.equal(response.summary.costs.status, "NOT_INGESTED", "the backend's verdict wins over inference");
  assert.equal(response.summary.costs.spend, null, "null stays null — never 0");
  assert.equal(response.summary.costs.currency, "UZS", "UZS fields are never labelled with the native USD currency");
  assert.deepEqual([response.summary.classifiedRate, response.summary.sqlRate, response.summary.sqlToSaleRate, response.summary.icpEvaluationShare], [0.85, 0.3, 0.25, 0.27]);
  assert.equal(response.spendAttribution?.unassigned.spendUzs, 44_551_844);
  assert.equal(response.meta?.until, "2026-10-15");
  assert.equal(response.usdToUzs, 11_800);
  assert.deepEqual(response.options.campaigns, [{ id: "120258774035960093", name: "CBO 150$" }]);
});

test("integration: costs render the owner's formats and never show null as 0", () => {
  const costs = resolveMarketingCosts({ ...cost, spendUzs: 39_201_960, cmcUzs: 5_888_436, roas: 0.8791, cplUzs: 45_941, costStatus: "AVAILABLE", spendApplies: true, saleCount: 2 });
  assert.equal(renderToStaticMarkup(<CostValue costs={costs} metric="spend" />), "39.2 mln UZS");
  assert.equal(renderToStaticMarkup(<CostValue costs={costs} metric="cmc" />), "5.89 mln UZS / mijoz");
  assert.equal(renderToStaticMarkup(<CostValue costs={costs} metric="roas" />), "0.88x");
  assert.equal(renderToStaticMarkup(<CostValue costs={costs} metric="cpl" />), "45 941 UZS");
  assert.equal(renderToStaticMarkup(<CostValue costs={{ ...costs, roas: 5.2240 }} metric="roas" />), "5.22x");
  assert.equal(renderToStaticMarkup(<CostValue costs={{ ...costs, roas: 0.012984 }} metric="roas" />), "0.013x");
  assert.equal(renderToStaticMarkup(<CostValue costs={{ ...costs, roas: 0 }} metric="roas" />), "0x", "a real 0 ROAS (spend, no revenue)");
  const noSales = resolveMarketingCosts({ ...cost, cmcUzs: null, costStatus: "NO_SALES", spendApplies: true, saleCount: 0 });
  assert.match(renderToStaticMarkup(<CostValue costs={noSales} metric="cmc" />), /Sotuv yo‘q/);
  for (const status of ["NOT_INGESTED", "PENDING", "NO_SPEND", "CURRENCY_UNAVAILABLE", "NOT_APPLICABLE"] as const) {
    const html = renderToStaticMarkup(<CostValue costs={resolveMarketingCosts({ ...cost, costStatus: status, spendApplies: true, saleCount: 1 })} metric="spend" />);
    assert.match(html, /marketing-unavailable/, status);
    assert.doesNotMatch(html, /\b0 UZS/, status);
  }
});

test("integration: attributed-spend labelling, data-quality buckets and Ad / Creative ranking wording", () => {
  const view = read("app/marketing/marketing-view.tsx");
  assert.equal(ATTRIBUTED_SPEND_HELP, "CMC va ROAS faqat workspace'ga ishonchli biriktirilgan reklama xarajatidan hisoblanadi. Biriktirilmagan yoki mixed xarajatlar hisobga kiritilmaydi.");
  assert.match(view, /Biriktirilgan reklama xarajati <span className="marketing-help" title=\{ATTRIBUTED_SPEND_HELP\}/);
  assert.match(view, /<th title=\{ATTRIBUTED_SPEND_HELP\}>Biriktirilgan spend<\/th>/);
  for (const label of ["Biriktirilmagan", "Mixed", "Non-dashboard funnel", "Boshqa workspace’lar"]) assert.ok(view.includes(`label="${label}"`), label);
  assert.match(view, /<summary><span>Data quality \/ Attribution coverage<\/span>/, "an expandable area, not the main KPI row");
  assert.match(view, /<h2>Ad \/ Creative ranking<\/h2>/);
  assert.doesNotMatch(view, /Video ranking/);
  assert.match(view, /Marketing kursi: 1 USD = /, "marketing FX shown as marketing data, not Finance");
  assert.match(view, /Marketing ma’lumoti yangilangan: \$\{fmtStamp\(summaryResponse\?\.meta\?\.updatedAt\)\}/);
  assert.match(view, /CRM sync \{fmtStamp\(summaryResponse\?\.dataAsOf\)\}/, "Meta time and CRM sync time are separate");
  // One conversion per card, each against the step before.
  assert.match(view, /Leaddan` : "Tanlangan marketing cohort"/);
  assert.match(view, /Saralangandan` : "Marketing cohort"/);
  assert.match(view, /SQL’dan` : "Marketing cohort"/);
  assert.match(view, /Faqat \{formatMarketingRate\(summary\.icpEvaluationShare\)\} Lead baholangan/, "low ICP evaluation coverage is visible next to the rate");
});

test("integration: a stale child filter from another parent is cleared, never silently active", () => {
  const options = { ...EMPTY_MARKETING_FILTERS_OPTIONS, adSets: [{ id: "S1", name: "S1" }], ads: [{ id: "A1", name: "A1" }] };
  const base = { ...EMPTY_MARKETING_FILTERS, campaignId: "C1" } as MarketingFilters;
  const kept = { ...base, adsetId: "S1", adId: "A1" };
  assert.equal(reconcileMarketingFilters(kept, options), kept, "valid children are kept as the same object (no re-render loop)");
  assert.deepEqual(reconcileMarketingFilters({ ...base, adsetId: "S_OTHER", adId: "A1" }, options), { ...base, adsetId: "", adId: "" });
  assert.deepEqual(reconcileMarketingFilters({ ...base, adsetId: "S1", adId: "A_OTHER" }, options), { ...base, adsetId: "S1", adId: "" });
});

test("integration: Deal drilldown keeps the exact workspace, date and entity context", () => {
  const filters = { ...EMPTY_MARKETING_FILTERS, startDate: "2026-09-15", endDate: "2026-10-14", placement: "ig_feed", landing: "/uz" } as MarketingFilters;
  const row = { id: "120258774036060093", level: "ad", campaignId: "120258774035960093", adSetId: "120258774036320093", adId: "120258774036060093" } as never;
  const request = marketingDealRequest({ workspace: "IBOX_UZ", filters }, "sql", "SQL", 4, row);
  assert.deepEqual([request.workspace, request.metric, request.expectedCount], ["IBOX_UZ", "sql", 4]);
  assert.deepEqual([request.filters.startDate, request.filters.endDate, request.filters.campaignId, request.filters.adsetId, request.filters.adId, request.filters.placement, request.filters.landing],
    ["2026-09-15", "2026-10-14", "120258774035960093", "120258774036320093", "120258774036060093", "ig_feed", "/uz"]);
});

test("pre-prod: the Marketing page names its population; Overview and Managers ask for the whole workspace", async () => {
  const view = read("app/marketing/marketing-view.tsx");
  assert.match(view, /label="Meta orqali biriktirilgan Leadlar"/);
  for (const label of ["CRM Leadlar", "Meta attribution mavjud", "Attribution coverage"]) assert.ok(view.includes(`<span>${label}</span>`), label);
  const additions = read("app/marketing/marketing-additions.tsx");
  assert.equal((additions.match(/scope: "workspace" as const/g) ?? []).length, 3, "Overview card, Overview ICP drawer and Managers ICP");
  assert.match(read("app/marketing/marketing-shared.tsx"), /scope: request\.scope \?\? "meta"/, "a drawer is cached per scope");
  const calls: URL[] = [];
  const adapter = new HttpMarketingAdapter((async (input: RequestInfo | URL) => { calls.push(new URL(String(input), "https://d.test")); return json({ ...summaryPayload, scope: "workspace" }); }) as never);
  await adapter.getSummary({ ...context, scope: "workspace" });
  await adapter.getSummary(context);
  assert.deepEqual(calls.map((url) => url.searchParams.get("scope")), ["workspace", null], "Meta scope is the API default");
});
