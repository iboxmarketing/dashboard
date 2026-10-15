import type { ProjectKey } from "@/lib/sales-projects";
import type {
  FixtureCreativeRankingRow, FixtureIcpBreakdown, FixtureMarketingDealRow, FixtureMarketingEntityRow,
  FixtureMarketingManagerIcpRow, FixtureMarketingSummary, MarketingCosts, MarketingCoverage, MarketingFilterOptions,
} from "./marketing-types";

const available = (values: Partial<MarketingCosts>): MarketingCosts => ({
  status: "AVAILABLE",
  message: null,
  currency: "UZS",
  spend: null,
  cpl: null,
  costPerIcp: null,
  costPerSql: null,
  cmc: null,
  roas: null,
  ...values,
});

const unavailable = (status: Exclude<MarketingCosts["status"], "AVAILABLE">, message: string): MarketingCosts => ({
  status,
  message,
  currency: "UZS",
  spend: null,
  cpl: null,
  costPerIcp: null,
  costPerSql: null,
  cmc: null,
  roas: null,
});

const iboxIcp: FixtureIcpBreakdown = {
  icpEvaluatedCount: 112,
  icpFitCount: 83,
  icpOtherCount: 29,
  icpUnsetCount: 14,
  icpFitRate: 74,
  rows: [
    { segment: "P1", label: "P1", meaning: "Mos", count: 28, share: 25 },
    { segment: "P2", label: "P2", meaning: "Mos", count: 34, share: 30 },
    { segment: "P3", label: "P3", meaning: "Mos", count: 21, share: 19 },
    { segment: "OTHER", label: "Other", meaning: "Mos emas", count: 29, share: 26 },
    { segment: "UNSET", label: "Belgilanmagan", meaning: "Belgilanmagan", count: 14, share: 11 },
  ],
};

const sdIcp: FixtureIcpBreakdown = {
  icpEvaluatedCount: 65,
  icpFitCount: 47,
  icpOtherCount: 18,
  icpUnsetCount: 23,
  icpFitRate: 72,
  rows: [
    { segment: "P1", label: "P1", meaning: "Mos", count: 14, share: 22 },
    { segment: "P2", label: "P2", meaning: "Mos", count: 19, share: 29 },
    { segment: "P3", label: "P3", meaning: "Mos", count: 14, share: 22 },
    { segment: "OTHER", label: "Other", meaning: "Mos emas", count: 18, share: 28 },
    { segment: "UNSET", label: "Belgilanmagan", meaning: "Belgilanmagan", count: 23, share: 26 },
  ],
};

export const MARKETING_SUMMARIES: Record<ProjectKey, FixtureMarketingSummary> = {
  IBOX: {
    project: "IBOX",
    leadCount: 126,
    classifiedCount: 112,
    icpEvaluatedCount: 112,
    icpFitCount: 83,
    icpOtherCount: 29,
    icpUnsetCount: 14,
    icpFitRate: 74,
    sqlCount: 46,
    sqlRate: 37,
    pipelineCount: 29,
    saleCount: 10,
    sqlToSaleRate: 22,
    revenue: 47_200_000,
    costs: available({ spend: 11_800_000, cpl: 93_651, costPerIcp: 142_169, costPerSql: 256_522, cmc: 1_180_000, roas: 4 }),
    icp: iboxIcp,
  },
  SALES_DOCTOR: {
    project: "SALES_DOCTOR",
    leadCount: 88,
    classifiedCount: 70,
    icpEvaluatedCount: 65,
    icpFitCount: 47,
    icpOtherCount: 18,
    icpUnsetCount: 23,
    icpFitRate: 72,
    sqlCount: 31,
    sqlRate: 35,
    pipelineCount: 19,
    saleCount: 7,
    sqlToSaleRate: 23,
    revenue: 31_500_000,
    costs: unavailable("META_NOT_CONNECTED", "Meta Insights ulanmagan"),
    icp: sdIcp,
  },
};

const row = (value: FixtureMarketingEntityRow): FixtureMarketingEntityRow => value;
const noCosts = unavailable("PENDING", "Spend ma'lumoti kutilmoqda");

const iboxRows: FixtureMarketingEntityRow[] = [
  row({ id: "cmp-leadgen", level: "CAMPAIGN", parentId: null, name: "Yangi oqim — Lead Gen", secondary: "Meta · Conversion", campaignId: "cmp-leadgen", campaignName: "Yangi oqim — Lead Gen", adSetId: null, adSetName: null, adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 48, classifiedCount: 43, icpEvaluatedCount: 42, icpFitCount: 32, icpOtherCount: 10, icpUnsetCount: 6, icpFitRate: 76, sqlCount: 18, sqlRate: 38, pipelineCount: 12, saleCount: 6, sqlToSaleRate: 33, revenue: 25_200_000, costs: available({ spend: 4_800_000, cpl: 100_000, costPerIcp: 150_000, costPerSql: 266_667, cmc: 800_000, roas: 5.3 }) }),
  row({ id: "cmp-retarget", level: "CAMPAIGN", parentId: null, name: "Retargeting · Ariza ochgan, lekin yakunlamagan auditoriya", secondary: "Meta · Retargeting", campaignId: "cmp-retarget", campaignName: "Retargeting · Ariza ochgan, lekin yakunlamagan auditoriya", adSetId: null, adSetName: null, adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 42, classifiedCount: 37, icpEvaluatedCount: 36, icpFitCount: 27, icpOtherCount: 9, icpUnsetCount: 6, icpFitRate: 75, sqlCount: 16, sqlRate: 38, pipelineCount: 11, saleCount: 4, sqlToSaleRate: 25, revenue: 22_000_000, costs: available({ spend: 3_700_000, cpl: 88_095, costPerIcp: 137_037, costPerSql: 231_250, cmc: 925_000, roas: 5.9 }) }),
  row({ id: "cmp-webinar", level: "CAMPAIGN", parentId: null, name: "Webinar · Kuzgi qabul", secondary: "Meta · Video", campaignId: "cmp-webinar", campaignName: "Webinar · Kuzgi qabul", adSetId: null, adSetName: null, adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 36, classifiedCount: 32, icpEvaluatedCount: 34, icpFitCount: 24, icpOtherCount: 10, icpUnsetCount: 2, icpFitRate: 71, sqlCount: 12, sqlRate: 33, pipelineCount: 6, saleCount: 0, sqlToSaleRate: 0, revenue: 0, costs: available({ spend: 3_300_000, cpl: 91_667, costPerIcp: 137_500, costPerSql: 275_000, cmc: null, roas: 0 }) }),

  row({ id: "set-broad", level: "AD_SET", parentId: "cmp-leadgen", name: "Broad · 23–40 · Uzbekistan", secondary: "Advantage+ audience", campaignId: "cmp-leadgen", campaignName: "Yangi oqim — Lead Gen", adSetId: "set-broad", adSetName: "Broad · 23–40 · Uzbekistan", adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 30, classifiedCount: 27, icpEvaluatedCount: 26, icpFitCount: 20, icpOtherCount: 6, icpUnsetCount: 4, icpFitRate: 77, sqlCount: 12, sqlRate: 40, pipelineCount: 8, saleCount: 4, sqlToSaleRate: 33, revenue: 17_400_000, costs: available({ spend: 2_900_000, cpl: 96_667, costPerIcp: 145_000, costPerSql: 241_667, cmc: 725_000, roas: 6 }) }),
  row({ id: "set-lookalike", level: "AD_SET", parentId: "cmp-leadgen", name: "Lookalike 1% · O‘tgan xaridorlar", secondary: "CRM seed", campaignId: "cmp-leadgen", campaignName: "Yangi oqim — Lead Gen", adSetId: "set-lookalike", adSetName: "Lookalike 1% · O‘tgan xaridorlar", adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 18, classifiedCount: 16, icpEvaluatedCount: 16, icpFitCount: 12, icpOtherCount: 4, icpUnsetCount: 2, icpFitRate: 75, sqlCount: 6, sqlRate: 33, pipelineCount: 4, saleCount: 2, sqlToSaleRate: 33, revenue: 7_800_000, costs: available({ spend: 1_900_000, cpl: 105_556, costPerIcp: 158_333, costPerSql: 316_667, cmc: 950_000, roas: 4.1 }) }),
  row({ id: "set-retarget", level: "AD_SET", parentId: "cmp-retarget", name: "Form opened · 30 days", secondary: "Warm audience", campaignId: "cmp-retarget", campaignName: "Retargeting · Ariza ochgan, lekin yakunlamagan auditoriya", adSetId: "set-retarget", adSetName: "Form opened · 30 days", adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 42, classifiedCount: 37, icpEvaluatedCount: 36, icpFitCount: 27, icpOtherCount: 9, icpUnsetCount: 6, icpFitRate: 75, sqlCount: 16, sqlRate: 38, pipelineCount: 11, saleCount: 4, sqlToSaleRate: 25, revenue: 22_000_000, costs: available({ spend: 3_700_000, cpl: 88_095, costPerIcp: 137_037, costPerSql: 231_250, cmc: 925_000, roas: 5.9 }) }),

  row({ id: "ad-video-01", level: "AD", parentId: "set-broad", name: "Ota-onalar uchun 3 savol · video", secondary: "Ad ID 23851239001", campaignId: "cmp-leadgen", campaignName: "Yangi oqim — Lead Gen", adSetId: "set-broad", adSetName: "Broad · 23–40 · Uzbekistan", adId: "23851239001", platform: "Meta", placement: "Instagram Reels", landingId: "form-ibox-main", landingLabel: "Meta Instant Form · IBOX Main", landingType: "INSTANT_FORM", marketingSource: "Paid Social", leadCount: 18, classifiedCount: 17, icpEvaluatedCount: 16, icpFitCount: 13, icpOtherCount: 3, icpUnsetCount: 2, icpFitRate: 81, sqlCount: 8, sqlRate: 44, pipelineCount: 6, saleCount: 3, sqlToSaleRate: 38, revenue: 13_500_000, costs: available({ spend: 1_550_000, cpl: 86_111, costPerIcp: 119_231, costPerSql: 193_750, cmc: 516_667, roas: 8.7 }) }),
  row({ id: "ad-static-02", level: "AD", parentId: "set-broad", name: "Kursni tanlashdan oldin · statik", secondary: "Ad ID 23851239002", campaignId: "cmp-leadgen", campaignName: "Yangi oqim — Lead Gen", adSetId: "set-broad", adSetName: "Broad · 23–40 · Uzbekistan", adId: "23851239002", platform: "Meta", placement: "Facebook Feed", landingId: "landing-form-new", landingLabel: "/uz/form-new", landingType: "WEBSITE", marketingSource: "Paid Social", leadCount: 12, classifiedCount: 10, icpEvaluatedCount: 10, icpFitCount: 7, icpOtherCount: 3, icpUnsetCount: 2, icpFitRate: 70, sqlCount: 4, sqlRate: 33, pipelineCount: 2, saleCount: 1, sqlToSaleRate: 25, revenue: 3_900_000, costs: available({ spend: 1_350_000, cpl: 112_500, costPerIcp: 192_857, costPerSql: 337_500, cmc: 1_350_000, roas: 2.9 }) }),
  row({ id: "ad-proof-03", level: "AD", parentId: "set-lookalike", name: "Bitiruvchilar natijasi · uzun testimonial creative nomi", secondary: "Ad ID 23851239003", campaignId: "cmp-leadgen", campaignName: "Yangi oqim — Lead Gen", adSetId: "set-lookalike", adSetName: "Lookalike 1% · O‘tgan xaridorlar", adId: "23851239003", platform: "Meta", placement: "Instagram Stories", landingId: "form-ibox-main", landingLabel: "Meta Instant Form · IBOX Main", landingType: "INSTANT_FORM", marketingSource: "Paid Social", leadCount: 18, classifiedCount: 16, icpEvaluatedCount: 16, icpFitCount: 12, icpOtherCount: 4, icpUnsetCount: 2, icpFitRate: 75, sqlCount: 6, sqlRate: 33, pipelineCount: 4, saleCount: 2, sqlToSaleRate: 33, revenue: 7_800_000, costs: available({ spend: 1_900_000, cpl: 105_556, costPerIcp: 158_333, costPerSql: 316_667, cmc: 950_000, roas: 4.1 }) }),
  row({ id: "ad-organic-04", level: "AD", parentId: "set-retarget", name: "CRM qayta aloqa · attribution topilmadi", secondary: "Ad ID noma’lum", campaignId: "cmp-retarget", campaignName: "Retargeting · Ariza ochgan, lekin yakunlamagan auditoriya", adSetId: "set-retarget", adSetName: "Form opened · 30 days", adId: null, platform: "Noma’lum", placement: null, landingId: null, landingLabel: "Attribution topilmadi", landingType: "UNKNOWN", marketingSource: "Attribution topilmadi", leadCount: 3, classifiedCount: 2, icpEvaluatedCount: 2, icpFitCount: 1, icpOtherCount: 1, icpUnsetCount: 1, icpFitRate: 50, sqlCount: 1, sqlRate: 33, pipelineCount: 1, saleCount: 1, sqlToSaleRate: 100, revenue: 4_200_000, costs: available({ spend: 0, cpl: 0, costPerIcp: 0, costPerSql: 0, cmc: 0, roas: null }) }),
  row({ id: "ad-currency-05", level: "AD", parentId: "set-retarget", name: "USD creative · kurs kutilmoqda", secondary: "Ad ID 23851239005", campaignId: "cmp-retarget", campaignName: "Retargeting · Ariza ochgan, lekin yakunlamagan auditoriya", adSetId: "set-retarget", adSetName: "Form opened · 30 days", adId: "23851239005", platform: "Meta", placement: "Instagram Feed", landingId: "form-ibox-main", landingLabel: "Meta Instant Form · IBOX Main", landingType: "INSTANT_FORM", marketingSource: "Paid Social", leadCount: 2, classifiedCount: 2, icpEvaluatedCount: 2, icpFitCount: 1, icpOtherCount: 1, icpUnsetCount: 0, icpFitRate: 50, sqlCount: 1, sqlRate: 50, pipelineCount: 1, saleCount: 0, sqlToSaleRate: 0, revenue: 0, costs: unavailable("CURRENCY_UNAVAILABLE", "Currency rate unavailable") }),

  row({ id: "placement-reels", level: "PLACEMENT", parentId: null, name: "Instagram Reels", secondary: "ig · mobile", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Instagram", placement: "Instagram Reels", landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 45, classifiedCount: 40, icpEvaluatedCount: 39, icpFitCount: 30, icpOtherCount: 9, icpUnsetCount: 6, icpFitRate: 77, sqlCount: 18, sqlRate: 40, pipelineCount: 12, saleCount: 5, sqlToSaleRate: 28, revenue: 23_000_000, costs: available({ spend: 4_200_000, cpl: 93_333, costPerIcp: 140_000, costPerSql: 233_333, cmc: 840_000, roas: 5.5 }) }),
  row({ id: "placement-feed", level: "PLACEMENT", parentId: null, name: "Facebook Feed", secondary: "fb · desktop + mobile", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Facebook", placement: "Facebook Feed", landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 51, classifiedCount: 45, icpEvaluatedCount: 43, icpFitCount: 31, icpOtherCount: 12, icpUnsetCount: 8, icpFitRate: 72, sqlCount: 17, sqlRate: 33, pipelineCount: 10, saleCount: 3, sqlToSaleRate: 18, revenue: 14_200_000, costs: available({ spend: 4_700_000, cpl: 92_157, costPerIcp: 151_613, costPerSql: 276_471, cmc: 1_566_667, roas: 3 }) }),
  row({ id: "placement-stories", level: "PLACEMENT", parentId: null, name: "Instagram Stories", secondary: "ig · mobile", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Instagram", placement: "Instagram Stories", landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 30, classifiedCount: 27, icpEvaluatedCount: 30, icpFitCount: 22, icpOtherCount: 8, icpUnsetCount: 0, icpFitRate: 73, sqlCount: 11, sqlRate: 37, pipelineCount: 7, saleCount: 2, sqlToSaleRate: 18, revenue: 10_000_000, costs: available({ spend: 2_900_000, cpl: 96_667, costPerIcp: 131_818, costPerSql: 263_636, cmc: 1_450_000, roas: 3.4 }) }),

  row({ id: "form-ibox-main", level: "LANDING_FORM", parentId: null, name: "Meta Instant Form · IBOX Main", secondary: "Meta Instant Form", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Meta", placement: null, landingId: "form-ibox-main", landingLabel: "Meta Instant Form · IBOX Main", landingType: "INSTANT_FORM", marketingSource: "Paid Social", leadCount: 79, classifiedCount: 71, icpEvaluatedCount: 68, icpFitCount: 52, icpOtherCount: 16, icpUnsetCount: 11, icpFitRate: 76, sqlCount: 31, sqlRate: 39, pipelineCount: 20, saleCount: 7, sqlToSaleRate: 23, revenue: 33_400_000, costs: available({ spend: 7_100_000, cpl: 89_873, costPerIcp: 136_538, costPerSql: 229_032, cmc: 1_014_286, roas: 4.7 }) }),
  row({ id: "landing-form-new", level: "LANDING_FORM", parentId: null, name: "/uz/form-new", secondary: "Website landing page", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Website", placement: null, landingId: "landing-form-new", landingLabel: "/uz/form-new", landingType: "WEBSITE", marketingSource: "Paid Social", leadCount: 44, classifiedCount: 39, icpEvaluatedCount: 41, icpFitCount: 30, icpOtherCount: 11, icpUnsetCount: 3, icpFitRate: 73, sqlCount: 14, sqlRate: 32, pipelineCount: 8, saleCount: 2, sqlToSaleRate: 14, revenue: 9_600_000, costs: available({ spend: 4_700_000, cpl: 106_818, costPerIcp: 156_667, costPerSql: 335_714, cmc: 2_350_000, roas: 2 }) }),
  row({ id: "landing-missing", level: "LANDING_FORM", parentId: null, name: "Attribution topilmadi", secondary: "Landing/Form belgilanmagan", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Noma’lum", placement: null, landingId: null, landingLabel: "Attribution topilmadi", landingType: "UNKNOWN", marketingSource: "Attribution topilmadi", leadCount: 3, classifiedCount: 2, icpEvaluatedCount: 3, icpFitCount: 1, icpOtherCount: 2, icpUnsetCount: 0, icpFitRate: 33, sqlCount: 1, sqlRate: 33, pipelineCount: 1, saleCount: 1, sqlToSaleRate: 100, revenue: 4_200_000, costs: available({ spend: 0, cpl: 0, costPerIcp: 0, costPerSql: 0, cmc: 0, roas: null }) }),
];

const sdRows: FixtureMarketingEntityRow[] = [
  row({ id: "sd-main", level: "CAMPAIGN", parentId: null, name: "Sales Doctor · Main Leads", secondary: "Meta · Instant Form", campaignId: "sd-main", campaignName: "Sales Doctor · Main Leads", adSetId: null, adSetName: null, adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 57, classifiedCount: 45, icpEvaluatedCount: 42, icpFitCount: 31, icpOtherCount: 11, icpUnsetCount: 15, icpFitRate: 74, sqlCount: 21, sqlRate: 37, pipelineCount: 13, saleCount: 5, sqlToSaleRate: 24, revenue: 22_500_000, costs: noCosts }),
  row({ id: "sd-web", level: "CAMPAIGN", parentId: null, name: "Sales Doctor · Website Applications", secondary: "Google / Website", campaignId: "sd-web", campaignName: "Sales Doctor · Website Applications", adSetId: null, adSetName: null, adId: null, platform: "Website", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Search", leadCount: 31, classifiedCount: 25, icpEvaluatedCount: 23, icpFitCount: 16, icpOtherCount: 7, icpUnsetCount: 8, icpFitRate: 70, sqlCount: 10, sqlRate: 32, pipelineCount: 6, saleCount: 2, sqlToSaleRate: 20, revenue: 9_000_000, costs: noCosts }),
  row({ id: "sd-broad", level: "AD_SET", parentId: "sd-main", name: "Entrepreneurs · Broad", secondary: "Uzbekistan", campaignId: "sd-main", campaignName: "Sales Doctor · Main Leads", adSetId: "sd-broad", adSetName: "Entrepreneurs · Broad", adId: null, platform: "Meta", placement: null, landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 57, classifiedCount: 45, icpEvaluatedCount: 42, icpFitCount: 31, icpOtherCount: 11, icpUnsetCount: 15, icpFitRate: 74, sqlCount: 21, sqlRate: 37, pipelineCount: 13, saleCount: 5, sqlToSaleRate: 24, revenue: 22_500_000, costs: noCosts }),
  row({ id: "sd-video", level: "AD", parentId: "sd-broad", name: "CEO bottleneck · video", secondary: "Ad ID 99220011", campaignId: "sd-main", campaignName: "Sales Doctor · Main Leads", adSetId: "sd-broad", adSetName: "Entrepreneurs · Broad", adId: "99220011", platform: "Meta", placement: "Instagram Reels", landingId: "sd-form-main", landingLabel: "Meta Instant Form · SD Main", landingType: "INSTANT_FORM", marketingSource: "Paid Social", leadCount: 57, classifiedCount: 45, icpEvaluatedCount: 42, icpFitCount: 31, icpOtherCount: 11, icpUnsetCount: 15, icpFitRate: 74, sqlCount: 21, sqlRate: 37, pipelineCount: 13, saleCount: 5, sqlToSaleRate: 24, revenue: 22_500_000, costs: noCosts }),
  row({ id: "sd-reels", level: "PLACEMENT", parentId: null, name: "Instagram Reels", secondary: "ig · mobile", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Instagram", placement: "Instagram Reels", landingId: null, landingLabel: null, landingType: null, marketingSource: "Paid Social", leadCount: 57, classifiedCount: 45, icpEvaluatedCount: 42, icpFitCount: 31, icpOtherCount: 11, icpUnsetCount: 15, icpFitRate: 74, sqlCount: 21, sqlRate: 37, pipelineCount: 13, saleCount: 5, sqlToSaleRate: 24, revenue: 22_500_000, costs: noCosts }),
  row({ id: "sd-form-main", level: "LANDING_FORM", parentId: null, name: "Meta Instant Form · SD Main", secondary: "Meta Instant Form", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Meta", placement: null, landingId: "sd-form-main", landingLabel: "Meta Instant Form · SD Main", landingType: "INSTANT_FORM", marketingSource: "Paid Social", leadCount: 57, classifiedCount: 45, icpEvaluatedCount: 42, icpFitCount: 31, icpOtherCount: 11, icpUnsetCount: 15, icpFitRate: 74, sqlCount: 21, sqlRate: 37, pipelineCount: 13, saleCount: 5, sqlToSaleRate: 24, revenue: 22_500_000, costs: noCosts }),
  row({ id: "sd-landing", level: "LANDING_FORM", parentId: null, name: "/sales-doctor/diagnostic", secondary: "Website landing page", campaignId: null, campaignName: null, adSetId: null, adSetName: null, adId: null, platform: "Website", placement: null, landingId: "sd-landing", landingLabel: "/sales-doctor/diagnostic", landingType: "WEBSITE", marketingSource: "Search", leadCount: 31, classifiedCount: 25, icpEvaluatedCount: 23, icpFitCount: 16, icpOtherCount: 7, icpUnsetCount: 8, icpFitRate: 70, sqlCount: 10, sqlRate: 32, pipelineCount: 6, saleCount: 2, sqlToSaleRate: 20, revenue: 9_000_000, costs: noCosts }),
];

export const MARKETING_ROWS: Record<ProjectKey, FixtureMarketingEntityRow[]> = { IBOX: iboxRows, SALES_DOCTOR: sdRows };

export const MARKETING_OPTIONS: Record<ProjectKey, MarketingFilterOptions> = {
  IBOX: {
    marketingSources: [{ id: "paid-social", name: "Paid Social" }, { id: "missing", name: "Attribution topilmadi" }],
    platforms: [{ id: "meta", name: "Meta" }, { id: "instagram", name: "Instagram" }, { id: "facebook", name: "Facebook" }, { id: "website", name: "Website" }],
    campaigns: iboxRows.filter((item) => item.level === "CAMPAIGN").map((item) => ({ id: item.id, name: item.name })),
    adSets: iboxRows.filter((item) => item.level === "AD_SET").map((item) => ({ id: item.id, name: item.name })),
    ads: iboxRows.filter((item) => item.level === "AD").map((item) => ({ id: item.id, name: item.name })),
    placements: [{ id: "reels", name: "Instagram Reels" }, { id: "feed", name: "Facebook Feed" }, { id: "stories", name: "Instagram Stories" }],
    landingForms: [{ id: "form-ibox-main", name: "Meta Instant Form · IBOX Main" }, { id: "landing-form-new", name: "/uz/form-new" }, { id: "missing", name: "Attribution topilmadi" }],
  },
  SALES_DOCTOR: {
    marketingSources: [{ id: "paid-social", name: "Paid Social" }, { id: "search", name: "Search" }],
    platforms: [{ id: "meta", name: "Meta" }, { id: "instagram", name: "Instagram" }, { id: "website", name: "Website" }],
    campaigns: sdRows.filter((item) => item.level === "CAMPAIGN").map((item) => ({ id: item.id, name: item.name })),
    adSets: sdRows.filter((item) => item.level === "AD_SET").map((item) => ({ id: item.id, name: item.name })),
    ads: sdRows.filter((item) => item.level === "AD").map((item) => ({ id: item.id, name: item.name })),
    placements: [{ id: "reels", name: "Instagram Reels" }],
    landingForms: [{ id: "sd-form-main", name: "Meta Instant Form · SD Main" }, { id: "sd-landing", name: "/sales-doctor/diagnostic" }],
  },
};

export const MARKETING_MANAGER_ICP: Record<ProjectKey, FixtureMarketingManagerIcpRow[]> = {
  IBOX: [
    { managerId: "4151", managerName: "Sanjar Juraev", evaluatedCount: 38, fitCount: 30, fitRate: 79, unsetCount: 4 },
    { managerId: "235", managerName: "Abdulla Norboyev", evaluatedCount: 31, fitCount: 22, fitRate: 71, unsetCount: 5 },
    { managerId: "199", managerName: "Otabek Sulaymonov", evaluatedCount: 24, fitCount: 17, fitRate: 71, unsetCount: 5 },
  ],
  SALES_DOCTOR: [
    { managerId: "223", managerName: "Abubakir Rahimov", evaluatedCount: 24, fitCount: 18, fitRate: 75, unsetCount: 8 },
    { managerId: "12565", managerName: "Abubakir Rahimov (old ID)", evaluatedCount: 18, fitCount: 13, fitRate: 72, unsetCount: 7 },
    { managerId: "199", managerName: "Otabek Sulaymonov", evaluatedCount: 23, fitCount: 16, fitRate: 70, unsetCount: 8 },
  ],
};

export const MARKETING_COVERAGE: Record<ProjectKey, MarketingCoverage> = {
  IBOX: { deals: 126, withCampaignId: 118, withAdsetId: 114, withAdId: 116, metaInstantForm: 79, website: 36, otherSource: 3, unknown: 8, conflicts: 2, notYetAttributed: 8 },
  SALES_DOCTOR: { deals: 88, withCampaignId: 80, withAdsetId: 74, withAdId: 71, metaInstantForm: 57, website: 23, otherSource: 0, unknown: 8, conflicts: 1, notYetAttributed: 8 },
};

export function creativeRows(project: ProjectKey): FixtureCreativeRankingRow[] {
  return MARKETING_ROWS[project].filter((item) => item.level === "AD").map((item) => ({
    adId: item.adId ?? "—",
    adName: item.name,
    campaignName: item.campaignName ?? "Attribution topilmadi",
    sales: item.saleCount,
    icpFitRate: item.icpFitRate,
    sql: item.sqlCount,
    roas: item.costs.roas,
    cmc: item.costs.cmc,
    costStatus: item.costs.status,
    currency: item.costs.currency,
  }));
}

const managers = ["Sanjar Juraev", "Abdulla Norboyev", "Otabek Sulaymonov", "Abubakir Rahimov"];
const stages = ["ОБРАБОТКА", "ВСТРЕЧА НАЗНАЧЕНА", "СОГЛАСИЕ", "Оплата получена"];

/** Deterministic, non-production rows used only to exercise the UI contract. */
export function buildMarketingDealFixtures(project: ProjectKey, count: number, seed: Partial<FixtureMarketingDealRow> = {}): FixtureMarketingDealRow[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({
    dealId: `${project === "IBOX" ? "4" : "5"}${String(301 + index).padStart(4, "0")}`,
    title: `${project === "IBOX" ? "IBOX" : "Sales Doctor"} marketing lead ${index + 1}`,
    manager: managers[index % managers.length],
    currentStage: stages[index % stages.length],
    quality: index % 5 === 0 ? "Saralanmagan" : "Saralangan",
    icp: (["P1", "P2", "P3", "OTHER", "UNSET"] as const)[index % 5],
    crmSource: index % 2 ? "CRM forma" : "WEB",
    marketingSource: index % 7 === 0 ? "Attribution topilmadi" : "Paid Social",
    platform: index % 2 ? "Instagram" : "Facebook",
    campaign: project === "IBOX" ? "Yangi oqim — Lead Gen" : "Sales Doctor · Main Leads",
    adSet: project === "IBOX" ? "Broad · 23–40 · Uzbekistan" : "Entrepreneurs · Broad",
    ad: project === "IBOX" ? "Ota-onalar uchun 3 savol · video" : "CEO bottleneck · video",
    createdAt: `2026-10-${String((index % 14) + 1).padStart(2, "0")}T09:30:00+05:00`,
    saleAt: index % 3 === 0 ? `2026-10-${String((index % 14) + 2).padStart(2, "0")}T16:20:00+05:00` : null,
    revenue: index % 3 === 0 ? 4_200_000 : 0,
    currency: "UZS",
    ...seed,
  }));
}
