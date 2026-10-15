import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SPEND_BUCKETS, assignAds, classifyAd, collectAdEvidence, summarizeAssignment } from "../lib/marketing/assignment";
import { MARKETING_WORKSPACES, workspaceForCategory, workspaceForProject, workspaceIcp } from "../lib/marketing/workspaces";
import { trackingCoverageRow, workspaceCoverage } from "../lib/marketing/coverage";
import { buildDealAttribution, stableId } from "../lib/marketing/attribution";
import { ICP_FIELD, marketingSelect, resolveMarketingFields } from "../lib/marketing/fields";
import { countIcp, icpClassFromLabel, readIcp, type IcpConfig } from "../lib/marketing/icp";
import { fetchDailyInsights, isRetryableMetaError, metaRange, nextWindow, parseInsightRow, spendRangeStatus } from "../lib/marketing/meta-insights";
import {
  buildCoverage, buildEntities, buildSummary, costMetrics, dealOutcome, dealsForMetric, spendTotals, UNATTRIBUTED,
  type AttributionView, type OutcomeRecord, type SpendRow,
} from "../lib/marketing/metrics";
import { decimalToMinor, DEFAULT_MARKETING_USD_TO_UZS, minorToUzs, opportunityToUzs } from "../lib/marketing/money";
import { MARKETING_SCHEMA_STATEMENTS } from "../lib/marketing/schema";
import { ATTRIBUTION_UPSERT, DAILY_UPSERT, attributionBackfillPageSql, attributionBindings, dailyBindings } from "../lib/marketing/sql";
import type { CrmFieldOption } from "../lib/types";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const FX = { usdToUzs: DEFAULT_MARKETING_USD_TO_UZS };
const IBOX_ICP = workspaceIcp("IBOX_UZ");
const NO_ICP: IcpConfig = { enabled: false };

/* The live Bitrix metadata, as staging stores it (2026-10-14), plus the named
   fields the Meta tracking Worker writes (its write audit lists exactly these). */
const CRM_FIELDS: CrmFieldOption[] = [
  { key: ICP_FIELD, title: "ICP ga moslik ", type: "enumeration", options: [
    { id: "11139", value: "P1 (Оптовик)" }, { id: "11141", value: "P2 (Импортер)" },
    { id: "11143", value: "P3 (Retail )" }, { id: "11145", value: "Other" },
  ] },
  ...["UTM_SOURCE", "UTM_MEDIUM", "UTM_CAMPAIGN", "UTM_CONTENT", "UTM_TERM"].map((key) => ({ key, title: key, type: "string", options: [] })),
  ...["LEAD", "PAGE", "FORM", "CAMPAIGN", "ADSET", "AD"].map((part) => ({ key: `UF_CRM_META_${part}_ID`, title: `Meta ${part} ID`, type: "string", options: [] })),
  { key: "UF_CRM_680729666FC5E", title: "utm_id", type: "string", options: [] },
  { key: "UF_CRM_1784828015", title: "Marketing: Landing", type: "string", options: [] },
  { key: "UF_CRM_1784823646", title: "Marketing Kanali", type: "enumeration", options: [] },
];
const RESOLVED = resolveMarketingFields(CRM_FIELDS);
const ICP_OPTIONS = new Map(CRM_FIELDS[0].options.map((option) => [option.id, option.value]));

/* ------------------------------------------------------------------ ICP */

test("ICP (IBOX_UZ): P1/P2/P3 fit, Other not fit, empty unset — resolved through the field's own metadata", () => {
  assert.deepEqual(IBOX_ICP, { enabled: true, fieldId: ICP_FIELD, fitValues: ["P1", "P2", "P3"], notFitValues: ["Other"] });
  assert.deepEqual(["11139", "11141", "11143", "11145"].map((id) => readIcp(id, ICP_OPTIONS, IBOX_ICP).icpClass), ["P1", "P2", "P3", "OTHER"]);
  assert.deepEqual(readIcp("11143", ICP_OPTIONS, IBOX_ICP), { raw: "11143", label: "P3 (Retail )", icpClass: "P3" }, "raw enum evidence and class both kept");
  for (const empty of [null, undefined, "", "0", []]) assert.equal(readIcp(empty, ICP_OPTIONS, IBOX_ICP).icpClass, "UNSET");
  // An option ID the metadata does not know is never guessed into a tier.
  assert.deepEqual(readIcp("99999", ICP_OPTIONS, IBOX_ICP), { raw: "99999", label: null, icpClass: "UNSET" });
  assert.equal(icpClassFromLabel("p2 (импортер)", IBOX_ICP), "P2");
  assert.equal(icpClassFromLabel("P10 (future)", IBOX_ICP), "OTHER", "P1 does not swallow P10");
  assert.equal(icpClassFromLabel("Something new", IBOX_ICP), "OTHER");
  for (const path of ["lib/marketing/icp.ts", "lib/marketing/workspaces.ts"]) assert.doesNotMatch(read(path), /1113\d|11145/, "no enum ID is hard-coded");
});

test("ICP is a workspace capability: only IBOX_UZ has it; elsewhere NOT_APPLICABLE, never UNSET or 0%", () => {
  assert.deepEqual(MARKETING_WORKSPACES.map((workspace) => [workspace.key, workspace.icp.enabled]), [["IBOX_UZ", true], ["SD_UZ", false], ["IBOX_KZ", false], ["SD_KZ", false]]);
  assert.deepEqual(readIcp("11139", ICP_OPTIONS, NO_ICP), { raw: "11139", label: null, icpClass: "NOT_APPLICABLE" }, "raw kept, no class");
  assert.equal(readIcp(null, ICP_OPTIONS, NO_ICP).icpClass, "NOT_APPLICABLE");
  assert.equal(countIcp(["P1", "UNSET"], NO_ICP), null);
  // Enabling it elsewhere later is a definition, not code: any field, any labels.
  const custom: IcpConfig = { enabled: true, fieldId: "UF_CRM_X", fitValues: ["Gold", "Silver"], notFitValues: ["No"] };
  assert.deepEqual(["Gold tier", "Silver", "No", "Bronze", ""].map((label) => icpClassFromLabel(label, custom)), ["Gold", "Silver", "OTHER", "OTHER", "UNSET"]);
  assert.deepEqual(countIcp(["Gold", "Silver", "OTHER", "UNSET"], custom), { evaluated: 3, fit: 2, notFit: 1, unset: 1, byTier: { Gold: 1, Silver: 1 }, fitRate: 2 / 3 });
  assert.doesNotMatch(read("lib/marketing/metrics.ts"), /"P1"|"P2"|"P3"|IBOX/, "metrics know no IBOX-specific ICP");
});

test("ICP fit rate = fit / evaluated; UNSET reported but never in the denominator", () => {
  const counts = countIcp(["P1", "P2", "P3", "OTHER", "UNSET", "UNSET", null], IBOX_ICP);
  assert.deepEqual({ ...counts }, { evaluated: 4, fit: 3, notFit: 1, unset: 3, byTier: { P1: 1, P2: 1, P3: 1 }, fitRate: 0.75 });
  assert.equal(countIcp(["UNSET", null], IBOX_ICP)?.fitRate, null, "nothing evaluated → no rate, not 0");
});

/* --------------------------------------------------------------- fields */

test("marketing fields resolve only from live metadata — no numeric UF guessed", () => {
  assert.deepEqual(RESOLVED.fields, {
    utmSource: "UTM_SOURCE", utmMedium: "UTM_MEDIUM", utmCampaign: "UTM_CAMPAIGN", utmContent: "UTM_CONTENT", utmTerm: "UTM_TERM",
    utmId: "UF_CRM_680729666FC5E",
    metaLeadId: "UF_CRM_META_LEAD_ID", metaPageId: "UF_CRM_META_PAGE_ID", metaFormId: "UF_CRM_META_FORM_ID",
    metaCampaignId: "UF_CRM_META_CAMPAIGN_ID", metaAdsetId: "UF_CRM_META_ADSET_ID", metaAdId: "UF_CRM_META_AD_ID",
    landingPath: "UF_CRM_1784828015", icp: ICP_FIELD,
  });
  // A field that does not exist in Bitrix is not selected.
  const withoutMeta = resolveMarketingFields(CRM_FIELDS.filter((field) => !field.key.startsWith("UF_CRM_META_")));
  assert.equal(withoutMeta.fields.metaCampaignId, undefined);
  // Two fields matching one title pattern are a question for a human, not a pick.
  const twoLandings = resolveMarketingFields([...CRM_FIELDS, { key: "UF_CRM_999", title: "Landing page", type: "string", options: [] }]);
  assert.equal(twoLandings.fields.landingPath, undefined);
  assert.deepEqual(twoLandings.ambiguous.map((item) => item.role), ["landingPath"]);
  assert.ok(marketingSelect(RESOLVED.fields).includes("UF_CRM_META_AD_ID"));
  const numeric = [...new Set(read("lib/marketing/fields.ts").match(/UF_CRM_\d+/g) ?? [])];
  assert.deepEqual(numeric, [ICP_FIELD], "the only numeric UF code is the owner-named ICP field");
});

test("raw_deals keeps marketing evidence: Full and incremental sync select the resolved fields", () => {
  const sync = read("lib/sync.ts");
  assert.match(sync, /if \(crmFields\.length\) await saveDictionary\("marketingFields", resolveMarketingFields\(crmFields\)\);/);
  assert.match(sync, /for \(const field of \[\.\.\.marketingSelect\(marketing\.fields \?\? \{\}\), \.\.\.icpFieldIds\(\)\]\) if \(!customFields\.includes\(field\)\) customFields\.push\(field\);/);
  // Same select for every scope (main, period-sale discovery, refresh), so nothing is dropped.
  assert.match(sync, /const select = \["ID", "TITLE", [^\n]*\.\.\.customFields\];/);
  assert.match(sync, /if \(job\.dealScope === "refresh"\) return await refreshKnownStep\(job, select,/);
  // New Deals get attribution in the same analytics batch — no manual backfill.
  assert.match(sync, /await saveSalesSnapshots\(records\);\n[\s\S]{0,300}try \{ await materializeAttribution\(parseRows<RawDeal>\(batchDeals\) as Record<string, unknown>\[\], records\); \}\n\s+catch \(error\) \{ await saveDictionary\("marketingAttributionError"/);
});

/* ---------------------------------------------------------- attribution */

const deal = (fields: Record<string, unknown>) => ({ ID: "501", ...fields });
const attribute = (fields: Record<string, unknown>, tracking: Parameters<typeof buildDealAttribution>[0]["tracking"] = null, projectKey = "IBOX") =>
  buildDealAttribution({ deal: deal(fields), workspaceKey: projectKey === "SALES_DOCTOR" ? "SD_UZ" : "IBOX_UZ", projectKey, leadCreatedAt: "2026-10-01T05:00:00.000Z", fields: RESOLVED.fields,
    icp: workspaceIcp(projectKey === "SALES_DOCTOR" ? "SD_UZ" : "IBOX_UZ"), icpOptions: ICP_OPTIONS, tracking });

const META_LEAD = {
  lead_id: "9000000000000001", page_id: "299589696560259", form_id: "964981302338971", form_name: "Optom forma",
  ad_account_id: "1137464954180448", campaign_id: "120200000000000001", campaign_name: "IBOX Optom",
  adset_id: "120200000000000101", adset_name: "Tashkent 25-45", ad_id: "120200000000001001", ad_name: "Video A", platform: "ig",
};

test("attribution: Bitrix fields first", () => {
  const row = attribute({
    UF_CRM_META_CAMPAIGN_ID: "120200000000000001", UF_CRM_META_ADSET_ID: "120200000000000101", UF_CRM_META_AD_ID: "120200000000001001",
    UF_CRM_META_LEAD_ID: "9000000000000001", UF_CRM_META_FORM_ID: "964981302338971", UF_CRM_META_PAGE_ID: "299589696560259",
    UTM_SOURCE: "facebook", UTM_MEDIUM: "paid", [ICP_FIELD]: "11139",
  });
  assert.equal(row.attributionSource, "BITRIX");
  assert.equal(row.channel, "META_INSTANT_FORM");
  assert.deepEqual([row.campaignId, row.adsetId, row.adId, row.metaLeadId], ["120200000000000001", "120200000000000101", "120200000000001001", "9000000000000001"]);
  assert.equal(row.icpClass, "P1");
  assert.equal(row.icpRaw, "11139");
  assert.equal(row.attributionConflict, null);
  assert.equal(row.bitrixEvidence.metaAdId, "120200000000001001", "raw Bitrix evidence kept");
});

test("attribution: tracking D1 fills only what Bitrix lacks; a numeric utm_id is the campaign", () => {
  const onlyTracking = attribute({}, { metaLead: META_LEAD });
  assert.equal(onlyTracking.attributionSource, "TRACKING_INSTANT_FORM");
  assert.equal(onlyTracking.adId, META_LEAD.ad_id);
  assert.equal(onlyTracking.campaignName, "IBOX Optom");
  assert.equal(onlyTracking.adAccountId, META_LEAD.ad_account_id);
  const mixed = attribute({ UF_CRM_META_CAMPAIGN_ID: META_LEAD.campaign_id }, { metaLead: { ...META_LEAD, campaign_id: null } });
  assert.equal(mixed.attributionSource, "BITRIX+TRACKING");
  assert.equal(mixed.adsetId, META_LEAD.adset_id);
  assert.equal(attribute({ UF_CRM_680729666FC5E: "120200000000000001" }).campaignId, "120200000000000001");
  assert.equal(attribute({ UF_CRM_680729666FC5E: "{{campaign.id}}" }).campaignId, null, "a template placeholder is not an ID");
  assert.equal(stableId("abc"), null);
});

test("attribution: Bitrix vs tracking disagreement is a conflict — Bitrix kept, both preserved", () => {
  const row = attribute({ UF_CRM_META_AD_ID: "120200000000009999" }, { metaLead: META_LEAD });
  assert.equal(row.adId, "120200000000009999", "never silently overwritten");
  assert.deepEqual(row.attributionConflict, { adId: { bitrix: "120200000000009999", tracking: META_LEAD.ad_id } });
  assert.equal(row.trackingEvidence?.metaLead?.ad_id, META_LEAD.ad_id, "the tracking side stays for diagnostics");
});

test("attribution: website leads land in the same model (last paid touch, else first touch)", () => {
  const touch = { campaign_id: "120200000000000002", adset_id: "120200000000000202", ad_id: "120200000000002002", ad_name: "Carousel B", placement: "Facebook_Mobile_Feed", landing_path: "/uz/optom?x=1", utm_source: "fb" };
  const row = attribute({}, { website: { submission_id: "s1", form_name: "Sayt", locale: "uz", first_touch: { campaign_id: "120200000000000003" }, last_paid_touch: touch } });
  assert.equal(row.channel, "WEBSITE");
  assert.equal(row.attributionSource, "TRACKING_WEBSITE");
  assert.deepEqual([row.campaignId, row.adId, row.placement, row.landingPath, row.locale], ["120200000000000002", "120200000000002002", "Facebook_Mobile_Feed", "/uz/optom", "uz"]);
  const firstOnly = attribute({}, { website: { submission_id: "s2", first_touch: { campaign_id: "120200000000000003" } } });
  assert.equal(firstOnly.campaignId, "120200000000000003");
  assert.equal(attribute({ UTM_SOURCE: "google" }).attributionSource, "BITRIX_UTM_ONLY");
  assert.equal(attribute({}).channel, "UNKNOWN");
});

test("attribution is project-aware: the Deal's own project, never another's", () => {
  const sd = attribute({ [ICP_FIELD]: "11139" }, null, "SALES_DOCTOR");
  assert.equal(sd.projectKey, "SALES_DOCTOR");
  assert.equal(sd.workspaceKey, "SD_UZ");
  assert.equal(sd.icpClass, "NOT_APPLICABLE", "a Sales Doctor Deal gets no ICP class, even with a value in the field");
  const store = read("lib/marketing/store.ts");
  // Materialized only for a Deal whose record has a project (recordProject), and read back per project.
  assert.match(store, /\.map\(\(record\) => \(\{ record, project: recordProject\(record\), deal: byId\.get\(record\.dealId\) \}\)\)/);
  assert.match(store, /FROM marketing_deal_attribution WHERE project_key = \? AND lead_created_at >= \? AND lead_created_at <= \?/);
  // A project's spend is exactly its assigned ads' spend.
  assert.match(store, /const workspace = workspaceForProject\(project\);\n\s+return rows\.filter\(\(row\) => assignment\.get\(row\.adId\) === workspace\);/);
  // The tracking D1 is SELECT-only.
  const trackingSql = store.slice(store.indexOf("export async function lookupTracking"), store.indexOf("/* ---------------------------------------------- materialize"));
  assert.doesNotMatch(trackingSql, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i);
});

/* ------------------------------------------------- cohort, CMC, ROAS, FX */

const rec = (dealId: string, outcome: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  dealId, createdAt: "2026-10-01T05:00:00.000Z", qualified: false, lossReasonGroup: "NONE", salesStatus: "ACTIVE", opportunity: 0, currencyId: "UZS", ...outcome,
});
const view = (dealId: string, ids: Partial<AttributionView> = {}): AttributionView => ({
  dealId, campaignId: null, campaignName: null, adsetId: null, adsetName: null, adId: null, adName: null,
  placement: null, landingPath: null, channel: "META_INSTANT_FORM", attributionSource: "BITRIX", conflict: false, icpClass: "UNSET", ...ids,
});
const spend = (adId: string, usdCents: number, extra: Partial<SpendRow> = {}): SpendRow => ({
  date: "2026-10-01", adId, adAccountId: "1137464954180448", campaignId: "C1", campaignName: "Camp", adsetId: "S1", adsetName: "Set",
  adName: "Ad", creativeId: null, spendMinor: usdCents, currency: "USD", impressions: 100, clicks: 5, ...extra,
});

test("outcomes come from the record's accepted analytics; In Pipeline = SQL, open, not sold, not lost", () => {
  assert.deepEqual(dealOutcome(rec("1", { qualified: true, salesStatus: "ACTIVE" })), { saralangan: true, sql: true, nr: false, sale: false, lost: false, inPipeline: true });
  assert.equal(dealOutcome(rec("2", { qualified: true, salesStatus: "WON" })).inPipeline, false);
  assert.equal(dealOutcome(rec("3", { qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES" })).lost, true);
  assert.deepEqual(dealOutcome(rec("4", { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" })), { saralangan: true, sql: false, nr: true, sale: false, lost: false, inPipeline: false });
  assert.doesNotMatch(read("lib/marketing/metrics.ts"), /stageId\s*===|C3:|C5:/, "no stage-based classifier of its own");
});

test("FX: USD cents × 11,800 in exact integers; no rate → unavailable, never invented", () => {
  assert.equal(decimalToMinor("12.34", "USD"), 1234);
  assert.equal(decimalToMinor("0.005", "USD"), 1, "half-up at the exponent, no float");
  assert.equal(decimalToMinor("1000", "USD"), 100000);
  assert.throws(() => decimalToMinor("1e3", "USD"));
  assert.equal(minorToUzs(100000, "USD", FX), 11_800_000, "1,000 USD → 11,800,000 UZS");
  assert.equal(minorToUzs(1, "USD", FX), 118);
  assert.equal(minorToUzs(250, "UZS", FX), 3, "UZS minor units → whole sum, half-up");
  assert.equal(minorToUzs(100, "EUR", FX), null);
  assert.equal(opportunityToUzs(47_200_000, "UZS", FX), 47_200_000);
  assert.equal(minorToUzs(Number.MAX_SAFE_INTEGER, "UZS", FX), Math.round(Number.MAX_SAFE_INTEGER / 100));
  assert.match(read("lib/marketing/store.ts"), /usdToUzs: Number\.isSafeInteger\(rate\) && rate > 0 \? rate : DEFAULT_MARKETING_USD_TO_UZS/, "the rate is a Marketing setting");
  assert.doesNotMatch(read("lib/marketing/metrics.ts"), /11[_,]?800/, "never hard-coded inside a metric");
});

test("CMC = spend UZS / attributed cohort Sales; ROAS = revenue / spend; zero → null", () => {
  assert.deepEqual(costMetrics({ spendUzs: 11_800_000, leads: 10, icpFit: 4, sql: 5, sales: 2, revenueUzs: 47_200_000 }), {
    cmcUzs: 5_900_000, roas: 4, cplUzs: 1_180_000, costPerIcpFitUzs: 2_950_000, costPerSqlUzs: 2_360_000, costPerSaleUzs: 5_900_000,
  });
  const none = costMetrics({ spendUzs: 11_800_000, leads: 0, icpFit: 0, sql: 0, sales: 0, revenueUzs: 0 });
  assert.equal(none.cmcUzs, null); assert.equal(none.cplUzs, null);
  assert.equal(costMetrics({ spendUzs: 0, leads: 3, icpFit: 1, sql: 1, sales: 1, revenueUzs: 5 }).roas, null);
  assert.equal(costMetrics({ spendUzs: null, leads: 3, icpFit: 1, sql: 1, sales: 1, revenueUzs: 5 }).cmcUzs, null, "unconvertible spend → unavailable");
});

test("summary: the owner's example — 11,800,000 UZS spend, 47,200,000 UZS cohort revenue → ROAS 4.0x", () => {
  const cohort = [
    rec("1", { qualified: true, salesStatus: "WON", opportunity: 47_200_000 }),
    rec("2", { qualified: true }), rec("3"), rec("4", { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
    rec("5", { qualified: true, salesStatus: "WON", opportunity: 9_000_000 }), // organic: not attributed
  ];
  const attribution = new Map([
    ["1", view("1", { campaignId: "C1", adId: "A1", icpClass: "P1" })], ["2", view("2", { campaignId: "C1", adId: "A1", icpClass: "OTHER" })],
    ["3", view("3", { campaignId: "C1", adId: "A2" })], ["4", view("4", { campaignId: "C1", adId: "A2", icpClass: "P2" })],
  ]);
  const summary = buildSummary({ cohort, attribution, spend: [spend("A1", 60000), spend("A2", 40000)], fx: FX, icp: IBOX_ICP });
  assert.equal(summary.spendUzs, 11_800_000);
  assert.equal(summary.attributedSaleCount, 1);
  assert.equal(summary.attributedRevenueUzs, 47_200_000);
  assert.equal(summary.roas, 4);
  assert.equal(summary.cmcUzs, 11_800_000);
  assert.equal(summary.leadCount, 5); assert.equal(summary.saleCount, 2, "all cohort sales are still reported");
  assert.deepEqual([summary.icpEvaluatedCount, summary.icpFitCount, summary.icpOtherCount, summary.icpUnsetCount, summary.icpFitRate], [3, 2, 1, 2, 2 / 3]);
  assert.equal(summary.inPipelineCount, 1);
  assert.equal(summary.coverage.campaignIdCoverage, 0.8);
  assert.deepEqual(summary.revenueByCurrency, { UZS: 56_200_000 });
});

test("cohort semantics: only the lead-date cohort counts — Period Sales never enter acquisition ROAS", () => {
  const http = read("lib/marketing/http.ts");
  assert.match(http, /const base = salesPopulations\(records, salesQuery\)\.cohort\.filter\(isEligibleCohortDeal\)/);
  assert.doesNotMatch(http, /\.won\b|periodSales/);
  // A Deal sold in the range but created before it is simply not in the cohort passed in.
  const summary = buildSummary({ cohort: [rec("1")], attribution: new Map([["1", view("1", { campaignId: "C1" })]]), spend: [spend("A1", 100)], fx: FX, icp: IBOX_ICP });
  assert.equal(summary.attributedSaleCount, 0);
  assert.equal(summary.cmcUzs, null);
});

test("entities group by stable ID; a renamed campaign is one row with its latest name", () => {
  const cohort = [rec("1", { qualified: true, salesStatus: "WON", opportunity: 1_000_000 }), rec("2"), rec("3")];
  const attribution = new Map([
    ["1", view("1", { campaignId: "C1", campaignName: "Old name" })], ["2", view("2", { campaignId: "C1", campaignName: "Old name" })],
  ]);
  const rows = buildEntities({ level: "campaign", cohort, attribution, fx: FX, icp: IBOX_ICP, spend: [
    spend("A1", 10000, { date: "2026-10-01", campaignName: "Old name" }), spend("A1", 20000, { date: "2026-10-02", campaignName: "New name" }),
  ] });
  const c1 = rows.find((row) => row.id === "C1")!;
  assert.equal(rows.filter((row) => row.id === "C1").length, 1);
  assert.equal(c1.name, "New name");
  assert.equal(c1.leadCount, 2); assert.equal(c1.saleCount, 1);
  assert.equal(c1.spendUzs, 3_540_000);
  assert.equal(c1.cmcUzs, 3_540_000);
  const unattributed = rows.find((row) => row.id === UNATTRIBUTED)!;
  assert.equal(unattributed.leadCount, 1, "rows still sum to the cohort");
  const ads = buildEntities({ level: "ad", cohort, attribution: new Map([["1", view("1", { campaignId: "C1", adsetId: "S1", adId: "A1" })]]), spend: [spend("A1", 100)], fx: FX, icp: IBOX_ICP });
  assert.deepEqual([ads[0].id, ads[0].campaignId, ads[0].adsetId], ["A1", "C1", "S1"], "parent IDs exposed");
  const placements = buildEntities({ level: "placement", cohort, attribution: new Map([["1", view("1", { placement: "ig_feed" })]]), spend: [spend("A1", 100)], fx: FX, icp: IBOX_ICP });
  assert.equal(placements.find((row) => row.id === "ig_feed")?.spendUzs, null, "no spend breakdown by placement — unavailable, not zero");
});

test("deals drill-down and coverage", () => {
  const cohort = [rec("1", { qualified: true }), rec("2", { qualified: true, salesStatus: "WON" }), rec("3")];
  const attribution = new Map([["1", view("1", { campaignId: "C1", icpClass: "P3" })], ["2", view("2", { channel: "WEBSITE", conflict: true, adId: "A1" })]]);
  assert.deepEqual(dealsForMetric("pipeline", cohort, attribution, IBOX_ICP)!.map((row) => row.dealId), ["1"]);
  assert.deepEqual(dealsForMetric("icp_fit", cohort, attribution, IBOX_ICP)!.map((row) => row.dealId), ["1"]);
  assert.deepEqual(dealsForMetric("icp_unset", cohort, attribution, IBOX_ICP)!.map((row) => row.dealId), ["2", "3"]);
  assert.equal(dealsForMetric("icp_fit", cohort, attribution, NO_ICP), null, "no ICP drill-down where ICP does not apply");
  assert.equal(dealsForMetric("sql", cohort, attribution, NO_ICP)?.[0].icpClass, "NOT_APPLICABLE");
  // A Sales Doctor-like summary and entity row carry no ICP numbers at all — not zeros.
  const sdSummary = buildSummary({ cohort, attribution, spend: [], fx: FX, icp: NO_ICP }) as unknown as Record<string, unknown>;
  assert.equal(sdSummary.icpStatus, "NOT_APPLICABLE");
  for (const key of ["icpEvaluatedCount", "icpFitCount", "icpOtherCount", "icpUnsetCount", "icpFitRate", "costPerIcpFitUzs", "icp"]) assert.ok(!(key in sdSummary), key);
  const [sdRow] = buildEntities({ level: "campaign", cohort, attribution, spend: [], fx: FX, icp: NO_ICP }) as unknown as Record<string, unknown>[];
  assert.equal(sdRow.icpStatus, "NOT_APPLICABLE");
  assert.ok(!("icpFitRate" in sdRow) && !("costPerIcpFitUzs" in sdRow));
  const iboxSummary = buildSummary({ cohort, attribution, spend: [], fx: FX, icp: IBOX_ICP });
  assert.deepEqual([iboxSummary.icpStatus, iboxSummary.icpFitCount, iboxSummary.icpUnsetCount, iboxSummary.icpByTier], ["ENABLED", 1, 2, { P1: 0, P2: 0, P3: 1 }]);
  assert.match(read("app/api/marketing/deals/route.ts"), /code: "ICP_NOT_APPLICABLE"/);
  assert.match(read("lib/marketing/http.ts"), /icpStatus: context\.icp\.enabled \? "ENABLED" : "NOT_APPLICABLE"/);
  assert.deepEqual(buildCoverage(cohort, attribution), {
    deals: 3, withCampaignId: 1, withAdsetId: 0, withAdId: 1, metaInstantForm: 1, website: 1, otherSource: 0, unknown: 0, conflicts: 1, notYetAttributed: 1,
  });
});

test("spend totals keep native currencies apart; any unconvertible currency makes UZS unavailable", () => {
  const totals = spendTotals([spend("A1", 100), spend("A2", 50, { currency: "EUR" })], FX);
  assert.deepEqual(totals.spendByCurrency, { USD: 100, EUR: 50 });
  assert.equal(totals.spendUzs, null);
  assert.equal(spendTotals([], FX).spendUzs, 0);
});

/* ------------------------------------------- SQL: real upserts in SQLite */

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(MARKETING_SCHEMA_STATEMENTS.join(";\n"));
  db.exec("CREATE TABLE analytics_records (deal_id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE raw_deals (deal_id TEXT PRIMARY KEY, payload TEXT);");
  return db;
}

test("the migration file is exactly the schema module, additive only", () => {
  const sql = read("drizzle/0015_marketing_data.sql");
  for (const statement of MARKETING_SCHEMA_STATEMENTS) assert.ok(sql.includes(`${statement};`), statement.slice(0, 60));
  assert.doesNotMatch(sql, /\b(DROP|ALTER|DELETE|UPDATE)\b/i);
  assert.ok(MARKETING_SCHEMA_STATEMENTS.every((statement) => /^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(statement)));
});

test("attribution upsert is idempotent: re-running a backfill never duplicates a Deal", () => {
  const db = database();
  const row = attribute({ UF_CRM_META_AD_ID: "120200000000001001" });
  const insert = db.prepare(ATTRIBUTION_UPSERT);
  insert.run(...(attributionBindings(row, "t1") as never[]));
  insert.run(...(attributionBindings({ ...row, adName: "Renamed" }, "t2") as never[]));
  insert.run(...(attributionBindings(row, "t3") as never[]));
  const rows = db.prepare("SELECT deal_id, ad_id, created_at, updated_at FROM marketing_deal_attribution").all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { deal_id: "501", ad_id: "120200000000001001", created_at: "t1", updated_at: "t3" });
});

test("backfill resumes after its cursor: nothing re-read, nothing skipped", () => {
  const db = database();
  for (const id of ["10", "11", "12", "13", "14"]) {
    db.prepare("INSERT INTO analytics_records VALUES(?, ?)").run(id, "{}");
    db.prepare("INSERT INTO raw_deals VALUES(?, ?)").run(id, "{}");
  }
  const page = db.prepare(attributionBackfillPageSql(2));
  const seen: string[] = [];
  let cursor = "";
  for (let guard = 0; guard < 10; guard += 1) {
    const rows = page.all(cursor) as { deal_id: string }[];
    seen.push(...rows.map((row) => row.deal_id));
    if (rows.length < 2) break;
    cursor = rows[rows.length - 1].deal_id; // the checkpoint saved after each batch
  }
  assert.deepEqual(seen, ["10", "11", "12", "13", "14"]);
  const jobs = read("lib/marketing/jobs.ts");
  assert.match(jobs, /cursor: rows\.length \? rows\[rows\.length - 1\]\.deal_id : state\.cursor,/);
  assert.match(jobs, /if \(state\?\.status === "error"\) await saveDictionary\(ATTRIBUTION_BACKFILL_KEY, \{ \.\.\.state, status: "running", lastError: null \}\);/, "resume continues from the cursor");
});

test("Meta daily: the same date/ad replaces that day — re-fetching never adds spend", () => {
  const db = database();
  const account = { id: "1137464954180448", currency: "USD", timezone: "Asia/Tashkent" };
  const first = parseInsightRow({ date_start: "2026-10-01", ad_id: "120200000000001001", campaign_id: "120200000000000001", spend: "10.50", impressions: "1000", clicks: "20" }, account)!;
  const again = { ...first, spendMinor: decimalToMinor("12.00", "USD") };
  const upsert = db.prepare(DAILY_UPSERT);
  upsert.run(...(dailyBindings(first, "t1") as never[]));
  upsert.run(...(dailyBindings(again, "t2") as never[]));
  upsert.run(...(dailyBindings({ ...first, date: "2026-10-02" }, "t3") as never[]));
  const rows = db.prepare("SELECT date, spend_minor FROM marketing_meta_daily ORDER BY date").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ date: "2026-10-01", spend_minor: 1200 }, { date: "2026-10-02", spend_minor: 1050 }]);
});

test("Meta Insights: parse, paging, newest-first windows, token never in an error", async () => {
  const account = { id: "1137464954180448", currency: "USD", timezone: "Asia/Tashkent" };
  assert.equal(parseInsightRow({ date_start: "2026-10-01", ad_id: "{{ad.id}}", spend: "1" }, account), null);
  const row = parseInsightRow({ date_start: "2026-10-01", ad_id: "120200000000001001", spend: "3.456", account_currency: "usd" }, account)!;
  assert.equal(row.spendMinor, 346); assert.equal(row.currency, "USD");
  assert.deepEqual(nextWindow("2026-10-14", "2026-10-01"), { since: "2026-10-08", until: "2026-10-14", nextCursor: "2026-10-07" });
  assert.deepEqual(nextWindow("2026-10-03", "2026-10-01"), { since: "2026-10-01", until: "2026-10-03", nextCursor: null });
  assert.equal(nextWindow("2026-09-30", "2026-10-01"), null);
  const calls: string[] = [];
  const pages = [
    { data: [{ date_start: "2026-10-01", ad_id: "120200000000001001", spend: "1.00" }], paging: { next: "https://graph.facebook.com/v21.0/act_1/insights?after=X&access_token=SECRET" } },
    { data: [{ date_start: "2026-10-02", ad_id: "120200000000001001", spend: "2.00" }] },
  ];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(pages.shift())); }) as unknown as typeof fetch;
  const rows = await fetchDailyInsights(fetchImpl, account, "2026-10-01", "2026-10-02", "TOKEN");
  assert.deepEqual(rows.map((item) => item.spendMinor), [100, 200]);
  assert.equal(calls.length, 2);
  const failing = (async () => new Response(JSON.stringify({ error: { code: 190, type: "OAuthException", message: "token TOKEN expired" } }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchDailyInsights(failing, account, "2026-10-01", "2026-10-01", "TOKEN"), (error: Error) => !error.message.includes("TOKEN") && /OAuthException:190/.test(error.message));
});

/* ------------------------------------------------- ad-level spend assignment */

test("spend is assigned per ad to a workspace: UZ and reserved KZ apart; category 1, mixed and no-Deal ads never leak", () => {
  const evidence = collectAdEvidence(
    [
      { adId: "A_IBOX", workspaceKey: "IBOX_UZ" }, { adId: "A_IBOX", workspaceKey: "IBOX_UZ" },
      { adId: "A_SD", workspaceKey: "SD_UZ" },
      { adId: "A_BOTH", workspaceKey: "IBOX_UZ" }, { adId: "A_BOTH", workspaceKey: "SD_UZ" },
      { adId: "A_UZ_KZ", workspaceKey: "IBOX_UZ" },
    ],
    [
      { adId: "A_IBOX", categoryId: "13" },        // IBOX post-sale: still IBOX_UZ
      { adId: "A_SD", categoryId: "17" },          // SD post-sale: still SD_UZ
      { adId: "A_IBOX_KZ", categoryId: "41" },     // reserved workspace, kept apart
      { adId: "A_SD_KZ", categoryId: "33" },
      { adId: "A_CAT1", categoryId: "1" },
      { adId: "A_UZ_KZ", categoryId: "41" },       // the same ad fed IBOX UZ and IBOX KZ
      { adId: "A_KZ_BOTH", categoryId: "41" }, { adId: "A_KZ_BOTH", categoryId: "33" },
    ],
  );
  const ids = ["A_IBOX", "A_SD", "A_BOTH", "A_IBOX_KZ", "A_SD_KZ", "A_CAT1", "A_UZ_KZ", "A_KZ_BOTH", "A_NEW"];
  assert.deepEqual(Object.fromEntries(assignAds(evidence, ids)), {
    A_IBOX: "IBOX_UZ", A_SD: "SD_UZ", A_BOTH: "MIXED", A_IBOX_KZ: "IBOX_KZ", A_SD_KZ: "SD_KZ", A_CAT1: "NON_DASHBOARD",
    A_UZ_KZ: "MIXED", A_KZ_BOTH: "MIXED", A_NEW: "UNASSIGNED",
  });
  assert.equal(classifyAd({ workspaces: new Set(), otherCategories: new Set(["1"]) }), "NON_DASHBOARD");
  assert.deepEqual(SPEND_BUCKETS, ["IBOX_UZ", "SD_UZ", "IBOX_KZ", "SD_KZ", "NON_DASHBOARD", "MIXED", "UNASSIGNED"]);
  // Workspaces map exactly the owner's categories; projects stay the accepted registry.
  assert.deepEqual(["3", "13", "5", "17", "41", "33", "1"].map(workspaceForCategory), ["IBOX_UZ", "IBOX_UZ", "SD_UZ", "SD_UZ", "IBOX_KZ", "SD_KZ", null]);
  assert.deepEqual([workspaceForProject("IBOX"), workspaceForProject("SALES_DOCTOR")], ["IBOX_UZ", "SD_UZ"]);
  assert.doesNotMatch(read("lib/sales-projects.ts"), /IBOX_KZ|SD_KZ|"41"|"33"/, "KZ is not a dashboard project yet");
  // Never by account, never by campaign: neither is an input to the decision.
  assert.doesNotMatch(read("lib/marketing/assignment.ts"), /campaign_id|ad_account|campaignId|adAccountId/);
  assert.doesNotMatch(read("lib/marketing/jobs.ts"), /projectKey|workspaceKey/, "ingest assigns no workspace");
  const dailyTable = MARKETING_SCHEMA_STATEMENTS.find((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS marketing_meta_daily"))!;
  assert.doesNotMatch(dailyTable, /project_key|workspace_key/, "no stored owner on spend rows");
  const attributionTable = MARKETING_SCHEMA_STATEMENTS[0];
  assert.match(attributionTable, /workspace_key TEXT NOT NULL,\n  project_key TEXT,/, "every Deal row carries its workspace; KZ needs no schema change");

  const assignment = assignAds(evidence, ids);
  const rows = [
    { adId: "A_IBOX", spendMinor: 1000, currency: "USD" }, { adId: "A_SD", spendMinor: 500, currency: "USD" },
    { adId: "A_IBOX_KZ", spendMinor: 400, currency: "USD" }, { adId: "A_SD_KZ", spendMinor: 300, currency: "USD" },
    { adId: "A_BOTH", spendMinor: 300, currency: "USD" }, { adId: "A_CAT1", spendMinor: 200, currency: "USD" },
    { adId: "A_NEW", spendMinor: 100, currency: "USD" }, { adId: "A_NEW", spendMinor: 100, currency: "USD" },
  ];
  const buckets = summarizeAssignment(rows, assignment, (minor, currency) => minorToUzs(minor, currency, FX));
  assert.deepEqual(SPEND_BUCKETS.map((bucket) => buckets[bucket].spendUzs), [118_000, 59_000, 47_200, 35_400, 23_600, 35_400, 23_600]);
  assert.deepEqual([buckets.UNASSIGNED.ads, buckets.UNASSIGNED.adDays], [1, 2]);
  const total = Object.values(buckets).reduce((sum, bucket) => sum + (bucket.spendUzs ?? 0), 0);
  assert.equal(total, minorToUzs(2900, "USD", FX), "every ad-day lands in exactly one bucket");
});

test("coverage per workspace: UZ on dashboard attribution, reserved KZ on tracking-delivered Deals", () => {
  const kz = trackingCoverageRow({ deal_id: "70001", workspace_key: "IBOX_KZ", lead_id: "9000000000000009", mc: "120200000000000041", ma: null, mad: "120200000000004101", submission_id: null, wc: null, wa: null, wad: null });
  assert.deepEqual(kz, { dealId: "70001", workspaceKey: "IBOX_KZ", campaignId: "120200000000000041", adsetId: null, adId: "120200000000004101", channel: "META_INSTANT_FORM", conflict: false });
  const site = trackingCoverageRow({ deal_id: "70002", workspace_key: "SD_KZ", lead_id: null, mc: null, ma: null, mad: null, submission_id: "s9", wc: "120200000000000033", wa: "120200000000003301", wad: null });
  assert.equal(site.channel, "WEBSITE");
  const coverage = workspaceCoverage([
    { dealId: "1", workspaceKey: "IBOX_UZ", campaignId: "C", adsetId: "S", adId: "A", channel: "META_INSTANT_FORM", conflict: false },
    { dealId: "2", workspaceKey: "IBOX_UZ", campaignId: null, adsetId: null, adId: null, channel: "UNKNOWN", conflict: false },
    { dealId: "3", workspaceKey: "SD_UZ", campaignId: "C", adsetId: null, adId: "A", channel: "WEBSITE", conflict: true },
    kz, site, { ...kz }, // a repeated Deal counts once
  ]);
  assert.deepEqual(Object.keys(coverage), ["IBOX_UZ", "SD_UZ", "IBOX_KZ", "SD_KZ"]);
  assert.deepEqual([coverage.IBOX_UZ.deals, coverage.IBOX_UZ.withAdId, coverage.IBOX_UZ.unknown], [2, 1, 1]);
  assert.deepEqual([coverage.SD_UZ.website, coverage.SD_UZ.conflicts], [1, 1]);
  assert.deepEqual([coverage.IBOX_KZ.deals, coverage.IBOX_KZ.measuredOn], [1, "TRACKING_DELIVERED_DEALS"]);
  assert.deepEqual([coverage.SD_KZ.deals, coverage.SD_KZ.withAdsetId], [1, 1]);
  assert.equal(coverage.SD_UZ.measuredOn, "DASHBOARD_ATTRIBUTION");
  const store = read("lib/marketing/store.ts");
  const kzSql = store.slice(store.indexOf("export async function workspaceCoverageEvidence"));
  assert.doesNotMatch(kzSql.slice(kzSql.indexOf("if (tracking && reserved.length)")), /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i, "tracking stays read-only");
  assert.match(store, /AND EXISTS \(SELECT 1 FROM analytics_records a WHERE a\.deal_id = m\.deal_id\)/, "coverage counts the current Deal store");
  assert.match(read("app/api/marketing/workspace-coverage/route.ts"), /export async function GET\(request: Request\) \{\n  const denied = await authorizePermission\(request, "settings"\);/);
});

test("campaign and ad set spend inside a project roll up its assigned ads only", () => {
  const assignment = new Map([["A1", "IBOX_UZ"], ["A2", "MIXED"]]);
  const all = [spend("A1", 1000, { campaignId: "C1", adsetId: "S1" }), spend("A2", 9000, { campaignId: "C1", adsetId: "S1" })];
  const ibox = all.filter((row) => assignment.get(row.adId) === "IBOX_UZ"); // what listSpend returns for IBOX
  const [campaign] = buildEntities({ level: "campaign", cohort: [], attribution: new Map(), spend: ibox, fx: FX, icp: IBOX_ICP });
  const [adset] = buildEntities({ level: "adset", cohort: [], attribution: new Map(), spend: ibox, fx: FX, icp: IBOX_ICP });
  assert.equal(campaign.spendUzs, 118_000, "the MIXED ad of the same campaign is not forced in");
  assert.equal(adset.spendUzs, 118_000);
});

test("Meta backfill survives throttling: same window retried, a hard error pauses one account, start never wipes a run", () => {
  const jobs = read("lib/marketing/jobs.ts");
  for (const code of ["OAuthException:4", "OAuthException:17", "OAuthException:613", "OAuthException:80000", "OAuthException:80004", "NETWORK", "HTTP", "OAuthException:2"]) assert.equal(isRetryableMetaError(code), true, code);
  for (const code of ["OAuthException:190", "OAuthException:100", "OAuthException:200", "OAuthException:10"]) assert.equal(isRetryableMetaError(code), false, code);
  assert.match(jobs, /if \(isRetryableMetaError\(code\) && account\.attempts < 8\) throttled = true;\n\s+else account\.paused = true;/, "a throttle keeps the cursor; a hard error pauses only that account");
  assert.doesNotMatch(jobs.slice(jobs.indexOf("export async function stepMetaSync")), /account\.cursor = null;\n\s+\}\s*catch|catch[\s\S]{0,200}account\.cursor = null/, "an error never discards the cursor");
  assert.match(jobs, /if \(!restart && existing && existing\.status === "running"\) return existing;/, "a second start resumes");
  assert.match(jobs, /account\.completedUntil = account\.completedUntil \?\? window\.until;\n\s+account\.completedSince = window\.since;/, "the exact stored range is recorded");
  assert.match(read("app/api/marketing/meta-sync/route.ts"), /if \(payload\.action === "resume"\) return resumeMetaSync\(\);/);
  assert.match(jobs, /\? \{ \.\.\.account, cursor: account\.completedSince \? dayBefore\(account\.completedSince\) : state\.to, paused: false, attempts: 0 \}/, "extend fetches only the days before what is stored");
  const now = new Date("2026-10-15T09:00:00Z");
  assert.deepEqual(metaRange({ from: "2025-10-15", to: "2026-10-14" }, now), { from: "2025-10-15", to: "2026-10-14" });
  assert.equal(metaRange({ from: "2025-10-01", to: "2026-10-14" }, now), null, "over 366 days");
  assert.equal(metaRange({ from: "2026-10-14", to: "2026-10-16" }, now), null, "future");
  assert.equal(metaRange({ from: "x", to: "2026-10-14" }, now), null);
});

test("marketing APIs take ?workspace=; a reserved KZ workspace is refused explicitly, not answered empty", () => {
  const http = read("lib/marketing/http.ts");
  assert.match(http, /if \(!workspace\.activated \|\| !workspace\.project\) \{\n\s+return \{ ok: false, response: Response\.json\(\{ error: "Bu workspace hali faollashtirilmagan", code: "WORKSPACE_NOT_ACTIVATED"/);
  assert.match(http, /const scoped = marketingScope\(request\);/);
  assert.match(http, /if \(raw === null \|\| raw === ""\) return requestProject\(request\);/, "?project= keeps working");
});

test("no Meta data is 'spend unavailable', never 0 UZS / 0 CPL / 0 CMC", () => {
  assert.equal(spendRangeStatus(null, "2026-10-01", "2026-10-07"), "NOT_INGESTED");
  assert.equal(spendRangeStatus([], "2026-10-01", "2026-10-07"), "NOT_INGESTED");
  const done = { currency: "USD", completedSince: "2025-10-15", completedUntil: "2026-10-14" };
  assert.equal(spendRangeStatus([done, done], "2026-10-01", "2026-10-07"), "AVAILABLE");
  assert.equal(spendRangeStatus([done, { currency: "USD", completedSince: "2026-10-05", completedUntil: "2026-10-14" }], "2026-10-01", "2026-10-07"), "PARTIAL_RANGE");
  assert.equal(spendRangeStatus([done], "2026-10-01", "2026-10-20"), "PARTIAL_RANGE", "a range past the stored end is not covered");
  const cohort = [rec("1", { qualified: true, salesStatus: "WON", opportunity: 1_000_000 })];
  const attribution = new Map([["1", view("1", { campaignId: "C1", adId: "A1" })]]);
  const summary = buildSummary({ cohort, attribution, spend: [], fx: FX, icp: IBOX_ICP, spendApplies: false });
  assert.deepEqual([summary.spendUzs, summary.cmcUzs, summary.roas, summary.cplUzs, summary.costPerSqlUzs, summary.costPerIcpFitUzs], [null, null, null, null, null, null]);
  const [row] = buildEntities({ level: "ad", cohort, attribution, spend: [], fx: FX, icp: IBOX_ICP, spendApplies: false });
  assert.deepEqual([row.spendUzs, row.cmcUzs, row.cplUzs], [null, null, null]);
  const http = read("lib/marketing/http.ts");
  assert.match(http, /const spendApplies = spendStatus === "AVAILABLE";/);
  assert.match(http, /spendStatus: context\.spendStatus, range:/);
});

/* ------------------------------------------------ isolation and guards */

test("marketing is additive: no Sales, Finance or Auth module imports it, and its APIs are guarded", () => {
  for (const path of ["lib/analytics.ts", "lib/sales-sections.ts", "lib/dashboard-metrics.ts", "lib/auth/http.ts", "app/dashboard-client.tsx"]) {
    assert.doesNotMatch(read(path), /marketing\//, path);
  }
  // Each route guards itself before anything else runs: dashboard to read, settings to run jobs.
  for (const route of ["summary", "entities", "deals", "icp", "coverage"]) {
    assert.match(read(`app/api/marketing/${route}/route.ts`), /export async function GET\(request: Request\) \{\n  const denied = await authorizePermission\(request, "dashboard"\);\n  if \(denied\) return denied;/, route);
  }
  assert.match(read("app/api/marketing/spend-assignment/route.ts"), /export async function GET\(request: Request\) \{\n  const denied = await authorizePermission\(request, "settings"\);/);
  for (const route of ["backfill", "meta-sync"]) {
    assert.match(read(`app/api/marketing/${route}/route.ts`), /export async function POST\(request: Request\) \{\n  const denied = await authorizePermission\(request, "settings"\);\n  if \(denied\) return denied;/, route);
  }
  assert.match(read("app/api/marketing/settings/route.ts"), /export async function POST\(request: Request\) \{\n  try \{ await requirePermission\(request, "settings"\); \}/);
  assert.match(read("lib/marketing/jobs.ts"), /export const META_TOKEN_SECRET = "META_ADS_ACCESS_TOKEN";/);
});
