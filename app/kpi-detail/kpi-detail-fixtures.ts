import type {
  KpiBreakdown,
  KpiDeal,
  KpiDetailMetric,
  KpiDetailRequest,
  KpiDetailResponse,
  KpiDetailTemplate,
  KpiDisplayStat,
  KpiDistribution,
  KpiFunnelStep,
} from "@/lib/kpi-detail-contract";
import type { KpiDetailAdapter } from "./kpi-detail-adapter";

type FixtureDefinition = {
  template: KpiDetailTemplate;
  title: string;
  subtitle: string;
  definition: string;
  value: string;
  rate?: { value: string; label: string };
  summary?: KpiDisplayStat[];
};

/** Representative preview values. They are never imported by production composition. */
const METRICS: Record<KpiDetailMetric, FixtureDefinition> = {
  leads: { template: "population", title: "Leadlar", subtitle: "Canonical loyiha Leadlari", definition: "Tanlangan davrda yaratilgan va loyiha a’zoligi tasdiqlangan Deal’lar.", value: "435", rate: { value: "+8%", label: "Oldingi davrga nisbatan" } },
  sorted: { template: "population", title: "Saralangan", subtitle: "Sifat qarori mavjud Leadlar", definition: "SQL yoki Not Relevant sifat qarori mavjud Leadlar.", value: "326", rate: { value: "75%", label: "Leadlardan" }, summary: [
    { id: "leads", label: "Lead", value: "435", tone: "info" },
    { id: "sorted", label: "Saralangan", value: "326", note: "75%", tone: "success" },
    { id: "unsorted", label: "Saralanmagan", value: "109", note: "25%", tone: "warning" },
  ] },
  sql: { template: "population", title: "SQL", subtitle: "Sifatli deb qabul qilingan Leadlar", definition: "Server tasdiqlagan canonical SQL populyatsiyasi.", value: "59", rate: { value: "18%", label: "Saralanganlardan" } },
  not_relevant: { template: "population", title: "Not Relevant", subtitle: "Marketing sifatsizligi", definition: "Not Relevant bosqichi bilan yakunlangan canonical marketing sifatsizligi.", value: "41", rate: { value: "13%", label: "Saralanganlardan" } },
  lost: { template: "population", title: "Sotilmadi", subtitle: "Canonical Sales Lost", definition: "SQL sifatida qabul qilingan, ammo sotuvga aylanmagan Deal’lar.", value: "12", rate: { value: "20%", label: "SQL’dan" } },
  cohort_sales: { template: "sales", title: "Cohort sotuvlar", subtitle: "Tanlangan davrda kelgan leadlardan sotilganlari", definition: "Lead yaratilgan sana tanlangan davr ichida bo‘lgan sotuvlar.", value: "15", rate: { value: "25%", label: "SQL → Sale" } },
  period_sales: { template: "sales", title: "Davrdagi sotuvlar", subtitle: "Sotuv sanasi tanlangan davr ichida bo‘lgan sotuvlar", definition: "Server qaytargan ishonchli sotuv sanasi bo‘yicha davr natijasi.", value: "18", summary: [
    { id: "revenue", label: "Revenue", value: "486 000 000 UZS" },
    { id: "average", label: "O‘rtacha chek", value: "27 000 000 UZS" },
    { id: "median", label: "Median", value: "24 500 000 UZS" },
  ] },
  average_check: { template: "sales", title: "Chek", subtitle: "Sotuvlar qiymati", definition: "Tanlangan sotuvlar bo‘yicha server hisoblagan o‘rtacha Opportunity.", value: "27 000 000 UZS", summary: [
    { id: "median", label: "Median", value: "24 500 000 UZS" },
    { id: "sales", label: "Sotuvlar", value: "18" },
    { id: "revenue", label: "Revenue", value: "486 000 000 UZS" },
  ] },
  sales_cycle: { template: "time", title: "Savdo sikli", subtitle: "Leaddan sotuvgacha", definition: "Lead yaratilganidan canonical sotuvgacha o‘tgan vaqt.", value: "5,4 kun", summary: [
    { id: "median", label: "Median", value: "4,8 kun" },
    { id: "population", label: "O‘lchangan sotuv", value: "15" },
  ] },
  active_leads: { template: "population", title: "Aktiv leadlar", subtitle: "Tanlangan cohortdagi ochiq ish", definition: "Tanlangan davrda kelib, hali yopilmagan Deal’lar.", value: "87" },
  sla_response: { template: "time", title: "SLA — javob vaqti", subtitle: "Taqsimotdan birinchi harakatgacha", definition: "Faqat rasmiy ish vaqti bo‘yicha server hisoblagan javob muddati.", value: "18 daqiqa", rate: { value: "82%", label: "SLA ichida · 288/351 yakunlangan" }, summary: [
    { id: "median", label: "Median", value: "11 daqiqa" },
    { id: "completed", label: "Yakunlangan", value: "351" },
    { id: "inside", label: "SLA ichida", value: "288 · 82%", tone: "success" },
  ] },
  calendar_response: { template: "time", title: "Kalendar javob vaqti", subtitle: "Real o‘tgan vaqt — tun va dam olish kunlari ham kiradi", definition: "Taqsimotdan birinchi harakatgacha real kalendar vaqti; bu SLA bahosi emas.", value: "2,3 soat", summary: [
    { id: "median", label: "Median", value: "48 daqiqa" },
    { id: "population", label: "O‘lchangan", value: "351" },
  ] },
  funnel_conversion: { template: "funnel", title: "Funnel konversiyasi", subtitle: "Lead → Saralangan → SQL → Sale", definition: "Har bir o‘tish foizi API ko‘rsatgan o‘z denominatoriga ega.", value: "25%", rate: { value: "15 / 59", label: "SQL → Sale" } },
  sorting_time: { template: "time", title: "Saralash vaqti", subtitle: "Leaddan sifat qarorigacha", definition: "SQL yoki Not Relevant qarorigacha server hisoblagan ish vaqti; SLA emas.", value: "3,2 soat", summary: [
    { id: "median", label: "Median", value: "1,7 soat" },
    { id: "population", label: "Qarori mavjud", value: "326" },
  ] },
  icp_fit: { template: "funnel", title: "ICP ga moslik", subtitle: "IBOX Leadlarining ICP bahosi", definition: "Fit Rate = Fit / Evaluated. Unset baholangan populyatsiyaga kirmaydi.", value: "64%", rate: { value: "128 / 200", label: "Fit / Evaluated" }, summary: [
    { id: "fit", label: "Fit", value: "128", tone: "success" },
    { id: "not_fit", label: "Not Fit", value: "72", tone: "warning" },
    { id: "evaluated", label: "Evaluated", value: "200" },
    { id: "unset", label: "Unset", value: "235", note: "Baholanmagan", tone: "neutral" },
  ] },
};

const DEALS: KpiDeal[] = [
  { id: "48102", title: "CRM forma — Toshkent", createdAt: "2026-10-03T06:15:00Z", manager: "Dilshod Karimov", source: "CRM-форма", stage: "ОБРАБОТКА", status: "SQL", opportunity: "24 000 000 UZS", bitrixUrl: "https://example.bitrix24.test/crm/deal/details/48102/" },
  { id: "48127", title: "Webinar arizasi", createdAt: "2026-10-04T09:40:00Z", manager: "Madina Aliyeva", source: "Web", stage: "ВСТРЕЧА НАЗНАЧЕНА", status: "Faol", opportunity: "18 500 000 UZS", bitrixUrl: "https://example.bitrix24.test/crm/deal/details/48127/" },
  { id: "48211", title: "Instagram lead", createdAt: "2026-10-05T12:05:00Z", manager: "Jasur Shadiev", source: "Instagram", stage: "Not Relevant", status: "Not Relevant", opportunity: null, bitrixUrl: "https://example.bitrix24.test/crm/deal/details/48211/" },
];

const managerBreakdown: KpiBreakdown = {
  id: "manager",
  title: "Menejerlar kesimida",
  columns: [{ key: "manager", label: "Menejer" }, { key: "count", label: "Deal", align: "right" }, { key: "rate", label: "Ulush", align: "right" }],
  rows: [
    { id: "25", cells: { manager: "Dilshod Karimov", count: "24", rate: "41%" }, dealFilter: { key: "manager", value: "25", label: "Dilshod Karimov" } },
    { id: "31", cells: { manager: "Madina Aliyeva", count: "19", rate: "32%" }, dealFilter: { key: "manager", value: "31", label: "Madina Aliyeva" } },
  ],
};

const sourceBreakdown: KpiBreakdown = {
  id: "source",
  title: "Manba kesimida",
  columns: [{ key: "source", label: "Manba (SOURCE_ID)" }, { key: "count", label: "Deal", align: "right" }, { key: "rate", label: "Ulush", align: "right" }],
  rows: [
    { id: "crm", cells: { source: "CRM-форма", count: "38", rate: "64%" }, dealFilter: { key: "source", value: "CRM-форма", label: "CRM-форма" } },
    { id: "web", cells: { source: "Web", count: "12", rate: "20%" }, dealFilter: { key: "source", value: "Web", label: "Web" } },
  ],
};

const stageBreakdown: KpiBreakdown = {
  id: "stage",
  title: "Bosqichlar",
  columns: [{ key: "stage", label: "Joriy bosqich" }, { key: "count", label: "Deal", align: "right" }],
  rows: [
    { id: "processing", cells: { stage: "ОБРАБОТКА", count: "27" }, dealFilter: { key: "stage", value: "C3:PREPARATION", label: "ОБРАБОТКА" } },
    { id: "meeting", cells: { stage: "ВСТРЕЧА НАЗНАЧЕНА", count: "16" }, dealFilter: { key: "stage", value: "C3:UC_MEETING", label: "ВСТРЕЧА НАЗНАЧЕНА" } },
  ],
};

const reasonBreakdown = (lost: boolean): KpiBreakdown => ({
  id: "reason",
  title: lost ? "Nega sotilmadi?" : "Nega Not Relevant bo‘ldi?",
  columns: [{ key: "reason", label: "Sabab" }, { key: "count", label: "Soni", align: "right" }, { key: "rate", label: "%", align: "right" }],
  rows: [
    { id: "price", cells: { reason: lost ? "Narx mos kelmadi" : "Noto‘g‘ri kontakt", count: "8", rate: "40%" }, dealFilter: { key: "reason", value: "price", label: lost ? "Narx mos kelmadi" : "Noto‘g‘ri kontakt" } },
    { id: "missing", cells: { reason: null, count: "3", rate: "15%" }, dealFilter: { key: "reason", value: "__missing__", label: "Sabab ko‘rsatilmagan" } },
  ],
});

const salesFunnel: KpiFunnelStep[] = [
  { id: "leads", label: "Lead", value: "435", transition: { value: "75%", label: "Lead → Saralangan" }, dealFilter: { key: "population", value: "leads" } },
  { id: "sorted", label: "Saralangan", value: "326", transition: { value: "18%", label: "Saralangan → SQL" }, dealFilter: { key: "population", value: "sorted" } },
  { id: "sql", label: "SQL", value: "59", transition: { value: "25%", label: "SQL → Sale" }, dealFilter: { key: "population", value: "sql" } },
  { id: "sale", label: "Sale", value: "15", dealFilter: { key: "population", value: "sale" } },
];

function distribution(metric: KpiDetailMetric): KpiDistribution | null {
  if (metric === "average_check") return { title: "Chek taqsimoti", items: [
    { id: "low", label: "<20 mln", value: "5", share: "28%" }, { id: "mid", label: "20–30 mln", value: "9", share: "50%" }, { id: "high", label: "30+ mln", value: "4", share: "22%" },
  ] };
  if (metric === "sales_cycle") return { title: "Davomiylik taqsimoti", items: ["<1 kun", "1–3 kun", "3–7 kun", "7–14 kun", "14+ kun"].map((label, index) => ({ id: String(index), label, value: ["2", "4", "5", "3", "1"][index], share: ["13%", "27%", "33%", "20%", "7%"][index] })) };
  if (metric === "sorting_time") return { title: "Saralash vaqti taqsimoti", items: ["<1 soat", "1–4 soat", "4–8 soat", "8–24 soat", "24+ soat"].map((label, index) => ({ id: String(index), label, value: ["98", "112", "56", "39", "21"][index], share: ["30%", "34%", "17%", "12%", "7%"][index] })) };
  if (metric === "sla_response" || metric === "calendar_response") return { title: "Javob vaqti taqsimoti", items: [
    { id: "inside", label: "SLA ichida", value: "288", share: "82%", dealFilter: { key: "sla", value: "ON_TIME" } },
    { id: "late", label: "SLA buzilgan", value: "63", share: "18%", dealFilter: { key: "sla", value: "LATE" } },
    { id: "pending", label: "Pending", value: "47", dealFilter: { key: "sla", value: "PENDING" } },
    { id: "unknown", label: "Unknown", value: "37", dealFilter: { key: "sla", value: "UNKNOWN_EVIDENCE" } },
  ] };
  return null;
}

function fixtureResponse(request: KpiDetailRequest): KpiDetailResponse {
  const definition = METRICS[request.metric];
  if (request.metric === "icp_fit" && request.project !== "IBOX") {
    return { project: request.project, metric: request.metric, template: "funnel", status: "NOT_APPLICABLE", title: "ICP ga moslik", message: "Bu workspace uchun ICP qo‘llanilmaydi" };
  }
  const params = new URLSearchParams(request.search);
  const noRows = params.get("source") === "__empty__";
  const breakdowns = request.metric === "not_relevant"
    ? [reasonBreakdown(false), managerBreakdown, sourceBreakdown]
    : request.metric === "lost"
      ? [reasonBreakdown(true), managerBreakdown, sourceBreakdown]
      : definition.template === "population"
        ? [managerBreakdown, sourceBreakdown, stageBreakdown]
        : [managerBreakdown, sourceBreakdown];
  const sortedSegments = request.metric === "sorted" ? [
    { id: "unsorted", label: "Saralanmagan", count: "109" },
    { id: "sorted", label: "Saralangan", count: "326" },
  ] : undefined;
  const timeSegments = request.metric === "sla_response" ? [
    { id: "on_time", label: "SLA ichida", count: "288" },
    { id: "late", label: "SLA buzilgan", count: "63" },
    { id: "pending", label: "Pending", count: "47" },
    { id: "unknown", label: "Unknown", count: "37" },
  ] : undefined;
  const dealTotal = request.metric === "funnel_conversion" ? "435"
    : request.metric === "icp_fit" ? "128"
      : definition.summary?.find((row) => ["population", "completed", "sales"].includes(row.id))?.value ?? definition.value;
  return {
    project: request.project,
    metric: request.metric,
    template: definition.template,
    status: noRows ? "EMPTY" : "READY",
    title: definition.title,
    subtitle: definition.subtitle,
    definition: definition.definition,
    period: { from: "2026-10-01", to: "2026-10-15", label: "01.10.2026 — 15.10.2026" },
    appliedFilters: [
      { id: "project", label: "Loyiha", value: request.project === "IBOX" ? "IBOX" : "Sales Doctor" },
      ...(params.getAll("manager").map((value) => ({ id: `manager:${value}`, label: "Menejer", value }))),
      ...(params.getAll("source").filter((value) => value !== "__empty__").map((value) => ({ id: `source:${value}`, label: "Manba", value }))),
    ],
    hero: { value: noRows ? "—" : definition.value, rate: noRows ? null : definition.rate ?? null },
    summary: noRows ? [] : definition.summary,
    funnel: noRows ? [] : ["cohort_sales", "funnel_conversion"].includes(request.metric) ? salesFunnel : undefined,
    breakdowns: noRows ? [] : breakdowns,
    distribution: noRows ? null : distribution(request.metric),
    deals: {
      title: `${definition.title} tarkibidagi Deal’lar`,
      total: noRows ? "0" : dealTotal,
      page: Number(params.get("page") || 1),
      pageSize: 25,
      pageCount: noRows ? 0 : 1,
      searchable: true,
      sortableOpportunity: request.metric === "average_check",
      activeSegment: params.get("segment") ?? sortedSegments?.[0]?.id ?? timeSegments?.[0]?.id ?? null,
      segments: sortedSegments ?? timeSegments,
      rows: noRows ? [] : DEALS,
    },
  };
}

/** Explicit-only adapter for component development and tests. */
export class FixtureKpiDetailAdapter implements KpiDetailAdapter {
  readonly source = "fixtures" as const;

  async getDetail(request: KpiDetailRequest, signal?: AbortSignal): Promise<KpiDetailResponse> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return fixtureResponse(request);
  }
}

export const fixtureKpiDetailResponse = fixtureResponse;
