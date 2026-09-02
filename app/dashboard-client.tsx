"use client";

import {
  Activity, AlertTriangle, ArrowLeft, BarChart3, CalendarDays, Check,
  ChevronDown, Clock3, Database, Download, ExternalLink, Gauge, LayoutDashboard,
  Loader2, Menu, RefreshCw, Search, Settings, ShieldCheck,
  SlidersHorizontal, TimerReset, Users, X, XCircle, CircleDollarSign, ClipboardList, Layers3, GripVertical, ChevronUp
} from "lucide-react";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { DashboardRecord, StageFunnelRecord } from "@/lib/dashboard-record";
import {
  buildHistorical, buildManagerMatrix, buildOverdueRows, buildReconciliationView, buildStageCatalog,
  buildStageHealth, buildSummary, humanDuration, stageKey,
  type MatrixCell, type OverdueSort, type ReconciliationView, type StageCatalogEntry,
} from "@/lib/stage-control-analytics";
import { DASHBOARD_HEADLINE_CARD_IDS, headlineCardLabel, resolveHeadlineCardIds, type HeadlineCardId } from "@/lib/dashboard-cards";
import { BUCKET_COUNT, DEFAULT_LEAD_FLOW_METRIC, LEAD_FLOW_METRICS, WEEKDAY_LABELS, bucketLabel, buildLeadFlow, higherIsHealthier, leadFlowValue, type LeadFlowMetricId } from "@/lib/lead-flow-analytics";
import { buildManagerProfile, notRelevantRecords, reasonBreakdown, salesLostRecords, sourceFunnelRows, stageWorkloadRows, teamMedian } from "@/lib/manager-profile";
import { buildQualityAnalytics, type MarketingManagerDiagnostic, type SalesManagerDiagnostic } from "@/lib/quality-analytics";
import { DEFAULT_TREND_METRIC, TREND_METRICS, buildTrendSeries, supportsMovingAverage, trendBarHeight, trendMetric, type TrendBounds, type TrendMetricId, type TrendPoint } from "@/lib/trend-series";
import { initialStageFunnelState, stageFunnelNext, type StageFunnelAction, type StageFunnelState, type StageFunnelStatus } from "@/lib/stage-funnel-cache";
import type { CrmFieldOption, CurrentStageRecord, DashboardSettings, PipelineOption, PipelineStageOption, ProviderDiagnostic, StageReconciliation, SyncProgressState } from "@/lib/types";
import { ANALYTICS_VERSION } from "@/lib/analytics";
import { canonicalizeFieldOptions, normalizeCrmFields } from "@/lib/crm-fields";
import { normalizeSettings } from "@/lib/settings-safety";
import {
  DEADLINE_STATES, deadlineState, filterProjects, isOverdue, latestUpdate, projectUpdates,
  statusBreakdown, statusOptions, summarizeProjects, wasEdited, type Project, type ProjectUpdate,
} from "@/lib/projects";
import {
  MANUAL_KPI_FORMATS, PAGE_RANGES, PAGE_TEMPLATES, WIDGET_REGISTRY, WIDGET_SOURCE_LABELS,
  filterPages, formatManualValue, pageRangeBounds, pageRangeLabel, pageWidgets, templateById,
  resolveWidgetCustomRange, resolveWidgetRange, selectLatestUpdates, selectProjectsListRows, widgetSource,
  type CustomPage, type PageWidget, type WidgetSource, type WidgetType,
} from "@/lib/custom-pages";
import { boundsFromKeys } from "@/lib/period";
import {
  DEFAULT_SHARED_WIDGET_TYPES, SHARE_STATUS_LABELS, defaultVisibleWidgetIds, shareStatus,
  type PageShare,
} from "@/lib/share-tokens";
import { countClassificationConflicts, dealOutcomeLabel, isClassifiedLead, isEligibleCohortDeal, isPreSqlClosed, isUnclassifiedLead, salesManagerKey } from "@/lib/sales-logic";
import { countDuplicates, markDuplicates } from "@/lib/duplicates";
import { stageConfigConflicts } from "@/lib/stage-config";
import { DASHBOARD_METRICS, buildDashboardMetrics, resolveDashboardMetric, selectPeriodPopulations, type DashboardMetricId } from "@/lib/dashboard-metrics";
import { SLA_LABELS, SLA_TONES, resolveSlaState } from "@/lib/sla";
import { stageConfigReadiness, summarizeDataQuality } from "@/lib/diagnostics";
import {
  canFullSync, fullSyncBlockers, fullSyncConfirmation, isSettingsDirty, settingsReadiness,
  type SettingsReadiness,
} from "@/lib/settings-readiness";
import {
  CheckCard, DateInput, FormField, NumberInput, SelectInput, TextInput, Textarea, TimeInput,
} from "./ui/form";
import { Drawer } from "./ui/drawer";
import { StatusCombobox } from "./ui/combobox";

/** Sales analytics views. Only these carry the global cohort filter bar. */
const SALES_VIEWS = ["dashboard", "managers", "managerDetail", "leadFlow", "quality", "stages", "deals"] as const;
/** Management views: no sales filters, no funnel/sync controls. */
const MANAGEMENT_VIEWS = ["projects", "projectDetail", "pages", "pageDetail", "settings", "diagnostics"] as const;
export const isSalesView = (view: string) => (SALES_VIEWS as readonly string[]).includes(view);
export const isManagementView = (view: string) => (MANAGEMENT_VIEWS as readonly string[]).includes(view);

type View = "dashboard" | "managers" | "managerDetail" | "leadFlow" | "quality" | "stages" | "deals" | "projects" | "projectDetail" | "pages" | "pageDetail" | "diagnostics" | "settings";
type SyncState = SyncProgressState;
type Filters = {
  range: "today" | "yesterday" | "7" | "30" | "month" | "lastMonth" | "custom";
  from: string; to: string; manager: string; pipeline: string; source: string;
  stage: string; period: string; sla: string; processing: string; search: string;
};

const emptyFilters: Filters = {
  range: "30", from: "", to: "", manager: "", pipeline: "", source: "",
  stage: "", period: "", sla: "", processing: "", search: "",
};

const idleSync: SyncState = {
  status: "idle", phase: null, progress: 0, message: null, processed: 0, total: 0,
  stale: false, selectedPipelines: [], scopePipelineId: null, lastSyncAt: null, lastFrom: null,
  counts: {}, permissions: {}, safeError: null,
};

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "managers", label: "Menejerlar", icon: Users },
  { id: "leadFlow", label: "Lead oqimi", icon: BarChart3 },
  { id: "quality", label: "Lead sifati", icon: ClipboardList },
  { id: "stages", label: "Stage nazorati", icon: Layers3 },
  { id: "deals", label: "Deal’lar", icon: Database },
  { id: "projects", label: "Projects", icon: ClipboardList },
  { id: "pages", label: "Pages", icon: LayoutDashboard },
  { id: "diagnostics", label: "Diagnostika", icon: Activity },
  { id: "settings", label: "Sozlamalar", icon: Settings },
];

function pct(value: number, total: number) { return total ? Math.round((value / total) * 100) : 0; }
function fmtMinutes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 60) return `${Math.round(value)} min`;
  return `${Math.floor(value / 60)} s ${Math.round(value % 60)} min`;
}
function fmtHours(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 24) return `${Math.round(value * 10) / 10} soat`;
  return `${Math.round((value / 24) * 10) / 10} kun`;
}
function fmtDate(value: string | null, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}
/** Re-resolves SLA state against the current clock so a lead can cross its
 * deadline without waiting for another sync. */
function withLiveSlaState(rows: DashboardRecord[], settings: DashboardSettings, now = new Date()): DashboardRecord[] {
  return rows.map((row) => ({ ...row, slaStatus: resolveSlaState(row, settings, now) }));
}
function hydrateRecord(row: DashboardRecord): DashboardRecord {
  return {
    ...row,
    analyticsVersion: Number(row.analyticsVersion ?? 1),
    originCategoryId: row.originCategoryId ?? row.categoryId,
    originPipeline: row.originPipeline ?? row.pipeline,
    operationalPipeline: row.operationalPipeline ?? true,
    stageEnteredAt: row.stageEnteredAt ?? row.createdAt,
    stageAgeHours: Number(row.stageAgeHours ?? 0),
    stageLimitHours: Number(row.stageLimitHours ?? 24),
    stageOverdue: row.stageOverdue ?? false,
    salesStatus: row.salesStatus ?? "ACTIVE",
    qualified: row.qualified ?? true,
    qualifiedAt: row.qualifiedAt ?? (row.qualified ? row.createdAt : null),
    qualifiedStageId: row.qualifiedStageId ?? null,
    qualifiedStage: row.qualifiedStage ?? null,
    wonAt: row.wonAt ?? null,
    salesCycleHours: row.salesCycleHours ?? (row.wonAt ? Math.max(0, (new Date(row.wonAt).getTime() - new Date(row.createdAt).getTime()) / 3_600_000) : null),
    opportunity: Number(row.opportunity ?? 0),
    currencyId: row.currencyId ?? "",
    lossReason: row.lossReason ?? "",
    lossReasonGroup: row.lossReasonGroup ?? (row.salesStatus === "LOW_QUALITY" ? "MARKETING" : row.salesStatus === "LOST" ? "SALES" : "NONE"),
    contactId: row.contactId ?? null,
    companyId: row.companyId ?? null,
    customerKey: row.customerKey ?? null,
    duplicateOfDealId: row.duplicateOfDealId ?? null,
    stageHistoryCount: Number(row.stageHistoryCount ?? 0),
    salesManagerId: row.salesManagerId ?? null,
    salesManager: row.salesManager ?? null,
    salesManagerAttribution: row.salesManagerAttribution ?? "UNKNOWN",
  };
}
function localDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function rangeBounds(filters: Filters) {
  const now = new Date(); const today = localDateKey(now);
  const startOf = (days: number) => localDateKey(new Date(now.getTime() - days * 86_400_000));
  if (filters.range === "today") return { from: today, to: today };
  if (filters.range === "yesterday") { const yesterday = startOf(1); return { from: yesterday, to: yesterday }; }
  if (filters.range === "7") return { from: startOf(6), to: today };
  if (filters.range === "30") return { from: startOf(29), to: today };
  if (filters.range === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (filters.range === "lastMonth") {
    return { from: localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: localDateKey(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
  return { from: filters.from, to: filters.to };
}

function StatusDot({ state }: { state: string }) {
  const ok = state === "ok" || state === "success" || state === "connected";
  return <span className={`status-dot ${ok ? "ok" : state === "warning" ? "warning" : "error"}`} aria-hidden="true" />;
}
function Select({ value, onChange, children, label }: { value: string; onChange: (value: string) => void; children: React.ReactNode; label: string }) {
  return <label className="select-wrap" aria-label={label}><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select><ChevronDown size={14} aria-hidden="true" /></label>;
}
function Skeleton() {
  return <div className="app-loading" aria-label="Yuklanmoqda"><div className="loading-mark"><Loader2 size={28} className="spin" /></div><p>Dashboard tayyorlanmoqda…</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
}

function SyncProgress({ sync, busy, onPause, onResume }: { sync: SyncState; busy: boolean; onPause: () => void; onResume: () => void }) {
  if (!["running", "paused", "error"].includes(sync.status)) return null;
  return <div className={`sync-progress ${sync.status}`}>
    <div className="sync-progress-head"><div>{sync.status === "running" ? <Loader2 size={18} className="spin" /> : sync.status === "paused" ? <TimerReset size={18} /> : <XCircle size={18} />}<span><strong>{sync.status === "running" ? "Sinxronizatsiya ishlayapti" : sync.status === "paused" ? "Sinxronizatsiya pauzada" : "Sinxronizatsiya to‘xtadi"}</strong><small>{sync.message ?? sync.safeError ?? "Holat yangilanmoqda…"}</small></span></div><b>{sync.progress}%</b></div>
    <div className="sync-track"><span style={{ width: `${sync.progress}%` }} /></div>
    <div className="sync-progress-foot"><span>{sync.selectedPipelines[0]?.name || "Sales funnel"} · faqat shu funnel</span><span>{sync.processed}{sync.total ? ` / ${sync.total}` : ""}</span></div>
    {sync.status === "running" ? <button className="button small secondary" onClick={onPause}>Pauza</button> : sync.status === "paused" ? <button className="button small primary" disabled={busy} onClick={onResume}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Davom ettirish</button> : <small className="sync-restart-hint">Yuqoridan IBOX yoki SD funnel’ni tanlab yangi sync boshlang.</small>}
  </div>;
}

function SetupScreen({ configured, sync, syncing, externalError, onStart, onPause, onResume }: { configured: boolean; sync: SyncState; syncing: boolean; externalError: string | null; onStart: () => void; onPause: () => void; onResume: () => void }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Record<string, string | null> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function testConnection() {
    setTesting(true); setError(null);
    try {
      const response = await fetch("/api/test-connection", { method: "POST" });
      const payload = await response.json() as Record<string, string | null>;
      if (!response.ok) throw new Error(payload.error ?? "Ulanishni tekshirib bo‘lmadi");
      setResult(payload);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Ulanishni tekshirib bo‘lmadi"); }
    finally { setTesting(false); }
  }
  const checks = [["Bitrix24", result?.bitrix], ["Deal’lar", result?.deals], ["Stage history", result?.stageHistory], ["Menejerlar", result?.managers]];

  return <main className="setup-page">
    <div className="setup-brand"><span>B24</span><strong>Deal Processing</strong></div>
    <section className="setup-card">
      <div className="setup-icon"><ShieldCheck size={30} /></div><p className="eyebrow">XAVFSIZ SERVER ULANISHI</p>
      <h1>{configured ? "Bitrix24 ulanishini tekshiring" : "Bitrix24 webhook ulanmagan."}</h1>
      <p className="setup-copy">{configured ? "Webhook serverda topildi. Faqat tanlangan Sales pipeline’lari paketlarda sinxronlanadi; call center pipeline’lari olinmaydi." : <>Site Secrets ichiga <code>BITRIX24_WEBHOOK_URL</code> qo‘shing. Webhook brauzerga, loglarga yoki dashboard javoblariga chiqarilmaydi.</>}</p>
      <div className="setup-steps">
        <div><span>1</span><p><strong>Incoming webhook yarating</strong><small>CRM o‘qish va qisqa user ma’lumoti ruxsatlari</small></p></div>
        <div><span>2</span><p><strong>Secret sifatida qo‘shing</strong><small>BITRIX24_WEBHOOK_URL</small></p></div>
        <div><span>3</span><p><strong>Ulanishni tekshiring</strong><small>Deal, stage history va menejer ruxsatlari yetarli</small></p></div>
      </div>
      {result && <div className="connection-grid">{checks.map(([label, state]) => <div key={label ?? ""}><StatusDot state={state ?? "error"} /><span>{label}</span><strong>{state === "ok" ? "Tayyor" : state === "warning" ? "Cheklangan" : "Xato"}</strong></div>)}</div>}
      {result?.warning && <div className="notice warning"><AlertTriangle size={18} />{result.warning}</div>}
      {error && <div className="notice error"><XCircle size={18} />{error}</div>}
      {externalError && <div className="notice error"><XCircle size={18} />{externalError}</div>}
      <SyncProgress sync={sync} busy={syncing} onPause={onPause} onResume={onResume} />
      <div className="setup-actions">
        <button className="button secondary" onClick={testConnection} disabled={testing || !configured}>{testing ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}Bitrix24 ulanishini tekshirish</button>
        {result?.bitrix === "ok" && !["running", "paused"].includes(sync.status) && <button className="button primary" onClick={onStart} disabled={syncing}>{syncing ? <Loader2 className="spin" size={18} /> : <Database size={18} />}Birinchi sinxronizatsiyani boshlash</button>}
      </div>
    </section>
    <p className="privacy-note">Telefon raqamlar, email va yozuvlar olinmaydi. Telefoniya ma’lumotlari umuman sinxronlanmaydi.</p>
  </main>;
}

function KpiCard({ label, value, detail, tone = "blue", icon: Icon, valueClassName = "" }: { label: string; value: string; detail: React.ReactNode; tone?: string; icon: typeof Activity; valueClassName?: string }) {
  return <article className={`kpi-card ${tone}`}><div className="kpi-top"><span>{label}</span><div className="kpi-icon"><Icon size={18} /></div></div><strong className={valueClassName}>{value}</strong><small>{detail}</small></article>;
}
function MetricDelta({ current, previous }: { current: number; previous: number }) {
  if (!previous && !current) return <span className="delta-inline neutral">o‘tgan davr bilan teng</span>;
  if (!previous) return <span className="delta-inline up">yangi o‘sish</span>;
  const delta = Math.round(((current - previous) / previous) * 100);
  return <span className={`delta-inline ${delta > 0 ? "up" : delta < 0 ? "down" : "neutral"}`}>{delta > 0 ? "+" : ""}{delta}% oldingi davrga</span>;
}
function BarList({ rows }: { rows: { label: string; value: number; total: number; color?: string; icon?: string }[] }) {
  return <div className="bar-list">{rows.map((row) => { const percentage = pct(row.value, row.total); return <div className="bar-row" key={row.label}><div><span>{row.icon} {row.label}</span><strong>{row.value} <small>{percentage}%</small></strong></div><div className="bar-track"><span style={{ width: `${percentage}%`, background: row.color }} /></div></div>; })}</div>;
}
function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="section-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}

/**
 * One manager row, read left to right as a funnel: how many leads arrived,
 * were they classified, what quality, what the cohort produced, how efficiently
 * SQL closed, what was lost, what closed this period, and the operational load.
 *
 * Every figure comes from `buildDashboardMetrics` over that manager's own
 * records, so a row is the dashboard's definitions restricted to one seller
 * rather than a second set of formulas.
 */
type ManagerRow = {
  id: string; name: string;
  leads: number; leadShare: number;
  classified: number; classificationCoverage: number;
  sql: number; qualityAcceptedRate: number;
  notRelevant: number; lowQualityRate: number;
  cohortSales: number; leadToSale: number; cohortRevenue: number;
  sqlToSale: number;
  salesLost: number; salesLostRate: number;
  periodSales: number; revenue: number;
  active: number;
  avgProcessing: number | null;
  overdueUnprocessed: number; overdueRate: number;
  // Carried for the profile's team benchmarks; the table does not show them.
  slaRate: number | null; slaDenominator: number; salesCycleHours: number | null;
  currency: string;
};


/**
 * Manager rows built from the canonical metric helper.
 *
 * The two populations mirror the dashboard exactly: `records` is the cohort
 * (deals created in the period) and `wonRecords` is the period-sales set
 * (deals won in the period). They are partitioned by `salesManagerKey`, so
 * every deal lands in exactly one row and the rows sum back to the dashboard's
 * own totals — which is what makes the lead-share denominator trustworthy.
 */
function buildManagers(records: DashboardRecord[], wonRecords: DashboardRecord[] = records.filter((row) => row.salesStatus === "WON")): ManagerRow[] {
  const cohortByManager = new Map<string, DashboardRecord[]>();
  const wonByManager = new Map<string, DashboardRecord[]>();
  for (const record of records) {
    const key = salesManagerKey(record);
    cohortByManager.set(key, [...(cohortByManager.get(key) ?? []), record]);
  }
  for (const record of wonRecords) {
    const key = salesManagerKey(record);
    wonByManager.set(key, [...(wonByManager.get(key) ?? []), record]);
  }
  const ids = new Set([...cohortByManager.keys(), ...wonByManager.keys()]);
  const built = [...ids].map((id) => {
    const cohort = cohortByManager.get(id) ?? [];
    const won = wonByManager.get(id) ?? [];
    const metrics = buildDashboardMetrics(cohort, won);
    return {
      id,
      name: cohort[0]?.salesManager ?? won[0]?.salesManager ?? "Aniqlanmagan",
      leads: metrics.counts.leads,
      leadShare: 0, // filled once every row is known — see below
      classified: metrics.counts.classified_leads,
      classificationCoverage: metrics.rates.classification_coverage,
      sql: metrics.counts.sql,
      qualityAcceptedRate: metrics.rates.quality_accepted_rate,
      notRelevant: metrics.counts.not_relevant,
      lowQualityRate: metrics.rates.low_quality_rate,
      cohortSales: metrics.counts.cohort_sales,
      leadToSale: metrics.rates.lead_to_sale,
      cohortRevenue: metrics.money.cohort_revenue,
      sqlToSale: metrics.rates.sql_to_sale,
      salesLost: metrics.counts.sales_lost,
      salesLostRate: metrics.rates.sales_lost,
      periodSales: metrics.counts.period_sales,
      revenue: metrics.money.revenue,
      active: metrics.counts.active_cohort,
      avgProcessing: metrics.timing.avg_processing,
      // Canonical OVERDUE_UNPROCESSED, not the SLA rate — different metrics.
      overdueUnprocessed: metrics.sla.overdue,
      overdueRate: pct(metrics.sla.overdue, metrics.counts.leads),
      slaRate: metrics.sla.denominator ? metrics.rates.sla : null,
      slaDenominator: metrics.sla.denominator,
      salesCycleHours: metrics.timing.sales_cycle,
      currency: metrics.money.currency,
    } satisfies ManagerRow;
  });
  // The share denominator is every manager's leads, never just the rows a
  // caller happens to display: the Dashboard shows a top-8 slice, and dividing
  // by that would report percentages of a subset as percentages of the team.
  const totalLeads = built.reduce((sum, row) => sum + row.leads, 0);
  return built
    .map((row) => ({ ...row, leadShare: pct(row.leads, totalLeads) }))
    .sort((a, b) => b.periodSales - a.periodSales || b.cohortSales - a.cohortSales);
}

/**
 * @param limit shows only the first N rows *after* sorting. The Dashboard uses
 * it for a top-8 summary; the Managers page passes nothing and shows everyone.
 */
function ManagerTable({ rows, onSelect, limit }: { rows: ManagerRow[]; onSelect: (manager: ManagerRow) => void; limit?: number }) {
  const [sort, setSort] = useState<keyof ManagerRow>("periodSales");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const aValue = a[sort]; const bValue = b[sort];
    const compared = typeof aValue === "string" ? aValue.localeCompare(String(bValue)) : Number(aValue ?? Infinity) - Number(bValue ?? Infinity);
    return direction === "asc" ? compared : -compared;
  }), [rows, sort, direction]);
  // Sort every manager first, then cut. Slicing before sorting would rank the
  // eight best sellers by Davr sotuv against each other on whatever column the
  // user picked, which reads as a top-8 for that column but is not one.
  const visibleRows = useMemo(() => (limit ? sorted.slice(0, limit) : sorted), [sorted, limit]);
  function setColumn(column: keyof ManagerRow) {
    if (sort === column) setDirection(direction === "asc" ? "desc" : "asc");
    else { setSort(column); setDirection("asc"); }
  }
  /** Each combined column sorts by the primary figure it leads with. */
  const header = (label: string, key: keyof ManagerRow) => <button onClick={() => setColumn(key)}>{label}{sort === key && (direction === "asc" ? " ↑" : " ↓")}</button>;
  const money = (value: number, currency: string) => `${Math.round(value).toLocaleString("uz-UZ")} ${currency || "UZS"}`;
  return <div className="table-wrap"><table className="data-table manager-table funnel-table">
    {/* A second header row names the funnel stages, so the columns read as a
        sequence rather than as unrelated numbers. */}
    <thead>
      <tr className="group-row">
        <th aria-hidden="true" />
        <th colSpan={2}>LEAD TAQSIMOTI</th>
        <th colSpan={2}>SIFAT</th>
        <th colSpan={3}>COHORT NATIJA</th>
        <th>DAVR NATIJA</th>
        <th colSpan={3}>OPERATSIYA</th>
      </tr>
      <tr>
        <th className="sticky-col">{header("Sotuvchi", "name")}</th>
        <th title="Menejer leadlari / barcha menejerlar leadlari">{header("Leadlar", "leads")}</th>
        <th title="Saralangan / Leadlar">{header("Saralash", "classificationCoverage")}</th>
        <th title="SQL / Saralangan">{header("SQL", "sql")}</th>
        <th title="Not Relevant / Saralangan">{header("Not Relevant", "notRelevant")}</th>
        <th title="Cohort sotuv soni, Lead → Sotuv % va o‘sha sotuvlar summasi">{header("Cohort sotuv", "cohortSales")}</th>
        <th title="Cohort sotuv / SQL">{header("SQL → Sotuv", "sqlToSale")}</th>
        <th title="Sotilmadi / SQL">{header("Sotilmadi", "salesLost")}</th>
        <th title="Sotuv sanasi tanlangan davrda bo‘lgan sotuvlar">{header("Davr sotuv", "periodSales")}</th>
        <th title="Tanlangan davrda kelib, hali yopilmagan">{header("Aktiv", "active")}</th>
        <th title="Lead kelganidan SQL yoki Not Relevant bo‘lguncha">{header("Avg saralash", "avgProcessing")}</th>
        <th title="OVERDUE_UNPROCESSED — SLA foizi emas">{header("Ishlov muddati o‘tgan", "overdueUnprocessed")}</th>
      </tr>
    </thead>
    <tbody>{visibleRows.map((row) => <tr key={row.id} onClick={() => onSelect(row)}>
      <td className="sticky-col"><div className="manager-cell"><span>{row.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><strong>{row.name}</strong></div></td>
      <td><strong>{row.leads}</strong><small>{row.leadShare}% jamidan</small></td>
      <td><strong>{row.classified} / {row.leads}</strong><small>{row.classificationCoverage}%</small></td>
      <td><strong>{row.sql}</strong><small>{row.qualityAcceptedRate}% saralanganlardan</small></td>
      <td><strong className={row.notRelevant ? "warning-text" : ""}>{row.notRelevant}</strong><small>{row.lowQualityRate}% saralanganlardan</small></td>
      <td><strong className="success-text">{row.cohortSales} ta · {row.leadToSale}%</strong><small>{money(row.cohortRevenue, row.currency)}</small></td>
      <td><span className="pill success">{row.sqlToSale}%</span><small>{row.cohortSales} / {row.sql} SQL</small></td>
      <td><strong className={row.salesLost ? "danger-text" : ""}>{row.salesLost} ta</strong><small>{row.salesLostRate}% SQL’dan</small></td>
      <td><strong className="success-text">{row.periodSales} ta</strong><small>{money(row.revenue, row.currency)}</small></td>
      <td>{row.active}</td>
      <td>{fmtMinutes(row.avgProcessing)}</td>
      <td><strong className={row.overdueUnprocessed ? "danger-text" : ""}>{row.overdueUnprocessed} ta</strong><small>{row.overdueRate}% leadlardan</small></td>
    </tr>)}</tbody>
  </table>{!rows.length && <div className="empty-table">Tanlangan filtr bo‘yicha menejerlar topilmadi.</div>}</div>;
}

function FiltersBar({ filters, setFilters, records, currentStages, mode = "cohort" }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>; records: DashboardRecord[]; currentStages?: CurrentStageRecord[]; mode?: "cohort" | "current" }) {
  const [expanded, setExpanded] = useState(false);
  const managers = mode === "current"
    ? [...new Map((currentStages ?? []).map((row) => [row.assignedManagerId, row.assignedManager] as const)).entries()]
    : [...new Map(records.flatMap((row) => [[row.assignedManagerId, row.assignedManager] as const, ...(row.salesManagerId ? [[row.salesManagerId, row.salesManager ?? "Aniqlanmagan"] as const] : [])])).entries()];
  const pipelines = mode === "current" ? [...new Set((currentStages ?? []).map((row) => row.pipeline))].sort() : [...new Set(records.map((row) => row.originPipeline))].sort();
  const sources = [...new Set(records.map((row) => row.source))].sort();
  const stages = mode === "current" ? [...new Set((currentStages ?? []).map((row) => row.stage))].sort() : [...new Set(records.map((row) => row.stage))].sort();
  const set = (key: keyof Filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = Object.entries(filters).filter(([key, value]) => !["range", "search", "from", "to"].includes(key) && value).length;
  if (mode === "current") {
    const currentActiveCount = [filters.manager, filters.pipeline, filters.stage].filter(Boolean).length;
    return <div className="filters-shell current-stage-filters"><div className="filters-main">
      <div className="search-box"><Search size={16} /><input value={filters.search} onChange={(event) => set("search", event.target.value)} placeholder="Deal ID yoki nomi…" /></div>
      <Select label="Menejer" value={filters.manager} onChange={(value) => set("manager", value)}><option value="">Barcha menejerlar</option>{managers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
      <Select label="Pipeline" value={filters.pipeline} onChange={(value) => set("pipeline", value)}><option value="">Barcha pipeline</option>{pipelines.map((pipeline) => <option key={pipeline}>{pipeline}</option>)}</Select>
      <Select label="Joriy stage" value={filters.stage} onChange={(value) => set("stage", value)}><option value="">Barcha stage’lar</option>{stages.map((stage) => <option key={stage}>{stage}</option>)}</Select>
      {(currentActiveCount > 0 || filters.search) && <button className="clear-filter" onClick={() => setFilters((current) => ({ ...emptyFilters, range: current.range }))}><X size={15} />Tozalash</button>}
    </div><div className="current-filter-note"><Clock3 size={15} /><span>Joriy stage sonlariga sana filtri qo‘llanmaydi — Bitrix’dagi hozirgi ochiq deal’lar ko‘rsatiladi.</span></div></div>;
  }
  return <div className="filters-shell">
    <div className="filters-main">
      <div className="search-box"><Search size={16} /><input value={filters.search} onChange={(event) => set("search", event.target.value)} placeholder="Deal ID yoki nomi…" /></div>
      <Select label="Sana oralig‘i" value={filters.range} onChange={(value) => set("range", value)}><option value="today">Bugun</option><option value="yesterday">Kecha</option><option value="7">Oxirgi 7 kun</option><option value="30">Oxirgi 30 kun</option><option value="month">Shu oy</option><option value="lastMonth">O‘tgan oy</option><option value="custom">Custom</option></Select>
      <Select label="Menejer" value={filters.manager} onChange={(value) => set("manager", value)}><option value="">Barcha menejerlar</option>{managers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
      <Select label="Pipeline" value={filters.pipeline} onChange={(value) => set("pipeline", value)}><option value="">Barcha pipeline</option>{pipelines.map((value) => <option key={value}>{value}</option>)}</Select>
      <button className={`filter-toggle ${activeCount ? "active" : ""}`} onClick={() => setExpanded(!expanded)}><SlidersHorizontal size={16} />Boshqa filtrlar{activeCount > 0 && <span>{activeCount}</span>}</button>
      {(activeCount > 0 || filters.search) && <button className="clear-filter" onClick={() => setFilters(emptyFilters)}><X size={15} />Tozalash</button>}
    </div>
    {filters.range === "custom" && <div className="custom-dates"><label>Boshlanish<input type="date" value={filters.from} onChange={(event) => set("from", event.target.value)} /></label><label>Tugash<input type="date" value={filters.to} onChange={(event) => set("to", event.target.value)} /></label></div>}
    {expanded && <div className="filters-extra">
      <Select label="Manba" value={filters.source} onChange={(value) => set("source", value)}><option value="">Barcha manbalar</option>{sources.map((value) => <option key={value}>{value}</option>)}</Select>
      <Select label="Status" value={filters.stage} onChange={(value) => set("stage", value)}><option value="">Barcha statuslar</option>{stages.map((value) => <option key={value}>{value}</option>)}</Select>
      <Select label="Ish vaqti" value={filters.period} onChange={(value) => set("period", value)}><option value="">Ish vaqti: barchasi</option><option value="WORK_HOURS">Ish vaqtida</option><option value="AFTER_HOURS">Ish vaqtidan tashqarida</option></Select>
      <Select label="SLA" value={filters.sla} onChange={(value) => set("sla", value)}><option value="">SLA: barchasi</option>{(Object.keys(SLA_LABELS) as (keyof typeof SLA_LABELS)[]).map((state) => <option key={state} value={state}>{SLA_LABELS[state]}</option>)}</Select>
      <Select label="Obrabotka usuli" value={filters.processing} onChange={(value) => set("processing", value)}><option value="">Obrabotka: barchasi</option><option value="QUALIFICATION_STAGE">Ishlov berilgan</option><option value="NO_PROCESSING">Ishlov berilmagan</option><option value="NO_PROCESSING_EVIDENCE">Vaqti noma’lum</option></Select>
    </div>}
  </div>;
}

function DashboardView({ records, salesRecords, previousRecords, previousSalesRecords, metricIds, onManager }: { records: DashboardRecord[]; salesRecords: DashboardRecord[]; previousRecords: DashboardRecord[]; previousSalesRecords: DashboardRecord[]; metricIds: string[]; onManager: (manager: ManagerRow) => void }) {
  const previousMetrics = buildDashboardMetrics(previousRecords, previousSalesRecords);
  const managers = buildManagers(records, salesRecords);
  const metrics = buildDashboardMetrics(records, salesRecords);
  const selected = resolveHeadlineCardIds(metricIds);
  const money = (value: number) => `${Math.round(value).toLocaleString("uz-UZ")} ${metrics.money.currency || "UZS"}`;
  const number = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString("uz-UZ"));
  /**
   * One business question per card. Where a figure used to have a card of its
   * own it is now the secondary line of the card that answers the same
   * question — no formula changed, only where the number is shown.
   */
  const cards: Record<HeadlineCardId, { value: string; detail: React.ReactNode; tone: string; icon: typeof Activity }> = {
    leads: {
      value: String(metrics.counts.leads),
      detail: <><MetricDelta current={metrics.counts.leads} previous={previousMetrics.counts.leads} /> · routing chiqarilgan</>,
      tone: "blue", icon: Database },
    classified_leads: {
      value: String(metrics.counts.classified_leads),
      detail: <>{metrics.rates.classification_coverage}% Leadlardan<small className="card-note">{metrics.counts.unclassified_leads} ta saralanmagan</small></>,
      tone: "green", icon: ClipboardList },
    sql: {
      value: String(metrics.counts.sql),
      detail: <>{metrics.rates.quality_accepted_rate}% saralanganlardan<small className="card-note">Sifatli lead</small></>,
      tone: "green", icon: Check },
    not_relevant: {
      value: String(metrics.counts.not_relevant),
      detail: <>{metrics.rates.low_quality_rate}% saralanganlardan<small className="card-note">Sifatsiz lead</small></>,
      tone: "amber", icon: AlertTriangle },
    sales_lost: {
      value: String(metrics.counts.sales_lost),
      detail: `${metrics.rates.sales_lost}% SQL'dan`,
      tone: "red", icon: XCircle },
    cohort_sales: {
      value: `${metrics.counts.cohort_sales} ta`,
      detail: <>{money(metrics.money.cohort_revenue)}<small className="card-note">Tanlangan davrda kelgan leadlardan sotilganlari</small></>,
      tone: "green", icon: CircleDollarSign },
    period_sales: {
      value: `${metrics.counts.period_sales} ta`,
      detail: <>{money(metrics.money.revenue)}<small className="card-note"><MetricDelta current={metrics.counts.period_sales} previous={previousMetrics.counts.period_sales} /> · sotuv sanasi bo‘yicha</small></>,
      tone: "cyan", icon: CircleDollarSign },
    avg_check: {
      value: number(metrics.money.avg_check),
      detail: `Median: ${number(metrics.money.median_check)}`,
      tone: "indigo", icon: Gauge },
    lead_to_sql: {
      value: `${metrics.rates.lead_to_sql}%`,
      detail: <>Lead → SQL<small className="card-note">Lead → Sotuv {metrics.rates.lead_to_sale}% · SQL → Sotuv {metrics.rates.sql_to_sale}%</small></>,
      tone: "green", icon: Check },
    avg_processing: {
      value: fmtMinutes(metrics.timing.avg_processing),
      detail: <>SLA {metrics.rates.sla}%<small className="card-note">{metrics.sla.onTime} / {metrics.sla.denominator} · muddati aniqlangan lead</small></>,
      tone: "indigo", icon: Clock3 },
    sales_cycle: {
      value: fmtHours(metrics.timing.sales_cycle),
      detail: "Lead kelganidan sotuvgacha",
      tone: "violet", icon: TimerReset },
    active_cohort: {
      value: String(metrics.counts.active_cohort),
      detail: "Tanlangan davrda kelib, hali yopilmagan",
      tone: "violet", icon: Layers3 },
  };
  return <>
    <section className="kpi-grid sales-kpis">
      {/* Driven by the saved order, not the registry order. */}
      {selected.map((id) => {
        const card = cards[id];
        return <KpiCard key={id} label={headlineCardLabel(id)} value={card.value} detail={card.detail} tone={card.tone} icon={card.icon} />;
      })}
    </section>
    <section className="panel"><SectionHeader title="Menejerlar performance" subtitle="Qatorni bossangiz dashboard shu menejer bo‘yicha filtrlanadi" /><ManagerTable rows={managers} limit={8} onSelect={onManager} /></section>
  </>;
}

/** Tooltip date labels, e.g. "18-avgust". */
const MONTHS_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

/**
 * Created-cohort trend. Bars are the selected metric per Tashkent day, the
 * faint line is a trailing 7-day average, and the small markers are the same
 * metric one period earlier aligned by relative day.
 *
 * Sales metrics are intentionally not offered here — see `lib/trend-series.ts`.
 */
function TrendChart({ records, previousRecords, bounds, previousBounds }: { records: DashboardRecord[]; previousRecords: DashboardRecord[]; bounds: TrendBounds | null; previousBounds: TrendBounds | null }) {
  const [metric, setMetric] = useState<TrendMetricId>(DEFAULT_TREND_METRIC);
  const definition = trendMetric(metric);
  const { points, hasPrevious } = useMemo(
    () => buildTrendSeries(records, previousRecords, metric, bounds ?? undefined, previousBounds ?? undefined),
    [records, previousRecords, metric, bounds, previousBounds],
  );
  const format = (value: number | null) => {
    if (value === null) return "—";
    if (definition.unit === "minutes") return fmtMinutes(value);
    if (definition.unit === "percent") return `${Math.round(value)}%`;
    return `${Math.round(value)} ta`;
  };
  const max = Math.max(1, ...points.map((point) => Math.max(point.value ?? 0, point.average ?? 0, point.previous ?? 0)));
  const height = (value: number | null) => trendBarHeight(value, max);
  /** Only the figures that explain the selected metric — nothing unrelated. */
  const tooltip = (point: TrendPoint) => {
    const day = `${Number(point.date.slice(8))}-${MONTHS_UZ[Number(point.date.slice(5, 7)) - 1]}`;
    const lines = [day, `${definition.label}: ${format(point.value)}`];
    if (definition.needsCoverage) {
      lines.push(`Saralangan: ${point.classified} / ${point.leads}`);
      lines.push(`Saralash qamrovi: ${point.coverage === null ? "—" : `${point.coverage}%`}`);
      if (point.immature) lines.push("Cohort hali to‘liq saralanmagan");
    }
    if (metric === "coverage") lines.push(`Saralangan: ${point.classified} / ${point.leads}`);
    if (metric === "sla") lines.push(`${point.slaOnTime} / ${point.slaDenominator}`);
    if (metric === "overdue") lines.push(`${point.overdueRate === null ? "—" : `${point.overdueRate}%`} leadlardan`);
    if (definition.unit === "minutes") lines.push(`${point.leads} ta lead`);
    if (point.value === null) lines.push("Ma’lumot yo‘q");
    if (point.previous !== null) lines.push(`Oldingi davr: ${format(point.previous)}`);
    return lines.join("\n");
  };
  const groups = [...new Set(TREND_METRICS.map((entry) => entry.group))];
  return <section className="panel"><SectionHeader
      title="Trend"
      subtitle={`Kunlik cohort — yaratilgan sana bo‘yicha · ${definition.label}${definition.unit === "percent" ? " (%)" : definition.unit === "minutes" ? " (vaqt)" : " (ta)"}`}
      action={<Select label="Trend metrikasi" value={metric} onChange={(value) => setMetric(value as TrendMetricId)}>
        {groups.map((group) => <optgroup key={group} label={group}>
          {TREND_METRICS.filter((entry) => entry.group === group).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </optgroup>)}
      </Select>} />
    <div className="trend-chart">{points.map((point) => (
      <div className={`trend-column${point.immature ? " immature" : ""}`} key={point.date} title={tooltip(point)}>
        {point.average !== null && <i className="trend-average" style={{ bottom: `${height(point.average)}%` }} />}
        {point.previous !== null && <i className="trend-previous" style={{ bottom: `${height(point.previous)}%` }} />}
        <span style={{ height: `${height(point.value)}%` }} className={point.value === null ? "trend-empty" : undefined} />
        <small>{point.date.slice(8)}</small>
      </div>
    ))}</div>
    <div className="trend-legend">
      <span><i className="swatch bar" />{definition.label}</span>
      {supportsMovingAverage(metric) && <span><i className="swatch avg" />7 kunlik o‘rtacha</span>}
      {hasPrevious && <span><i className="swatch prev" />Oldingi davr</span>}
      {definition.needsCoverage && <span><i className="swatch immature" />Cohort hali to‘liq saralanmagan</span>}
    </div>
    {!points.length && <div className="empty-chart">Trend uchun ma’lumot yo‘q.</div>}
  </section>;
}

/**
 * Individual seller profile.
 *
 * Reads INPUT → QUALITY → COHORT RESULT → PERIOD RESULT → WORKLOAD → CAUSES.
 * Every KPI comes from `buildManagerProfile`, which runs the same canonical
 * metric helper as the Dashboard and the manager table, so the numbers here
 * reconcile with the row that was clicked. The lower sections explain the top
 * rather than repeating it.
 */
function ManagerDetailView({ manager, cohortRecords, salesRecords, currentStages, onBack }: { manager: ManagerRow; cohortRecords: DashboardRecord[]; salesRecords: DashboardRecord[]; currentStages: CurrentStageRecord[] | null; onBack: () => void }) {
  const { cohort, metrics } = buildManagerProfile(cohortRecords, salesRecords, manager.id);
  // Lead share reconciles to every manager bucket, including unattributed
  // deals. Performance benchmarks compare real seller accounts only.
  const team = useMemo(() => buildManagers(cohortRecords, salesRecords), [cohortRecords, salesRecords]);
  const benchmarkTeam = team.filter((row) => row.id !== "unknown");
  const teamLeads = team.reduce((sum, row) => sum + row.leads, 0);

  const money = (value: number) => `${Math.round(value).toLocaleString("uz-UZ")} ${metrics.money.currency || "UZS"}`;
  const number = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString("uz-UZ"));
  /** Subtle team context. No score, no ranking — just where the median sits. */
  const benchmark = (value: number | null, median: number | null, unit: "pp" | "time", betterIsHigher: boolean) => {
    if (value === null || median === null) return null;
    if (unit === "time") {
      const label = value <= median ? "tezroq" : "sekinroq";
      return `Jamoa medianasi ${fmtMinutes(median)} · ${label}`;
    }
    const delta = Math.round(value - median);
    const sign = delta > 0 ? "+" : "";
    const good = betterIsHigher ? delta >= 0 : delta <= 0;
    return `Jamoa medianasi ${Math.round(median)}% · ${sign}${delta} p.p.${good ? "" : ""}`;
  };
  const withSql = (row: ManagerRow) => row.sql > 0;
  const medianSqlToSale = teamMedian(benchmarkTeam, (row) => row.sqlToSale, withSql);
  const medianSalesLostRate = teamMedian(benchmarkTeam, (row) => row.salesLostRate, withSql);
  const medianProcessing = teamMedian(benchmarkTeam, (row) => row.avgProcessing, (row) => row.avgProcessing !== null);
  const medianSla = teamMedian(benchmarkTeam, (row) => row.slaRate, (row) => row.slaDenominator > 0);
  const medianCycle = teamMedian(benchmarkTeam, (row) => row.salesCycleHours, (row) => row.salesCycleHours !== null);

  const active = currentStages?.filter((row) => (row.assignedManagerId || "unknown") === manager.id) ?? [];
  const stageRows = stageWorkloadRows(active);
  const notRelevant = notRelevantRecords(cohort);
  const salesLost = salesLostRecords(cohort);
  const notRelevantReasons = reasonBreakdown(notRelevant);
  const salesLostReasons = reasonBreakdown(salesLost);
  const sources = sourceFunnelRows(cohort);

  return <><div className="page-title manager-detail-title"><div><button className="back-button" onClick={onBack}><ArrowLeft size={16} />Menejerlarga qaytish</button><p className="eyebrow">INDIVIDUAL PERFORMANCE</p><h1>{manager.name}</h1><p>Nima berildi → qanday saralandi → qanday natija berdi → nima ochiq qoldi.</p></div><div className="manager-identity"><span>{manager.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><div><strong>{manager.name}</strong><small>{manager.id === "unknown" ? "Sotuvchi aniqlanmagan" : `Bitrix user #${manager.id}`}</small></div></div></div>

    <section className="kpi-grid sales-kpis">
      <KpiCard label="Leadlar" icon={Database} value={String(metrics.counts.leads)}
        detail={`${pct(metrics.counts.leads, teamLeads)}% jamoa leadlaridan`} />
      <KpiCard label="Saralangan" icon={ClipboardList} tone="green" value={String(metrics.counts.classified_leads)}
        detail={<>{metrics.counts.classified_leads} / {metrics.counts.leads} · {metrics.rates.classification_coverage}%<small className="card-note">{metrics.counts.unclassified_leads} ta saralanmagan</small></>} />
      <KpiCard label="SQL" icon={Check} tone="green" value={String(metrics.counts.sql)}
        detail={<>{metrics.rates.quality_accepted_rate}% saralanganlardan<small className="card-note">Sifatli lead</small></>} />
      <KpiCard label="Not Relevant" icon={AlertTriangle} tone="amber" value={String(metrics.counts.not_relevant)}
        detail={<>{metrics.rates.low_quality_rate}% saralanganlardan<small className="card-note">Sifatsiz lead · manba sifati</small></>} />
      <KpiCard label="Kelgan leadlardan sotuv" icon={CircleDollarSign} tone="green" value={`${metrics.counts.cohort_sales} ta`}
        detail={<>{metrics.rates.lead_to_sale}% Leadlardan<small className="card-note">{money(metrics.money.cohort_revenue)}</small></>} />
      <KpiCard label="SQL → Sotuv" icon={Check} tone="green" value={`${metrics.rates.sql_to_sale}%`}
        detail={<>{metrics.counts.cohort_sales} / {metrics.counts.sql} SQL<small className="card-note">{benchmark(metrics.rates.sql_to_sale, medianSqlToSale, "pp", true)}</small></>} />
      <KpiCard label="Sotilmadi" icon={XCircle} tone="red" value={String(metrics.counts.sales_lost)}
        detail={<>{metrics.rates.sales_lost}% SQL’dan<small className="card-note">{benchmark(metrics.rates.sales_lost, medianSalesLostRate, "pp", false)}</small></>} />
      <KpiCard label="Shu davrdagi sotuv" icon={CircleDollarSign} tone="cyan" value={`${metrics.counts.period_sales} ta`}
        detail={<>{money(metrics.money.revenue)}<small className="card-note">Sotuv sanasi bo‘yicha</small></>} />
      <KpiCard label="Aktiv leadlar" icon={Layers3} tone="violet" value={String(metrics.counts.active_cohort)}
        detail="Tanlangan davrda kelib, hali yopilmagan" />
      <KpiCard label="Saralash tezligi" icon={Clock3} tone="indigo" value={fmtMinutes(metrics.timing.avg_processing)}
        detail={<>SLA {metrics.rates.sla}% · {metrics.sla.onTime} / {metrics.sla.denominator}<small className="card-note">{metrics.sla.overdue} ta ishlov muddati o‘tgan · {benchmark(metrics.timing.avg_processing, medianProcessing, "time", false)}{medianSla === null ? "" : ` · jamoa SLA medianasi ${Math.round(medianSla)}%`}</small></>} />
      <KpiCard label="Savdo sikli" icon={TimerReset} tone="violet" value={fmtHours(metrics.timing.sales_cycle)}
        detail={<>Lead kelganidan sotuvgacha<small className="card-note">{medianCycle === null ? "" : `Jamoa medianasi ${fmtHours(medianCycle)}`}</small></>} />
    </section>

    <section className="panel"><SectionHeader title="Source funnel" subtitle="Tanlangan davrda kelgan leadlar bo‘yicha — davr sotuvi bu yerda ko‘rsatilmaydi" />
      <div className="table-wrap"><table className="data-table funnel-table"><thead><tr>
        <th className="sticky-col">Source</th><th>Leadlar</th><th>Saralangan</th><th>SQL</th><th>Not Relevant</th><th>Cohort sotuv</th><th title="Cohort sotuv / SQL">SQL → Sotuv</th><th title="Sotilmadi / SQL">Sotilmadi</th>
      </tr></thead><tbody>{sources.map((row) => <tr key={row.source}>
        <td className="sticky-col"><strong>{row.source}</strong></td>
        <td><strong>{row.leads}</strong></td>
        <td><strong>{row.classified}</strong><small>{row.coverage}%</small></td>
        <td><strong>{row.sql}</strong><small>{row.qualityAcceptedRate}% saralanganlardan</small></td>
        <td><strong className={row.notRelevant ? "warning-text" : ""}>{row.notRelevant}</strong><small>{row.lowQualityRate}%</small></td>
        <td><strong className="success-text">{row.cohortSales} · {row.leadToSale}%</strong><small>{money(row.cohortRevenue)}</small></td>
        <td><span className="pill success">{row.sqlToSale}%</span></td>
        <td><strong className={row.salesLost ? "danger-text" : ""}>{row.salesLost}</strong><small>{row.salesLostRate}% SQL’dan</small></td>
      </tr>)}</tbody></table>{!sources.length && <div className="empty-table">Source ma’lumoti yo‘q.</div>}</div>
    </section>

    <section className="dashboard-grid two-one">
      <article className="panel"><SectionHeader title="Joriy stage yuklamasi" subtitle="Bitrix’dagi joriy ochiq deal’lar" />
        <div className="stage-load-list">{stageRows.map((row) => <div key={row.stage}>
          <span>{row.stage}</span><strong>{row.active} ta</strong>
          <small className={row.overdue ? "danger-text" : ""}>{row.overdue} ta muddati o‘tgan · {row.overdueRate}%</small>
        </div>)}{!stageRows.length && <div className="empty-table">Aktiv lead yo‘q.</div>}</div>
      </article>
      <article className="panel compact-kpis"><SectionHeader title="Chek" />
        <div><span>O‘rtacha chek</span><strong>{number(metrics.money.avg_check)}</strong></div>
        <div><span>Median chek</span><strong>{number(metrics.money.median_check)}</strong></div>
        <div><span>Asos</span><strong>{metrics.counts.period_sales} ta davr sotuv</strong></div>
      </article>
    </section>

    <section className="dashboard-grid split-even">
      <article className="panel"><SectionHeader title="Not Relevant sabablari" subtitle={`${notRelevant.length} ta Not Relevant · foizlar shu sondan`} />
        <BarList rows={notRelevantReasons.slice(0, 12).map((row) => ({ label: row.reason, value: row.count, total: notRelevant.length, color: "#f59e0b" }))} />
        {!notRelevantReasons.length && <div className="empty-table">Not Relevant yo‘q.</div>}
      </article>
      <article className="panel"><SectionHeader title="Sotilmadi sabablari" subtitle={`${salesLost.length} ta Sotilmadi · SQLgacha yopilganlar kirmaydi`} />
        <BarList rows={salesLostReasons.slice(0, 12).map((row) => ({ label: row.reason, value: row.count, total: salesLost.length, color: "#ef5962" }))} />
        {!salesLostReasons.length && <div className="empty-table">Sotilmadi yo‘q.</div>}
      </article>
    </section>
  </>;
}

/**
 * Incoming-load analytics.
 *
 * One heatmap, four modes. The point is not "when do leads arrive" but "when
 * do leads arrive AND processing quality drops", so volume and processing
 * quality share one grid the user can switch between. The daily created-cohort
 * trend lives on the Main Dashboard and is deliberately not repeated here.
 */
function LeadFlowView({ records }: { records: DashboardRecord[] }) {
  const [metric, setMetric] = useState<LeadFlowMetricId>(DEFAULT_LEAD_FLOW_METRIC);
  const flow = useMemo(() => buildLeadFlow(records), [records]);
  const definition = LEAD_FLOW_METRICS.find((entry) => entry.id === metric) ?? LEAD_FLOW_METRICS[0];
  const format = (value: number | null) => {
    if (value === null) return "—";
    if (definition.unit === "minutes") return fmtMinutes(value);
    if (definition.unit === "percent") return `${Math.round(value)}%`;
    return String(Math.round(value));
  };
  const values = flow.cells.map((cell) => leadFlowValue(cell, metric)).filter((value): value is number => value !== null);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  /** Intensity always means "more pressure", so SLA is inverted: low SLA burns. */
  const intensity = (value: number | null) => {
    if (value === null) return 0;
    const span = Math.max(1, max - min);
    const ratio = (value - min) / span;
    return higherIsHealthier(metric) ? 1 - ratio : ratio;
  };
  const palette = metric === "volume" ? "36, 107, 253" : metric === "sla" ? "239, 89, 98" : metric === "avg_processing" ? "245, 158, 11" : "239, 89, 98";
  const groups = [...new Set(LEAD_FLOW_METRICS.map((entry) => entry.group))];
  const cellTooltip = (cell: (typeof flow.cells)[number]) => {
    const head = `${WEEKDAY_LABELS[cell.weekday]} · ${bucketLabel(cell.bucket)}`;
    const lines = [head, `Leadlar: ${cell.leads} ta`, `Jami oqimdan: ${cell.share}%`];
    if (metric === "overdue_rate") lines.push(`Muddati o‘tgan: ${cell.overdue}`, `Overdue rate: ${cell.overdueRate === null ? "—" : `${cell.overdueRate}%`}`);
    if (metric === "sla") lines.push(`SLA: ${cell.slaRate === null ? "—" : `${cell.slaRate}%`}`, `${cell.slaOnTime} / ${cell.slaDenominator} SLA ichida`);
    if (metric === "avg_processing") lines.push(`Avg saralash: ${fmtMinutes(cell.avgProcessing)}`, `Ishlov ma’lum: ${cell.processingKnown} ta`);
    return lines.join("\n");
  };
  const rateOf = (value: number | null) => (value === null ? "—" : `${value}%`);

  return <><div className="page-title"><div><p className="eyebrow">STAFFING ANALYTICS</p><h1>Lead oqimi va capacity</h1><p>Qachon oqim ko‘payadi va aynan o‘sha paytda ishlov sifati tushadimi — bitta jadvalda.</p></div></div>

    <section className="kpi-grid">
      <KpiCard label="Peak vaqt" icon={Clock3} tone="indigo" value={flow.peakBucket?.label ?? "—"}
        detail={flow.peakBucket ? `${flow.peakBucket.leads} ta lead · jami leadlarning ${Math.round(flow.peakBucket.share)}%` : "Ma’lumot yo‘q"} />
      <KpiCard label="Eng band kun" icon={CalendarDays} tone="blue" value={flow.busiestWeekday?.label ?? "—"}
        detail={flow.busiestWeekday ? `${flow.busiestWeekday.leads} ta lead · jami oqimning ${Math.round(flow.busiestWeekday.share)}%` : "Ma’lumot yo‘q"} />
      <KpiCard label="After-hours" icon={TimerReset} tone="amber" value={`${Math.round(flow.afterHours.share)}%`}
        detail={`${flow.afterHours.leads} ta lead · sozlangan ish vaqti bo‘yicha`} />
      <KpiCard label="Peak workload riski" icon={AlertTriangle} tone="red"
        value={`${flow.peakRisk.overdue} ta · ${rateOf(flow.peakRisk.overdueRate)}`}
        detail={<>Muddati o‘tgan / Leadlar<small className="card-note">Top-3 peak vaqt oralig‘ida · {flow.peakRisk.leads} ta lead</small></>} />
    </section>

    <section className="panel"><SectionHeader
        title="Hafta kuni × 2 soat heatmap"
        subtitle={`${definition.label}${definition.unit === "percent" ? " (%)" : definition.unit === "minutes" ? " (vaqt)" : " (ta)"} · vaqt Asia/Tashkent · routing hisobga olinmaydi`}
        action={<Select label="Ko‘rsatkich" value={metric} onChange={(value) => setMetric(value as LeadFlowMetricId)}>
          {groups.map((group) => <optgroup key={group} label={group}>
            {LEAD_FLOW_METRICS.filter((entry) => entry.group === group).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </optgroup>)}
        </Select>} />
      <div className="heatmap-wrap">
        <div className="heatmap-head"><span />{Array.from({ length: BUCKET_COUNT }, (_, bucket) => <small key={bucket}>{String(bucket * 2).padStart(2, "0")}:00</small>)}</div>
        {WEEKDAY_LABELS.map((label, weekday) => <div className="heatmap-row" key={label}>
          <strong>{label.slice(0, 3)}</strong>
          {flow.cells.filter((cell) => cell.weekday === weekday).map((cell) => {
            const value = leadFlowValue(cell, metric);
            const alpha = value === null ? 0.04 : 0.12 + intensity(value) * 0.8;
            return <span key={cell.bucket} title={cellTooltip(cell)}
              style={{ backgroundColor: `rgba(${palette}, ${alpha})`, color: alpha > 0.55 ? "white" : "#526078" }}>
              {format(value)}
            </span>;
          })}
        </div>)}
      </div>
      <div className="trend-legend">
        <span><i className="swatch bar" style={{ background: `rgba(${palette}, .85)` }} />{definition.label} — {higherIsHealthier(metric) ? "to‘q rang = SLA past · och rang = SLA yuqori" : "to‘q rang = yuklama/bosim yuqori"}</span>
        <span><i className="swatch prev" />— · ma’lumot yo‘q</span>
      </div>
    </section>

    <section className="panel"><SectionHeader title="Staffing signallari" subtitle="Tanlangan davrdagi real oqimdan hisoblandi · tavsiya emas, signal" />
      <div className="signal-list">
        {flow.staffingSignals.map((signal) => <div key={signal.id}>
          <strong>{signal.id === "peak_bucket" ? `${signal.label} — eng katta oqim`
            : signal.id === "busiest_weekday" ? `${signal.label} — eng band kun`
              : `After-hours: ${Math.round(signal.stats.share)}%`}</strong>
          <small>{signal.stats.leads} ta lead · {signal.id === "after_hours" ? "sozlangan ish vaqtidan tashqari" : `jami oqimning ${Math.round(signal.stats.share)}%`}
            {` · muddati o‘tgan ${signal.stats.overdue} ta / ${rateOf(signal.stats.overdueRate)}`}</small>
        </div>)}
      </div>
      {!flow.total && <div className="empty-table">Tanlangan filtr bo‘yicha lead yo‘q.</div>}
    </section>
  </>;
}

function DealsTable({ records }: { records: DashboardRecord[] }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"createdAt" | "processingBusinessMinutes">("createdAt");
  const perPage = 20;
  const sorted = useMemo(() => [...records].sort((a, b) => sort === "createdAt" ? b.createdAt.localeCompare(a.createdAt) : Number(a.processingBusinessMinutes ?? Infinity) - Number(b.processingBusinessMinutes ?? Infinity)), [records, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const safePage = Math.min(page, pages);
  const rows = sorted.slice((safePage - 1) * perPage, safePage * perPage);
  function exportCsv() {
    const headers = ["Deal ID", "Deal nomi", "Yaratilgan vaqt", "Deal mas’uli", "Sales pipeline", "Current pipeline", "Current stage", "Stage age hours", "Stage limit hours", "Sales status", "SQL at", "Sales manager", "Seller attribution", "Won at", "Sales cycle hours", "Opportunity", "Currency", "Failure group", "Failure reason", "Source", "Duplicate of", "First processing at", "Processing source", "Processing business minutes", "SLA status"];
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines: unknown[][] = [headers, ...sorted.map((row) => [row.dealId, row.title, row.createdAt, row.assignedManager, row.originPipeline, row.pipeline, row.stage, row.stageAgeHours, row.stageLimitHours, row.salesStatus, row.qualifiedAt, row.salesManager, row.salesManagerAttribution, row.wonAt, row.salesCycleHours, row.opportunity, row.currencyId, row.lossReasonGroup, row.lossReason, row.source, row.duplicateOfDealId, row.processingAt, row.processingSource, row.processingBusinessMinutes, row.slaStatus])];
    const blob = new Blob(["\ufeff", lines.map((line) => line.map(quote).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `bitrix-deals-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="panel deals-panel"><SectionHeader title="Detailed Deal report" subtitle={`${records.length} ta Deal`} action={<div className="table-actions"><Select label="Saralash" value={sort} onChange={(value) => setSort(value as typeof sort)}><option value="createdAt">Yangi Deal</option><option value="processingBusinessMinutes">Eng tez obrabotka</option></Select><button className="button small secondary" onClick={exportCsv}><Download size={16} />CSV export</button></div>} />
    <div className="table-wrap"><table className="data-table deal-table"><thead><tr><th>Deal</th><th>Sotuv holati</th><th>Mas’ul / sotuvchi</th><th>Pipeline / Stage</th><th>Stage yoshi</th><th>Source / sabab</th><th>Birinchi ishlov</th><th>SLA</th></tr></thead><tbody>{rows.map((row) => { const outcome = dealOutcomeLabel(row); return <tr key={row.dealId}>
      <td><div className="deal-name"><strong>{row.title}</strong>{row.bitrixUrl ? <a href={row.bitrixUrl} target="_blank" rel="noreferrer">#{row.dealId}<ExternalLink size={12} /></a> : <small>#{row.dealId}</small>}</div></td>
      <td><span className={`pill ${outcome.tone}`}>{outcome.label}</span><small>{row.wonAt ? fmtDate(row.wonAt) : fmtDate(row.createdAt)}{row.duplicateOfDealId ? ` · duplicate #${row.duplicateOfDealId}` : ""}</small></td>
      <td><span>{row.salesManager ?? "Aniqlanmagan"}</span><small>{row.salesManagerAttribution} · hozir: {row.assignedManager}</small></td><td><span>{row.originPipeline}</span><small>{row.stage}{row.qualifiedAt ? ` · SQL ${fmtDate(row.qualifiedAt)}` : ""}</small></td>
      <td><span className={row.stageOverdue ? "danger-text" : ""}>{Math.round(row.stageAgeHours)} soat</span><small>Limit: {row.stageLimitHours} soat</small></td>
      <td><span>{row.source}</span><small>{row.lossReasonGroup !== "NONE" ? `${row.lossReasonGroup} · ${row.lossReason}` : row.lossReason || "—"}</small></td>
      <td><span className="source-pill">{row.processingSource === "QUALIFICATION_STAGE" ? "✅ Ishlov" : row.processingSource === "NO_PROCESSING_EVIDENCE" ? "❔ Noma’lum" : "⚠️ Yo‘q"}</span><small>{fmtMinutes(row.processingBusinessMinutes)}</small></td>
      <td><span className={`pill ${SLA_TONES[row.slaStatus]}`}>{SLA_LABELS[row.slaStatus]}</span></td>
    </tr>; })}</tbody></table>{!rows.length && <div className="empty-table">Tanlangan filtr bo‘yicha Deal topilmadi.</div>}</div>
    <div className="pagination"><span>{safePage} / {pages} sahifa</span><div><button disabled={safePage <= 1} onClick={() => setPage((value) => value - 1)}>Oldingi</button><button disabled={safePage >= pages} onClick={() => setPage((value) => value + 1)}>Keyingi</button></div></div>
  </section>;
}

function groupedCount<T>(records: T[], key: (row: T) => string) {
  const counts = new Map<string, number>();
  for (const row of records) { const label = key(row) || "Ko‘rsatilmagan"; counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

type QualitySortDirection = "asc" | "desc";
type MarketingQualitySort = "default" | "name" | "classified" | "notRelevant" | "notRelevantRate" | "topReasonShare" | "missingReasons" | "reasonFillRate";
type SalesQualitySort = "default" | "name" | "sql" | "salesLost" | "salesLostRate" | "sqlToSale" | "topReasonShare" | "missingReasons";

function qualityRate(value: number | null) { return value === null ? "—" : `${value}%`; }
function topReasonTitle(rows: { reason: string; count: number }[]) {
  return rows.length ? rows.map((row) => `${row.reason} — ${row.count}`).join(" · ") : "Sabab yo‘q";
}
function compareDiagnosticValues(a: string | number | null, b: string | number | null, direction: QualitySortDirection) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const compared = typeof a === "string" ? a.localeCompare(String(b)) : a - Number(b);
  return direction === "asc" ? compared : -compared;
}
function QualitySortButton({ label, active, direction, onClick, title }: { label: string; active: boolean; direction: QualitySortDirection; onClick: () => void; title?: string }) {
  return <button onClick={onClick} title={title}>{label}{active ? direction === "asc" ? " ↑" : " ↓" : ""}</button>;
}
function QualityManagerName({ row, onSelect }: { row: { id: string; name: string; isUnknown: boolean; smallSample: boolean }; onSelect: (id: string) => void }) {
  return <button className="quality-manager-name" onClick={(event) => { event.stopPropagation(); onSelect(row.id); }} title={`${row.name} profilini ochish`}>
    <strong>{row.name}</strong>
    {row.isUnknown ? <small>Atributsiya diagnostikasi</small> : row.smallSample ? <small className="sample-note">kam sample</small> : null}
  </button>;
}
function ReasonPanels({ marketing, sales }: { marketing: ReturnType<typeof buildQualityAnalytics>["marketingReasons"]; sales: ReturnType<typeof buildQualityAnalytics>["salesReasons"] }) {
  return <section className="quality-reasons">
    <article className="panel"><SectionHeader title="Marketing sifatsizligi sabablari" subtitle="Faqat canonical Not Relevant · ulush Not Relevant’dan" />{marketing.length ? <BarList rows={marketing.map((row) => ({ label: row.reason, value: row.count, total: marketing.reduce((sum, entry) => sum + entry.count, 0), color: "#f59e0b" }))} /> : <div className="empty-table">Not Relevant sababi yo‘q.</div>}</article>
    <article className="panel"><SectionHeader title="Sales’da sotilmagan sabablar" subtitle="Faqat canonical Sales Lost · ulush Sotilmadi’dan" />{sales.length ? <BarList rows={sales.map((row) => ({ label: row.reason, value: row.count, total: sales.reduce((sum, entry) => sum + entry.count, 0), color: "#ef5962" }))} /> : <div className="empty-table">Sales Lost sababi yo‘q.</div>}</article>
  </section>;
}

function MarketingQualityTable({ rows, onSelect }: { rows: MarketingManagerDiagnostic[]; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<MarketingQualitySort>("default");
  const [direction, setDirection] = useState<QualitySortDirection>("desc");
  const sorted = useMemo(() => {
    if (sort === "default") return rows;
    const value = (row: MarketingManagerDiagnostic): string | number | null => sort === "topReasonShare" ? row.topReason?.share ?? null : row[sort];
    return [...rows].sort((a, b) => compareDiagnosticValues(value(a), value(b), direction));
  }, [rows, sort, direction]);
  function setColumn(column: Exclude<MarketingQualitySort, "default">) {
    if (sort === column) setDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(column); setDirection(column === "name" ? "asc" : "desc"); }
  }
  const header = (label: string, column: Exclude<MarketingQualitySort, "default">, title?: string) =>
    <QualitySortButton label={label} active={sort === column} direction={direction} onClick={() => setColumn(column)} title={title} />;
  return <section className="panel"><SectionHeader title="Not Relevant — menejerlar kesimida" subtitle="Qaysi menejerda sifatsiz lead ulushi yuqori va eng asosiy sabab nima" />
    <div className="table-wrap"><table className="data-table quality-manager-table marketing-quality-table"><thead><tr>
      <th>{header("Menejer", "name")}</th><th>{header("Saralangan", "classified")}</th><th>{header("Not Relevant", "notRelevant")}</th>
      <th>{header("NR %", "notRelevantRate", "Not Relevant / Saralangan")}</th><th>Top sabab</th><th>{header("Top sabab ulushi", "topReasonShare")}</th>
      <th>{header("Sababsiz", "missingReasons")}</th><th>{header("Reason fill %", "reasonFillRate")}</th>
    </tr></thead><tbody>{sorted.map((row) => <tr key={row.id} onClick={() => onSelect(row.id)} title={`${row.name} profilini ochish`}>
      <td><QualityManagerName row={row} onSelect={onSelect} /></td><td>{row.classified}</td><td><strong className={row.notRelevant ? "warning-text" : ""}>{row.notRelevant}</strong></td>
      <td>{qualityRate(row.notRelevantRate)}</td><td title={topReasonTitle(row.topReasons)}>{row.topReason ? <><strong>{row.topReason.reason} · {row.topReason.count}</strong></> : "—"}</td>
      <td>{row.topReason ? `${row.topReason.share}%` : "—"}</td><td>{row.missingReasons}</td><td>{qualityRate(row.reasonFillRate)}</td>
    </tr>)}</tbody></table>{!rows.length && <div className="empty-table">Menejer diagnostikasi uchun lead yo‘q.</div>}</div>
  </section>;
}

function SalesQualityTable({ rows, onSelect }: { rows: SalesManagerDiagnostic[]; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<SalesQualitySort>("default");
  const [direction, setDirection] = useState<QualitySortDirection>("desc");
  const sorted = useMemo(() => {
    if (sort === "default") return rows;
    const value = (row: SalesManagerDiagnostic): string | number | null => sort === "topReasonShare" ? row.topReason?.share ?? null : row[sort];
    return [...rows].sort((a, b) => compareDiagnosticValues(value(a), value(b), direction));
  }, [rows, sort, direction]);
  function setColumn(column: Exclude<SalesQualitySort, "default">) {
    if (sort === column) setDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(column); setDirection(column === "name" ? "asc" : "desc"); }
  }
  const header = (label: string, column: Exclude<SalesQualitySort, "default">, title?: string) =>
    <QualitySortButton label={label} active={sort === column} direction={direction} onClick={() => setColumn(column)} title={title} />;
  return <section className="panel"><SectionHeader title="Sotilmadi — menejerlar kesimida" subtitle="Qaysi sotuvchida SQL yo‘qotish ko‘p va eng asosiy sabab nima" />
    <div className="table-wrap"><table className="data-table quality-manager-table sales-quality-table"><thead><tr>
      <th>{header("Menejer", "name")}</th><th>{header("SQL", "sql")}</th><th>{header("Sotilmadi", "salesLost")}</th>
      <th>{header("Lost rate", "salesLostRate", "Sotilmadi / SQL")}</th><th>{header("SQL → Sotuv", "sqlToSale")}</th><th>Top sabab</th>
      <th>{header("Top sabab ulushi", "topReasonShare")}</th><th>{header("Sababsiz", "missingReasons")}</th>
    </tr></thead><tbody>{sorted.map((row) => <tr key={row.id} onClick={() => onSelect(row.id)} title={`${row.name} profilini ochish`}>
      <td><QualityManagerName row={row} onSelect={onSelect} /></td><td>{row.sql}</td><td><strong className={row.salesLost ? "danger-text" : ""}>{row.salesLost}</strong></td>
      <td>{qualityRate(row.salesLostRate)}</td><td>{qualityRate(row.sqlToSale)}</td><td title={topReasonTitle(row.topReasons)}>{row.topReason ? <strong>{row.topReason.reason} · {row.topReason.count}</strong> : "—"}</td>
      <td>{row.topReason ? `${row.topReason.share}%` : "—"}</td><td>{row.missingReasons}</td>
    </tr>)}</tbody></table>{!rows.length && <div className="empty-table">Menejer diagnostikasi uchun lead yo‘q.</div>}</div>
  </section>;
}

function QualityView({ records, onManager }: { records: DashboardRecord[]; onManager: (managerId: string) => void }) {
  const analytics = useMemo(() => buildQualityAnalytics(records), [records]);
  const { summary } = analytics;
  const topMarketing = summary.topMarketingReason;
  const topSales = summary.topSalesReason;
  return <><div className="page-title"><div><p className="eyebrow">LEAD QUALITY</p><h1>Lead sifati va yo‘qotish sabablari</h1><p>Marketing/manba sifati, seller closing va sabab intizomi alohida diagnostika qilinadi.</p></div></div>
    <section className="kpi-grid quality-kpis">
      <KpiCard label="Not Relevant" value={String(summary.notRelevant)} detail={<>{qualityRate(summary.notRelevantRate)} saralanganlardan<small className="card-note">Marketing / manba sifati</small></>} icon={AlertTriangle} tone="amber" />
      <KpiCard label="Saralash qamrovi" value={qualityRate(summary.classificationCoverage)} detail={<>{summary.classified} / {summary.leads} · Saralangan / Leadlar<small className="card-note">Saralanmagan: {summary.unclassified}</small></>} icon={Gauge} tone="blue" />
      <KpiCard label="Sotilmadi" value={String(summary.salesLost)} detail={<>{qualityRate(summary.salesLostRate)} SQL’dan<small className="card-note">Faqat canonical Sales Lost</small></>} icon={XCircle} tone="red" />
      <KpiCard label="Sababsiz yopilgan" value={String(summary.missingReasons)} detail={<>{qualityRate(summary.missingReasonRate)} · {summary.missingReasons} / {summary.missingReasonPopulation}<small className="card-note">NR + Sales Lost · sabab intizomi</small></>} icon={ClipboardList} tone="slate" />
      <KpiCard label="Top marketing muammo" value={topMarketing?.reason ?? "—"} valueClassName="reason-value" detail={topMarketing ? `${topMarketing.count} ta · ${topMarketing.share}% Not Relevant’dan` : "Not Relevant yo‘q"} icon={AlertTriangle} tone="amber" />
      <KpiCard label="Top sales yo‘qotish sababi" value={topSales?.reason ?? "—"} valueClassName="reason-value" detail={topSales ? `${topSales.count} ta · ${topSales.share}% Sotilmadi’dan` : "Sales Lost yo‘q"} icon={XCircle} tone="red" />
    </section>
    <ReasonPanels marketing={analytics.marketingReasons} sales={analytics.salesReasons} />
    <MarketingQualityTable rows={analytics.marketingManagers} onSelect={onManager} />
    <SalesQualityTable rows={analytics.salesManagers} onSelect={onManager} />
    <section className="panel routing-panel"><SectionHeader title="Routing" subtitle="Lead sifati va seller performance hisobiga kirmaydi" />
      <div className="routing-summary"><strong>{summary.routing} ta yo‘naltirilgan</strong>{analytics.routingReasons.length ? <BarList rows={analytics.routingReasons.map((row) => ({ label: row.reason, value: row.count, total: summary.routing, color: "#8a5dd1" }))} /> : <small>Routing yozuvi yo‘q.</small>}</div>
    </section>
  </>;
}

function ReconciliationBanner({ view }: { view: ReconciliationView }) {
  const [open, setOpen] = useState(false);
  const idList = (label: string, ids: string[], total: number) => ids.length
    ? <p><strong>{label}:</strong> {ids.slice(0, 40).join(", ")}{total > ids.length ? ` … (${total} tadan ${Math.min(40, ids.length)} tasi)` : ""}</p>
    : null;
  return <div className={`reconciliation-banner ${view.severity}`}>
    <div className="recon-head">
      {view.severity === "ok" ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}
      <div className="recon-primary">
        <strong>Bitrix joriy: {view.liveCount} ta ochiq deal</strong>
        <span className="recon-coverage">Analytics coverage: {view.matchedCount} / {view.liveCount}{view.coverage === null ? "" : ` · ${view.coverage}%`}</span>
        <small>Analytics tarix cache: {view.cachedCount} ta record — bu live hisob-kitobning maxraji emas.</small>
      </div>
    </div>
    <p className="recon-note">Joriy Stage nazorati Bitrix live snapshot’dan olinadi. Analytics cache farqi live Deal’larni bu sahifadan olib tashlamaydi.</p>
    {view.truncated && <p className="recon-alert"><AlertTriangle size={15} />Bitrix live snapshot to‘liq yuklanmadi — joriy sonlar ham to‘liq bo‘lmasligi mumkin.</p>}
    <div className="recon-chips">
      {view.expectedGap > 0 && <span className="pill neutral" title="Analytics tarix oynasidan oldin yaratilgan — kutilgan holat">{view.expectedGap} ta eski ochiq deal {view.historyDays ?? "—"} kunlik analytics tarixidan oldin yaratilgan</span>}
      {view.unexpectedGap > 0 && <span className="pill danger">{view.unexpectedGap} ta joriy deal history oynasi ichida, lekin analytics cache’da yo‘q</span>}
      {view.staleCount > 0 && <span className="pill danger">{view.staleCount} ta eskirgan cache yozuvi</span>}
      {view.stageMismatchCount > 0 && <span className="pill danger">{view.stageMismatchCount} ta stage farqi</span>}
      {view.severity === "ok" && <span className="pill success">Live snapshot ishonchli</span>}
    </div>
    {(view.missingCount || view.staleCount || view.stageMismatchCount) > 0 && <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>Farqli Deal ID’lar</summary>
      <div className="recon-details">
        {idList("History oynasidan eski", view.expectedGapDealIds, view.expectedGap)}
        {idList("History oynasi ichida yo‘q", view.unexpectedGapDealIds, view.unexpectedGap)}
        {idList("Eskirgan cache", view.staleDealIds, view.staleCount)}
        {idList("Stage farqi", view.stageMismatchDealIds, view.stageMismatchCount)}
      </div>
    </details>}
  </div>;
}

function StageMatrixCell({ cell }: { cell: MatrixCell }) {
  if (!cell.active) return <td className="matrix-cell empty">—</td>;
  const tone = cell.overdue ? (cell.overdueRate !== null && cell.overdueRate >= 50 ? "danger" : "warning") : "neutral";
  return <td className={`matrix-cell ${tone}`}>
    <strong>{cell.active}</strong>
    {cell.overdue > 0 && <small>{cell.overdue} overdue · {cell.overdueRate}%</small>}
  </td>;
}

function OverdueList({ rows, catalog, managers }: { rows: CurrentStageRecord[]; catalog: StageCatalogEntry[]; managers: { id: string; name: string }[] }) {
  const [manager, setManager] = useState(""); const [stage, setStage] = useState(""); const [search, setSearch] = useState("");
  const [sort, setSort] = useState<OverdueSort>("overrun"); const [page, setPage] = useState(0);
  const filtered = useMemo(() => buildOverdueRows(rows, { manager, stage, search }, sort), [rows, manager, stage, search, sort]);
  const total = rows.filter((row) => row.stageOverdue).length;
  const perPage = 20;
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * perPage, current * perPage + perPage);
  return <section className="panel">
    <SectionHeader title="Limitdan oshgan Deal’lar" subtitle={`${total} ta overdue · filtrdan keyin ${filtered.length} ta · ${pages} sahifa`} />
    <div className="overdue-controls">
      <Select label="Menejer" value={manager} onChange={(value) => { setManager(value); setPage(0); }}>
        <option value="">Barcha menejerlar</option>
        {managers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
      </Select>
      <Select label="Stage" value={stage} onChange={(value) => { setStage(value); setPage(0); }}>
        <option value="">Barcha stage’lar</option>
        {catalog.map((row) => <option key={row.key} value={row.key}>{row.name}</option>)}
      </Select>
      <Select label="Tartib" value={sort} onChange={(value) => { setSort(value as OverdueSort); setPage(0); }}>
        <option value="overrun">Limitdan eng ko‘p oshgan</option>
        <option value="age">Eng eski stage</option>
        <option value="ratio">Limitga nisbatan</option>
      </Select>
      <label className="search-box"><Search size={14} aria-hidden="true" />
        <input placeholder="Deal ID, nom yoki menejer" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
      </label>
    </div>
    <div className="table-wrap">
      <table className="data-table overdue-table">
        <thead><tr><th>Deal</th><th>Menejer</th><th>Stage</th><th>Stage’da</th><th>Limit</th><th>Limitdan</th><th>Nisbat</th></tr></thead>
        <tbody>{shown.map((row) => <tr key={row.dealId}>
          <td><a href={row.bitrixUrl ?? undefined} target="_blank" rel="noreferrer" className="deal-link"><strong>{row.title}</strong><small>#{row.dealId}</small></a></td>
          <td>{row.assignedManager || "Aniqlanmagan"}</td>
          <td>{row.stage}</td>
          <td title={`${Math.round(row.stageAgeHours)} soat`}>{humanDuration(row.stageAgeHours)}</td>
          <td title={`${row.stageLimitHours} soat`}>{humanDuration(row.stageLimitHours)}</td>
          <td className="overrun" title={`${Math.round(row.overrunHours)} soat`}>+{humanDuration(row.overrunHours)}</td>
          <td>{row.ratio === null ? "—" : `${row.ratio.toFixed(1)}×`}</td>
        </tr>)}</tbody>
      </table>
      {!filtered.length && <div className="empty-table">{total ? "Filtrga mos overdue Deal yo‘q." : "Limitdan oshgan aktiv Deal yo‘q."}</div>}
    </div>
    {pages > 1 && <div className="pager">
      <button className="button secondary" onClick={() => setPage(Math.max(0, current - 1))} disabled={current === 0}>Oldingi</button>
      <span>{current + 1} / {pages} · {filtered.length} tadan {shown.length} tasi</span>
      <button className="button secondary" onClick={() => setPage(Math.min(pages - 1, current + 1))} disabled={current >= pages - 1}>Keyingi</button>
    </div>}
  </section>;
}

function StageControlView({ records, historicalRecords, reconciliation, stageCatalog, truncated, settings, loading, error, onRefresh, funnelStatus, onRetryFunnel }: { records: CurrentStageRecord[]; historicalRecords: StageFunnelRecord[]; reconciliation: StageReconciliation | null; stageCatalog: PipelineStageOption[]; truncated: boolean; settings: DashboardSettings | null; loading: boolean; error: string | null; onRefresh: () => void; funnelStatus: StageFunnelStatus; onRetryFunnel: () => void }) {
  const pipelineNames = useMemo(() => new Map((settings?.selectedPipelineIds ?? []).map((id, index) => [String(id), settings?.selectedPipelineNames?.[index] ?? `Pipeline #${id}`])), [settings]);
  const liveCatalog = useMemo(() => buildStageCatalog({ catalog: stageCatalog, live: records, pipelineNames }), [stageCatalog, records, pipelineNames]);
  const historyCatalog = useMemo(() => buildStageCatalog({ catalog: stageCatalog, historical: historicalRecords, pipelineNames }), [stageCatalog, historicalRecords, pipelineNames]);
  const summary = useMemo(() => buildSummary(records, liveCatalog), [records, liveCatalog]);
  const matrix = useMemo(() => buildManagerMatrix(records, liveCatalog), [records, liveCatalog]);
  const health = useMemo(() => buildStageHealth(records, liveCatalog), [records, liveCatalog]);
  const historical = useMemo(() => buildHistorical(historicalRecords, historyCatalog, settings ?? {}), [historicalRecords, historyCatalog, settings]);
  const reconView = useMemo(() => buildReconciliationView(reconciliation, { truncated }), [reconciliation, truncated]);
  // Only stages that actually carry live deals become matrix columns, so an
  // untouched closed stage (Оплата получена is CLOSED=Y) cannot widen the grid.
  const columns = useMemo(() => liveCatalog.filter((stage) => records.some((row) => stageKey(row.categoryId, row.stageId) === stage.key)), [liveCatalog, records]);
  const managers = useMemo(() => matrix.map((row) => ({ id: row.managerId, name: row.manager })), [matrix]);

  return <><div className="page-title"><div><p className="eyebrow">PIPELINE CONTROL</p><h1>Stage nazorati</h1><p>Bitrix’dagi joriy ochiq deal’lar. <strong>Joriy stage sana filtriga bog‘liq emas</strong> — 400 kun oldin ochilgan deal ham shu yerda qoladi.</p></div><button className="button secondary" onClick={onRefresh} disabled={loading}>{loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}Joriy holatni yangilash</button></div>
    {loading && !reconciliation && <div className="notice page-notice"><Loader2 size={17} className="spin" />Bitrix’dagi joriy stage’lar olinmoqda…</div>}
    {error && <div className="notice warning page-notice"><AlertTriangle size={17} /><span>Bitrix live snapshot olinmadi: {error}. Vaqtincha oxirgi sync bazasi ko‘rsatilmoqda.</span></div>}
    {reconView && <ReconciliationBanner view={reconView} />}

    <p className="scope-flag live">Bitrix live · hozir</p>
    <section className="kpi-grid stage-kpis">
      <KpiCard label="Joriy aktiv lead" value={String(summary.active)} detail={<>{reconciliation ? "Bitrix live snapshot" : "Oxirgi sync bazasi"}<small className="card-note">Yaratilgan sana bo‘yicha cheklanmagan</small></>} icon={Layers3} />
      <KpiCard label="Limitdan oshgan" value={String(summary.overdue)} detail={<>{summary.overdue} / {summary.active}{summary.overdueRate === null ? "" : ` · ${summary.overdueRate}%`}<small className="card-note">Sozlangan stage limitlari bo‘yicha</small></>} icon={AlertTriangle} tone="red" />
      <KpiCard label="Eng ko‘p yuklangan stage" value={summary.busiest?.name ?? "—"} valueClassName="reason-value" detail={summary.busiest ? <>{summary.busiest.active} ta · aktiv leadlarning {summary.busiest.share}%<small className="card-note">{summary.busiest.overdue} ta overdue{summary.busiest.overdueRate === null ? "" : ` · ${summary.busiest.overdueRate}%`}</small></> : "Aktiv lead yo‘q"} icon={Layers3} tone="blue" />
      <KpiCard label="Eng uzoq turib qolgan" value={humanDuration(summary.oldest?.stageAgeHours ?? null)} detail={summary.oldest ? <span title={`${Math.round(summary.oldest.stageAgeHours)} soat · limit ${summary.oldest.stageLimitHours} soat`}>{summary.oldest.title}<small className="card-note">{summary.oldest.assignedManager || "Aniqlanmagan"} · {summary.oldest.stage}</small></span> : "—"} icon={Clock3} tone="amber" />
    </section>

    <section className="panel"><SectionHeader title="Sotuvchi × joriy stage" subtitle="Bitrix’dagi hozirgi ochiq Deal’lar · stage tartibi Bitrix funnel bo‘yicha" />
      <div className="table-wrap"><table className="data-table stage-matrix">
        <thead><tr><th className="sticky-col">Sotuvchi</th>{columns.map((stage) => <th key={stage.key}>{stage.name}{stage.legacy ? <small className="legacy-tag">legacy</small> : null}</th>)}<th>Jami</th><th>Overdue</th><th>Overdue %</th></tr></thead>
        <tbody>{matrix.map((row) => <tr key={row.managerId}>
          <td className="sticky-col"><strong>{row.manager}</strong>{row.isUnknown ? <small>Atributsiya diagnostikasi</small> : null}</td>
          {columns.map((stage) => {
            const cell = row.cells.find((entry) => entry.key === stage.key) ?? { key: stage.key, active: 0, overdue: 0, overdueRate: null };
            return <td key={stage.key} className="matrix-slot" title={`${stage.name}\n${cell.active} ta aktiv\n${cell.overdue} ta limitdan oshgan\n${cell.overdueRate === null ? "—" : `${cell.overdueRate}%`}`}><StageMatrixCell cell={cell} /></td>;
          })}
          <td><strong>{row.total}</strong></td>
          <td><span className={row.overdue ? "pill danger" : "pill neutral"}>{row.overdue}</span></td>
          <td>{row.overdueRate === null ? "—" : `${row.overdueRate}%`}</td>
        </tr>)}</tbody>
      </table></div>
      {!matrix.length && <div className="empty-table">Joriy ochiq Deal yo‘q.</div>}
    </section>

    <section className="panel"><SectionHeader title="Stage health" subtitle="Bitrix funnel tartibida · hajm emas, holat" />
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Stage</th><th>Aktiv</th><th>Ulushi</th><th>Overdue</th><th>Overdue %</th><th>Median stage yoshi</th><th>Limit</th></tr></thead>
        <tbody>{health.map((row) => <tr key={row.key} className={row.active ? "" : "muted-row"}>
          <td><strong>{row.name}</strong>{row.legacy ? <small className="legacy-tag">legacy</small> : null}</td>
          <td>{row.active}</td>
          <td>{row.share === null ? "—" : `${row.share}%`}</td>
          <td><span className={row.overdue ? "pill danger" : "pill neutral"}>{row.overdue}</span></td>
          <td>{row.overdueRate === null ? "—" : `${row.overdueRate}%`}</td>
          <td title={row.maxAgeHours === null ? undefined : `Eng eski: ${humanDuration(row.maxAgeHours)}`}>{humanDuration(row.medianAgeHours)}</td>
          <td>{row.limitConflict ? <span className="pill warning" title={`Turli limitlar: ${row.limits.join(", ")} soat`}>{row.limits.map((value) => humanDuration(value)).join(" / ")}</span> : humanDuration(row.limitHours)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <OverdueList rows={records} catalog={columns} managers={managers} />

    <p className="scope-flag history">Analytics stage history · import oralig‘i</p>
    <section className="panel"><SectionHeader title="Tarixiy pipeline progression" subtitle="Faqat progression bosqichlari · terminal outcome’lar bu jadvalda emas" />
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Stage</th><th>Kirgan</th><th>Keyingiga o‘tgan</th><th>Konversiya</th><th>Drop-off</th><th>Avg vaqt</th><th>Median vaqt</th></tr></thead>
        <tbody>{historical.progression.map((row) => <tr key={row.key}>
          <td><strong>{row.stage}</strong>{row.legacy ? <small className="legacy-tag">legacy</small> : null}</td>
          <td>{row.entered}</td><td>{row.advanced}</td>
          <td><span className="pill success">{row.conversion === null ? "—" : `${row.conversion}%`}</span></td>
          <td><span className={row.dropOff ? "pill danger" : "pill neutral"}>{row.dropOff}</span></td>
          <td>{fmtHours(row.avgHours)}</td><td>{fmtHours(row.medianHours)}</td>
        </tr>)}</tbody>
      </table>
      {funnelStatus === "loading" && !historical.progression.length && <div className="empty-table"><Loader2 size={16} className="spin" /> Stage tarixi yuklanmoqda…</div>}
      {funnelStatus === "error" && <div className="notice warning page-notice"><AlertTriangle size={17} /><span>Stage tarixi yuklanmadi. Bu — tarix yo‘q degani emas.</span><button className="button secondary" onClick={onRetryFunnel}><RefreshCw size={15} />Qayta urinish</button></div>}
      {funnelStatus !== "loading" && funnelStatus !== "error" && !historical.progression.length && <div className="empty-table">Stage history sync qilingandan keyin funnel ko‘rinadi.</div>}</div>
    </section>

    {Boolean(historical.total) && <section className="panel"><SectionHeader title="Tarixiy outcome’lar" subtitle="Canonical semantика bo‘yicha — stage yoki sabab matni bo‘yicha emas" />
      <div className="outcome-grid">{historical.outcomes.map((row) => <div key={row.key} className="outcome-cell">
        <span>{row.label}</span><strong>{row.count}</strong><small>{row.share === null ? "—" : `${row.share}%`}</small>
      </div>)}</div>
      <p className="outcome-note">Jami {historical.total} ta tarixiy Deal. Outcome — progression konversiyasi emas, shuning uchun ular yuqoridagi jadvalda ko‘rsatilmaydi.</p>
    </section>}
  </>;
}
function CoverageNotice({ records, filters }: { records: DashboardRecord[]; filters: Filters }) {
  const bounds = rangeBounds(filters);
  if (!bounds.from || !records.length) return null;
  const earliest = records.reduce((min, row) => (row.createdAt && row.createdAt < min ? row.createdAt : min), records[0].createdAt);
  if (!earliest) return null;
  const earliestDay = earliest.slice(0, 10);
  if (bounds.from >= earliestDay) return null;
  return <div className="notice warning page-notice"><AlertTriangle size={17} />
    <span>Tanlangan oraliq {bounds.from} dan boshlanadi, lekin sinxronlangan eng eski lead {earliestDay}. {bounds.from} — {earliestDay} oralig‘idagi kunlar bazada yo‘q, shuning uchun Leadlar, Saralangan va barcha sifat foizlari to‘liq emas.</span>
  </div>;
}

function ClassificationDiagnostics({ records }: { records: DashboardRecord[] }) {
  const routing = records.filter((row) => !isEligibleCohortDeal(row));
  const eligible = records.filter(isEligibleCohortDeal);
  const classified = eligible.filter(isClassifiedLead);
  const unclassified = eligible.filter(isUnclassifiedLead);
  const sql = eligible.filter((row) => row.qualified);
  const notRelevant = eligible.filter((row) => row.lossReasonGroup === "MARKETING");
  const preSql = eligible.filter(isPreSqlClosed);
  const conflicts = countClassificationConflicts(eligible);
  const stageRows = groupedCount(unclassified, (row) => row.stage || "Stage ko‘rsatilmagan");
  const rows: { label: string; value: string; hint: string }[] = [
    { label: "Xom cohort", value: String(records.length), hint: `${eligible.length} eligible + ${routing.length} routing` },
    { label: "Leadlar", value: String(eligible.length), hint: "Routing chiqarilgan" },
    { label: "Saralangan", value: String(classified.length), hint: `${sql.length} SQL + ${notRelevant.length} Not Relevant` },
    { label: "Saralanmagan", value: String(unclassified.length), hint: "Aktiv pre-SQL + SQLgacha yopilgan" },
    { label: "SQLgacha yopilgan", value: String(preSql.length), hint: "Sales’da yopilgan, SQL dalili yo‘q" },
    { label: "Saralash qamrovi", value: `${pct(classified.length, eligible.length)}%`, hint: "Saralangan / Leadlar" },
    { label: "Takroriy (xom cohort)", value: String(countDuplicates(records)), hint: "Routing ham kiradi — tarixiy ta’rif" },
    { label: "Takroriy (Leadlar ichida)", value: String(countDuplicates(eligible)), hint: "Leadlar bilan solishtirish uchun" },
  ];
  return <section className="panel"><SectionHeader title="Lead saralash diagnostikasi" subtitle="Xom cohort = Leadlar + Routing · Saralangan = Sifatli + Sifatsiz" />
    <div className="quality-grid">{rows.map((row) => <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong><small>{row.hint}</small></div>)}</div>
    {records.length !== eligible.length + routing.length && <div className="notice warning page-notice"><AlertTriangle size={17} /><span>Xom cohort Leadlar + Routing yig‘indisiga teng emas.</span></div>}
    {conflicts > 0 && <div className="notice warning page-notice"><AlertTriangle size={17} /><span>{conflicts} ta yozuv bir vaqtda ham Sifatli, ham Sifatsiz deb belgilangan. Saralangan = Sifatli + Sifatsiz tenglamasi shu yozuvlarda buziladi.</span></div>}
    {Boolean(unclassified.length) && <div className="table-wrap"><table className="data-table"><thead><tr><th>Saralanmagan stage</th><th>Soni</th><th>Saralanmaganlarning %</th></tr></thead><tbody>{stageRows.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.value}</td><td>{pct(row.value, unclassified.length)}%</td></tr>)}</tbody></table></div>}
    {Boolean(preSql.length) && <><SectionHeader title="SQLgacha yopilgan sabablar" subtitle="Sales’da yopilgan, lekin SQL bosqichiga yetmagan — workflow signali, KPI emas" /><div className="table-wrap"><table className="data-table"><thead><tr><th>Sabab</th><th>Soni</th><th>%</th></tr></thead><tbody>{groupedCount(preSql, (row) => row.lossReason || "Sabab ko‘rsatilmagan").slice(0, 12).map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.value}</td><td>{pct(row.value, preSql.length)}%</td></tr>)}</tbody></table></div></>}
  </section>;
}

function DiagnosticsView({ sync, records, reconciliation, settings }: { sync: SyncState; records: DashboardRecord[]; reconciliation: StageReconciliation | null; settings: DashboardSettings }) {
  // Calls are no longer a data source, so those API permissions are irrelevant.
  const permissions = [["Deal API", sync.permissions.deals], ["Stage history", sync.permissions.stageHistory], ["User API", sync.permissions.managers]];
  const quality = summarizeDataQuality(records);
  const readiness = stageConfigReadiness(settings);
  const conflicts = stageConfigConflicts(settings);
  const qualities: { label: string; hint: string; count: number }[] = [
    { label: "Sotuv vaqti aniqlanmagan", hint: "Sotuv hisoblangan, lekin aniq sotuv sanasi yo‘q", count: quality.wonWithoutSaleDate },
    { label: "Sotuvchi aniqlanmagan", hint: "Hech bir manbadan sotuvchi topilmadi", count: quality.missingSalesManager },
    { label: "Manager ID = 0", hint: "Atributsiya ma’nosi hali tasdiqlanmagan", count: quality.managerIdZero },
    { label: "Birinchi ishlov vaqti noma’lum", hint: "Tarix yetishmaydi — SLA’ga kirmaydi", count: quality.unknownProcessingTime },
    { label: "Stage history yo‘q", hint: "Deal uchun bosqich tarixi yuklanmagan", count: quality.missingStageHistory },
    { label: "Provala sababi yo‘q", hint: "Yopilgan lead’da Причина провала to‘ldirilmagan", count: quality.missingFailureReason },
    { label: "Sotuvchi joriy mas’uldan olindi", hint: "Eng zaif atributsiya manbai", count: quality.currentResponsibleFallback },
    { label: "Takroriy lead", hint: "Contact ID, keyin Company ID bo‘yicha", count: quality.duplicateLeads },
    { label: "Ma’lumot mavjud emas", hint: "Activity yoki stage history olinmagan", count: quality.dataUnavailable },
  ];
  return <><div className="page-title"><div><p className="eyebrow">ADMIN</p><h1>Diagnostika</h1><p>API ruxsatlari, call provider’lar va data quality nazorati.</p></div></div>
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Bitrix24 ruxsatlari" /><div className="permission-list">{permissions.map(([label, state]) => <div key={label}><StatusDot state={state ?? "error"} /><span>{label}</span><strong>{state === "ok" ? "Tayyor" : state === "warning" ? "Cheklangan" : "Tekshirish kerak"}</strong></div>)}</div></article>
      <article className="panel"><SectionHeader title="Data counts" /><div className="diagnostic-counts"><div><span>Deal</span><strong>{sync.counts.deals ?? records.length}</strong></div><div><span>Stage history</span><strong>{sync.counts.stageHistory ?? 0}</strong></div></div></article>
    </section>
    <ClassificationDiagnostics records={records} />
    <section className="panel"><SectionHeader title="Data quality" subtitle="O‘lchov uchun; bu sonlar hech qanday funnel ko‘rsatkichini o‘zgartirmaydi" /><div className="quality-grid">{qualities.map((row) => <div key={row.label}><span>{row.label}</span><strong>{row.count}</strong><small>{row.hint}</small></div>)}</div>
      {quality.wonWithoutSaleDate > 0 && <div className="notice warning page-notice"><AlertTriangle size={17} /><span>{quality.wonWithoutSaleDate} ta sotuv Cohort sotuvda hisoblanadi, lekin sotuv sanasi yo‘qligi uchun Davr sotuvi, summa, o‘rtacha chek va savdo sikliga kirmaydi.</span></div>}
    </section>
    <section className="panel"><SectionHeader title="Konfiguratsiya tayyorligi" subtitle="Bosqich nomi bo‘yicha zaxira aniqlash ishlaydi, shuning uchun bu xato emas — tayyorlik darajasi" />
      <div className={`field-discovery ${readiness.complete ? "ok" : "warning"}`}>Bosqich ID konfiguratsiyasi: {readiness.configured}/{readiness.total}{readiness.complete ? " — to‘liq" : `. Stage ID konfiguratsiyasi to‘liq emas: ${readiness.missing.join(", ")}`}</div>
      {conflicts.length > 0 && <div className="field-discovery warning">Bir bosqich bir nechta ma’noda: {conflicts.map((conflict) => `${conflict.stageId} (${conflict.groups.join(", ")})`).join("; ")}</div>}
      <div className="field-discovery ok">Oxirgi to‘liq sync talab qilinadi: avvalgi sprintlar tarixiy hisob-kitobni o‘zgartirdi. Sozlamalardan har bir Sales funnel uchun full sync’ni qo‘lda bajaring.</div>
    </section>
    {reconciliation && <section className="panel"><SectionHeader title="Bitrix ↔ analytics reconciliation" subtitle="Joriy ochiq deal’lar tarixiy sync bazasidan alohida tekshiriladi" /><div className="quality-grid reconciliation-grid"><div><span>Bitrix joriy</span><strong>{reconciliation.liveCount}</strong></div><div><span>Analytics cache</span><strong>{reconciliation.cachedCount}</strong></div><div><span>Cache’da yetishmaydi</span><strong>{reconciliation.missingCount}</strong></div><div><span>Cache’da eskirgan</span><strong>{reconciliation.staleCount}</strong></div><div><span>Stage farqi</span><strong>{reconciliation.stageMismatchCount}</strong></div></div></section>}
    {sync.safeError && <div className="notice error page-notice"><XCircle size={18} />{sync.safeError}</div>}
  </>;
}

type StageSemanticKey = "qualifiedStageIds" | "lowQualityStageIds" | "paymentStageIds" | "closedLostStageIds";
const stageSemanticFields: { key: StageSemanticKey; title: string; hint: string }[] = [
  { key: "qualifiedStageIds", title: "SQL bosqichi", hint: "Obrabotka — sifatli deb qabul qilingan lead" },
  { key: "lowQualityStageIds", title: "Not Relevant bosqichi", hint: "Marketing sifatsizligi; Sotilmadi’ga qo‘shilmaydi" },
  { key: "paymentStageIds", title: "Sotuv / To‘lov bosqichi", hint: "Bu bosqichga yetgan deal sotilgan hisoblanadi" },
  { key: "closedLostStageIds", title: "Sotilmadi bosqichi", hint: "Закрыто и нереализовано — sotuvda yo‘qotilgan" },
];

function StagePicker({ title, hint, stages, selected, onToggle }: { title: string; hint: string; stages: PipelineStageOption[]; selected: string[]; onToggle: (stageId: string, checked: boolean) => void }) {
  return <div className="stage-semantic-group">
    <div className="stage-semantic-head"><strong>{title}</strong><small>{hint}</small></div>
    <div className="sql-stage-options">{stages.map((stage) => <CheckCard key={`${stage.categoryId}:${stage.id}`}
      checked={selected.includes(stage.id)} onChange={(checked) => onToggle(stage.id, checked)}
      title={stage.name} meta={stage.id} />)}</div>
    {!stages.length && <small>Bitrix’dan bosqichlar yuklanmoqda…</small>}
  </div>;
}

const SETTINGS_TABS = [
  { id: "asosiy", label: "Asosiy" },
  { id: "funnel", label: "Funnel qoidalari" },
  { id: "dashboard", label: "Dashboard" },
  { id: "sla", label: "SLA va ish vaqti" },
  { id: "data", label: "Data va sinxronizatsiya" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** Compact readiness strip shown above every Settings tab. */
function ReadinessBar({ readiness, lastSyncAt }: { readiness: SettingsReadiness; lastSyncAt: string | null }) {
  const items = [
    { label: "Bosqich ma’nolari", value: `${readiness.stages.configured}/${readiness.stages.total}`, ok: readiness.stages.complete },
    { label: "Konfliktlar", value: String(readiness.conflicts.count), ok: readiness.conflicts.count === 0 },
    { label: "Proval sababi", value: `${readiness.failureReason.configured}/${readiness.failureReason.total}`, ok: readiness.failureReason.complete },
    { label: "Tarix oralig‘i", value: `${readiness.historyDays} kun`, ok: true },
    { label: "Avto sinxronizatsiya", value: readiness.autoSync.enabled ? `${readiness.autoSync.minutes} min` : "O‘chirilgan", ok: true },
    { label: "Oxirgi sinxronizatsiya", value: fmtDate(lastSyncAt), ok: true },
  ];
  return <div className="readiness-bar">{items.map((item) => (
    <div key={item.label} className={`readiness-item ${item.ok ? "ok" : "warning"}`}>
      <span>{item.label}</span><strong>{item.value}</strong>
    </div>
  ))}</div>;
}

/**
 * Dashboard card selection *and* order.
 *
 * `dashboardMetricIds` is the saved order, so this list is the dashboard's
 * running order rather than a set of checkboxes: dragging a row moves the card.
 * Drag uses the native HTML5 API — the list is short and flat, so a dependency
 * would buy nothing — and every move is also available from the Up/Down
 * buttons, which is what makes it usable without a pointer.
 */
function DashboardMetricOrder({ selected, onChange }: { selected: HeadlineCardId[]; onChange: (ids: HeadlineCardId[]) => void }) {
  const [dragging, setDragging] = useState<HeadlineCardId | null>(null);
  const [over, setOver] = useState<HeadlineCardId | null>(null);
  const label = (id: HeadlineCardId) => headlineCardLabel(id);
  // Only the curated headline cards are offered here; the diagnostics that were
  // folded into them keep their formulas and stay available elsewhere.
  const available = DASHBOARD_HEADLINE_CARD_IDS.filter((id) => !selected.includes(id));

  const move = (id: HeadlineCardId, offset: number) => {
    const from = selected.indexOf(id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= selected.length) return;
    const next = [...selected];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  };
  const dropOn = (target: HeadlineCardId) => {
    if (!dragging || dragging === target) return;
    const next = selected.filter((id) => id !== dragging);
    next.splice(next.indexOf(target), 0, dragging);
    onChange(next);
  };
  // Never leave the dashboard with no cards at all: the last one stays.
  const remove = (id: HeadlineCardId) => { if (selected.length > 1) onChange(selected.filter((entry) => entry !== id)); };

  return <section className="panel">
    <SectionHeader title="Dashboard ko‘rsatkichlari" subtitle="Kartalarni tanlang va tartibini o‘zgartiring. Ro‘yxatdagi tartib — dashboarddagi tartib. Hisoblash o‘zgarmaydi." />
    <ol className="metric-order" aria-label="Tanlangan kartalar tartibi">
      {selected.map((id, index) => (
        <li key={id}
          className={`metric-order-row${dragging === id ? " dragging" : ""}${over === id && dragging !== id ? " over" : ""}`}
          draggable
          onDragStart={() => setDragging(id)}
          onDragEnd={() => { setDragging(null); setOver(null); }}
          onDragOver={(event) => { event.preventDefault(); setOver(id); }}
          onDrop={(event) => { event.preventDefault(); dropOn(id); setDragging(null); setOver(null); }}>
          <span className="metric-order-handle" aria-hidden="true"><GripVertical size={15} /></span>
          <span className="metric-order-index">{index + 1}</span>
          <input type="checkbox" checked readOnly={selected.length === 1}
            aria-label={`${label(id)} kartasini o‘chirish`}
            onChange={() => remove(id)} />
          <span className="metric-order-label">{label(id)}</span>
          <span className="metric-order-actions">
            <button type="button" aria-label={`${label(id)} — yuqoriga`} disabled={index === 0}
              onClick={() => move(id, -1)}><ChevronUp size={15} /></button>
            <button type="button" aria-label={`${label(id)} — pastga`} disabled={index === selected.length - 1}
              onClick={() => move(id, 1)}><ChevronDown size={15} /></button>
          </span>
        </li>
      ))}
    </ol>
    {Boolean(available.length) && <>
      <SectionHeader title="Ko‘rsatilmayotgan kartalar" subtitle="Belgilansa, ro‘yxat oxiriga qo‘shiladi" />
      <div className="metric-options">{available.map((id) => (
        <CheckCard key={id} checked={false} title={headlineCardLabel(id)}
          onChange={() => onChange([...selected, id])} />
      ))}</div>
    </>}
  </section>;
}

function SettingsView({ settings, syncing, lastSyncAt, onSave, onFullSync, onDirtyChange }: {
  settings: DashboardSettings; syncing: boolean; lastSyncAt: string | null;
  onSave: (settings: DashboardSettings) => Promise<void>;
  onFullSync: (settings: DashboardSettings, pipelineId: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => normalizeSettings(settings)); const [holiday, setHoliday] = useState("");
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>("asosiy");
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]); const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [fields, setFields] = useState<CrmFieldOption[]>([]); const [stages, setStages] = useState<PipelineStageOption[]>([]);
  // Every array below is guaranteed by normalizeSettings, so no view needs a guard.
  const [customFieldCount, setCustomFieldCount] = useState(0);
  const days = [[1, "Dushanba"], [2, "Seshanba"], [3, "Chorshanba"], [4, "Payshanba"], [5, "Juma"], [6, "Shanba"], [0, "Yakshanba"]] as const;
  useEffect(() => {
    void fetch("/api/pipelines", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { pipelines?: PipelineOption[]; selectedIds?: string[]; reportingIds?: string[]; fields?: CrmFieldOption[]; customFieldCount?: number; detectedFailureReasonField?: string | null; stages?: PipelineStageOption[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Pipeline’lar yuklanmadi");
      const options = Array.isArray(payload.pipelines) ? payload.pipelines : [];
      setPipelines(options);
      const loadedFields = normalizeCrmFields(payload.fields); const loadedStages = Array.isArray(payload.stages) ? payload.stages : [];
      setFields(loadedFields); setCustomFieldCount(payload.customFieldCount ?? 0); setStages(loadedStages);
      setDraft((current) => {
        const visibleStageIds = new Set(loadedStages.map((stage) => stage.id));
        const keptQualified = current.qualifiedStageIds.filter((id) => visibleStageIds.has(id));
        const detectedSql = loadedStages.filter((stage) => /^(обработка|obrabotka|processing|sql)$/i.test(stage.name.trim())).map((stage) => stage.id);
        const knownField = current.failureReasonField && loadedFields.some((field) => field.key === current.failureReasonField)
          ? current.failureReasonField
          : payload.detectedFailureReasonField ?? null;
        return { ...current, qualifiedStageIds: keptQualified.length ? keptQualified : detectedSql, failureReasonField: knownField };
      });
      if (!settings.selectedPipelineIds.length && payload.selectedIds?.length) {
        const selected = options.filter((item) => payload.selectedIds?.includes(item.id));
        setDraft((current) => ({ ...current, selectedPipelineIds: selected.map((item) => item.id), selectedPipelineNames: selected.map((item) => item.name) }));
      }
      if (!settings.postSalePipelineIds.length && payload.reportingIds?.length) {
        const selected = options.filter((item) => payload.reportingIds?.includes(item.id));
        setDraft((current) => ({ ...current, postSalePipelineIds: selected.map((item) => item.id), postSalePipelineNames: selected.map((item) => item.name) }));
      }
    }).catch((caught) => setPipelineError(caught instanceof Error ? caught.message : "Pipeline’lar yuklanmadi"));
  }, [settings.selectedPipelineIds.length, settings.postSalePipelineIds.length]);

  const normalizeName = (name: string) => name.toLocaleLowerCase().replace(/[^a-zа-яё0-9]+/gi, " ").trim();
  const brandOf = (name: string) => normalizeName(name).includes("ibox") ? "ibox" : /(^| )sd( |$)/.test(normalizeName(name)) ? "sd" : null;
  const salesPipelines = pipelines.filter((pipeline) => {
    const name = normalizeName(pipeline.name);
    return draft.selectedPipelineIds.includes(pipeline.id) || (Boolean(brandOf(pipeline.name)) && /(^| )sales( |$)/.test(name) && !/(обуч|сопров|obuch|training|support)/.test(name));
  });
  const postSaleCandidates = pipelines.filter((pipeline) => /(обуч|сопров|obuch|training|support|onboard)/.test(normalizeName(pipeline.name)));
  const pairFor = (pipeline: PipelineOption) => postSaleCandidates.find((candidate) => brandOf(candidate.name) === brandOf(pipeline.name)) ?? null;
  function togglePipeline(pipeline: PipelineOption, checked: boolean) {
    const selected = checked
      ? [...pipelines.filter((item) => draft.selectedPipelineIds.includes(item.id)), pipeline]
      : pipelines.filter((item) => draft.selectedPipelineIds.includes(item.id) && item.id !== pipeline.id);
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()].slice(0, 2);
    const paired = unique.flatMap((item) => { const match = pairFor(item); return match ? [match] : []; });
    setDraft({
      ...draft,
      selectedPipelineIds: unique.map((item) => item.id), selectedPipelineNames: unique.map((item) => item.name),
      postSalePipelineIds: paired.map((item) => item.id), postSalePipelineNames: paired.map((item) => item.name),
    });
  }

  const savedSettings = useMemo(() => normalizeSettings(settings), [settings]);
  const dirty = isSettingsDirty(savedSettings, draft);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  // A reload must not silently discard edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Saving never leaves the form stuck: busy state resets in `finally`. */
  async function save() {
    setSaving(true); setSaved(false); setSaveError(null);
    try {
      await onSave(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Sozlamalarni saqlab bo‘lmadi");
    } finally {
      setSaving(false);
    }
  }
  function resetDraft() { setDraft(normalizeSettings(settings)); setSaveError(null); }

  async function fullSync(pipelineId: string, funnelName: string) {
    if (!canFullSync(readiness)) return;
    if (!window.confirm(fullSyncConfirmation(funnelName, draft.historyDays))) return;
    setSaving(true); setSaved(false); setSaveError(null);
    try { await onFullSync(draft, pipelineId); }
    catch (caught) { setSaveError(caught instanceof Error ? caught.message : "Full sync bajarilmadi"); }
    finally { setSaving(false); }
  }

  const fieldOptions = fields.map((field) => <option key={field.key} value={field.key}>{field.title}{field.sampleValue ? ` · namuna: ${field.sampleValue}` : ""}</option>);
  const stageConflicts = stageConfigConflicts(draft);
  // Enumeration fields are the only sensible Причина провала candidates.
  const reasonFieldOptions = canonicalizeFieldOptions(fields.filter((field) => /enum/i.test(field.type) || (field.options ?? []).length > 0));
  const stageNameById = new Map(stages.map((stage) => [stage.id, stage.name]));
  const pairedProjectCount = draft.selectedPipelineIds.filter((id) => { const main = pipelines.find((item) => item.id === id); return main && draft.postSalePipelineNames.some((name) => brandOf(name) === brandOf(main.name)); }).length;
  const readiness = settingsReadiness(draft, pairedProjectCount);
  const blockers = fullSyncBlockers(readiness);
  const validConfig = readiness.pairing.valid;

  return <><div className="page-title"><div><p className="eyebrow">ADMIN</p><h1>Sozlamalar</h1><p>Sotuv loyihasi, Bitrix maydonlari va hisoblash qoidalari.</p></div></div>

    <ReadinessBar readiness={readiness} lastSyncAt={lastSyncAt} />

    <div className="settings-tabs" role="tablist" aria-label="Sozlamalar bo‘limlari">
      {SETTINGS_TABS.map((item) => <button key={item.id} type="button" role="tab" className="settings-tab"
        aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>

    {saveError && <div className="notice error page-notice"><XCircle size={18} /><span>{saveError}</span></div>}

    {tab === "asosiy" && <>
      <section className="panel pipeline-settings"><SectionHeader title="Sotuv loyihasi" subtitle="Bitta loyiha — Sales va unga bog‘langan Обучение / Сопровождение funnel’i." />
        {pipelineError && <div className="notice error"><XCircle size={17} />{pipelineError}</div>}
        <div className="pipeline-options project-options">{salesPipelines.map((pipeline) => { const checked = draft.selectedPipelineIds.includes(pipeline.id); const paired = pairFor(pipeline); return <CheckCard key={pipeline.id}
          checked={checked} disabled={!checked && draft.selectedPipelineIds.length >= 2}
          onChange={(next) => togglePipeline(pipeline, next)}
          title={pipeline.name}
          meta={paired ? `+ ${paired.name}` : "Mos post-sale funnel topilmadi"}
          hint={`Sales ID: ${pipeline.id}${paired ? ` · Post-sale ID: ${paired.id}` : ""}`} />; })}
          {!pipelines.length && !pipelineError && <small>Bitrix’dan pipeline’lar yuklanmoqda…</small>}</div>
        <div className={`pipeline-selection-note ${validConfig ? "ok" : "warning"}`}>{validConfig ? `Faol loyiha: ${draft.selectedPipelineNames.join(" + ")}. Deal ID bo‘yicha unique hisoblanadi.` : "Kamida bitta Sales loyiha va uning post-sale funnel’i topilishi kerak."}</div>
      </section>
    </>}

    {tab === "funnel" && <>
      <section className="panel"><SectionHeader title="Bosqich ma’nolari" subtitle={`${draft.selectedPipelineNames.join(" + ") || "Tanlangan Sales funnel"} bosqichlari. Bosqich ID saqlanadi, shuning uchun Bitrix’da nom o‘zgarsa ham hisob buzilmaydi.`} />
        {stageSemanticFields.map((field) => <StagePicker key={field.key} title={field.title} hint={field.hint} stages={stages} selected={draft[field.key]} onToggle={(stageId, checked) => setDraft({ ...draft, [field.key]: checked ? [...new Set([...draft[field.key], stageId])] : draft[field.key].filter((id) => id !== stageId) })} />)}
        <div className={`field-discovery ${stageConflicts.length ? "warning" : "ok"}`}>{stageConflicts.length
          ? `Bir bosqich bir nechta ma’noga biriktirilgan: ${stageConflicts.map((conflict) => `${stageNameById.get(conflict.stageId) ?? conflict.stageId} (${conflict.groups.join(", ")})`).join("; ")}. SQL chegarasi eng erta tanlangan bosqichdan boshlanadi, shuning uchun keyingi bosqichlarni SQL ro‘yxatidan olib tashlang. Konflikt bor ekan full sync qilmang.`
          : "Bo‘sh qoldirilsa avvalgidek bosqich nomi bo‘yicha aniqlanadi. Faqat tanlangan Sales funnel bosqichlari ko‘rsatiladi."}</div>
      </section>
      <section className="panel"><SectionHeader title="Proval sababi maydoni" subtitle="Har bir Sales funnel o‘z Причина провала maydonidan o‘qiladi. Sinxronizatsiyadan oldin tanlang." />
        <div className="config-fields">{draft.selectedPipelineIds.map((categoryId, index) => {
          const funnelName = draft.selectedPipelineNames[index] ?? `Sales funnel #${categoryId}`;
          const chosen = draft.failureReasonFieldByPipeline?.[categoryId] ?? "";
          return <FormField key={categoryId} label={funnelName} required
            hint={chosen ? `Tanlandi: ${chosen}` : undefined}
            error={chosen ? null : "Bu funnel uchun proval sababi o‘qilmaydi"}>
            <SelectInput value={chosen} error={chosen ? null : "missing"} onChange={(event) => {
              const next = { ...(draft.failureReasonFieldByPipeline ?? {}) };
              if (event.target.value) next[categoryId] = event.target.value; else delete next[categoryId];
              setDraft({ ...draft, failureReasonFieldByPipeline: next });
            }}>
              <option value="">Tanlanmagan</option>
              {reasonFieldOptions.map((field) => <option key={field.key} value={field.key}>{field.title} · {field.key}</option>)}
            </SelectInput>
          </FormField>;
        })}</div>
        <div className={`field-discovery ${readiness.failureReason.complete ? "ok" : "warning"}`}>Proval sababi konfiguratsiyasi: {readiness.failureReason.configured}/{readiness.failureReason.total}{readiness.failureReason.complete ? " — to‘liq" : `. Tanlanmagan: ${readiness.failureReason.missing.join(", ")}`}</div>
      </section>
      <section className="panel"><SectionHeader title="Yo‘naltirish sabablari" subtitle="Bu so‘zlar topilsa lead marketing sifatsizligiga qo‘shilmaydi." />
        <FormField label="Kalit so‘zlar" hint="Vergul bilan ajrating">
          <Textarea value={draft.routingReasonPatterns.join(", ")} rows={3}
            onChange={(event) => setDraft({ ...draft, routingReasonPatterns: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} />
        </FormField>
      </section>
    </>}

    {tab === "dashboard" && <DashboardMetricOrder
      selected={resolveHeadlineCardIds(draft.dashboardMetricIds)}
      onChange={(ids) => setDraft({ ...draft, dashboardMetricIds: ids })} />}

    {tab === "sla" && <>
      <section className="settings-grid">
        <article className="panel"><SectionHeader title="Ish vaqti" subtitle={`Vaqt mintaqasi: ${draft.timezone}`} />
          <div className="schedule-list">{days.map(([key, label]) => { const day = draft.schedule[key]; return <div key={key} className={!day.enabled ? "disabled" : ""}>
            <CheckCard checked={day.enabled} title={label}
              onChange={(checked) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, enabled: checked } } })} />
            <TimeInput value={day.start} disabled={!day.enabled} aria-label={`${label} — boshlanishi`}
              onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, start: event.target.value } } })} />
            <span>—</span>
            <TimeInput value={day.end} disabled={!day.enabled} aria-label={`${label} — tugashi`}
              onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, end: event.target.value } } })} />
          </div>; })}</div>
        </article>
        <div className="settings-stack">
          <article className="panel"><SectionHeader title="SLA" subtitle="Ishlov berilmagan Deal alohida qoladi" />
            <FormField label="SLA maqsadi" hint="Ish vaqti daqiqalarida">
              <NumberInput min={1} max={240} value={draft.slaMinutes} onChange={(event) => setDraft({ ...draft, slaMinutes: Number(event.target.value) })} />
            </FormField>
          </article>
          <article className="panel"><SectionHeader title="Dam olish va bayramlar" subtitle="Bu sanalarda ish vaqti hisoblanmaydi" />
            <div className="holiday-add">
              <DateInput value={holiday} aria-label="Bayram sanasi" onChange={(event) => setHoliday(event.target.value)} />
              <button className="button small secondary" disabled={!holiday || draft.holidays.includes(holiday)} onClick={() => { setDraft({ ...draft, holidays: [...draft.holidays, holiday].sort() }); setHoliday(""); }}>Bayram qo‘shish</button>
            </div>
            <div className="holiday-list">{draft.holidays.map((date) => <span key={date}>{date}<button aria-label={`${date} sanani o‘chirish`} onClick={() => setDraft({ ...draft, holidays: draft.holidays.filter((value) => value !== date) })}><X size={13} /></button></span>)}{!draft.holidays.length && <small>Hozircha maxsus bayram sanalari qo‘shilmagan.</small>}</div>
          </article>
        </div>
      </section>
      <section className="panel"><SectionHeader title="Har bir bosqich uchun limit" subtitle="Faqat tanlangan Sales funnel bosqichlari. Aktiv Deal limitdan oshsa Bosqich nazoratida qizil ko‘rinadi." />
        <div className="stage-limits">
          <FormField label="Standart limit" hint="soat">
            <NumberInput min={1} max={720} value={draft.defaultStageLimitHours} onChange={(event) => setDraft({ ...draft, defaultStageLimitHours: Number(event.target.value) })} />
          </FormField>
          {stages.map((stage) => <FormField key={`${stage.categoryId}:${stage.id}`} label={stage.name} hint="soat">
            <NumberInput min={1} max={720} value={draft.stageLimits[stage.id] ?? draft.defaultStageLimitHours}
              onChange={(event) => setDraft({ ...draft, stageLimits: { ...draft.stageLimits, [stage.id]: Number(event.target.value) } })} />
          </FormField>)}
        </div>
      </section>
    </>}

    {tab === "data" && <>
      <section className="settings-grid">
        <article className="panel"><SectionHeader title="Tarix oralig‘i" subtitle="Har bir funnel to‘liq sinxronizatsiyasi uchun import oralig‘i" />
          <FormField label="Import oralig‘i">
            <SelectInput value={draft.historyDays} onChange={(event) => setDraft({ ...draft, historyDays: Number(event.target.value) })}>
              {[7, 14, 30, 90, 180, 365].map((value) => <option key={value} value={value}>{value} kun</option>)}
            </SelectInput>
          </FormField>
        </article>
        <article className="panel"><SectionHeader title="Avtomatik yangilash" subtitle="Dashboard ochiq bo‘lganda incremental sinxronizatsiya avtomatik boshlanadi." />
          <FormField label="Interval">
            <SelectInput value={draft.autoSyncMinutes} onChange={(event) => setDraft({ ...draft, autoSyncMinutes: Number(event.target.value) })}>
              <option value="0">O‘chirilgan</option>
              {[10, 15, 30, 60].map((value) => <option key={value} value={value}>{value} daqiqa</option>)}
            </SelectInput>
          </FormField>
        </article>
      </section>
      <section className="panel"><SectionHeader title="To‘liq qayta yuklash" subtitle="Sales va unga bog‘langan Обучение / Сопровождение funnel’ini birga oladi." />
        {blockers.length > 0 && <div className="field-discovery warning">To‘liq qayta yuklash bloklangan:
          <ul className="full-sync-blockers">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </div>}
        <div className="scoped-sync-grid">{draft.selectedPipelineIds.map((id, index) => {
          const name = draft.selectedPipelineNames[index] ?? `Sales funnel #${id}`;
          const brand = brandOf(name) ?? "sales";
          const postSale = draft.postSalePipelineNames.find((item) => brandOf(item) === brand) ?? "mos post-sale funnel";
          return <article key={id}><div><span>{brand.toUpperCase()}</span><div><strong>{name}</strong><small>+ {postSale}</small></div></div>
            <p>Oxirgi {draft.historyDays} kun. Sales va post-sale kartochkalari Deal ID bo‘yicha bitta lead hisoblanadi.</p>
            <button className="button secondary" disabled={saving || syncing || blockers.length > 0} onClick={() => void fullSync(id, name)}>
              {saving || syncing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}{name} — to‘liq qayta yuklash
            </button></article>;
        })}</div>
      </section>
      <section className="panel"><SectionHeader title="Qo‘shimcha Bitrix maydonlari" subtitle="Sotuvchi maydoni. Manba doim standart SOURCE_ID’dan olinadi." />
        <div className={`field-discovery ${customFieldCount ? "ok" : "warning"}`}>{customFieldCount ? `${customFieldCount} ta maxsus maydon topildi. Nom yoki kod bo‘yicha qidiring.` : "Webhook maxsus maydon nomlarini bermadi. UF_CRM_... kodini qo‘lda kiritish mumkin."}</div>
        <datalist id="crm-field-options">{fieldOptions}</datalist>
        <div className="config-fields">
          <FormField label="Sotuvchi maydoni" hint="Sotuvchi yozilgan employee maydoni bo‘lsa. Bo‘sh bo‘lsa avtomatik attribution ishlaydi.">
            <TextInput list="crm-field-options" value={draft.salesManagerField ?? ""} placeholder="Bo‘sh bo‘lsa avtomatik"
              onChange={(event) => setDraft({ ...draft, salesManagerField: event.target.value.trim() || null })} />
          </FormField>
        </div>
      </section>
    </>}

    {dirty && <div className="save-bar" role="status">
      <strong>Saqlanmagan o‘zgarishlar</strong>
      <div className="save-bar-actions">
        <button className="button secondary" onClick={resetDraft} disabled={saving}>Bekor qilish</button>
        <button className="button primary" onClick={() => void save()} disabled={saving || !validConfig}>
          {saving ? <Loader2 size={17} className="spin" /> : <Check size={17} />}Saqlash
        </button>
      </div>
    </div>}
    {!dirty && saved && <div className="save-bar" role="status"><strong>Saqlandi</strong></div>}
  </>;
}

/**
 * Keeps one failing view from unmounting the whole dashboard.
 *
 * A missing import previously blanked the entire app when Settings rendered.
 * The message is deliberately generic: an error string could otherwise carry a
 * URL or credential into the DOM.
 */
class ViewErrorBoundary extends Component<{ children: ReactNode; onBack: () => void }, { failed: boolean }> {
  constructor(props: { children: ReactNode; onBack: () => void }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("View render failed:", error.message, info.componentStack);
  }

  componentDidUpdate(previous: { children: ReactNode }) {
    if (this.state.failed && previous.children !== this.props.children) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="panel view-error">
      <div className="notice error page-notice"><XCircle size={18} /><span><strong>Sahifani ko‘rsatishda xato yuz berdi.</strong> Ilovaning qolgan qismi ishlashda davom etadi.</span></div>
      <div className="setup-actions">
        <button className="button primary" onClick={() => { this.setState({ failed: false }); this.props.onBack(); }}>Dashboardga qaytish</button>
        <button className="button secondary" onClick={() => window.location.reload()}><RefreshCw size={16} />Sahifani yangilash</button>
      </div>
    </section>;
  }
}

type ProjectDraft = { id?: string; name: string; description: string; status: string; deadline: string };
type UpdateDraft = { id?: string; projectId: string; title: string; description: string; status: string; deadline: string };

function StatusPill({ status, overdue }: { status: string; overdue?: boolean }) {
  return <span className="status-pair"><span className="pill neutral">{status || "—"}</span>
    {overdue && <span className="pill danger">Muddati o‘tgan</span>}</span>;
}

/** Free-typing input with suggestions from statuses already in use. */
/** Relative activity time, e.g. "2 soat oldin". */
function relativeTime(iso: string | null) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "hozir";
  if (minutes < 60) return `${minutes} daqiqa oldin`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} soat oldin`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} kun oldin`;
  return fmtDate(iso, false);
}

const DEADLINE_BADGE: Record<string, { label: string; tone: string } | null> = {
  OVERDUE: { label: "Muddati o‘tgan", tone: "danger" },
  SOON: { label: "Yaqinlashmoqda", tone: "warn" },
  FUTURE: null,
  NONE: null,
};

function DeadlineBadge({ deadline, archived }: { deadline: string | null; archived?: boolean }) {
  if (archived) return null;
  const badge = DEADLINE_BADGE[deadlineState(deadline)];
  return badge ? <span className={`deadline-badge ${badge.tone}`}>{badge.label}</span> : null;
}

function ProjectsView({ projects, updates, filters, setFilters, onOpen, onNew, busy }: {
  projects: Project[]; updates: ProjectUpdate[];
  filters: { status: string; deadline: string; search: string; includeArchived: boolean };
  setFilters: React.Dispatch<React.SetStateAction<{ status: string; deadline: string; search: string; includeArchived: boolean }>>;
  onOpen: (project: Project) => void; onNew: () => void; busy: boolean;
}) {
  const summary = summarizeProjects(projects);
  const visible = filterProjects(projects, filters);
  const statuses = statusOptions(projects, updates);
  const breakdown = statusBreakdown(projects);
  // An empty list means two different things; the copy has to tell them apart.
  const filtersActive = Boolean(filters.search || filters.status || filters.deadline || filters.includeArchived);
  const noProjectsAtAll = projects.length === 0;

  return <><div className="page-title"><div><p className="eyebrow">BOSHQARUV</p><h1>Projects</h1><p>Marketing, Sales, Product va Analytics bo‘yicha ishlar va ularning oxirgi holati.</p></div>
    <button className="button primary" onClick={onNew} disabled={busy}><ClipboardList size={17} />Yangi loyiha</button></div>
    <section className="kpi-grid">
      <KpiCard label="Jami loyihalar" value={String(summary.total)} detail="Arxivlanmagan" icon={ClipboardList} />
      <KpiCard label="Muddati o‘tgan" value={String(summary.overdue)} detail="Muddati o‘tib ketgan" icon={AlertTriangle} tone="red" />
      <KpiCard label="Oxirgi 7 kunda yangilangan" value={String(summary.updatedLast7Days)} detail="Bugundan orqaga 7 kun" icon={RefreshCw} tone="green" />
      <KpiCard label="Keyingi 7 kun deadline" value={String(summary.deadlineNext7Days)} detail="Bugundan oldinga 7 kun" icon={CalendarDays} tone="cyan" />
    </section>
    <div className="filters-shell"><div className="filters-main">
      <div className="search-box"><Search size={16} /><input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Loyiha nomi yoki status…" /></div>
      <Select label="Status" value={filters.status} onChange={(value) => setFilters((current) => ({ ...current, status: value }))}>
        <option value="">{statuses.length ? "Barcha statuslar" : "Status yo‘q"}</option>{statuses.map((status) => <option key={status}>{status}</option>)}
      </Select>
      <Select label="Muddat" value={filters.deadline} onChange={(value) => setFilters((current) => ({ ...current, deadline: value }))}>
        {DEADLINE_STATES.map((state) => <option key={state.id} value={state.id}>{state.label}</option>)}
      </Select>
      <CheckCard checked={filters.includeArchived} title="Arxiv bilan"
        onChange={(checked) => setFilters((current) => ({ ...current, includeArchived: checked }))} />
      {filtersActive && <button className="button small secondary" onClick={() => setFilters({ status: "", deadline: "", search: "", includeArchived: false })}>Filtrni tozalash</button>}
    </div></div>
    {breakdown.length > 0 && <section className="panel"><SectionHeader title="Statuslar" subtitle="Ma’lumotdagi haqiqiy statuslar bo‘yicha" />
      <BarList rows={breakdown.map((row) => ({ label: row.status, value: row.count, total: summary.total, color: "#246bfd" }))} /></section>}
    <section className="panel"><SectionHeader title="Loyihalar" subtitle={`${visible.length} ta ko‘rsatilmoqda`} />
      <div className="project-list">{visible.map((project) => { const last = latestUpdate(updates, project.id); return <button key={project.id} type="button" className={`project-card${project.archivedAt ? " archived" : ""}`} onClick={() => onOpen(project)}>
        <span className="project-card-head"><strong>{project.name}</strong>
          <span className="project-card-tags">{project.archivedAt && <span className="archive-tag">Arxivlangan</span>}<DeadlineBadge deadline={project.deadline} archived={Boolean(project.archivedAt)} /><StatusPill status={project.status} /></span></span>
        <span className="project-card-desc">{project.description || (last ? last.title : "Tavsif kiritilmagan")}</span>
        <span className="project-card-foot">
          <span>Muddat: <strong>{project.deadline ?? "yo‘q"}</strong></span>
          <span>Oxirgi faollik: <strong>{relativeTime(project.updatedAt)}</strong></span>
        </span>
      </button>; })}
      {!visible.length && (noProjectsAtAll
        ? <div className="empty-state"><strong>Loyihalar hali yo‘q</strong>
            <p>Marketing, Product yoki boshqa yo‘nalishdagi ishni yaratishingiz mumkin.</p>
            <button className="button primary" onClick={onNew} disabled={busy}><ClipboardList size={16} />Yangi loyiha</button></div>
        : <div className="empty-state"><strong>Filtrga mos loyiha topilmadi</strong>
            <p>Qidiruv yoki filtrlarni o‘zgartirib ko‘ring.</p>
            <button className="button secondary" onClick={() => setFilters({ status: "", deadline: "", search: "", includeArchived: false })}>Filtrni tozalash</button></div>)}
      </div>
    </section></>;
}

function ProjectDetailView({ project, updates, onBack, onEditProject, onArchive, onNewUpdate, onEditUpdate, onDeleteUpdate, busy }: {
  project: Project; updates: ProjectUpdate[]; onBack: () => void;
  onEditProject: () => void; onArchive: () => void; onNewUpdate: () => void;
  onEditUpdate: (update: ProjectUpdate) => void; onDeleteUpdate: (update: ProjectUpdate) => void; busy: boolean;
}) {
  const timeline = projectUpdates(updates, project.id);
  return <><div className="page-title"><div><button className="back-button" onClick={onBack}><ArrowLeft size={16} />Loyihalarga qaytish</button>
    <p className="eyebrow">LOYIHA</p><h1>{project.name}</h1>
    <div className="project-meta"><StatusPill status={project.status} />
      <DeadlineBadge deadline={project.deadline} archived={Boolean(project.archivedAt)} />
      {project.archivedAt && <span className="archive-tag">Arxivlangan</span>}</div></div>
    <div className="settings-actions">
      <button className="button primary" onClick={onNewUpdate} disabled={busy}><ClipboardList size={16} />Update qo‘shish</button>
      <button className="button secondary" onClick={onEditProject} disabled={busy}><Settings size={16} />Tahrirlash</button>
      <button className="button secondary" onClick={onArchive} disabled={busy}>{project.archivedAt ? "Arxivdan chiqarish" : "Arxivlash"}</button></div></div>

    <section className="panel"><SectionHeader title="Loyiha haqida" />
      <p className="note-body">{project.description || "Tavsif kiritilmagan"}</p>
      <div className="quality-grid">
        <div><span>Status</span><strong>{project.status}</strong></div>
        <div><span>Muddat</span><strong>{project.deadline ?? "yo‘q"}</strong></div>
        <div><span>Yaratilgan</span><strong>{fmtDate(project.createdAt, false)}</strong></div>
        <div><span>Oxirgi faollik</span><strong>{relativeTime(project.updatedAt)}</strong></div>
      </div>
    </section>

    <section className="panel"><SectionHeader title="Update tarixi" subtitle="Eng oxirgi faollik yuqorida" />
      <div className="update-timeline">{timeline.map((update) => <article key={update.id} className="update-item">
        <div className="update-head"><strong>{update.title}</strong>
          <span className="project-card-tags"><DeadlineBadge deadline={update.deadline} /><StatusPill status={update.status} /></span></div>
        {update.description && <p>{update.description}</p>}
        <div className="update-foot">
          <small>{wasEdited(update) ? `Yangilangan: ${fmtDate(update.updatedAt)}` : `Yaratilgan: ${fmtDate(update.createdAt)}`}{update.deadline ? ` · muddat ${update.deadline}` : ""}</small>
          <span><button className="button small secondary" onClick={() => onEditUpdate(update)} disabled={busy}>Tahrirlash</button>
          <button className="button small secondary" onClick={() => onDeleteUpdate(update)} disabled={busy}>O‘chirish</button></span></div>
      </article>)}
      {!timeline.length && <div className="empty-state"><strong>Hali update yo‘q</strong>
        <p>Loyiha bo‘yicha birinchi holatni yozib qo‘ying.</p>
        <button className="button primary" onClick={onNewUpdate} disabled={busy}><ClipboardList size={16} />Update qo‘shish</button></div>}</div>
    </section></>;
}

type PageDraft = { id?: string; name: string; description: string; audience: string; defaultRange: string; defaultFrom: string; defaultTo: string };
type WidgetDraft = { id?: string; pageId: string; widgetType: WidgetType; title: string; config: Record<string, unknown> };

/** Renders one widget. Sales numbers come from the canonical metric helper. */
function WidgetBlock({ widget, records, projects, updates, page, editing }: {
  widget: PageWidget; records: DashboardRecord[]; projects: Project[]; updates: ProjectUpdate[];
  page: Pick<CustomPage, "defaultRange" | "defaultFrom" | "defaultTo">; editing: boolean;
}) {
  const pageRange = page.defaultRange;
  const source = widgetSource(widget.widgetType);
  const badge = editing ? <small className="widget-source">{WIDGET_SOURCE_LABELS[source]}</small> : null;

  if (widget.widgetType === "SECTION_HEADER") {
    return <div className="page-section-header"><h2>{widget.title || "Bo‘lim"}</h2>
      {Boolean(widget.config.subtitle) && <p>{String(widget.config.subtitle)}</p>}{badge}</div>;
  }

  if (widget.widgetType === "SALES_KPI") {
    const range = resolveWidgetRange(widget.config, pageRange);
    const custom = resolveWidgetCustomRange(widget.config, page);
    const bounds = pageRangeBounds(range, new Date(), custom);
    const populations = selectPeriodPopulations(records, bounds.from, bounds.to);
    const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);
    const resolved = resolveDashboardMetric(metrics, String(widget.config.metricId) as DashboardMetricId);
    return <KpiCard label={widget.title || resolved.label} value={resolved.value}
      detail={<>{pageRangeLabel(range, custom)}{badge}</>} icon={BarChart3} tone="blue" />;
  }

  if (widget.widgetType === "MANUAL_KPI") {
    return <KpiCard label={widget.title || String(widget.config.label ?? "KPI")} value={formatManualValue(widget.config)}
      detail={<>{String(widget.config.note ?? "") || "Qo‘lda kiritilgan"}{badge}</>} icon={ClipboardList} tone="amber" />;
  }

  if (widget.widgetType === "TEXT_NOTE") {
    return <article className="panel"><SectionHeader title={widget.title || "Izoh"} />
      <p className="note-body">{String(widget.config.body ?? "") || "Matn kiritilmagan"}</p>{badge}</article>;
  }

  if (widget.widgetType === "PROJECT_SUMMARY") {
    const summary = summarizeProjects(projects);
    return <article className="panel"><SectionHeader title={widget.title || "Loyihalar xulosasi"} />
      <div className="quality-grid"><div><span>Jami loyihalar</span><strong>{summary.total}</strong></div>
        <div><span>Deadline o‘tgan</span><strong>{summary.overdue}</strong></div>
        <div><span>Oxirgi 7 kunda yangilangan</span><strong>{summary.updatedLast7Days}</strong></div>
        <div><span>Keyingi 7 kun deadline</span><strong>{summary.deadlineNext7Days}</strong></div></div>{badge}</article>;
  }

  if (widget.widgetType === "PROJECT_STATUS_BREAKDOWN") {
    const breakdown = statusBreakdown(projects);
    const total = breakdown.reduce((sum, row) => sum + row.count, 0);
    return <article className="panel"><SectionHeader title={widget.title || "Statuslar"} />
      <BarList rows={breakdown.map((row) => ({ label: row.status, value: row.count, total, color: "#246bfd" }))} />
      {!breakdown.length && <div className="widget-empty">Status ma’lumoti yo‘q</div>}{badge}</article>;
  }

  if (widget.widgetType === "PROJECTS_LIST") {
    const rows = selectProjectsListRows(projects, widget.config);
    return <article className="panel"><SectionHeader title={widget.title || "Loyihalar"} />
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Loyiha</th><th>Status</th><th>Deadline</th><th>Oxirgi update</th></tr></thead>
        <tbody>{rows.map((project) => <tr key={project.id}><td><strong>{project.name}</strong></td>
          <td><StatusPill status={project.status} overdue={isOverdue(project)} /></td>
          <td>{project.deadline ?? "—"}</td><td>{latestUpdate(updates, project.id)?.title ?? "—"}</td></tr>)}</tbody></table>
        {!rows.length && <div className="widget-empty">Loyiha topilmadi</div>}</div>{badge}</article>;
  }

  if (widget.widgetType === "LATEST_UPDATES") {
    const source2 = selectLatestUpdates(updates, widget.config);
    return <article className="panel"><SectionHeader title={widget.title || "Oxirgi update’lar"} />
      <div className="update-timeline">{source2.map((update) => <div key={update.id} className="update-item">
        <div className="update-head"><strong>{update.title}</strong><StatusPill status={update.status} /></div>
        <small>{projects.find((project) => project.id === update.projectId)?.name ?? "—"} · {fmtDate(update.createdAt)}</small>
      </div>)}{!source2.length && <div className="widget-empty">Update topilmadi</div>}</div>{badge}</article>;
  }

  return null;
}

type ShareDraft = { id?: string; pageId: string; label: string; expiresAt: string; widgetIds: string[] };

/**
 * Share management for one Custom Page.
 *
 * Visibility is per share, not per widget: the same page can back a link that
 * shows only Sales KPIs and another that also carries the internal notes.
 * Defaults are conservative, and the raw URL is displayed once — the server
 * keeps only a hash and cannot show it again.
 */
/** Palette entries grouped by where their numbers come from. */
/**
 * Save gating for the drawers. The API validates these too — this only stops
 * the UI offering a save it knows the server will reject.
 */
function pageDraftValid(draft: PageDraft) {
  if (!draft.name.trim()) return false;
  if (draft.defaultRange !== "custom") return true;
  return Boolean(draft.defaultFrom && draft.defaultTo && draft.defaultFrom <= draft.defaultTo);
}

function widgetDraftValid(draft: WidgetDraft) {
  const config = draft.config;
  if (draft.widgetType === "MANUAL_KPI" && !String(config.label ?? "").trim()) return false;
  if (draft.widgetType !== "SALES_KPI" || config.range !== "custom") return true;
  const from = String(config.from ?? ""); const to = String(config.to ?? "");
  return Boolean(from && to && from <= to);
}

/** Uzbek labels for the manual KPI formats; ids stay untouched. */
const MANUAL_FORMAT_LABELS: Record<string, string> = {
  text: "Matn", integer: "Butun son", decimal: "O‘nlik", percentage: "Foiz", currency: "Valyuta",
};

const PALETTE_GROUPS: { source: WidgetSource; title: string }[] = [
  { source: "BITRIX", title: "Bitrix’dan avtomatik" },
  { source: "PROJECTS", title: "Loyihalar" },
  { source: "MANUAL", title: "Qo‘lda kiritiladigan" },
];

/** Starting config for a freshly added widget. */
function defaultWidgetConfig(type: WidgetType): Record<string, unknown> {
  if (type === "SALES_KPI") return { metricId: "leads", range: "", from: null, to: null };
  if (type === "MANUAL_KPI") return { label: "KPI", value: "", unit: "", note: "", format: "text" };
  if (type === "PROJECTS_LIST") return { status: "", deadline: "", includeArchived: false, limit: 10 };
  if (type === "LATEST_UPDATES") return { projectId: "", status: "", limit: 5 };
  if (type === "TEXT_NOTE") return { body: "" };
  return { subtitle: "" };
}
/** Types that are meaningless until configured, so adding one opens settings. */
const NEEDS_CONFIG: WidgetType[] = ["SALES_KPI", "MANUAL_KPI", "TEXT_NOTE", "SECTION_HEADER"];

function SourceBadge({ source }: { source: WidgetSource }) {
  return <span className={`source-badge ${source.toLowerCase()}`}>{WIDGET_SOURCE_LABELS[source]}</span>;
}

function WidgetPalette({ onAdd, busy }: { onAdd: (type: WidgetType) => void; busy: boolean }) {
  return <aside className="builder-palette" aria-label="Widget palitrasi">
    <h3>Bloklar</h3>
    {PALETTE_GROUPS.map((group) => {
      const entries = WIDGET_REGISTRY.filter((entry) => entry.source === group.source);
      return <section key={group.source}>
        <h4>{group.title}</h4>
        {entries.map((entry) => <button key={entry.type} type="button" className="palette-item" disabled={busy}
          onClick={() => onAdd(entry.type)}>
          <span className="palette-item-head"><strong>{entry.label}</strong><SourceBadge source={entry.source} /></span>
          <small>{entry.hint}</small>
        </button>)}
      </section>;
    })}
  </aside>;
}

/** Consistent shell around every widget on the canvas. */
function WidgetShell({ widget, editing, first, last, busy, onMove, onEdit, onDelete, children }: {
  widget: PageWidget; editing: boolean; first: boolean; last: boolean; busy: boolean;
  onMove: (direction: "up" | "down") => void; onEdit: () => void; onDelete: () => void; children: React.ReactNode;
}) {
  const label = widget.title || WIDGET_REGISTRY.find((entry) => entry.type === widget.widgetType)?.label || "Widget";
  if (!editing) return <div className="canvas-widget">{children}</div>;
  return <div className="canvas-widget editing">
    <div className="widget-toolbar">
      <span className="widget-toolbar-id"><strong>{label}</strong><SourceBadge source={widgetSource(widget.widgetType)} /></span>
      <span className="widget-toolbar-actions">
        <button className="button small secondary" aria-label={`${label} — yuqoriga`} title="Yuqoriga" disabled={busy || first} onClick={() => onMove("up")}>↑</button>
        <button className="button small secondary" aria-label={`${label} — pastga`} title="Pastga" disabled={busy || last} onClick={() => onMove("down")}>↓</button>
        <button className="button small secondary" disabled={busy} onClick={onEdit}>Sozlash</button>
        <button className="button small secondary danger" disabled={busy} onClick={onDelete}>O‘chirish</button>
      </span>
    </div>
    {children}
  </div>;
}

function PagesListView({ pages, widgets, search, setSearch, includeArchived, setIncludeArchived, onOpen, onNew, onTemplate, busy }: {
  pages: CustomPage[]; widgets: PageWidget[]; search: string; setSearch: (value: string) => void;
  includeArchived: boolean; setIncludeArchived: (value: boolean) => void;
  onOpen: (page: CustomPage) => void; onNew: () => void; onTemplate: (templateId: string) => void; busy: boolean;
}) {
  const visible = filterPages(pages, { search, includeArchived });
  const filtersActive = Boolean(search || includeArchived);
  return <>
    <div className="page-title"><div><p className="eyebrow">BOSHQARUV</p><h1>Pages</h1>
      <p>CEO, Marketing, Sales yoki boshqa auditoriya uchun o‘z dashboardingizni yig‘ing.</p></div>
      <button className="button primary" disabled={busy} onClick={onNew}><Layers3 size={17} />Yangi sahifa</button></div>

    <section className="panel template-panel"><SectionHeader title="Tez boshlash" subtitle="Tayyor tuzilma yaratadi — har bir widget keyin tahrirlanadi" />
      <div className="template-grid">{PAGE_TEMPLATES.map((template) => <button key={template.id} type="button" className="template-card" disabled={busy}
        onClick={() => onTemplate(template.id)}>
        <strong>{template.name}</strong>
        <small>{template.audience}</small>
        <small>{template.widgets.length} ta widget</small>
      </button>)}</div>
    </section>

    <div className="filters-shell"><div className="filters-main">
      <div className="search-box"><Search size={16} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Sahifa nomi yoki auditoriya…" /></div>
      <CheckCard checked={includeArchived} title="Arxiv bilan" onChange={setIncludeArchived} />
      {filtersActive && <button className="button small secondary" onClick={() => { setSearch(""); setIncludeArchived(false); }}>Filtrni tozalash</button>}
    </div></div>

    <section className="panel"><SectionHeader title="Sahifalar" subtitle={`${visible.length} ta ko‘rsatilmoqda`} />
      <div className="project-list">{visible.map((page) => <button key={page.id} type="button" className={`project-card${page.archivedAt ? " archived" : ""}`}
        onClick={() => onOpen(page)}>
        <span className="project-card-head"><strong>{page.name}</strong>
          <span className="project-card-tags">{page.archivedAt && <span className="archive-tag">Arxivlangan</span>}
            {page.audience && <span className="pill neutral">{page.audience}</span>}</span></span>
        <span className="project-card-desc">{page.description || "Tavsif kiritilmagan"}</span>
        <span className="project-card-foot">
          <span>Oraliq: <strong>{pageRangeLabel(page.defaultRange, { from: page.defaultFrom, to: page.defaultTo })}</strong></span>
          <span>Widget: <strong>{pageWidgets(widgets, page.id).length}</strong></span>
          <span>Yangilangan: <strong>{fmtDate(page.updatedAt, false)}</strong></span>
        </span>
      </button>)}
      {!visible.length && (pages.length === 0
        ? <div className="empty-state"><strong>Sahifalar hali yo‘q</strong>
            <p>CEO, Marketing, Sales yoki boshqa auditoriya uchun dashboard yarating.</p>
            <button className="button primary" onClick={onNew} disabled={busy}><Layers3 size={16} />Yangi sahifa</button></div>
        : <div className="empty-state"><strong>Filtrga mos sahifa topilmadi</strong>
            <p>Qidiruvni o‘zgartiring yoki arxivdagilarni ham ko‘rsating.</p>
            <button className="button secondary" onClick={() => { setSearch(""); setIncludeArchived(false); }}>Filtrni tozalash</button></div>)}
      </div>
    </section></>;
}

function SharePanel({ page, widgets, shares, draft, setDraft, createdUrl, dismissUrl, onSubmit, onRevoke, busy }: {
  page: CustomPage; widgets: PageWidget[]; shares: PageShare[];
  draft: ShareDraft | null; setDraft: (draft: ShareDraft | null) => void;
  createdUrl: string | null; dismissUrl: () => void;
  onSubmit: (draft: ShareDraft) => void; onRevoke: (share: PageShare) => void; busy: boolean;
}) {
  const rows = shares.filter((share) => share.pageId === page.id);
  const newDraft = (): ShareDraft => ({ pageId: page.id, label: "", expiresAt: "", widgetIds: defaultVisibleWidgetIds(widgets) });
  const toggle = (widgetId: string) => {
    if (!draft) return;
    const next = draft.widgetIds.includes(widgetId)
      ? draft.widgetIds.filter((id) => id !== widgetId)
      : [...draft.widgetIds, widgetId];
    setDraft({ ...draft, widgetIds: next });
  };

  return <div className="share-panel">
    <p className="form-hint">Faqat o‘qish uchun havola — qabul qiluvchi tanlangan widgetlardan boshqa hech narsani ko‘rmaydi.</p>
    <button className="button primary" disabled={busy} onClick={() => setDraft(newDraft())}>Yangi link yaratish</button>

    {createdUrl && <div className="share-created">
      <strong>Havola faqat shu safar ko‘rsatiladi</strong>
      <code>{createdUrl}</code>
      <div className="share-created-actions">
        <button className="button small" onClick={() => { void navigator.clipboard?.writeText(createdUrl); }}>Nusxalash</button>
        <button className="button small secondary" onClick={dismissUrl}>Yopish</button>
      </div>
      <small>Bu havola qayta ko‘rsatilmaydi. Hozir nusxalang.</small>
    </div>}

    {draft && <div className="share-draft">
      <div className="filter-grid">
        <FormField label="Nomi" hint="Havolani kim uchun yaratayotganingiz">
          <TextInput value={draft.label} placeholder="CEO, Board weekly, Sales Director"
            onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></FormField>
        <FormField label="Amal qilish muddati" hint="Bo‘sh qoldirilsa — muddatsiz">
          <DateInput value={draft.expiresAt}
            onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} /></FormField>
      </div>
      <p className="share-hint">Ko‘rinadigan widgetlar ({draft.widgetIds.length}/{widgets.length}). Ichki matn va loyiha nomlari sukut bo‘yicha yopiq.</p>
      <div className="share-widget-list">{widgets.map((widget) => <CheckCard key={widget.id}
        checked={draft.widgetIds.includes(widget.id)} onChange={() => toggle(widget.id)}
        title={widget.title || WIDGET_REGISTRY.find((entry) => entry.type === widget.widgetType)?.label || widget.widgetType}
        meta={`${WIDGET_SOURCE_LABELS[widgetSource(widget.widgetType)]}${DEFAULT_SHARED_WIDGET_TYPES.includes(widget.widgetType) ? "" : " · ichki"}`} />)}
        {!widgets.length && <div className="empty-table">Avval widget qo‘shing.</div>}</div>
      <div className="drawer-actions">
        <button className="button" disabled={busy || !draft.widgetIds.length} onClick={() => onSubmit(draft)}>Saqlash</button>
        <button className="button secondary" disabled={busy} onClick={() => setDraft(null)}>Bekor qilish</button>
      </div>
    </div>}

    <div className="table-wrap"><table className="data-table">
      <thead><tr><th>Nomi</th><th>Yaratilgan</th><th>Muddat</th><th>Holat</th><th>Widget</th><th /></tr></thead>
      <tbody>{rows.map((share) => {
        const status = shareStatus(share);
        return <tr key={share.id}>
          <td><strong>{share.label || "Nomsiz"}</strong></td>
          <td>{fmtDate(share.createdAt, false)}</td>
          <td>{share.expiresAt ? fmtDate(share.expiresAt, false) : "Muddatsiz"}</td>
          <td><span className={`status-pill ${status === "ACTIVE" ? "ok" : "muted"}`}>{SHARE_STATUS_LABELS[status]}</span></td>
          <td>{share.widgetIds.length}</td>
          <td><button className="button small secondary" disabled={busy}
            onClick={() => setDraft({ id: share.id, pageId: page.id, label: share.label, expiresAt: (share.expiresAt ?? "").slice(0, 10), widgetIds: share.widgetIds })}>Tahrirlash</button>
          {status === "ACTIVE" && <button className="button small secondary" disabled={busy}
            onClick={() => { if (window.confirm("Havola bekor qilinsinmi? Bu amalni qaytarib bo‘lmaydi.")) onRevoke(share); }}>Bekor qilish</button>}</td>
        </tr>;
      })}</tbody></table>
      {!rows.length && <div className="widget-empty">Hali ulashish havolasi yo‘q</div>}</div>
  </div>;
}

export default function DashboardClient() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [records, setRecords] = useState<DashboardRecord[]>([]);
  // Stage history is fetched the first time Stage Control is opened, never on
  // the dashboard's initial load.
  const [stageFunnelRecords, setStageFunnelRecords] = useState<StageFunnelRecord[]>([]);
  const [stageFunnelStatus, setStageFunnelStatus] = useState<StageFunnelStatus>("idle");
  // The machine's state is mirrored in a ref because every trigger — a nav
  // click, an invalidation from load(), a request settling — reads it outside
  // React's render, where the state variable would be a stale closure.
  const stageFunnelRef = useRef<StageFunnelState>(initialStageFunnelState);
  const dispatchRef = useRef<((action: StageFunnelAction) => void) | null>(null);
  const viewRef = useRef<View>("dashboard");
  const [currentStageRecords, setCurrentStageRecords] = useState<CurrentStageRecord[] | null>(null);
  const [stageReconciliation, setStageReconciliation] = useState<StageReconciliation | null>(null);
  const [stageCatalog, setStageCatalog] = useState<PipelineStageOption[]>([]);
  const [stageSnapshotTruncated, setStageSnapshotTruncated] = useState(false);
  const [currentStageLoading, setCurrentStageLoading] = useState(false);
  const [currentStageError, setCurrentStageError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [sync, setSync] = useState<SyncState>(idleSync);
  const [view, setView] = useState<View>("dashboard");
  const [selectedManager, setSelectedManager] = useState<ManagerRow | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [refreshing, setRefreshing] = useState(false);
  const [syncPipelineId, setSyncPipelineId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectUpdateRows, setProjectUpdateRows] = useState<ProjectUpdate[]>([]);
  const [projectFilters, setProjectFilters] = useState({ status: "", deadline: "", search: "", includeArchived: false });
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [updateDraft, setUpdateDraft] = useState<UpdateDraft | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [pages, setPages] = useState<CustomPage[]>([]);
  const [widgets, setWidgets] = useState<PageWidget[]>([]);
  const [openPageId, setOpenPageId] = useState<string | null>(null);
  const [pageEditing, setPageEditing] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  const [pageDraft, setPageDraft] = useState<PageDraft | null>(null);
  const [widgetDraft, setWidgetDraft] = useState<WidgetDraft | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [shares, setShares] = useState<PageShare[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareDraft, setShareDraft] = useState<ShareDraft | null>(null);
  const [shareUrlOnce, setShareUrlOnce] = useState<string | null>(null);
  const [pageIncludeArchived, setPageIncludeArchived] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const syncLoopRef = useRef(false);
  const autoSyncIndexRef = useRef(0);
  const syncRunnerRef = useRef<((mode: "start" | "resume", full?: boolean, daysOverride?: number, pipelineId?: string) => Promise<void>) | null>(null);

  const loadCurrentStages = useCallback(async () => {
    setCurrentStageLoading(true); setCurrentStageError(null);
    try {
      const response = await fetch("/api/current-stages", { cache: "no-store" });
      const payload = await response.json() as { records?: CurrentStageRecord[]; reconciliation?: StageReconciliation | null; stageCatalog?: PipelineStageOption[]; truncated?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Joriy stage’lar yuklanmadi");
      setCurrentStageRecords(payload.records ?? []); setStageReconciliation(payload.reconciliation ?? null);
      // Bitrix pagination truncation makes the live counts themselves partial,
      // so the signal must survive all the way into the trust banner.
      setStageCatalog(payload.stageCatalog ?? []); setStageSnapshotTruncated(Boolean(payload.truncated));
    } catch (caught) {
      setCurrentStageError(caught instanceof Error ? caught.message : "Joriy stage’lar yuklanmadi");
    } finally { setCurrentStageLoading(false); }
  }, []);

  /**
   * Runs one Stage Control history request. Every caller goes through
   * `dispatchStageFunnel`, so the machine decides whether a request happens at
   * all — this function never guards for itself.
   */
  const runStageFunnelFetch = useCallback(async () => {
    try {
      const response = await fetch("/api/stage-funnel", { cache: "no-store" });
      const payload = await response.json() as { records?: StageFunnelRecord[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Stage tarixi yuklanmadi");
      setStageFunnelRecords(payload.records ?? []);
      dispatchRef.current?.({ type: "SUCCESS" });
    } catch {
      // The previous records are kept rather than replaced with an empty list:
      // "we could not load history" must not render as "there is no history".
      dispatchRef.current?.({ type: "FAILURE" });
    }
  }, []);

  const dispatchStageFunnel = useCallback((action: StageFunnelAction) => {
    const next = stageFunnelNext(stageFunnelRef.current, action);
    stageFunnelRef.current = { status: next.status, dirty: next.dirty };
    setStageFunnelStatus(next.status);
    if (next.fetch) void runStageFunnelFetch();
  }, [runStageFunnelFetch]);
  // SUCCESS/FAILURE are dispatched from inside the fetch, which is defined
  // first; the ref breaks that cycle without reordering the file. Assigned in
  // an effect, matching how syncRunnerRef is kept current below.
  useEffect(() => { dispatchRef.current = dispatchStageFunnel; });

  /** The analytics dataset changed, so the cached history is now older than it. */
  const invalidateStageFunnel = useCallback(() => {
    dispatchStageFunnel({ type: "INVALIDATE", visible: viewRef.current === "stages" });
  }, [dispatchStageFunnel]);

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const payload = await response.json() as { projects?: Project[]; updates?: ProjectUpdate[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Loyihalar yuklanmadi");
      setProjects(payload.projects ?? []); setProjectUpdateRows(payload.updates ?? []);
    } catch (caught) { setProjectError(caught instanceof Error ? caught.message : "Loyihalar yuklanmadi"); }
  }, []);

  const projectAction = useCallback(async (body: Record<string, unknown>) => {
    setProjectBusy(true); setProjectError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Amal bajarilmadi");
      await loadProjects();
      return true;
    } catch (caught) { setProjectError(caught instanceof Error ? caught.message : "Amal bajarilmadi"); return false; }
    finally { setProjectBusy(false); }
  }, [loadProjects]);

  const loadPages = useCallback(async () => {
    try {
      const response = await fetch("/api/pages", { cache: "no-store" });
      const payload = await response.json() as { pages?: CustomPage[]; widgets?: PageWidget[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Sahifalar yuklanmadi");
      setPages(payload.pages ?? []); setWidgets(payload.widgets ?? []);
    } catch (caught) { setProjectError(caught instanceof Error ? caught.message : "Sahifalar yuklanmadi"); }
  }, []);

  const loadShares = useCallback(async () => {
    try {
      const response = await fetch("/api/shares", { cache: "no-store" });
      const payload = await response.json() as { shares?: PageShare[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Havolalar yuklanmadi");
      setShares(payload.shares ?? []);
    } catch (caught) { setProjectError(caught instanceof Error ? caught.message : "Havolalar yuklanmadi"); }
  }, []);

  /** The create response is the only place a raw URL exists; it is never refetched. */
  const shareAction = useCallback(async (body: Record<string, unknown>) => {
    setProjectBusy(true); setProjectError(null);
    try {
      const response = await fetch("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { url?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Amal bajarilmadi");
      await loadShares();
      return payload.url ?? null;
    } catch (caught) { setProjectError(caught instanceof Error ? caught.message : "Amal bajarilmadi"); return null; }
    finally { setProjectBusy(false); }
  }, [loadShares]);

  const pageAction = useCallback(async (body: Record<string, unknown>) => {
    setProjectBusy(true); setProjectError(null);
    try {
      const response = await fetch("/api/pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Amal bajarilmadi");
      await loadPages();
      return payload.id ?? true;
    } catch (caught) { setProjectError(caught instanceof Error ? caught.message : "Amal bajarilmadi"); return null; }
    finally { setProjectBusy(false); }
  }, [loadPages]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const bootstrapResponse = await fetch("/api/bootstrap", { cache: "no-store" });
      const bootstrap = await bootstrapResponse.json() as { configured: boolean; settings: DashboardSettings; sync: SyncState; providers: ProviderDiagnostic[]; error?: string };
      if (!bootstrapResponse.ok) throw new Error(bootstrap.error ?? "Dashboard yuklanmadi");
      setConfigured(bootstrap.configured); setSettings(normalizeSettings(bootstrap.settings)); setSync(bootstrap.sync);
      if (bootstrap.configured) {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        const payload = await response.json() as { records: DashboardRecord[]; settings: DashboardSettings; sync: SyncState; providers: ProviderDiagnostic[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Dashboard ma’lumotlari yuklanmadi");
        const selectedOrigins = new Set(payload.settings.selectedPipelineIds.map(String));
        const selectedProjectCategories = new Set([...payload.settings.selectedPipelineIds, ...payload.settings.postSalePipelineIds].map(String));
        const projectRecords = (payload.records ?? []).map(hydrateRecord).filter((row) => !selectedOrigins.size || selectedOrigins.has(String(row.originCategoryId)) || selectedProjectCategories.has(String(row.categoryId)));
        setRecords(markDuplicates(withLiveSlaState(projectRecords, normalizeSettings(payload.settings)))); setSettings(normalizeSettings(payload.settings)); setSync(payload.sync);
        // The analytics dataset was just replaced, so any cached Stage Control
        // history now describes an older one. Deliberately here and nowhere
        // else: project/page/share/current-stage reloads are unrelated.
        invalidateStageFunnel();
        void loadCurrentStages(); void loadProjects(); void loadPages(); void loadShares();
      }
    } catch (caught) { setLoadError(caught instanceof Error ? caught.message : "Dashboard yuklanmadi"); }
    finally { setLoading(false); }
  }, [loadCurrentStages, loadProjects, loadPages, loadShares, invalidateStageFunnel]);
  useEffect(() => { viewRef.current = view; });
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!configured) return;
    const interval = window.setInterval(() => { void loadCurrentStages(); }, 120_000);
    return () => window.clearInterval(interval);
  }, [configured, loadCurrentStages]);

  const { cohortFiltered, wonFiltered, previousCohortFiltered, previousWonFiltered, trendBounds, previousTrendBounds, detailFiltered } = useMemo(() => {
    const bounds = rangeBounds(filters); const search = filters.search.trim().toLowerCase();
    const from = bounds.from ? boundsFromKeys({ from: bounds.from, to: bounds.from }).from : -Infinity;
    const to = bounds.to ? boundsFromKeys({ from: bounds.to, to: bounds.to }).to : Infinity;
    const base = records.filter((row) => {
      if (filters.manager && row.assignedManagerId !== filters.manager && row.salesManagerId !== filters.manager) return false;
      if (filters.pipeline && row.originPipeline !== filters.pipeline) return false;
      if (filters.source && row.source !== filters.source) return false;
      if (filters.stage && row.stage !== filters.stage) return false;
      if (filters.period && row.creationPeriod !== filters.period) return false;
      if (filters.sla && row.slaStatus !== filters.sla) return false;
      if (filters.processing && row.processingSource !== filters.processing) return false;
      if (search && !`${row.dealId} ${row.title}`.toLowerCase().includes(search)) return false;
      return true;
    });
    const cohort = base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= from && created <= to; });
    const won = base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= from && new Date(row.wonAt).getTime() <= to);
    const span = Number.isFinite(from) && Number.isFinite(to) ? Math.max(86_400_000, to - from + 1) : 0;
    const previousTo = from - 1; const previousFrom = previousTo - span + 1;
    const previousCohort = span ? base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= previousFrom && created <= previousTo; }) : [];
    const previousWon = span ? base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= previousFrom && new Date(row.wonAt).getTime() <= previousTo) : [];
    // The Trend needs the period itself, not just the records in it: its
    // calendar axis must include days on which nobody created a lead.
    const trendBounds = bounds.from && bounds.to ? { from: bounds.from, to: bounds.to } : null;
    const previousTrendBounds = span && trendBounds
      ? { from: localDateKey(new Date(previousFrom)), to: localDateKey(new Date(previousTo)) }
      : null;
    return { cohortFiltered: cohort, wonFiltered: won, previousCohortFiltered: previousCohort, previousWonFiltered: previousWon, trendBounds, previousTrendBounds, detailFiltered: [...new Map([...cohort, ...won].map((row) => [row.dealId, row])).values()] };
  }, [records, filters]);

  // The Managers page and Quality drill-down open the same canonical row
  // object; Quality does not build a parallel manager/profile model.
  const managerRows = useMemo(() => buildManagers(cohortFiltered, wonFiltered), [cohortFiltered, wonFiltered]);

  const cachedCurrentStages = useMemo<CurrentStageRecord[]>(() => records.filter((row) => row.salesStatus === "ACTIVE" && row.operationalPipeline).map((row) => ({
    dealId: row.dealId, title: row.title, createdAt: row.createdAt,
    assignedManagerId: row.assignedManagerId, assignedManager: row.assignedManager,
    categoryId: row.categoryId, pipeline: row.pipeline, stageId: row.stageId, stage: row.stage,
    stageEnteredAt: row.stageEnteredAt, stageAgeHours: row.stageAgeHours, stageLimitHours: row.stageLimitHours,
    stageOverdue: row.stageOverdue, bitrixUrl: row.bitrixUrl,
  })), [records]);
  const effectiveCurrentStages = currentStageRecords ?? cachedCurrentStages;
  const filteredCurrentStages = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    return effectiveCurrentStages.filter((row) => {
      if (filters.manager && row.assignedManagerId !== filters.manager) return false;
      if (filters.pipeline && row.pipeline !== filters.pipeline) return false;
      if (filters.stage && row.stage !== filters.stage) return false;
      if (search && !`${row.dealId} ${row.title}`.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [effectiveCurrentStages, filters.manager, filters.pipeline, filters.stage, filters.search]);
  // Same predicates as before, applied to the rows fetched for this view only.
  // The dashboard payload no longer carries stageTimeline, so the funnel reads
  // its own minimal records instead of the full cohort.
  const stageHistoricalRecords = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    return stageFunnelRecords.filter((row) => {
      if (filters.manager && row.assignedManagerId !== filters.manager && row.salesManagerId !== filters.manager) return false;
      if (filters.pipeline && row.originPipeline !== filters.pipeline) return false;
      if (search && !`${row.dealId} ${row.title}`.toLowerCase().includes(search)) return false;
      return true;
    });
  }, [stageFunnelRecords, filters.manager, filters.pipeline, filters.search]);

  async function postSync(body: Record<string, unknown>) {
    const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json() as SyncState & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Sinxronizatsiya bajarilmadi");
    setSync(payload);
    return payload;
  }
  async function syncLoop(mode: "start" | "resume", full = false, daysOverride?: number, pipelineId?: string) {
    if (!settings || syncLoopRef.current) return;
    syncLoopRef.current = true; setRefreshing(true); setLoadError(null);
    try {
      const activePipelineId = pipelineId || (settings.selectedPipelineIds.includes(syncPipelineId) ? syncPipelineId : settings.selectedPipelineIds[0]);
      let state = await postSync(mode === "start" ? { action: "start", days: daysOverride ?? Math.min(settings.historyDays, 30), full, pipelineId: activePipelineId } : { action: "resume" });
      while (syncLoopRef.current && state.status === "running") {
        state = await postSync({ action: "step", steps: 4 });
        if (state.status === "running") await new Promise((resolve) => window.setTimeout(resolve, 40));
      }
      if (!syncLoopRef.current && state.status === "running") await postSync({ action: "pause" });
      if (state.status === "success") await load();
    } catch (caught) { setLoadError(caught instanceof Error ? caught.message : "Sinxronizatsiya bajarilmadi"); }
    finally { syncLoopRef.current = false; setRefreshing(false); }
  }
  async function pauseCurrentSync() {
    syncLoopRef.current = false;
    try { await postSync({ action: "pause" }); } catch (caught) { setLoadError(caught instanceof Error ? caught.message : "Sync’ni pauza qilib bo‘lmadi"); }
  }
  function refresh() {
    if (sync.status === "running") void pauseCurrentSync();
    else {
      const pipelineId = settings?.selectedPipelineIds.includes(syncPipelineId) ? syncPipelineId : settings?.selectedPipelineIds[0];
      void syncLoop("start", false, Math.min(settings?.historyDays ?? 30, 30), pipelineId);
    }
  }
  async function saveSettings(next: DashboardSettings) {
    const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    const payload = await response.json() as { settings?: DashboardSettings; error?: string };
    if (!response.ok || !payload.settings) throw new Error(payload.error ?? "Sozlamalar saqlanmadi"); setSettings(normalizeSettings(payload.settings)); void loadCurrentStages();
  }
  async function saveAndFullSync(next: DashboardSettings, pipelineId: string) {
    await saveSettings(next);
    setSyncPipelineId(pipelineId);
    await syncLoop("start", true, next.historyDays, pipelineId);
  }
  useEffect(() => { syncRunnerRef.current = syncLoop; });

  useEffect(() => {
    if (!configured || !settings || sync.status !== "running" || refreshing || syncLoopRef.current) return;
    const timer = window.setTimeout(() => { void syncRunnerRef.current?.("resume"); }, 350);
    return () => window.clearTimeout(timer);
  }, [configured, settings, sync.status, refreshing]);
  useEffect(() => {
    if (!configured || !settings?.autoSyncMinutes) return;
    const interval = window.setInterval(() => {
      if (!syncLoopRef.current && ["idle", "success"].includes(sync.status)) {
        const pipelineId = settings.selectedPipelineIds[autoSyncIndexRef.current % Math.max(1, settings.selectedPipelineIds.length)];
        autoSyncIndexRef.current += 1;
        if (pipelineId) void syncRunnerRef.current?.("start", false, 30, pipelineId);
      }
    }, settings.autoSyncMinutes * 60_000);
    return () => window.clearInterval(interval);
  }, [configured, settings, sync.status]);

  if (loading) return <Skeleton />;
  if (!configured || (configured && !records.length && sync.status !== "success")) return <SetupScreen configured={configured} sync={sync} syncing={refreshing} externalError={loadError} onStart={() => void syncLoop("start", true, 30, settings?.selectedPipelineIds[0])} onPause={() => void pauseCurrentSync()} onResume={() => void syncLoop("resume")} />;
  if (!settings) return <div className="fatal-error"><XCircle /><p>Sozlamalar yuklanmadi.</p></div>;
  const title = view === "managerDetail" ? selectedManager?.name ?? "Menejer" : navItems.find((item) => item.id === view)?.label ?? "Dashboard";
  const openProject = projects.find((project) => project.id === openProjectId) ?? null;
  const projectStatusSuggestions = statusOptions(projects, projectUpdateRows);
  /** Leaving Settings with unsaved edits asks first. */
  function changeView(next: View) {
    // The guard reads `view` directly rather than the setState updater: the
    // updater runs after this function returns, so a flag set inside it is
    // still false here and the fetch below would never fire.
    if (view === "settings" && next !== "settings" && settingsDirty
      && !window.confirm("Sozlamalarda saqlanmagan o‘zgarishlar bor. Ularni tashlab ketilsinmi?")) return;
    setView(next);
    // Stage history is only needed by Stage Control, so it is fetched when the
    // user actually navigates there — once — rather than on the initial load.
    if (next === "stages") dispatchStageFunnel({ type: "OPEN" });
  }

  const openPage = pages.find((page) => page.id === openPageId) ?? null;
  const openPageWidgets = openPage ? pageWidgets(widgets, openPage.id) : [];
  const hasLegacyData = records.some((record) => record.analyticsVersion < ANALYTICS_VERSION);
  const syncOptions = settings.selectedPipelineIds.map((id, index) => ({ id, name: settings.selectedPipelineNames[index] ?? `Sales funnel #${id}` }));
  const activeSyncPipelineId = syncOptions.some((pipeline) => pipeline.id === syncPipelineId) ? syncPipelineId : syncOptions[0]?.id ?? "";

  return <div className="app-shell">
    <aside className={menuOpen ? "open" : ""}>
      <div className="brand"><div className="brand-mark">B24</div><div><strong>Deal Processing</strong><small>Sales analytics</small></div><button className="mobile-close" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
      <nav>{navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { if (item.id === "stages") setFilters((current) => ({ ...current, source: "", period: "", sla: "", processing: "" })); changeView(item.id); setMenuOpen(false); }}><item.icon size={18} /><span>{item.label}</span>{item.id === "diagnostics" && sync.permissions.stageHistory === "error" && <i />}</button>)}</nav>
      <div className="sidebar-status"><div><span className="live-dot" /><strong>Bitrix24 ulangan</strong></div><small>Oxirgi sync</small><p>{fmtDate(sync.lastSyncAt)}</p></div>
      <div className="sidebar-foot"><ShieldCheck size={16} /><span>Webhook server secret’da himoyalangan</span></div>
    </aside>
    {menuOpen && <button className="sidebar-backdrop" aria-label="Menyuni yopish" onClick={() => setMenuOpen(false)} />}
    <main className="content">
      <header className="topbar"><button className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><div><span>Bitrix24</span><small>/</small><strong>{title}</strong></div><div className="top-actions">{!isManagementView(view) && <><span className="sync-time">Oxirgi sinxronizatsiya: <strong>{fmtDate(sync.lastSyncAt)}</strong></span><Select label="Sinxronizatsiya funnel" value={activeSyncPipelineId} onChange={setSyncPipelineId}>{syncOptions.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</Select><button className="button secondary refresh" onClick={refresh}>{sync.status === "running" ? <TimerReset size={17} /> : refreshing ? <Loader2 size={17} className="spin" /> : <RefreshCw size={17} />}{sync.status === "running" ? "Pauza" : "Tanlangan funnelni sinxronlash"}</button></>}<div className="avatar">IM</div></div></header>
      <div className="content-inner">
        {loadError && <div className="notice error page-notice"><XCircle size={18} />{loadError}<button onClick={() => setLoadError(null)}><X size={14} /></button></div>}
        {hasLegacyData && sync.status !== "running" && <div className="notice warning page-notice"><AlertTriangle size={18} /><span>Eski sync ma’lumotlari bor. Yangi sales analytics to‘liq ishlashi uchun Sozlamalarda CRM field’larini tekshirib, <strong>“To‘liq qayta sync”</strong>ni bosing.</span><button onClick={() => setView("settings")}>Sozlamalar</button></div>}
        {["running", "paused", "error"].includes(sync.status) && <SyncProgress sync={sync} busy={refreshing} onPause={() => void pauseCurrentSync()} onResume={() => void syncLoop("resume")} />}
        {isSalesView(view) && <FiltersBar filters={filters} setFilters={setFilters} records={records} currentStages={effectiveCurrentStages} mode={view === "stages" ? "current" : "cohort"} />}
        {isSalesView(view) && <CoverageNotice records={records} filters={filters} />}
        <ViewErrorBoundary onBack={() => setView("dashboard")}>
        {view === "dashboard" && <><div className="page-title dashboard-title"><div><p className="eyebrow">SALES ANALYTICS</p><h1>Sales performance dashboard</h1><p>Tanlangan loyiha Sales + Обучение / Сопровождение bo‘yicha bitta oqim sifatida hisoblanadi.</p></div><div className="period-summary"><CalendarDays size={17} /><span>{rangeBounds(filters).from} — {rangeBounds(filters).to}</span><strong>{cohortFiltered.filter(isEligibleCohortDeal).length} Leadlar</strong></div></div><DashboardView records={cohortFiltered} salesRecords={wonFiltered} previousRecords={previousCohortFiltered} previousSalesRecords={previousWonFiltered} metricIds={settings.dashboardMetricIds} onManager={(manager) => { setSelectedManager(manager); setView("managerDetail"); }} /><TrendChart records={cohortFiltered} previousRecords={previousCohortFiltered} bounds={trendBounds} previousBounds={previousTrendBounds} /></>}
        {view === "managers" && <><div className="page-title"><div><p className="eyebrow">TEAM PERFORMANCE</p><h1>Menejerlar</h1><p>Lead, sifatsizlik, sales loss, sotuv soni va Opportunity kesimida.</p></div></div><section className="panel"><SectionHeader title="Menejerlar reytingi" subtitle="Lead va cohort konversiya — yaratilgan sana; davr sotuv — Oplata sanasi bo‘yicha" /><ManagerTable rows={managerRows} onSelect={(manager) => { setSelectedManager(manager); setView("managerDetail"); }} /></section></>}
        {view === "managerDetail" && selectedManager && <ManagerDetailView manager={selectedManager} cohortRecords={cohortFiltered} salesRecords={wonFiltered} currentStages={currentStageRecords} onBack={() => setView("managers")} />}
        {view === "leadFlow" && <LeadFlowView records={cohortFiltered} />}
        {view === "quality" && <QualityView records={cohortFiltered} onManager={(managerId) => {
          const manager = managerRows.find((row) => row.id === managerId);
          if (manager) { setSelectedManager(manager); setView("managerDetail"); }
        }} />}
        {view === "stages" && <StageControlView records={filteredCurrentStages} historicalRecords={stageHistoricalRecords} reconciliation={stageReconciliation} stageCatalog={stageCatalog} truncated={stageSnapshotTruncated} settings={settings} loading={currentStageLoading} error={currentStageError} onRefresh={() => void loadCurrentStages()} funnelStatus={stageFunnelStatus} onRetryFunnel={() => dispatchStageFunnel({ type: "RETRY" })} />}
        {view === "projects" && <ProjectsView projects={projects} updates={projectUpdateRows} filters={projectFilters} setFilters={setProjectFilters} busy={projectBusy}
          onOpen={(project) => { setOpenProjectId(project.id); setView("projectDetail"); }}
          onNew={() => setProjectDraft({ name: "", description: "", status: "", deadline: "" })} />}
        {view === "projectDetail" && openProject && <ProjectDetailView project={openProject} updates={projectUpdateRows} busy={projectBusy}
          onBack={() => { setOpenProjectId(null); setView("projects"); }}
          onEditProject={() => setProjectDraft({ id: openProject.id, name: openProject.name, description: openProject.description, status: openProject.status, deadline: openProject.deadline ?? "" })}
          onArchive={() => void projectAction({ action: openProject.archivedAt ? "restoreProject" : "archiveProject", id: openProject.id })}
          onNewUpdate={() => setUpdateDraft({ projectId: openProject.id, title: "", description: "", status: openProject.status, deadline: "" })}
          onEditUpdate={(update) => setUpdateDraft({ id: update.id, projectId: update.projectId, title: update.title, description: update.description, status: update.status, deadline: update.deadline ?? "" })}
          onDeleteUpdate={(update) => { if (window.confirm(`"${update.title}" update o‘chirilsinmi?`)) void projectAction({ action: "deleteUpdate", id: update.id }); }} />}
        {view === "pages" && <PagesListView pages={pages} widgets={widgets} search={pageSearch} setSearch={setPageSearch}
          includeArchived={pageIncludeArchived} setIncludeArchived={setPageIncludeArchived} busy={projectBusy}
          onOpen={(page) => { setOpenPageId(page.id); setPageEditing(false); setView("pageDetail"); }}
          onNew={() => setPageDraft({ name: "", description: "", audience: "", defaultRange: "30", defaultFrom: "", defaultTo: "" })}
          onTemplate={(templateId) => setTemplateDraft(templateId)} />}

        {view === "pageDetail" && openPage && <>
          <div className="page-title"><div>
            <button className="back-button" onClick={() => { setOpenPageId(null); setView("pages"); }}><ArrowLeft size={16} />Sahifalarga qaytish</button>
            <p className="eyebrow">{openPage.audience || "SAHIFA"}</p><h1>{openPage.name}</h1>
            <div className="project-meta">
              <span className="pill neutral">{pageRangeLabel(openPage.defaultRange, { from: openPage.defaultFrom, to: openPage.defaultTo })}</span>
              {openPage.archivedAt && <span className="archive-tag">Arxivlangan</span>}</div></div>
            <div className="settings-actions">
              <button className="button secondary" onClick={() => setPageEditing(!pageEditing)}>{pageEditing ? "Ko‘rish rejimi" : "Tahrirlash"}</button>
              <button className="button secondary" onClick={() => { setShareOpen(true); setShareDraft(null); setShareUrlOnce(null); }}><ExternalLink size={16} />Ulashish</button>
              {pageEditing && <>
                <button className="button secondary" onClick={() => setPageDraft({ id: openPage.id, name: openPage.name, description: openPage.description, audience: openPage.audience, defaultRange: openPage.defaultRange, defaultFrom: openPage.defaultFrom ?? "", defaultTo: openPage.defaultTo ?? "" })}><Settings size={16} />Sahifa sozlamasi</button>
                <button className="button secondary" disabled={projectBusy} onClick={() => void pageAction({ action: openPage.archivedAt ? "restorePage" : "archivePage", id: openPage.id })}>{openPage.archivedAt ? "Arxivdan chiqarish" : "Arxivlash"}</button>
                <button className="button secondary danger" disabled={projectBusy} onClick={() => { if (window.confirm(`"${openPage.name}" sahifasi butunlay o‘chirilsinmi? Bu amalni qaytarib bo‘lmaydi.`)) void pageAction({ action: "deletePage", id: openPage.id, confirm: true }).then(() => { setOpenPageId(null); setView("pages"); }); }}>O‘chirish</button>
              </>}
            </div></div>

          <div className={pageEditing ? "builder-shell" : ""}>
            {pageEditing && <WidgetPalette busy={projectBusy} onAdd={(type) => {
              const config = defaultWidgetConfig(type);
              if (NEEDS_CONFIG.includes(type)) {
                setWidgetDraft({ pageId: openPage.id, widgetType: type, title: WIDGET_REGISTRY.find((entry) => entry.type === type)?.label ?? "", config });
              } else {
                void pageAction({ action: "addWidget", pageId: openPage.id, widgetType: type, title: WIDGET_REGISTRY.find((entry) => entry.type === type)?.label ?? "", position: 0, config });
              }
            }} />}
            <div className="page-canvas">{openPageWidgets.map((widget, index) => <WidgetShell key={widget.id} widget={widget} editing={pageEditing}
              first={index === 0} last={index === openPageWidgets.length - 1} busy={projectBusy}
              onMove={(direction) => void pageAction({ action: "moveWidget", id: widget.id, pageId: openPage.id, direction })}
              onEdit={() => setWidgetDraft({ id: widget.id, pageId: openPage.id, widgetType: widget.widgetType, title: widget.title, config: widget.config })}
              onDelete={() => { if (window.confirm(`"${widget.title || widget.widgetType}" widgeti o‘chirilsinmi?`)) void pageAction({ action: "deleteWidget", id: widget.id, pageId: openPage.id }); }}>
              <WidgetBlock widget={widget} records={records} projects={projects} updates={projectUpdateRows} page={openPage} editing={pageEditing} />
            </WidgetShell>)}
            {!openPageWidgets.length && <div className="empty-state builder-empty"><strong>Sahifada hali widget yo‘q</strong>
              <p>{pageEditing ? "Chap tomondagi bloklardan birini qo‘shing." : "Tahrirlash rejimiga o‘ting va blok qo‘shing."}</p>
              {pageEditing && <div className="quick-adds">{(["SALES_KPI", "PROJECT_SUMMARY", "MANUAL_KPI", "TEXT_NOTE"] as WidgetType[]).map((type) => {
                const entry = WIDGET_REGISTRY.find((item) => item.type === type)!;
                return <button key={type} className="button secondary" disabled={projectBusy}
                  onClick={() => setWidgetDraft({ pageId: openPage.id, widgetType: type, title: entry.label, config: defaultWidgetConfig(type) })}>{entry.label}</button>;
              })}</div>}</div>}
            </div>
          </div>
        </>}

        {view === "deals" && <><div className="page-title"><div><p className="eyebrow">DETAIL REPORT</p><h1>Deal’lar</h1><p>Sotuv holati, sotuvchi attribution’i, stage yoshi va processing yagona jadvalda.</p></div></div><DealsTable records={detailFiltered} /></>}
        {view === "diagnostics" && <DiagnosticsView sync={sync} records={records} reconciliation={stageReconciliation} settings={settings} />}
        {view === "settings" && <SettingsView settings={settings} syncing={refreshing || sync.status === "running"} lastSyncAt={sync.lastSyncAt} onSave={saveSettings} onFullSync={saveAndFullSync} onDirtyChange={setSettingsDirty} />}
        </ViewErrorBoundary>
        <Drawer open={Boolean(pageDraft)} title={pageDraft?.id ? "Sahifa sozlamasi" : "Yangi sahifa"}
          context={pageDraft?.id ? pageDraft.name : "Auditoriya uchun dashboard"}
          dirty={Boolean(pageDraft && pageDraft.name.trim())} onClose={() => setPageDraft(null)}
          footer={<>
            <button className="button secondary" onClick={() => setPageDraft(null)} disabled={projectBusy}>Bekor qilish</button>
            <button className="button primary" disabled={projectBusy || !pageDraft || !pageDraftValid(pageDraft)} onClick={async () => {
              if (!pageDraft) return;
              const result = await pageAction({ action: pageDraft.id ? "updatePage" : "createPage", ...pageDraft });
              if (result) setPageDraft(null);
            }}>Saqlash</button></>}>
          {pageDraft && <div className="drawer-form">
            <FormField label="Nomi" required error={pageDraft.name.trim() ? null : "Sahifa nomi kerak"}>
              <TextInput data-autofocus value={pageDraft.name} error={pageDraft.name.trim() ? null : "required"}
                onChange={(event) => setPageDraft({ ...pageDraft, name: event.target.value })} /></FormField>
            <FormField label="Auditoriya" hint="Ixtiyoriy matn — CEO, Marketing, Sales…">
              <TextInput value={pageDraft.audience} onChange={(event) => setPageDraft({ ...pageDraft, audience: event.target.value })} /></FormField>
            <FormField label="Sana oralig‘i" hint="Sales widgetlar shu oraliqni meros oladi">
              <SelectInput value={pageDraft.defaultRange} onChange={(event) => setPageDraft({ ...pageDraft, defaultRange: event.target.value })}>
                {PAGE_RANGES.map((range) => <option key={range.id} value={range.id}>{range.label}</option>)}</SelectInput></FormField>
            {pageDraft.defaultRange === "custom" && <div className="range-pair">
              <FormField label="Boshlanish" required error={pageDraft.defaultFrom ? null : "Sana kerak"}>
                <DateInput value={pageDraft.defaultFrom} onChange={(event) => setPageDraft({ ...pageDraft, defaultFrom: event.target.value })} /></FormField>
              <FormField label="Tugash" required
                error={!pageDraft.defaultTo ? "Sana kerak" : pageDraft.defaultFrom && pageDraft.defaultFrom > pageDraft.defaultTo ? "Boshlanishdan keyin bo‘lishi kerak" : null}>
                <DateInput value={pageDraft.defaultTo} onChange={(event) => setPageDraft({ ...pageDraft, defaultTo: event.target.value })} /></FormField>
            </div>}
            <FormField label="Tavsif"><Textarea rows={5} value={pageDraft.description}
              onChange={(event) => setPageDraft({ ...pageDraft, description: event.target.value })} /></FormField>
          </div>}
        </Drawer>

        <Drawer open={shareOpen && Boolean(openPage)} title="Ulashish" context={openPage?.name}
          onClose={() => { setShareOpen(false); setShareDraft(null); setShareUrlOnce(null); }}
          footer={<button className="button secondary" onClick={() => { setShareOpen(false); setShareDraft(null); setShareUrlOnce(null); }}>Yopish</button>}>
          {openPage && <SharePanel page={openPage} widgets={openPageWidgets} shares={shares}
            draft={shareDraft} setDraft={setShareDraft} createdUrl={shareUrlOnce} dismissUrl={() => setShareUrlOnce(null)}
            busy={projectBusy}
            onRevoke={(share) => void shareAction({ action: "revokeShare", id: share.id })}
            onSubmit={(draft) => void shareAction(draft.id
              ? { action: "updateShare", id: draft.id, label: draft.label, expiresAt: draft.expiresAt, widgetIds: draft.widgetIds }
              : { action: "createShare", pageId: draft.pageId, label: draft.label, expiresAt: draft.expiresAt, widgetIds: draft.widgetIds })
              .then((url) => { setShareDraft(null); if (url) setShareUrlOnce(url); })} />}
        </Drawer>

        <Drawer open={Boolean(templateDraft)} title="Shablondan yaratish" context={templateById(templateDraft ?? "")?.name}
          onClose={() => setTemplateDraft(null)}
          footer={<>
            <button className="button secondary" onClick={() => setTemplateDraft(null)} disabled={projectBusy}>Bekor qilish</button>
            <button className="button primary" disabled={projectBusy} onClick={async () => {
              const id = await pageAction({ action: "createFromTemplate", templateId: templateDraft });
              if (typeof id === "string") { setTemplateDraft(null); setOpenPageId(id); setPageEditing(true); setView("pageDetail"); }
            }}>Shablondan yaratish</button></>}>
          {templateDraft && (() => { const template = templateById(templateDraft); if (!template) return null; return <div className="drawer-form">
            <div className="quality-grid">
              <div><span>Shablon</span><strong>{template.name}</strong></div>
              <div><span>Auditoriya</span><strong>{template.audience}</strong></div>
              <div><span>Sana oralig‘i</span><strong>Oxirgi 30 kun</strong></div>
            </div>
            <FormField label={`Yaratiladigan widgetlar (${template.widgets.length})`}>
              <ul className="template-widget-list">{template.widgets.map((widget, index) => <li key={`${widget.widgetType}-${index}`}>
                <span>{widget.title || WIDGET_REGISTRY.find((entry) => entry.type === widget.widgetType)?.label}</span>
                <SourceBadge source={widgetSource(widget.widgetType)} /></li>)}</ul></FormField>
            <p className="form-hint">Shablon faqat boshlang‘ich tuzilma — har bir widget keyin tahrirlanadi.</p>
          </div>; })()}
        </Drawer>

        <Drawer open={Boolean(widgetDraft)} title={widgetDraft?.id ? "Widget sozlamasi" : "Yangi widget"}
          context={widgetDraft ? WIDGET_REGISTRY.find((entry) => entry.type === widgetDraft.widgetType)?.label : undefined}
          dirty={false} onClose={() => setWidgetDraft(null)}
          footer={<>
            <button className="button secondary" onClick={() => setWidgetDraft(null)} disabled={projectBusy}>Bekor qilish</button>
            <button className="button primary" disabled={projectBusy || !widgetDraft || !widgetDraftValid(widgetDraft)} onClick={async () => {
              if (!widgetDraft) return;
              const result = await pageAction(widgetDraft.id
                ? { action: "updateWidget", id: widgetDraft.id, pageId: widgetDraft.pageId, widgetType: widgetDraft.widgetType, title: widgetDraft.title, config: widgetDraft.config }
                : { action: "addWidget", pageId: widgetDraft.pageId, widgetType: widgetDraft.widgetType, title: widgetDraft.title, position: 0, config: widgetDraft.config });
              if (result) setWidgetDraft(null);
            }}>Saqlash</button></>}>
          {widgetDraft && (() => {
            const config = widgetDraft.config;
            const setConfig = (patch: Record<string, unknown>) => setWidgetDraft({ ...widgetDraft, config: { ...config, ...patch } });
            const type = widgetDraft.widgetType;
            return <div className="drawer-form">
              <FormField label="Sarlavha"><TextInput data-autofocus value={widgetDraft.title}
                onChange={(event) => setWidgetDraft({ ...widgetDraft, title: event.target.value })} /></FormField>

              {type === "SECTION_HEADER" && <FormField label="Kichik sarlavha" hint="Ixtiyoriy">
                <TextInput value={String(config.subtitle ?? "")} onChange={(event) => setConfig({ subtitle: event.target.value })} /></FormField>}

              {type === "SALES_KPI" && <>
                <FormField label="Ko‘rsatkich" required hint="Bitrix’dagi kanonik ko‘rsatkichdan o‘qiladi">
                  <SelectInput value={String(config.metricId ?? "leads")} onChange={(event) => setConfig({ metricId: event.target.value })}>
                    {DASHBOARD_METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</SelectInput></FormField>
                <FormField label="Sana oralig‘i">
                  <SelectInput value={String(config.range ?? "")} onChange={(event) => setConfig({ range: event.target.value })}>
                    <option value="">Sahifa oralig‘idan foydalanish</option>
                    {PAGE_RANGES.map((range) => <option key={range.id} value={range.id}>{range.label}</option>)}</SelectInput></FormField>
                {config.range === "custom" && <div className="range-pair">
                  <FormField label="Boshlanish" required error={config.from ? null : "Sana kerak"}>
                    <DateInput value={String(config.from ?? "")} onChange={(event) => setConfig({ from: event.target.value })} /></FormField>
                  <FormField label="Tugash" required error={config.to ? null : "Sana kerak"}>
                    <DateInput value={String(config.to ?? "")} onChange={(event) => setConfig({ to: event.target.value })} /></FormField>
                </div>}
              </>}

              {(type === "PROJECT_SUMMARY" || type === "PROJECT_STATUS_BREAKDOWN") &&
                <p className="form-hint">Bu blokda sozlanadigan parametr yo‘q — u Loyihalar bo‘limidagi joriy ma’lumotni ko‘rsatadi. Faqat sarlavhani o‘zgartirishingiz mumkin.</p>}

              {type === "PROJECTS_LIST" && <>
                <FormField label="Status" hint="Bo‘sh — barcha statuslar">
                  <StatusCombobox value={String(config.status ?? "")} options={projectStatusSuggestions}
                    onChange={(value) => setConfig({ status: value })} /></FormField>
                <FormField label="Muddat holati">
                  <SelectInput value={String(config.deadline ?? "")} onChange={(event) => setConfig({ deadline: event.target.value })}>
                    {DEADLINE_STATES.map((state) => <option key={state.id} value={state.id}>{state.label}</option>)}</SelectInput></FormField>
                <CheckCard checked={config.includeArchived === true} title="Arxivlanganlarni ham ko‘rsatish"
                  onChange={(checked) => setConfig({ includeArchived: checked })} />
                <FormField label="Limit"><NumberInput min={1} max={50} value={Number(config.limit ?? 10)}
                  onChange={(event) => setConfig({ limit: Number(event.target.value) })} /></FormField>
              </>}

              {type === "LATEST_UPDATES" && <>
                <FormField label="Loyiha" hint="Bo‘sh — barcha loyihalar">
                  <SelectInput value={String(config.projectId ?? "")} onChange={(event) => setConfig({ projectId: event.target.value })}>
                    <option value="">Barcha loyihalar</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</SelectInput></FormField>
                <FormField label="Status" hint="Bo‘sh — barcha statuslar">
                  <StatusCombobox value={String(config.status ?? "")} options={projectStatusSuggestions}
                    onChange={(value) => setConfig({ status: value })} /></FormField>
                <FormField label="Limit"><NumberInput min={1} max={50} value={Number(config.limit ?? 5)}
                  onChange={(event) => setConfig({ limit: Number(event.target.value) })} /></FormField>
              </>}

              {type === "MANUAL_KPI" && <>
                <FormField label="Nomi" required><TextInput value={String(config.label ?? "")}
                  onChange={(event) => setConfig({ label: event.target.value })} /></FormField>
                <FormField label="Qiymat" hint="Qo‘lda kiritiladi — Bitrix’dan olinmaydi">
                  <TextInput value={String(config.value ?? "")} onChange={(event) => setConfig({ value: event.target.value })} /></FormField>
                <FormField label="Format">
                  <SelectInput value={String(config.format ?? "text")} onChange={(event) => setConfig({ format: event.target.value })}>
                    {MANUAL_KPI_FORMATS.map((format) => <option key={format} value={format}>{MANUAL_FORMAT_LABELS[format]}</option>)}</SelectInput></FormField>
                <FormField label="Birlik" hint="Masalan: UZS, %, ta"><TextInput value={String(config.unit ?? "")}
                  onChange={(event) => setConfig({ unit: event.target.value })} /></FormField>
                <FormField label="Izoh"><TextInput value={String(config.note ?? "")}
                  onChange={(event) => setConfig({ note: event.target.value })} /></FormField>
              </>}

              {type === "TEXT_NOTE" && <FormField label="Matn / izoh">
                <Textarea rows={10} value={String(config.body ?? "")} onChange={(event) => setConfig({ body: event.target.value })} /></FormField>}
            </div>;
          })()}
        </Drawer>

        {projectError && <div className="notice error page-notice"><XCircle size={18} />{projectError}<button onClick={() => setProjectError(null)}><X size={14} /></button></div>}
        <Drawer open={Boolean(projectDraft)} title={projectDraft?.id ? "Loyihani tahrirlash" : "Yangi loyiha"}
          context={projectDraft?.id ? projectDraft.name : "Marketing, Product yoki boshqa yo‘nalishdagi ish"}
          dirty={Boolean(projectDraft && (projectDraft.name.trim() || projectDraft.description.trim()))}
          onClose={() => setProjectDraft(null)}
          footer={<>
            <button className="button secondary" onClick={() => setProjectDraft(null)} disabled={projectBusy}>Bekor qilish</button>
            <button className="button primary" disabled={projectBusy || !projectDraft?.name.trim() || !projectDraft?.status.trim()} onClick={async () => {
              if (!projectDraft) return;
              const ok = await projectAction({ action: projectDraft.id ? "updateProject" : "createProject", id: projectDraft.id, name: projectDraft.name, description: projectDraft.description, status: projectDraft.status, deadline: projectDraft.deadline });
              if (ok) setProjectDraft(null);
            }}>Saqlash</button>
          </>}>
          {projectDraft && <div className="drawer-form">
            <FormField label="Nomi" required error={projectDraft.name.trim() ? null : "Loyiha nomi kerak"}>
              <TextInput data-autofocus value={projectDraft.name} error={projectDraft.name.trim() ? null : "required"}
                placeholder="Masalan: CAPI ulash" onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} /></FormField>
            <FormField label="Status" required hint="Ixtiyoriy matn — bo‘lim o‘z workflowini ishlatishi mumkin"
              error={projectDraft.status.trim() ? null : "Status kerak"}>
              <StatusCombobox value={projectDraft.status} options={projectStatusSuggestions} placeholder="Masalan: Jarayonda"
                onChange={(value) => setProjectDraft({ ...projectDraft, status: value })} /></FormField>
            <FormField label="Muddat" hint="Ixtiyoriy · Asia/Tashkent kalendar sanasi">
              <DateInput value={projectDraft.deadline} onChange={(event) => setProjectDraft({ ...projectDraft, deadline: event.target.value })} /></FormField>
            <FormField label="Tavsif" hint="Loyiha nima haqida ekanini qisqacha yozing">
              <Textarea rows={6} value={projectDraft.description} onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })} /></FormField>
          </div>}
        </Drawer>

        <Drawer open={Boolean(updateDraft)} title={updateDraft?.id ? "Update tahrirlash" : "Yangi update"}
          context={openProject?.name}
          dirty={Boolean(updateDraft && (updateDraft.title.trim() || updateDraft.description.trim()))}
          onClose={() => setUpdateDraft(null)}
          footer={<>
            <button className="button secondary" onClick={() => setUpdateDraft(null)} disabled={projectBusy}>Bekor qilish</button>
            <button className="button primary" disabled={projectBusy || !updateDraft?.title.trim() || !updateDraft?.status.trim()} onClick={async () => {
              if (!updateDraft) return;
              const ok = await projectAction({ action: updateDraft.id ? "updateUpdate" : "createUpdate", id: updateDraft.id, projectId: updateDraft.projectId, title: updateDraft.title, description: updateDraft.description, status: updateDraft.status, deadline: updateDraft.deadline });
              if (ok) setUpdateDraft(null);
            }}>Saqlash</button>
          </>}>
          {updateDraft && <div className="drawer-form">
            <FormField label="Nomi" required error={updateDraft.title.trim() ? null : "Update nomi kerak"}>
              <TextInput data-autofocus value={updateDraft.title} error={updateDraft.title.trim() ? null : "required"}
                onChange={(event) => setUpdateDraft({ ...updateDraft, title: event.target.value })} /></FormField>
            <FormField label="Status" required hint="Ixtiyoriy matn" error={updateDraft.status.trim() ? null : "Status kerak"}>
              <StatusCombobox value={updateDraft.status} options={projectStatusSuggestions}
                onChange={(value) => setUpdateDraft({ ...updateDraft, status: value })} /></FormField>
            <FormField label="Muddat" hint="Ixtiyoriy">
              <DateInput value={updateDraft.deadline} onChange={(event) => setUpdateDraft({ ...updateDraft, deadline: event.target.value })} /></FormField>
            <FormField label="Tavsif" hint="Nima o‘zgardi, nima to‘sqinlik qilmoqda">
              <Textarea rows={6} value={updateDraft.description} onChange={(event) => setUpdateDraft({ ...updateDraft, description: event.target.value })} /></FormField>
          </div>}
        </Drawer>

        <footer><span>Bitrix24 Deal Processing Dashboard</span><span>Timezone: Asia/Tashkent · Business minutes only</span></footer>
      </div>
    </main>
  </div>;
}
