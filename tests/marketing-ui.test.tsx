import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MarketingView, INITIAL_MARKETING_NAVIGATION, drillMarketingEntity } from "../app/marketing/marketing-view";
import { CostValue, formatMarketingMoney } from "../app/marketing/marketing-shared";
import { fixtureMarketingAdapter } from "../app/marketing/marketing-adapter";
import { ManagerIcpAdditions, MarketingOverviewAdditions } from "../app/marketing/marketing-additions";
import { EMPTY_MARKETING_FILTERS, type MarketingDataAdapter } from "../app/marketing/marketing-types";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const snapshot = (project: "IBOX" | "SALES_DOCTOR", level: "CAMPAIGN" | "AD_SET" | "AD" | "PLACEMENT" | "LANDING_FORM" = "CAMPAIGN", parentId: string | null = null) => fixtureMarketingAdapter.getSnapshot({ project, filters: EMPTY_MARKETING_FILTERS, level, parentId });

test("Marketing page renders inside the selected project workspace", () => {
  const html = renderToStaticMarkup(<MarketingView project="IBOX" />);
  assert.match(html, /Marketing performance/);
  assert.match(html, /IBOX/);
  assert.match(html, /Marketing Source/);
  assert.match(html, /Campaign/);
  assert.match(html, /Creative Ranking/);

  const sd = renderToStaticMarkup(<MarketingView project="SALES_DOCTOR" />);
  assert.match(sd, /Sales Doctor/);
  assert.match(sd, /Meta Insights ulanmagan/);
  assert.doesNotMatch(sd, />0 UZS</, "unavailable spend is never presented as zero");
});

test("ICP appears only when the workspace capability enables it", () => {
  assert.equal(snapshot("IBOX").capabilities.icp, true, "IBOX_UZ enables ICP");
  assert.equal(snapshot("SALES_DOCTOR").capabilities.icp, false, "SD_UZ disables ICP");

  const ibox = renderToStaticMarkup(<MarketingView project="IBOX" />);
  assert.match(ibox, /ICP ga moslik/);
  assert.match(ibox, /ICP mos/);

  const sd = renderToStaticMarkup(<MarketingView project="SALES_DOCTOR" />);
  assert.doesNotMatch(sd, /ICP/i, "a non-applicable workspace exposes no ICP card, columns, ranking, or unset copy");
  assert.equal(renderToStaticMarkup(<ManagerIcpAdditions project="SALES_DOCTOR" />), "", "manager ICP view is absent for SD_UZ");
  assert.equal(renderToStaticMarkup(<MarketingOverviewAdditions project="SALES_DOCTOR" />), "", "an unavailable generic cost block does not leave an empty section");
});

test("disabling ICP through adapter capability needs no UI redesign and keeps CMC and ROAS independent", () => {
  const icpDisabledAdapter: MarketingDataAdapter = {
    ...fixtureMarketingAdapter,
    getSnapshot(request) {
      return { ...fixtureMarketingAdapter.getSnapshot(request), capabilities: { icp: false } };
    },
  };

  const page = renderToStaticMarkup(<MarketingView project="IBOX" adapter={icpDisabledAdapter} />);
  assert.doesNotMatch(page, /ICP/i);
  assert.match(page, />CMC</);
  assert.match(page, />ROAS</);

  const overview = renderToStaticMarkup(<MarketingOverviewAdditions project="IBOX" adapter={icpDisabledAdapter} />);
  assert.doesNotMatch(overview, /ICP/i);
  assert.match(overview, />CMC</);
  assert.match(overview, />ROAS</);
  assert.equal(renderToStaticMarkup(<ManagerIcpAdditions project="IBOX" adapter={icpDisabledAdapter} />), "");
});

test("Campaign → Ad Set → Ad drilldown keeps a stable project/filter boundary", () => {
  const campaign = snapshot("IBOX").rows.find((row) => row.id === "cmp-leadgen")!;
  const atAdSets = drillMarketingEntity(INITIAL_MARKETING_NAVIGATION, campaign);
  assert.deepEqual({ level: atAdSets.level, parentId: atAdSets.parentId }, { level: "AD_SET", parentId: "cmp-leadgen" });
  const adSet = snapshot("IBOX", "AD_SET", "cmp-leadgen").rows.find((row) => row.id === "set-broad")!;
  const atAds = drillMarketingEntity(atAdSets, adSet);
  assert.deepEqual({ level: atAds.level, parentId: atAds.parentId }, { level: "AD", parentId: "set-broad" });
  assert.deepEqual(atAds.trail.map((row) => row.id), ["cmp-leadgen", "set-broad"]);

  const source = read("app/marketing/marketing-view.tsx");
  const drillHandler = source.slice(source.indexOf("const openEntity"), source.indexOf("const setLevel"));
  assert.doesNotMatch(drillHandler, /setFilters/, "drilling changes navigation only, so date/project filters survive");
});

test("ICP denominator semantics are display-only contract values and unset stays separate", () => {
  const summary = snapshot("IBOX").summary;
  assert.equal(summary.icpFitCount, 83);
  assert.equal(summary.icpEvaluatedCount, 112);
  assert.equal(summary.icpUnsetCount, 14);
  assert.equal(summary.icpFitRate, 74);
  assert.deepEqual(summary.icp.rows.map((row) => [row.label, row.meaning]), [
    ["P1", "Mos"], ["P2", "Mos"], ["P3", "Mos"], ["Other", "Mos emas"], ["Belgilanmagan", "Belgilanmagan"],
  ]);
  const html = renderToStaticMarkup(<MarketingView project="IBOX" />);
  assert.match(html, /83 \/ 112 belgilangan/);
  assert.match(html, /14 ta belgilanmagan/);

  const ui = read("app/marketing/marketing-view.tsx") + read("app/marketing/marketing-additions.tsx");
  assert.doesNotMatch(ui, /icpFitCount\s*\/\s*.*icpEvaluatedCount/);
  assert.doesNotMatch(ui, /revenue\s*\/\s*.*spend/);
  assert.doesNotMatch(ui, /spend\s*\/\s*.*saleCount/);
});

test("cost contract distinguishes unavailable, zero-spend, zero-sale, CMC and ROAS", () => {
  const ibox = snapshot("IBOX").summary;
  assert.equal(ibox.costs.spend, 11_800_000);
  assert.equal(ibox.costs.cmc, 1_180_000);
  assert.equal(ibox.costs.roas, 4);
  assert.match(formatMarketingMoney(ibox.costs.cmc, "UZS"), /UZS$/);
  assert.match(renderToStaticMarkup(<CostValue costs={ibox.costs} metric="roas" />), /4x/);

  const sd = snapshot("SALES_DOCTOR").summary;
  assert.equal(sd.costs.status, "META_NOT_CONNECTED");
  assert.match(renderToStaticMarkup(<CostValue costs={sd.costs} metric="spend" />), /Meta Insights ulanmagan/);

  const ads = snapshot("IBOX", "AD").rows;
  const zeroSpend = ads.find((row) => row.id === "ad-organic-04")!;
  assert.equal(zeroSpend.costs.spend, 0, "a real zero stays distinct from unavailable");
  const currencyUnavailable = ads.find((row) => row.id === "ad-currency-05")!;
  assert.equal(currencyUnavailable.costs.status, "CURRENCY_UNAVAILABLE");
  assert.match(renderToStaticMarkup(<CostValue costs={currencyUnavailable.costs} metric="spend" />), /Currency rate unavailable/);
  const zeroSale = snapshot("IBOX").rows.find((row) => row.id === "cmp-webinar")!;
  assert.equal(zeroSale.saleCount, 0);
  assert.equal(zeroSale.costs.cmc, null, "CMC is unavailable when the supplied contract has no sale");
});

test("Deal drilldown returns the exact parent count and typed context", () => {
  const campaign = snapshot("IBOX").rows.find((row) => row.id === "cmp-leadgen")!;
  assert.equal(campaign.sqlCount, 18);
  const deals = fixtureMarketingAdapter.getDeals({ project: "IBOX", metric: "SQL", metricLabel: "SQL", expectedCount: campaign.sqlCount, filters: { ...EMPTY_MARKETING_FILTERS, platform: "meta" }, entity: campaign });
  assert.equal(deals.length, 18);
  assert.ok(deals.every((deal) => deal.campaign === campaign.campaignName));
  assert.ok(deals.every((deal) => deal.platform === campaign.platform));
});

test("fixtures cover landing/form identity, long names and missing attribution", () => {
  const landings = snapshot("IBOX", "LANDING_FORM").rows;
  assert.equal(landings.find((row) => row.id === "form-ibox-main")?.landingType, "INSTANT_FORM");
  assert.equal(landings.find((row) => row.id === "landing-form-new")?.landingType, "WEBSITE");
  assert.equal(landings.find((row) => row.id === "landing-missing")?.landingType, "UNKNOWN");
  assert.ok(snapshot("IBOX").rows.some((row) => row.name.length > 45));
  assert.ok(snapshot("IBOX", "AD").rows.some((row) => row.marketingSource === "Attribution topilmadi"));
});

test("Overview and Managers remain intact and receive only additive Marketing blocks", () => {
  const client = read("app/dashboard-client.tsx");
  const dashboard = client.slice(client.indexOf("function DashboardView"), client.indexOf("function TrendChart"));
  assert.match(dashboard, /selected\.map\(\(id\) =>/);
  assert.match(dashboard, /<MarketingOverviewAdditions project=\{project\} \/>/);
  assert.match(client, /<ManagerTable rows=\{managersSection\.data\.managers/);
  assert.match(client, /<ManagerIcpAdditions project=\{project\} \/>/);
  assert.match(client, /id: "marketing", label: "Marketing"/);
});
