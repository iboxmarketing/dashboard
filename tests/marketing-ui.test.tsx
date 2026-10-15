import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { drillMarketingEntity, marketingDealRequest, MarketingView } from "../app/marketing/marketing-view";
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
import type { MarketingDealRequest, MarketingFilters } from "../app/marketing/marketing-types";

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
  assert.match(read("app/dashboard-client.tsx"), /const marketingAdapter = new FixtureMarketingAdapter\(\)/, "one composition-root swap activates HTTP later");
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
  assert.match(client, /<MarketingOverviewAdditions workspace=\{marketingWorkspaceForProject\(project\)\} adapter=\{marketingAdapter\} \/>/);
  assert.match(client, /<ManagerIcpAdditions workspace=\{marketingWorkspaceForProject\(project\)\} adapter=\{marketingAdapter\} \/>/);
  assert.match(client, /<MarketingView workspace=\{marketingWorkspaceForProject\(project\)\} adapter=\{marketingAdapter\} \/>/);
});
