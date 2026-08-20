"use client";

import {
  Activity, AlertTriangle, ArrowDownRight, ArrowLeft, ArrowUpRight, BarChart3, CalendarDays, Check,
  ChevronDown, Clock3, Database, Download, ExternalLink, Gauge, LayoutDashboard,
  Loader2, Menu, PhoneCall, RefreshCw, Search, Settings, ShieldCheck,
  SlidersHorizontal, TimerReset, Users, X, XCircle, CircleDollarSign, ClipboardList, Layers3,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyticsRecord, CrmFieldOption, DashboardSettings, PipelineOption, ProviderDiagnostic, SyncProgressState } from "@/lib/types";

type View = "dashboard" | "managers" | "managerDetail" | "leadFlow" | "quality" | "stages" | "deals" | "calls" | "diagnostics" | "settings";
type SyncState = SyncProgressState;
type Filters = {
  range: "today" | "yesterday" | "7" | "30" | "month" | "lastMonth" | "custom";
  from: string; to: string; manager: string; pipeline: string; source: string;
  stage: string; period: string; sla: string; processing: string; outcome: string;
  called: string; stageBeforeCall: string; search: string;
};

const emptyFilters: Filters = {
  range: "30", from: "", to: "", manager: "", pipeline: "", source: "",
  stage: "", period: "", sla: "", processing: "", outcome: "", called: "",
  stageBeforeCall: "", search: "",
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
  { id: "calls", label: "Qo‘ng‘iroqlar", icon: PhoneCall },
  { id: "diagnostics", label: "Diagnostika", icon: Activity },
  { id: "settings", label: "Sozlamalar", icon: Settings },
];

const outcomeColors: Record<string, string> = {
  "Ko‘tardi": "#16a46f", "Ko‘tarmadi": "#f59e0b", Band: "#ef8b2c",
  "Rad etdi": "#e34b52", "Bekor qilindi": "#9b6ed5", "Noto‘g‘ri raqam": "#7c879b",
  Ulanmadi: "#ef6a6a", Bloklangan: "#8f5aa9", "Noma’lum": "#a5adbb",
};

function pct(value: number, total: number) { return total ? Math.round((value / total) * 100) : 0; }
function average(values: (number | null)[]) {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}
function median(values: (number | null)[]) {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}
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
function hydrateRecord(row: AnalyticsRecord): AnalyticsRecord {
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
    stageTimeline: row.stageTimeline ?? [],
    salesManagerId: row.salesManagerId ?? null,
    salesManager: row.salesManager ?? null,
    salesManagerAttribution: row.salesManagerAttribution ?? "UNKNOWN",
  };
}
function markDuplicates(rows: AnalyticsRecord[]) {
  const firstByCustomer = new Map<string, string>();
  return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((row) => {
    if (!row.customerKey) return row;
    const first = firstByCustomer.get(row.customerKey);
    if (!first) firstByCustomer.set(row.customerKey, row.dealId);
    return { ...row, duplicateOfDealId: first ?? null };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function localDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function zonedCreationParts(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { weekday: weekdays[parts.weekday] ?? 0, hour: Number(parts.hour) };
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
  const checks = [["Bitrix24", result?.bitrix], ["Deal’lar", result?.deals], ["Activities", result?.activities], ["Stage history", result?.stageHistory], ["Menejerlar", result?.managers], ["Telephony", result?.telephony]];

  return <main className="setup-page">
    <div className="setup-brand"><span>B24</span><strong>Deal Processing</strong></div>
    <section className="setup-card">
      <div className="setup-icon"><ShieldCheck size={30} /></div><p className="eyebrow">XAVFSIZ SERVER ULANISHI</p>
      <h1>{configured ? "Bitrix24 ulanishini tekshiring" : "Bitrix24 webhook ulanmagan."}</h1>
      <p className="setup-copy">{configured ? "Webhook serverda topildi. Faqat IBOX Sales va SD Sales pipeline’lari eng yangi Deal’dan boshlab paketlarda sinxronlanadi; call center pipeline’lari olinmaydi." : <>Site Secrets ichiga <code>BITRIX24_WEBHOOK_URL</code> qo‘shing. Webhook brauzerga, loglarga yoki dashboard javoblariga chiqarilmaydi.</>}</p>
      <div className="setup-steps">
        <div><span>1</span><p><strong>Incoming webhook yarating</strong><small>CRM o‘qish va qisqa user ma’lumoti ruxsatlari</small></p></div>
        <div><span>2</span><p><strong>Secret sifatida qo‘shing</strong><small>BITRIX24_WEBHOOK_URL</small></p></div>
        <div><span>3</span><p><strong>Ulanishni tekshiring</strong><small>Telephony bo‘lmasa ham asosiy SLA ishlaydi</small></p></div>
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
    <p className="privacy-note">Telefon raqamlar, email, yozuvlar va call recording’lar olinmaydi.</p>
  </main>;
}

function KpiCard({ label, value, detail, tone = "blue", icon: Icon }: { label: string; value: string; detail: React.ReactNode; tone?: string; icon: typeof Activity }) {
  return <article className={`kpi-card ${tone}`}><div className="kpi-top"><span>{label}</span><div className="kpi-icon"><Icon size={18} /></div></div><strong>{value}</strong><small>{detail}</small></article>;
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

type ManagerRow = {
  id: string; name: string; deals: number; avg: number | null; median: number | null;
  firstCall: number | null; callPct: number; answeredPct: number; stageOnly: number;
  noProcessing: number; beforeCall: number; successTime: number | null;
  lowQuality: number; lost: number; active: number; sales: number; cohortSales: number; amount: number; conversion: number;
  avgCheck: number | null; medianCheck: number | null; salesCycle: number | null;
};

function buildManagers(records: AnalyticsRecord[], wonRecords: AnalyticsRecord[] = records.filter((row) => row.salesStatus === "WON")): ManagerRow[] {
  const grouped = new Map<string, AnalyticsRecord[]>(); const wonGrouped = new Map<string, AnalyticsRecord[]>();
  for (const record of records) {
    const key = record.salesManagerId || "unknown";
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  for (const record of wonRecords) {
    const key = record.salesManagerId || "unknown"; wonGrouped.set(key, [...(wonGrouped.get(key) ?? []), record]);
  }
  const ids = new Set([...grouped.keys(), ...wonGrouped.keys()]);
  return [...ids].map((id) => { const rows = grouped.get(id) ?? []; const won = wonGrouped.get(id) ?? []; return ({
    id, name: rows[0]?.salesManager ?? won[0]?.salesManager ?? "Aniqlanmagan", deals: rows.length,
    avg: average(rows.map((row) => row.processingBusinessMinutes)),
    median: median(rows.map((row) => row.processingBusinessMinutes)),
    firstCall: average(rows.map((row) => row.firstCallBusinessMinutes)),
    callPct: pct(rows.filter((row) => row.outgoingCallCount > 0).length, rows.length),
    answeredPct: pct(rows.filter((row) => row.firstCallOutcome === "Ko‘tardi").length, rows.filter((row) => row.outgoingCallCount > 0).length),
    stageOnly: rows.filter((row) => row.processingSource === "STAGE_CHANGE").length,
    noProcessing: rows.filter((row) => row.processingSource === "NO_PROCESSING").length,
    beforeCall: rows.filter((row) => row.stageChangedBeforeCall).length,
    successTime: average(rows.map((row) => row.firstSuccessfulCallBusinessMinutes)),
    lowQuality: rows.filter((row) => row.lossReasonGroup === "MARKETING").length,
    lost: rows.filter((row) => row.salesStatus === "LOST").length,
    active: rows.filter((row) => row.salesStatus === "ACTIVE").length,
    sales: won.length, cohortSales: rows.filter((row) => row.salesStatus === "WON").length, amount: won.reduce((sum, row) => sum + row.opportunity, 0),
    conversion: pct(rows.filter((row) => row.salesStatus === "WON").length, rows.length),
    avgCheck: average(won.map((row) => row.opportunity)), medianCheck: median(won.map((row) => row.opportunity)),
    salesCycle: average(won.map((row) => row.salesCycleHours)),
  }); }).sort((a, b) => b.sales - a.sales || b.conversion - a.conversion);
}

function ManagerTable({ rows, onSelect }: { rows: ManagerRow[]; onSelect: (manager: ManagerRow) => void }) {
  const [sort, setSort] = useState<keyof ManagerRow>("sales");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const aValue = a[sort]; const bValue = b[sort];
    const compared = typeof aValue === "string" ? aValue.localeCompare(String(bValue)) : Number(aValue ?? Infinity) - Number(bValue ?? Infinity);
    return direction === "asc" ? compared : -compared;
  }), [rows, sort, direction]);
  function setColumn(column: keyof ManagerRow) {
    if (sort === column) setDirection(direction === "asc" ? "desc" : "asc");
    else { setSort(column); setDirection("asc"); }
  }
  const header = (label: string, key: keyof ManagerRow) => <button onClick={() => setColumn(key)}>{label}{sort === key && (direction === "asc" ? " ↑" : " ↓")}</button>;
  return <div className="table-wrap"><table className="data-table manager-table"><thead><tr>
    <th>{header("Sotuvchi", "name")}</th><th>{header("Lead", "deals")}</th><th>{header("Davr sotuv", "sales")}</th><th>{header("Cohort sotuv", "cohortSales")}</th><th>{header("Summa", "amount")}</th>
    <th>{header("Konversiya", "conversion")}</th><th>{header("Sifatsiz", "lowQuality")}</th><th>{header("Sotilmadi", "lost")}</th><th>{header("Aktiv", "active")}</th>
    <th>{header("Avg obrabotka", "avg")}</th><th>{header("Call %", "callPct")}</th><th>{header("No processing", "noProcessing")}</th>
  </tr></thead><tbody>{sorted.map((row) => <tr key={row.id} onClick={() => onSelect(row)}>
    <td><div className="manager-cell"><span>{row.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><strong>{row.name}</strong></div></td>
    <td>{row.deals}</td><td><strong className="success-text">{row.sales}</strong></td><td>{row.cohortSales}</td><td>{row.amount.toLocaleString("uz-UZ")}</td>
    <td><span className="pill success">{row.conversion}%</span></td><td><span className={row.lowQuality ? "warning-text" : ""}>{row.lowQuality}</span></td>
    <td><span className={row.lost ? "danger-text" : ""}>{row.lost}</span></td><td>{row.active}</td><td>{fmtMinutes(row.avg)}</td>
    <td><span className="pill neutral">{row.callPct}%</span></td><td><span className={row.noProcessing ? "danger-text" : ""}>{row.noProcessing}</span></td>
  </tr>)}</tbody></table>{!rows.length && <div className="empty-table">Tanlangan filtr bo‘yicha menejerlar topilmadi.</div>}</div>;
}

function FiltersBar({ filters, setFilters, records }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>; records: AnalyticsRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const managers = [...new Map(records.flatMap((row) => [[row.assignedManagerId, row.assignedManager] as const, ...(row.salesManagerId ? [[row.salesManagerId, row.salesManager ?? "Aniqlanmagan"] as const] : [])])).entries()];
  const pipelines = [...new Set(records.map((row) => row.originPipeline))].sort();
  const sources = [...new Set(records.map((row) => row.source))].sort();
  const stages = [...new Set(records.map((row) => row.stage))].sort();
  const set = (key: keyof Filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = Object.entries(filters).filter(([key, value]) => !["range", "search", "from", "to"].includes(key) && value).length;
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
      <Select label="SLA" value={filters.sla} onChange={(value) => set("sla", value)}><option value="">SLA: barchasi</option><option value="ON_TIME">SLA ichida</option><option value="LATE">Kechikkan</option><option value="NO_PROCESSING">Obrabotka qilinmagan</option></Select>
      <Select label="Obrabotka usuli" value={filters.processing} onChange={(value) => set("processing", value)}><option value="">Obrabotka: barchasi</option><option value="OUTGOING_CALL">Outgoing call</option><option value="STAGE_CHANGE">Stage change</option><option value="NO_PROCESSING">Obrabotka yo‘q</option></Select>
      <Select label="Call outcome" value={filters.outcome} onChange={(value) => set("outcome", value)}><option value="">Call outcome: barchasi</option>{Object.keys(outcomeColors).map((value) => <option key={value}>{value}</option>)}</Select>
      <Select label="Call attempted" value={filters.called} onChange={(value) => set("called", value)}><option value="">Call attempted: barchasi</option><option value="yes">Ha</option><option value="no">Yo‘q</option></Select>
      <Select label="Status call’dan oldin" value={filters.stageBeforeCall} onChange={(value) => set("stageBeforeCall", value)}><option value="">Status → call: barchasi</option><option value="yes">Ha</option><option value="no">Yo‘q</option></Select>
    </div>}
  </div>;
}

function DashboardView({ records, salesRecords, previousRecords, previousSalesRecords, onManager }: { records: AnalyticsRecord[]; salesRecords: AnalyticsRecord[]; previousRecords: AnalyticsRecord[]; previousSalesRecords: AnalyticsRecord[]; onManager: (manager: ManagerRow) => void }) {
  const processed = records.filter((row) => row.processingBusinessMinutes !== null);
  const called = records.filter((row) => row.outgoingCallCount > 0);
  const answered = records.filter((row) => row.firstCallOutcome === "Ko‘tardi");
  const noProcessing = records.filter((row) => row.processingSource === "NO_PROCESSING");
  const stageOnly = records.filter((row) => row.processingSource === "STAGE_CHANGE");
  const afterHours = records.filter((row) => row.creationPeriod === "AFTER_HOURS");
  const slaOnTime = processed.filter((row) => row.slaStatus === "ON_TIME");
  const managers = buildManagers(records, salesRecords);
  const lowQuality = records.filter((row) => row.lossReasonGroup === "MARKETING");
  const routing = records.filter((row) => row.lossReasonGroup === "ROUTING");
  const lost = records.filter((row) => row.lossReasonGroup === "SALES");
  const active = records.filter((row) => row.salesStatus === "ACTIVE");
  const qualified = records.filter((row) => row.qualified);
  const cohortSales = records.filter((row) => row.salesStatus === "WON");
  const salesAmount = salesRecords.reduce((sum, row) => sum + row.opportunity, 0);
  const previousAmount = previousSalesRecords.reduce((sum, row) => sum + row.opportunity, 0);
  const duplicates = records.filter((row) => row.duplicateOfDealId);
  const segment = (rows: AnalyticsRecord[]) => ({
    count: rows.length, avg: average(rows.map((row) => row.processingBusinessMinutes)),
    median: median(rows.map((row) => row.processingBusinessMinutes)),
    call: pct(rows.filter((row) => row.outgoingCallCount > 0).length, rows.length),
    answered: pct(rows.filter((row) => row.firstCallOutcome === "Ko‘tardi").length, rows.filter((row) => row.outgoingCallCount > 0).length),
    no: pct(rows.filter((row) => row.processingSource === "NO_PROCESSING").length, rows.length),
  });
  const workSegment = segment(records.filter((row) => row.creationPeriod === "WORK_HOURS"));
  const afterSegment = segment(afterHours);
  return <>
    <section className="kpi-grid sales-kpis">
      <KpiCard label="Yangi lead" value={String(records.length)} detail={<><MetricDelta current={records.length} previous={previousRecords.length} /> · yaratilgan sana</>} icon={Database} />
      <KpiCard label="Qabul qilingan SQL" value={String(qualified.length)} detail={`${pct(qualified.length, records.length)}% sifatli lead`} icon={Check} tone="green" />
      <KpiCard label="Marketing sifatsiz" value={String(lowQuality.length)} detail="Not Relevant · routing kirmaydi" icon={AlertTriangle} tone="amber" />
      <KpiCard label="Routing" value={String(routing.length)} detail="IDOKO / SD / boshqa yo‘naltirish" icon={RefreshCw} tone="slate" />
      <KpiCard label="Sotilmadi" value={String(lost.length)} detail="Sifatli deb qabul qilingan, yopilgan" icon={XCircle} tone="red" />
      <KpiCard label="Aktiv lead" value={String(active.length)} detail="Hozir sales bosqichlarida" icon={Layers3} tone="violet" />
      <KpiCard label="Cohort sotuv" value={String(cohortSales.length)} detail={`${pct(cohortSales.length, records.length)}% shu davr lead → sotuv`} icon={CircleDollarSign} tone="green" />
      <KpiCard label="Davr sotuv" value={String(salesRecords.length)} detail={<><MetricDelta current={salesRecords.length} previous={previousSalesRecords.length} /> · Oplata sanasi</>} icon={CircleDollarSign} tone="cyan" />
      <KpiCard label="Sotuv summasi" value={salesAmount.toLocaleString("uz-UZ")} detail={<><MetricDelta current={salesAmount} previous={previousAmount} /> · {salesRecords[0]?.currencyId || "Bitrix valyutasi"}</>} icon={CircleDollarSign} tone="indigo" />
    </section>
    <SectionHeader title="Savdo iqtisodi va data sifati" subtitle="OPPORTUNITY — haqiqiy sotuv summasi; telefon raqami saqlanmaydi" />
    <section className="kpi-grid economy-kpis">
      <KpiCard label="O‘rtacha chek" value={(average(salesRecords.map((row) => row.opportunity)) ?? 0).toLocaleString("uz-UZ", { maximumFractionDigits: 0 })} detail="Tanlangan davr sotuvlari" icon={CircleDollarSign} tone="green" />
      <KpiCard label="Median chek" value={(median(salesRecords.map((row) => row.opportunity)) ?? 0).toLocaleString("uz-UZ", { maximumFractionDigits: 0 })} detail="Katta cheklar ta’sirini kamaytiradi" icon={Gauge} tone="indigo" />
      <KpiCard label="Savdo sikli" value={fmtHours(average(salesRecords.map((row) => row.salesCycleHours)))} detail="Deal yaratilishidan Oplata’gacha" icon={TimerReset} tone="violet" />
      <KpiCard label="Takroriy lead" value={String(duplicates.length)} detail={`${pct(duplicates.length, records.length)}% · Contact ID, keyin Company ID`} icon={Database} tone="amber" />
    </section>
    <SectionHeader title="Lead processing" subtitle="Quyidagi KPI’lar faqat IBOX Sales va SD Sales’dagi yangi leadlar bo‘yicha" />
    <section className="kpi-grid">
      <KpiCard label="Jami Deal" value={String(records.length)} detail="Tanlangan davr" icon={Database} />
      <KpiCard label="O‘rtacha obrabotka" value={fmtMinutes(average(records.map((row) => row.processingBusinessMinutes)))} detail="Faqat ish minutlari" icon={Clock3} tone="indigo" />
      <KpiCard label="Median obrabotka" value={fmtMinutes(median(records.map((row) => row.processingBusinessMinutes)))} detail="Ekstremal qiymatlarsiz markaz" icon={TimerReset} tone="violet" />
      <KpiCard label="SLA ichida" value={`${pct(slaOnTime.length, processed.length)}%`} detail={`${slaOnTime.length} / ${processed.length} obrabotka`} icon={Gauge} tone="green" />
      <KpiCard label="Qo‘ng‘iroq qilingan" value={`${pct(called.length, records.length)}%`} detail={`${called.length} ta Deal`} icon={PhoneCall} tone="cyan" />
      <KpiCard label="Faqat status orqali" value={String(stageOnly.length)} detail="Call yo‘q, stage change bor" icon={RefreshCw} tone="amber" />
      <KpiCard label="Obrabotka qilinmagan" value={String(noProcessing.length)} detail={`${pct(noProcessing.length, records.length)}% jami Deal’dan`} icon={AlertTriangle} tone="red" />
      <KpiCard label="Ish vaqtidan tashqarida" value={String(afterHours.length)} detail={`${pct(afterHours.length, records.length)}% jami Deal’dan`} icon={CalendarDays} tone="slate" />
    </section>
    <section className="dashboard-grid two-one">
      <article className="panel"><SectionHeader title="Obrabotka usuli" subtitle="Birinchi real harakat bo‘yicha" /><BarList rows={[
        { label: "Outgoing call", value: called.length, total: records.length, color: "#246bfd", icon: "📞" },
        { label: "Stage change", value: stageOnly.length, total: records.length, color: "#8a5dd1", icon: "🔄" },
        { label: "Obrabotka yo‘q", value: noProcessing.length, total: records.length, color: "#ef5962", icon: "⚠️" },
      ]} /></article>
      <article className="panel sla-panel"><SectionHeader title="Call funnel" subtitle="Outgoing call javobdan qat’i nazar processing hisoblanadi" />
        <div className="funnel-row"><span>Jami yangi Deal</span><strong>{records.length}</strong></div><div className="funnel-arrow">↓</div>
        <div className="funnel-row primary"><span>Outgoing call attempted</span><strong>{called.length}</strong><small>{pct(called.length, records.length)}%</small></div>
        <div className="funnel-split"><div><Check size={16} /><span>Ko‘tardi</span><strong>{answered.length}</strong></div><div><X size={16} /><span>Ko‘tarmadi / boshqa</span><strong>{called.length - answered.length}</strong></div></div>
        <div className="funnel-foot"><span>Status only <strong>{stageOnly.length}</strong></span><span>No processing <strong>{noProcessing.length}</strong></span></div>
      </article>
    </section>
    <section className="dashboard-grid two-one">
      <article className="panel"><SectionHeader title="Birinchi qo‘ng‘iroq natijasi" subtitle="Telephony ruxsati bo‘lmasa ‘Noma’lum’ ko‘rsatiladi" /><BarList rows={Object.keys(outcomeColors).map((label) => ({ label, value: records.filter((row) => row.firstCallOutcome === label).length, total: called.length, color: outcomeColors[label] })).filter((row) => row.value > 0)} /></article>
      <article className="panel compact-kpis"><SectionHeader title="Qo‘ng‘iroq KPI" />
        <div><span>O‘rtacha first call</span><strong>{fmtMinutes(average(records.map((row) => row.firstCallBusinessMinutes)))}</strong></div>
        <div><span>Mijoz ko‘targan</span><strong className="success-text">{pct(answered.length, called.length)}%</strong></div>
        <div><span>Mijoz ko‘tarmagan</span><strong>{pct(called.length - answered.length, called.length)}%</strong></div>
        <div><span>Qo‘ng‘iroqdan oldin status</span><strong className="warning-text">{records.filter((row) => row.stageChangedBeforeCall).length}</strong></div>
      </article>
    </section>
    <section className="panel"><SectionHeader title="Ish vaqti vs. ish vaqtidan tashqari" subtitle="After-hours SLA keyingi ish davri ochilishidan boshlanadi" />
      <div className="segment-grid">{[
        { title: "Ish vaqtida tushgan Deal’lar", data: workSegment, tone: "work" },
        { title: "Ish vaqtidan tashqarida tushgan", data: afterSegment, tone: "after" },
      ].map(({ title, data, tone }) => <div className={`segment-card ${tone}`} key={title}>
        <div className="segment-title"><span>{tone === "work" ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}</span><div><strong>{title}</strong><small>{data.count} ta Deal</small></div></div>
        <div className="segment-metrics"><div><span>Avg obrabotka</span><strong>{fmtMinutes(data.avg)}</strong></div><div><span>Median</span><strong>{fmtMinutes(data.median)}</strong></div><div><span>Call attempt</span><strong>{data.call}%</strong></div><div><span>Answered</span><strong>{data.answered}%</strong></div><div><span>No processing</span><strong>{data.no}%</strong></div></div>
      </div>)}</div>
    </section>
    <section className="panel"><SectionHeader title="Menejerlar performance" subtitle="Qatorni bossangiz dashboard shu menejer bo‘yicha filtrlanadi" /><ManagerTable rows={managers.slice(0, 8)} onSelect={onManager} /></section>
  </>;
}

function TrendChart({ records }: { records: AnalyticsRecord[] }) {
  const [metric, setMetric] = useState("avg");
  const days = useMemo(() => {
    const map = new Map<string, AnalyticsRecord[]>();
    for (const row of records) { const key = localDateKey(new Date(row.createdAt)); map.set(key, [...(map.get(key) ?? []), row]); }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([date, rows]) => ({
      date, avg: average(rows.map((row) => row.processingBusinessMinutes)) ?? 0,
      median: median(rows.map((row) => row.processingBusinessMinutes)) ?? 0,
      sla: pct(rows.filter((row) => row.slaStatus === "ON_TIME").length, rows.filter((row) => row.processingBusinessMinutes !== null).length),
      calls: pct(rows.filter((row) => row.outgoingCallCount > 0).length, rows.length), count: rows.length,
    }));
  }, [records]);
  const max = Math.max(1, ...days.map((row) => Number(row[metric as keyof typeof row])));
  return <section className="panel"><SectionHeader title="Trend" subtitle="Kunlik dinamikasi" action={<Select label="Trend metrikasi" value={metric} onChange={setMetric}><option value="avg">Avg obrabotka</option><option value="median">Median</option><option value="sla">SLA %</option><option value="calls">Call %</option><option value="count">Deal soni</option></Select>} />
    <div className="trend-chart">{days.map((row) => { const current = row as unknown as Record<string, string | number>; const value = Number(current[metric]); return <div className="trend-column" key={row.date} title={`${row.date}: ${Math.round(value)}`}><span style={{ height: `${Math.max(4, (value / max) * 100)}%` }} /><small>{row.date.slice(8)}</small></div>; })}</div>
    {!days.length && <div className="empty-chart">Trend uchun ma’lumot yo‘q.</div>}
  </section>;
}

function ManagerDetailView({ manager, cohortRecords, salesRecords, onBack }: { manager: ManagerRow; cohortRecords: AnalyticsRecord[]; salesRecords: AnalyticsRecord[]; onBack: () => void }) {
  const belongs = (row: AnalyticsRecord) => (row.salesManagerId || "unknown") === manager.id;
  const leads = cohortRecords.filter(belongs); const sales = salesRecords.filter(belongs);
  const qualified = leads.filter((row) => row.qualified); const active = leads.filter((row) => row.salesStatus === "ACTIVE");
  const marketing = leads.filter((row) => row.lossReasonGroup === "MARKETING"); const lost = leads.filter((row) => row.lossReasonGroup === "SALES");
  const amount = sales.reduce((sum, row) => sum + row.opportunity, 0);
  const sources = groupedCount(leads, (row) => row.source).map((source) => ({
    ...source,
    sql: qualified.filter((row) => row.source === source.label).length,
    low: marketing.filter((row) => row.source === source.label).length,
    lost: lost.filter((row) => row.source === source.label).length,
    sales: sales.filter((row) => row.source === source.label).length,
  }));
  const reasons = groupedCount(leads.filter((row) => row.lossReasonGroup !== "NONE"), (row) => `${row.lossReasonGroup === "MARKETING" ? "Marketing" : row.lossReasonGroup === "ROUTING" ? "Routing" : "Sales"} · ${row.lossReason}`);
  const stageRows = groupedCount(active, (row) => row.stage).map((stage) => ({ ...stage, overdue: active.filter((row) => row.stage === stage.label && row.stageOverdue).length }));
  return <><div className="page-title manager-detail-title"><div><button className="back-button" onClick={onBack}><ArrowLeft size={16} />Menejerlarga qaytish</button><p className="eyebrow">INDIVIDUAL PERFORMANCE</p><h1>{manager.name}</h1><p>Lead manbasi, SQL, sotuv, yo‘qotish, stage yuklamasi va tezlik bitta profilga jamlandi.</p></div><div className="manager-identity"><span>{manager.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><div><strong>{manager.name}</strong><small>{manager.id === "unknown" ? "Sotuvchi aniqlanmagan" : `Bitrix user #${manager.id}`}</small></div></div></div>
    <section className="kpi-grid sales-kpis"><KpiCard label="Yangi lead" value={String(leads.length)} detail="Tanlangan cohort" icon={Database} /><KpiCard label="SQL" value={String(qualified.length)} detail={`${pct(qualified.length, leads.length)}% qabul qilingan`} icon={Check} tone="green" /><KpiCard label="Davr sotuv" value={String(sales.length)} detail={`${pct(leads.filter((row) => row.salesStatus === "WON").length, leads.length)}% cohort konversiya`} icon={CircleDollarSign} tone="cyan" /><KpiCard label="Sotuv summasi" value={amount.toLocaleString("uz-UZ")} detail={sales[0]?.currencyId || "Bitrix valyutasi"} icon={CircleDollarSign} tone="indigo" /><KpiCard label="Marketing sifatsiz" value={String(marketing.length)} detail={`${pct(marketing.length, leads.length)}% lead’dan`} icon={AlertTriangle} tone="amber" /><KpiCard label="Sales loss" value={String(lost.length)} detail={`${pct(lost.length, qualified.length)}% SQL’dan`} icon={XCircle} tone="red" /><KpiCard label="Savdo sikli" value={fmtHours(average(sales.map((row) => row.salesCycleHours)))} detail="Yaratilishdan Oplata’gacha" icon={TimerReset} tone="violet" /><KpiCard label="First contact" value={fmtMinutes(average(leads.map((row) => row.processingBusinessMinutes)))} detail={`${leads.filter((row) => row.processingSource === "NO_PROCESSING").length} ta harakatsiz lead`} icon={PhoneCall} tone="slate" /></section>
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Qaysi source’dan nechta lead" subtitle="Sotuv — Oplata sanasi, qolganlari lead yaratilgan sanasi" /><div className="table-wrap"><table className="data-table"><thead><tr><th>Source</th><th>Lead</th><th>SQL</th><th>Sifatsiz</th><th>Sales loss</th><th>Sotuv</th></tr></thead><tbody>{sources.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.value}</td><td>{row.sql}</td><td>{row.low}</td><td>{row.lost}</td><td><strong className="success-text">{row.sales}</strong></td></tr>)}</tbody></table></div></article><article className="panel"><SectionHeader title="Aktiv stage yuklamasi" subtitle="Qizil raqam — limitdan oshgan" /><div className="stage-load-list">{stageRows.map((row) => <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong><small className={row.overdue ? "danger-text" : ""}>{row.overdue} overdue</small></div>)}{!stageRows.length && <div className="empty-table">Aktiv lead yo‘q.</div>}</div></article></section>
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Sabablar profili" subtitle="Marketing / Sales / Routing alohida" /><BarList rows={reasons.slice(0, 15).map((row) => ({ ...row, total: reasons.reduce((sum, item) => sum + item.value, 0), color: row.label.startsWith("Marketing") ? "#f59e0b" : row.label.startsWith("Routing") ? "#8a5dd1" : "#ef5962" }))} /></article><article className="panel compact-kpis"><SectionHeader title="Chek va aloqa sifati" /><div><span>O‘rtacha chek</span><strong>{(average(sales.map((row) => row.opportunity)) ?? 0).toLocaleString("uz-UZ", { maximumFractionDigits: 0 })}</strong></div><div><span>Median chek</span><strong>{(median(sales.map((row) => row.opportunity)) ?? 0).toLocaleString("uz-UZ", { maximumFractionDigits: 0 })}</strong></div><div><span>Call attempted</span><strong>{pct(leads.filter((row) => row.outgoingCallCount > 0).length, leads.length)}%</strong></div><div><span>SLA ichida</span><strong>{pct(leads.filter((row) => row.slaStatus === "ON_TIME").length, leads.filter((row) => row.processingBusinessMinutes !== null).length)}%</strong></div></article></section>
  </>;
}

function LeadFlowView({ records }: { records: AnalyticsRecord[] }) {
  const weekdays = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, rows: records.filter((row) => zonedCreationParts(row.createdAt).hour === hour) }));
  const dayRows = weekdays.map((label, weekday) => ({ label, rows: records.filter((row) => zonedCreationParts(row.createdAt).weekday === weekday) }));
  const maxHour = Math.max(1, ...hours.map((row) => row.rows.length));
  const peakHours = [...hours].sort((a, b) => b.rows.length - a.rows.length).slice(0, 3);
  const busiestDay = [...dayRows].sort((a, b) => b.rows.length - a.rows.length)[0];
  const afterHours = records.filter((row) => row.creationPeriod === "AFTER_HOURS");
  const noProcessingAtPeak = peakHours.flatMap((row) => row.rows).filter((row) => row.processingSource === "NO_PROCESSING").length;
  const heat = weekdays.map((label, weekday) => ({ label, cells: Array.from({ length: 12 }, (_, bucket) => records.filter((row) => { const part = zonedCreationParts(row.createdAt); return part.weekday === weekday && Math.floor(part.hour / 2) === bucket; })) }));
  const heatMax = Math.max(1, ...heat.flatMap((row) => row.cells.map((cell) => cell.length)));
  const dailyMap = new Map<string, number>();
  for (const row of records) { const key = localDateKey(new Date(row.createdAt)); dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1); }
  const daily = [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-45).map(([date, count]) => ({ date, count }));
  const dailyMax = Math.max(1, ...daily.map((row) => row.count));
  return <><div className="page-title"><div><p className="eyebrow">STAFFING ANALYTICS</p><h1>Deal yaratilish dinamikasi</h1><p>Qaysi kun va soatda lead oqimi oshishini ko‘rib, sotuvchilar smenasini talabga moslang.</p></div></div>
    <section className="kpi-grid"><KpiCard label="Peak soat" value={peakHours[0] ? `${String(peakHours[0].hour).padStart(2, "0")}:00` : "—"} detail={`${peakHours[0]?.rows.length ?? 0} ta lead`} icon={Clock3} tone="indigo" /><KpiCard label="Eng band kun" value={busiestDay?.label ?? "—"} detail={`${busiestDay?.rows.length ?? 0} ta lead`} icon={CalendarDays} tone="blue" /><KpiCard label="After-hours" value={`${pct(afterHours.length, records.length)}%`} detail={`${afterHours.length} ta lead ish vaqtidan tashqari`} icon={TimerReset} tone="amber" /><KpiCard label="Peak’da harakatsiz" value={String(noProcessingAtPeak)} detail="Top-3 soatda no processing" icon={AlertTriangle} tone="red" /></section>
    <section className="panel"><SectionHeader title="Hafta kuni × 2 soat heatmap" subtitle="To‘q rang — lead hajmi yuqori. Vaqt Asia/Tashkent bo‘yicha." /><div className="heatmap-wrap"><div className="heatmap-head"><span />{Array.from({ length: 12 }, (_, bucket) => <small key={bucket}>{String(bucket * 2).padStart(2, "0")}:00</small>)}</div>{heat.map((row) => <div className="heatmap-row" key={row.label}><strong>{row.label.slice(0, 3)}</strong>{row.cells.map((cell, bucket) => { const alpha = cell.length ? 0.14 + (cell.length / heatMax) * 0.78 : 0.04; return <span key={bucket} title={`${row.label}, ${String(bucket * 2).padStart(2, "0")}:00–${String(bucket * 2 + 2).padStart(2, "0")}:00 · ${cell.length} lead`} style={{ backgroundColor: `rgba(36, 107, 253, ${alpha})`, color: alpha > .55 ? "white" : "#526078" }}>{cell.length || ""}</span>; })}</div>)}</div></section>
    <section className="panel"><SectionHeader title="Kunlik Deal dinamikasi" subtitle="Oxirgi 45 kalendar kun; ustun ustiga borsangiz aniq son ko‘rinadi" /><div className="daily-flow-chart">{daily.map((row) => <div key={row.date} title={`${row.date} · ${row.count} lead`}><span style={{ height: `${Math.max(5, (row.count / dailyMax) * 100)}%` }} /><small>{row.date.slice(5)}</small></div>)}</div>{!daily.length && <div className="empty-chart">Kunlik dinamika uchun ma’lumot yo‘q.</div>}</section>
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Soatlik lead hajmi" subtitle="24 soatlik taqsimot" /><div className="hour-chart">{hours.map((row) => <div key={row.hour} title={`${String(row.hour).padStart(2, "0")}:00 · ${row.rows.length} lead`}><span style={{ height: `${Math.max(row.rows.length ? 8 : 2, (row.rows.length / maxHour) * 100)}%` }} /><small>{row.hour % 2 === 0 ? String(row.hour).padStart(2, "0") : ""}</small></div>)}</div></article><article className="panel"><SectionHeader title="Smena uchun tavsiya" subtitle="Tanlangan davrdagi real oqimdan hisoblandi" /><div className="staffing-callout"><BarChart3 size={24} /><div><strong>{peakHours.map((row) => `${String(row.hour).padStart(2, "0")}:00`).join(", ")} oralig‘ini kuchaytiring</strong><p>Top-3 soatda jami {peakHours.reduce((sum, row) => sum + row.rows.length, 0)} ta lead tushgan. {afterHours.length ? `Ish vaqtidan tashqari ${afterHours.length} ta lead bor — navbatchi yoki kechki smenani sinab ko‘ring.` : "After-hours oqimi past, asosiy smenani peak soatlarga jamlash mumkin."}</p></div></div><BarList rows={dayRows.map((row) => ({ label: row.label, value: row.rows.length, total: records.length, color: "#246bfd" }))} /></article></section>
  </>;
}

function CallsView({ records }: { records: AnalyticsRecord[] }) {
  const buckets = [["0–5 min", 0, 5], ["5–10 min", 6, 10], ["10–15 min", 11, 15], ["15–30 min", 16, 30], ["30–60 min", 31, 60], ["1–2 ish soati", 61, 120], ["2+ ish soati", 121, Infinity]] as const;
  const bucketRows: { label: string; value: number; total: number; color: string }[] = buckets.map(([label, min, max]) => ({ label, value: records.filter((row) => row.processingBusinessMinutes !== null && row.processingBusinessMinutes >= min && row.processingBusinessMinutes <= max).length, total: records.length, color: "#246bfd" }));
  bucketRows.push({ label: "Obrabotka yo‘q", value: records.filter((row) => row.processingBusinessMinutes === null).length, total: records.length, color: "#ef5962" });
  return <><div className="page-title"><div><p className="eyebrow">CALL ANALYTICS</p><h1>Qo‘ng‘iroqlar</h1><p>Birinchi urinish SLA’ni to‘xtatadi; javob natijasi alohida tahlil qilinadi.</p></div></div>
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Response time distribution" subtitle="Faqat business minutes" /><BarList rows={bucketRows} /></article><article className="panel"><SectionHeader title="Call outcome" /><BarList rows={Object.keys(outcomeColors).map((label) => ({ label, value: records.filter((row) => row.firstCallOutcome === label).length, total: records.filter((row) => row.outgoingCallCount > 0).length, color: outcomeColors[label] })).filter((row) => row.value > 0)} /></article></section>
    <TrendChart records={records} /></>;
}

function DealsTable({ records }: { records: AnalyticsRecord[] }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"createdAt" | "processingBusinessMinutes">("createdAt");
  const perPage = 20;
  const sorted = useMemo(() => [...records].sort((a, b) => sort === "createdAt" ? b.createdAt.localeCompare(a.createdAt) : Number(a.processingBusinessMinutes ?? Infinity) - Number(b.processingBusinessMinutes ?? Infinity)), [records, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const safePage = Math.min(page, pages);
  const rows = sorted.slice((safePage - 1) * perPage, safePage * perPage);
  function exportCsv() {
    const headers = ["Deal ID", "Deal nomi", "Yaratilgan vaqt", "Deal mas’uli", "Sales pipeline", "Current pipeline", "Current stage", "Stage age hours", "Stage limit hours", "Sales status", "SQL at", "Sales manager", "Seller attribution", "Won at", "Sales cycle hours", "Opportunity", "Currency", "Failure group", "Failure reason", "Source", "Duplicate of", "First outgoing call", "First call outcome", "Processing business minutes", "SLA status"];
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines: unknown[][] = [headers, ...sorted.map((row) => [row.dealId, row.title, row.createdAt, row.assignedManager, row.originPipeline, row.pipeline, row.stage, row.stageAgeHours, row.stageLimitHours, row.salesStatus, row.qualifiedAt, row.salesManager, row.salesManagerAttribution, row.wonAt, row.salesCycleHours, row.opportunity, row.currencyId, row.lossReasonGroup, row.lossReason, row.source, row.duplicateOfDealId, row.firstCallAt, row.firstCallOutcome, row.processingBusinessMinutes, row.slaStatus])];
    const blob = new Blob(["\ufeff", lines.map((line) => line.map(quote).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `bitrix-deals-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="panel deals-panel"><SectionHeader title="Detailed Deal report" subtitle={`${records.length} ta Deal`} action={<div className="table-actions"><Select label="Saralash" value={sort} onChange={(value) => setSort(value as typeof sort)}><option value="createdAt">Yangi Deal</option><option value="processingBusinessMinutes">Eng tez obrabotka</option></Select><button className="button small secondary" onClick={exportCsv}><Download size={16} />CSV export</button></div>} />
    <div className="table-wrap"><table className="data-table deal-table"><thead><tr><th>Deal</th><th>Sotuv holati</th><th>Mas’ul / sotuvchi</th><th>Pipeline / Stage</th><th>Stage yoshi</th><th>Source / sabab</th><th>First call</th><th>Processing</th><th>SLA</th></tr></thead><tbody>{rows.map((row) => <tr key={row.dealId}>
      <td><div className="deal-name"><strong>{row.title}</strong>{row.bitrixUrl ? <a href={row.bitrixUrl} target="_blank" rel="noreferrer">#{row.dealId}<ExternalLink size={12} /></a> : <small>#{row.dealId}</small>}</div></td>
      <td><span className={`pill ${row.salesStatus === "WON" ? "success" : row.salesStatus === "LOST" ? "danger" : row.salesStatus === "LOW_QUALITY" ? "warning" : "neutral"}`}>{row.salesStatus === "WON" ? "Sotilgan" : row.salesStatus === "LOST" ? "Sotilmadi" : row.salesStatus === "LOW_QUALITY" ? "Sifatsiz" : "Aktiv"}</span><small>{row.wonAt ? fmtDate(row.wonAt) : fmtDate(row.createdAt)}{row.duplicateOfDealId ? ` · duplicate #${row.duplicateOfDealId}` : ""}</small></td>
      <td><span>{row.salesManager ?? "Aniqlanmagan"}</span><small>{row.salesManagerAttribution} · hozir: {row.assignedManager}</small></td><td><span>{row.originPipeline}</span><small>{row.stage}{row.qualifiedAt ? ` · SQL ${fmtDate(row.qualifiedAt)}` : ""}</small></td>
      <td><span className={row.stageOverdue ? "danger-text" : ""}>{Math.round(row.stageAgeHours)} soat</span><small>Limit: {row.stageLimitHours} soat</small></td>
      <td><span>{row.source}</span><small>{row.lossReasonGroup !== "NONE" ? `${row.lossReasonGroup} · ${row.lossReason}` : row.lossReason || "—"}</small></td>
      <td><span>{fmtDate(row.firstCallAt)}</span><small>{row.firstCallManager ?? "—"} · {row.firstCallOutcome}</small></td>
      <td><span className="source-pill">{row.processingSource === "OUTGOING_CALL" ? "📞 Call" : row.processingSource === "STAGE_CHANGE" ? "🔄 Stage" : "⚠️ Yo‘q"}</span><small>{fmtMinutes(row.processingBusinessMinutes)}</small></td>
      <td><span className={`pill ${row.slaStatus === "ON_TIME" ? "success" : row.slaStatus === "LATE" ? "warning" : "danger"}`}>{row.slaStatus === "ON_TIME" ? "SLA ichida" : row.slaStatus === "LATE" ? "Kechikkan" : "Obrabotka yo‘q"}</span></td>
    </tr>)}</tbody></table>{!rows.length && <div className="empty-table">Tanlangan filtr bo‘yicha Deal topilmadi.</div>}</div>
    <div className="pagination"><span>{safePage} / {pages} sahifa</span><div><button disabled={safePage <= 1} onClick={() => setPage((value) => value - 1)}>Oldingi</button><button disabled={safePage >= pages} onClick={() => setPage((value) => value + 1)}>Keyingi</button></div></div>
  </section>;
}

function groupedCount(records: AnalyticsRecord[], key: (row: AnalyticsRecord) => string) {
  const counts = new Map<string, number>();
  for (const row of records) { const label = key(row) || "Ko‘rsatilmagan"; counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function QualityView({ records }: { records: AnalyticsRecord[] }) {
  const low = records.filter((row) => row.lossReasonGroup === "MARKETING");
  const lost = records.filter((row) => row.lossReasonGroup === "SALES");
  const routing = records.filter((row) => row.lossReasonGroup === "ROUTING");
  const lowReasons = groupedCount(low, (row) => row.lossReason); const lostReasons = groupedCount(lost, (row) => row.lossReason);
  const routingReasons = groupedCount(routing, (row) => row.lossReason);
  const managerReasons = groupedCount([...low, ...lost], (row) => `${row.salesManager ?? "Aniqlanmagan"} · ${row.lossReason}`);
  const sources = groupedCount(records, (row) => row.source).map((source) => ({ ...source, low: low.filter((row) => row.source === source.label).length, lost: lost.filter((row) => row.source === source.label).length, routing: routing.filter((row) => row.source === source.label).length }));
  return <><div className="page-title"><div><p className="eyebrow">LEAD QUALITY</p><h1>Lead sifati va yo‘qotish sabablari</h1><p>Marketing sifatsizligi va sotuvda yo‘qotilgan sifatli leadlar aralashtirilmaydi.</p></div></div>
    <section className="kpi-grid"><KpiCard label="Not Relevant" value={String(low.length)} detail={`${pct(low.length, records.length)}% · marketing sifati`} icon={AlertTriangle} tone="amber" /><KpiCard label="Sales loss" value={String(lost.length)} detail={`${pct(lost.length, records.length)}% · SQL qabul qilingan`} icon={XCircle} tone="red" /><KpiCard label="Routing" value={String(routing.length)} detail="IDOKO / SD va boshqa yo‘naltirish" icon={RefreshCw} tone="violet" /><KpiCard label="Sababsiz yopilgan" value={String([...low, ...lost].filter((row) => row.lossReason === "Sabab ko‘rsatilmagan").length)} detail="Причина провала to‘ldirilmagan" icon={ClipboardList} tone="slate" /></section>
    <section className="quality-three"><article className="panel"><SectionHeader title="Marketing sifatsizligi sabablari" subtitle="Faqat haqiqiy Not Relevant" /><BarList rows={lowReasons.map((row) => ({ ...row, total: low.length, color: "#f59e0b" }))} /></article><article className="panel"><SectionHeader title="Sales’da sotilmagan sabablar" subtitle="SQL bo‘lgan, lekin sotilmagan" /><BarList rows={lostReasons.map((row) => ({ ...row, total: lost.length, color: "#ef5962" }))} /></article><article className="panel"><SectionHeader title="Routing sabablari" subtitle="Marketing sifatsizligiga qo‘shilmaydi" /><BarList rows={routingReasons.map((row) => ({ ...row, total: routing.length, color: "#8a5dd1" }))} /></article></section>
    <section className="panel"><SectionHeader title="Qaysi sabab qaysi menejerda ko‘p" subtitle="Menejer + Причина провала kombinatsiyasi" /><BarList rows={managerReasons.slice(0, 15).map((row) => ({ ...row, total: low.length + lost.length, color: "#8a5dd1" }))} /></section>
    <section className="panel"><SectionHeader title="Source bo‘yicha sifat" subtitle="Marketing kanal custom field; topilmasa standart Source" /><div className="table-wrap"><table className="data-table"><thead><tr><th>Source</th><th>Lead</th><th>Not Relevant</th><th>Sifatsizlik %</th><th>Sales loss</th><th>Routing</th></tr></thead><tbody>{sources.map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.value}</td><td>{row.low}</td><td><span className="pill warning">{pct(row.low, row.value)}%</span></td><td>{row.lost}</td><td>{row.routing}</td></tr>)}</tbody></table></div></section>
  </>;
}

function StageControlView({ records }: { records: AnalyticsRecord[] }) {
  const active = records.filter((row) => row.salesStatus === "ACTIVE" && row.operationalPipeline);
  const overdue = active.filter((row) => row.stageOverdue);
  const stages = [...new Set(active.map((row) => row.stage))].sort(); const managers = [...new Set(active.map((row) => row.salesManager ?? "Aniqlanmagan"))].sort();
  const stageStats = groupedCount(active, (row) => row.stage);
  const funnelMap = new Map<string, { pipeline: string; stage: string; entered: number; advanced: number; dropOff: number; durations: number[]; order: number[] }>();
  for (const row of records) {
    const timeline = row.stageTimeline.filter((entry) => entry.categoryId === row.originCategoryId);
    timeline.forEach((entry, index) => {
      const key = `${entry.categoryId}:${entry.stageId}`; const current = funnelMap.get(key) ?? { pipeline: entry.pipeline, stage: entry.stage, entered: 0, advanced: 0, dropOff: 0, durations: [], order: [] };
      current.entered += 1; current.durations.push(entry.durationHours); current.order.push(index);
      const hasNext = Boolean(timeline[index + 1]);
      if (hasNext || (!hasNext && row.salesStatus === "WON")) current.advanced += 1;
      if (!hasNext && ["LOW_QUALITY", "LOST"].includes(row.salesStatus)) current.dropOff += 1;
      funnelMap.set(key, current);
    });
  }
  const funnelRows = [...funnelMap.values()].sort((a, b) => a.pipeline.localeCompare(b.pipeline) || (average(a.order) ?? 0) - (average(b.order) ?? 0));
  return <><div className="page-title"><div><p className="eyebrow">PIPELINE CONTROL</p><h1>Stage nazorati</h1><p>Har bir menejerda qaysi bosqichda nechta lead turgani va limitdan oshganlari.</p></div></div>
    <section className="kpi-grid"><KpiCard label="Aktiv lead" value={String(active.length)} detail="IBOX Sales + SD Sales" icon={Layers3} /><KpiCard label="Limitdan oshgan" value={String(overdue.length)} detail={`${pct(overdue.length, active.length)}% aktiv lead`} icon={AlertTriangle} tone="red" /><KpiCard label="Eng eski lead" value={active.length ? `${Math.round(Math.max(...active.map((row) => row.stageAgeHours)))} soat` : "—"} detail="Joriy stage’da" icon={Clock3} tone="amber" /></section>
    <section className="panel"><SectionHeader title="Sotuvchi × stage" subtitle="Custom sales manager → first call → stage mover → current responsible attribution’i" /><div className="table-wrap"><table className="data-table stage-matrix"><thead><tr><th>Sotuvchi</th>{stages.map((stage) => <th key={stage}>{stage}</th>)}<th>Jami</th></tr></thead><tbody>{managers.map((manager) => { const rows = active.filter((row) => (row.salesManager ?? "Aniqlanmagan") === manager); return <tr key={manager}><td><strong>{manager}</strong></td>{stages.map((stage) => { const cell = rows.filter((row) => row.stage === stage); return <td key={stage}><span className={cell.some((row) => row.stageOverdue) ? "pill danger" : "pill neutral"}>{cell.length}</span></td>; })}<td><strong>{rows.length}</strong></td></tr>; })}</tbody></table></div></section>
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Stage bo‘yicha yuklama" /><BarList rows={stageStats.map((row) => ({ ...row, total: active.length, color: "#246bfd" }))} /></article><article className="panel"><SectionHeader title="Limitdan oshgan Deal’lar" subtitle="Sozlamadagi har bir stage limiti bo‘yicha" /><div className="stuck-list">{overdue.sort((a, b) => b.stageAgeHours - a.stageAgeHours).slice(0, 20).map((row) => <a key={row.dealId} href={row.bitrixUrl ?? undefined} target="_blank" rel="noreferrer"><span><strong>{row.title}</strong><small>{row.assignedManager} · {row.stage}</small></span><b>{Math.round(row.stageAgeHours)} / {row.stageLimitHours} soat</b></a>)}{!overdue.length && <div className="empty-table">Limitdan oshgan aktiv Deal yo‘q.</div>}</div></article></section>
    <section className="panel"><SectionHeader title="To‘liq stage funnel" subtitle="Bosqichga kirgan, keyingisiga o‘tgan, tushib qolgan va shu bosqichda sarflangan vaqt" /><div className="table-wrap"><table className="data-table"><thead><tr><th>Pipeline</th><th>Stage</th><th>Kirgan</th><th>Keyingi / sotuv</th><th>Konversiya</th><th>Drop-off</th><th>Avg vaqt</th><th>Median vaqt</th></tr></thead><tbody>{funnelRows.map((row) => <tr key={`${row.pipeline}:${row.stage}`}><td>{row.pipeline}</td><td><strong>{row.stage}</strong></td><td>{row.entered}</td><td>{row.advanced}</td><td><span className="pill success">{pct(row.advanced, row.entered)}%</span></td><td><span className={row.dropOff ? "pill danger" : "pill neutral"}>{row.dropOff}</span></td><td>{fmtHours(average(row.durations))}</td><td>{fmtHours(median(row.durations))}</td></tr>)}</tbody></table>{!funnelRows.length && <div className="empty-table">Stage history sync qilingandan keyin funnel ko‘rinadi.</div>}</div></section>
  </>;
}

function DiagnosticsView({ sync, providers, records, onProviderChange }: { sync: SyncState; providers: ProviderDiagnostic[]; records: AnalyticsRecord[]; onProviderChange: (key: string, mode: string) => void }) {
  const permissions = [["Deal API", sync.permissions.deals], ["Activity API", sync.permissions.activities], ["Stage history", sync.permissions.stageHistory], ["User API", sync.permissions.managers], ["Telephony / Call Statistics", sync.permissions.telephony]];
  const qualities = [["Deals without activities", records.filter((row) => row.outgoingCallCount === 0).length], ["Deals without stage history", records.filter((row) => !row.stageTimeline.length).length], ["Calls without outcome data", records.filter((row) => row.outgoingCallCount > 0 && row.firstCallOutcome === "Noma’lum").length], ["Missing sales manager", records.filter((row) => !row.salesManagerId).length], ["Missing failure reason", records.filter((row) => ["LOW_QUALITY", "LOST"].includes(row.salesStatus) && row.lossReason === "Sabab ko‘rsatilmagan").length], ["Seller fallback: current responsible", records.filter((row) => row.salesManagerAttribution === "CURRENT_RESPONSIBLE").length], ["Duplicate leads", records.filter((row) => row.duplicateOfDealId).length], ["Data unavailable", records.filter((row) => row.dataUnavailable).length]] as const;
  return <><div className="page-title"><div><p className="eyebrow">ADMIN</p><h1>Diagnostika</h1><p>API ruxsatlari, call provider’lar va data quality nazorati.</p></div></div>
    {sync.permissions.telephony !== "ok" && <div className="notice warning page-notice"><AlertTriangle size={18} />Qo‘ng‘iroq natijasini aniqlash uchun Bitrix Telephony / Call Statistics ruxsati kerak. SLA va first outgoing call analytics ishlashda davom etadi.</div>}
    <section className="dashboard-grid two-one"><article className="panel"><SectionHeader title="Bitrix24 ruxsatlari" /><div className="permission-list">{permissions.map(([label, state]) => <div key={label}><StatusDot state={state ?? "error"} /><span>{label}</span><strong>{state === "ok" ? "Tayyor" : state === "warning" ? "Cheklangan" : "Tekshirish kerak"}</strong></div>)}</div></article>
      <article className="panel"><SectionHeader title="Data counts" /><div className="diagnostic-counts"><div><span>Deal</span><strong>{sync.counts.deals ?? records.length}</strong></div><div><span>Activity</span><strong>{sync.counts.activities ?? 0}</strong></div><div><span>Outgoing calls</span><strong>{sync.counts.outgoingCalls ?? 0}</strong></div><div><span>Stage history</span><strong>{sync.counts.stageHistory ?? 0}</strong></div><div><span>Telephony</span><strong>{sync.counts.telephony ?? 0}</strong></div></div></article>
    </section>
    <section className="panel"><SectionHeader title="Call providers" subtitle="AUTO — Bitrix type va direction bo‘yicha aniqlaydi. USE / IGNORE keyingi sync’da qo‘llanadi." /><div className="table-wrap"><table className="data-table"><thead><tr><th>PROVIDER_ID</th><th>PROVIDER_TYPE_ID</th><th>TYPE_ID</th><th>DIRECTION</th><th>Count</th><th>Sample subject</th><th>Holat</th></tr></thead><tbody>{providers.map((provider) => <tr key={provider.key}><td><code>{provider.providerId}</code></td><td><code>{provider.providerTypeId}</code></td><td>{provider.typeId}</td><td>{provider.direction}</td><td>{provider.count}</td><td>{provider.sampleSubject}</td><td><Select label="Provider holati" value={provider.mode} onChange={(mode) => onProviderChange(provider.key, mode)}><option value="AUTO">Auto</option><option value="USE">Use</option><option value="IGNORE">Ignore</option></Select></td></tr>)}</tbody></table>{!providers.length && <div className="empty-table">Providerlar birinchi sync’dan keyin ko‘rinadi.</div>}</div></section>
    <section className="panel"><SectionHeader title="Data Quality" subtitle="No processing va data unavailable alohida hisoblanadi" /><div className="quality-grid">{qualities.map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong></div>)}</div></section>
    {sync.safeError && <div className="notice error page-notice"><XCircle size={18} />{sync.safeError}</div>}
  </>;
}

function SettingsView({ settings, syncing, onSave, onFullSync }: { settings: DashboardSettings; syncing: boolean; onSave: (settings: DashboardSettings) => Promise<void>; onFullSync: (settings: DashboardSettings, pipelineId: string) => Promise<void> }) {
  const [draft, setDraft] = useState(settings); const [holiday, setHoliday] = useState("");
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]); const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [fields, setFields] = useState<CrmFieldOption[]>([]); const [stages, setStages] = useState<PipelineOption[]>([]);
  const [customFieldCount, setCustomFieldCount] = useState(0);
  const days = [[1, "Dushanba"], [2, "Seshanba"], [3, "Chorshanba"], [4, "Payshanba"], [5, "Juma"], [6, "Shanba"], [0, "Yakshanba"]] as const;
  useEffect(() => {
    void fetch("/api/pipelines", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { pipelines?: PipelineOption[]; selectedIds?: string[]; reportingIds?: string[]; fields?: CrmFieldOption[]; customFieldCount?: number; stages?: PipelineOption[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Pipeline’lar yuklanmadi");
      const options = payload.pipelines ?? [];
      setPipelines(options);
      setFields(payload.fields ?? []); setCustomFieldCount(payload.customFieldCount ?? 0); setStages(payload.stages ?? []);
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
  function togglePipeline(pipeline: PipelineOption, checked: boolean) {
    const selected = checked
      ? [...pipelines.filter((item) => draft.selectedPipelineIds.includes(item.id)), pipeline]
      : pipelines.filter((item) => draft.selectedPipelineIds.includes(item.id) && item.id !== pipeline.id);
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()].slice(0, 2);
    setDraft({ ...draft, selectedPipelineIds: unique.map((item) => item.id), selectedPipelineNames: unique.map((item) => item.name) });
  }
  function toggleReporting(pipeline: PipelineOption, checked: boolean) {
    const selected = checked ? [...pipelines.filter((item) => draft.postSalePipelineIds.includes(item.id)), pipeline] : pipelines.filter((item) => draft.postSalePipelineIds.includes(item.id) && item.id !== pipeline.id);
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()].slice(0, 2);
    setDraft({ ...draft, postSalePipelineIds: unique.map((item) => item.id), postSalePipelineNames: unique.map((item) => item.name) });
  }
  async function save() { setSaving(true); setSaved(false); await onSave(draft); setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2500); }
  async function fullSync(pipelineId: string) { setSaving(true); setSaved(false); try { await onFullSync(draft, pipelineId); } finally { setSaving(false); } }
  const fieldOptions = fields.map((field) => <option key={field.key} value={field.key}>{field.title}{field.sampleValue ? ` · namuna: ${field.sampleValue}` : ""}</option>);
  const validConfig = draft.selectedPipelineIds.length === 2 && draft.postSalePipelineIds.length === 2;
  return <><div className="page-title"><div><p className="eyebrow">ADMIN</p><h1>Sozlamalar</h1><p>Sales pipeline, CRM field’lari va hisoblash qoidalari.</p></div><div className="settings-actions"><button className="button primary" onClick={save} disabled={saving || !validConfig}>{saving ? <Loader2 size={17} className="spin" /> : saved ? <Check size={17} /> : <Settings size={17} />}{saved ? "Saqlandi" : "Sozlamalarni saqlash"}</button></div></div>
    <section className="panel pipeline-settings"><SectionHeader title="Sales pipeline’lar" subtitle="Aynan 2 ta funnel tanlanadi. Qolganlari, jumladan call center pipeline’lari sync qilinmaydi." />
      {pipelineError && <div className="notice error"><XCircle size={17} />{pipelineError}</div>}
      <div className="pipeline-options">{pipelines.map((pipeline) => { const checked = draft.selectedPipelineIds.includes(pipeline.id); return <label key={pipeline.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} disabled={!checked && draft.selectedPipelineIds.length >= 2} onChange={(event) => togglePipeline(pipeline, event.target.checked)} /><span><Check size={15} /></span><div><strong>{pipeline.name}</strong><small>ID: {pipeline.id}</small></div></label>; })}{!pipelines.length && !pipelineError && <small>Bitrix’dan pipeline’lar yuklanmoqda…</small>}</div>
      <div className={`pipeline-selection-note ${draft.selectedPipelineIds.length === 2 ? "ok" : "warning"}`}>{draft.selectedPipelineIds.length === 2 ? `Tanlangan: ${draft.selectedPipelineNames.join(" + ")}` : "Davom etish uchun aynan 2 ta sales pipeline tanlang."}</div>
    </section>
    <section className="panel pipeline-settings"><SectionHeader title="Sotuvni tasdiqlovchi post-sale funnel’lar" subtitle="Faqat sotuvni topish uchun: IBOX va SD Обучение / Сопровождение. Call center hisobga olinmaydi." />
      <div className="pipeline-options">{pipelines.map((pipeline) => { const checked = draft.postSalePipelineIds.includes(pipeline.id); return <label key={pipeline.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} disabled={!checked && draft.postSalePipelineIds.length >= 2} onChange={(event) => toggleReporting(pipeline, event.target.checked)} /><span><Check size={15} /></span><div><strong>{pipeline.name}</strong><small>ID: {pipeline.id}</small></div></label>; })}</div>
      <div className={`pipeline-selection-note ${draft.postSalePipelineIds.length === 2 ? "ok" : "warning"}`}>{draft.postSalePipelineIds.length === 2 ? `Tanlangan: ${draft.postSalePipelineNames.join(" + ")}` : "Sotuvni to‘liq sanash uchun 2 ta post-sale funnel tanlang."}</div>
    </section>
    <section className="panel"><SectionHeader title="Funnel bo‘yicha alohida sinxronizatsiya" subtitle="Bir tugma faqat shu Sales funnel va unga mos Обучение / Сопровождение funnel’ini oladi. Ikkinchi funnel ma’lumotlari saqlanib qoladi." /><div className="scoped-sync-grid">{draft.selectedPipelineIds.map((id, index) => { const name = draft.selectedPipelineNames[index] ?? `Sales funnel #${id}`; const brand = name.toLowerCase().includes("sd") ? "sd" : "ibox"; const postSale = draft.postSalePipelineNames.find((item) => item.toLowerCase().includes(brand)) ?? "mos post-sale funnel"; return <article key={id}><div><span>{brand.toUpperCase()}</span><div><strong>{name}</strong><small>+ {postSale}</small></div></div><p>Faqat oxirgi {draft.historyDays} kun. Boshqa funnel o‘chirilmaydi.</p><button className="button secondary" disabled={saving || syncing || !validConfig} onClick={() => void fullSync(id)}>{saving || syncing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}{name} full sync</button></article>; })}</div></section>
    <section className="panel"><SectionHeader title="Bitrix custom field’lari" subtitle="Ro‘yxatdan qidiring yoki Bitrix’dagi UF_CRM_... kodini qo‘lda kiriting." />
      <div className={`field-discovery ${customFieldCount ? "ok" : "warning"}`}>{customFieldCount ? `${customFieldCount} ta custom field topildi. Input ichida nom yoki kod bo‘yicha qidiring.` : "Webhook custom field nomlarini bermadi. UF_CRM_... kodini qo‘lda kiritish mumkin."}</div>
      <datalist id="crm-field-options">{fieldOptions}</datalist><div className="config-fields">
      <label>Причина провала<input list="crm-field-options" value={draft.failureReasonField ?? ""} placeholder="UF_CRM_..." onChange={(event) => setDraft({ ...draft, failureReasonField: event.target.value.trim() || null })} /><small>Not Relevant va Sales loss sabablarini olish uchun</small></label>
      <label>Marketing kanal<input list="crm-field-options" value={draft.marketingChannelField ?? ""} placeholder="Bo‘sh bo‘lsa standart SOURCE_ID" onChange={(event) => setDraft({ ...draft, marketingChannelField: event.target.value.trim() || null })} /><small>Custom marketing kanal field kodi</small></label>
      <label>Sales manager field<input list="crm-field-options" value={draft.salesManagerField ?? ""} placeholder="Bo‘sh bo‘lsa avtomatik attribution" onChange={(event) => setDraft({ ...draft, salesManagerField: event.target.value.trim() || null })} /><small>Sotuvchi yozilgan employee field bo‘lsa</small></label>
    </div></section>
    <section className="panel"><SectionHeader title="SQL qabul qilingan bosqich" subtitle="Deal bu stage’ga bir marta kirsa, keyin boshqa stage yoki funnel’ga o‘tsa ham SQL bo‘lib qoladi." /><div className="sql-stage-options">{stages.map((stage) => { const checked = draft.qualifiedStageIds.includes(stage.id); return <label key={stage.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} onChange={(event) => setDraft({ ...draft, qualifiedStageIds: event.target.checked ? [...new Set([...draft.qualifiedStageIds, stage.id])] : draft.qualifiedStageIds.filter((id) => id !== stage.id) })} /><span><Check size={13} /></span><strong>{stage.name}</strong></label>; })}</div><div className="field-discovery ok">Hech narsa tanlanmasa “Обработка / Processing / SQL” nomli stage’lar avtomatik aniqlanadi.</div></section>
    <section className="settings-grid"><article className="panel"><SectionHeader title="Routing sabablari" subtitle="Bu so‘zlar topilsa lead marketing sifatsizligiga qo‘shilmaydi." /><label className="wide-field">Kalit so‘zlar<textarea value={draft.routingReasonPatterns.join(", ")} onChange={(event) => setDraft({ ...draft, routingReasonPatterns: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} rows={3} /></label></article><article className="panel"><SectionHeader title="Avtomatik yangilash" subtitle="Dashboard ochiq bo‘lganda incremental sync avtomatik boshlanadi; uzilgan sync keyingi ochilishda davom etadi." /><label className="field-label">Interval<select value={draft.autoSyncMinutes} onChange={(event) => setDraft({ ...draft, autoSyncMinutes: Number(event.target.value) })}><option value="0">O‘chirilgan</option><option value="10">10 minut</option><option value="15">15 minut</option><option value="30">30 minut</option><option value="60">60 minut</option></select></label></article></section>
    <section className="panel"><SectionHeader title="Har bir stage uchun limit" subtitle="Aktiv Deal shu stage’da limitdan ko‘p tursa Stage nazoratida qizil ko‘rinadi." /><div className="stage-limits"><label className="field-label">Default limit<input type="number" min="1" max="720" value={draft.defaultStageLimitHours} onChange={(event) => setDraft({ ...draft, defaultStageLimitHours: Number(event.target.value) })} /><span>soat</span></label>{stages.map((stage) => <label key={stage.id}><span>{stage.name}</span><input type="number" min="1" max="720" value={draft.stageLimits[stage.id] ?? draft.defaultStageLimitHours} onChange={(event) => setDraft({ ...draft, stageLimits: { ...draft.stageLimits, [stage.id]: Number(event.target.value) } })} /><small>soat</small></label>)}</div></section>
    <section className="settings-grid"><article className="panel"><SectionHeader title="Ish vaqti" subtitle={`Timezone: ${draft.timezone}`} /><div className="schedule-list">{days.map(([key, label]) => { const day = draft.schedule[key]; return <div key={key} className={!day.enabled ? "disabled" : ""}><label className="check-label"><input type="checkbox" checked={day.enabled} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, enabled: event.target.checked } } })} /><span><Check size={13} /></span><strong>{label}</strong></label><input type="time" value={day.start} disabled={!day.enabled} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, start: event.target.value } } })} /><span>—</span><input type="time" value={day.end} disabled={!day.enabled} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, end: event.target.value } } })} /></div>; })}</div></article>
      <div className="settings-stack"><article className="panel"><SectionHeader title="SLA" subtitle="Obrabotka qilinmagan Deal alohida qoladi" /><label className="field-label">SLA target<input type="number" min="1" max="240" value={draft.slaMinutes} onChange={(event) => setDraft({ ...draft, slaMinutes: Number(event.target.value) })} /><span>business minutes</span></label></article><article className="panel"><SectionHeader title="History" subtitle="Har bir funnel full sync’i uchun alohida import oralig‘i" /><label className="field-label">Import range<select value={draft.historyDays} onChange={(event) => setDraft({ ...draft, historyDays: Number(event.target.value) })}><option value="7">7 kun</option><option value="14">14 kun</option><option value="30">30 kun</option><option value="90">90 kun</option><option value="180">180 kun</option><option value="365">365 kun</option></select></label></article></div>
    </section>
    <section className="panel"><SectionHeader title="Dam olish / bayramlar" subtitle="Bu sanalarda business minutes hisoblanmaydi" /><div className="holiday-add"><input type="date" value={holiday} onChange={(event) => setHoliday(event.target.value)} /><button className="button small secondary" disabled={!holiday || draft.holidays.includes(holiday)} onClick={() => { setDraft({ ...draft, holidays: [...draft.holidays, holiday].sort() }); setHoliday(""); }}>Bayram qo‘shish</button></div><div className="holiday-list">{draft.holidays.map((date) => <span key={date}>{date}<button aria-label={`${date} sanani o‘chirish`} onClick={() => setDraft({ ...draft, holidays: draft.holidays.filter((value) => value !== date) })}><X size={13} /></button></span>)}{!draft.holidays.length && <small>Hozircha maxsus bayram sanalari qo‘shilmagan.</small>}</div></section>
  </>;
}

export default function DashboardClient() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [records, setRecords] = useState<AnalyticsRecord[]>([]);
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [sync, setSync] = useState<SyncState>(idleSync);
  const [providers, setProviders] = useState<ProviderDiagnostic[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [selectedManager, setSelectedManager] = useState<ManagerRow | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [refreshing, setRefreshing] = useState(false);
  const [syncPipelineId, setSyncPipelineId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const syncLoopRef = useRef(false);
  const autoSyncIndexRef = useRef(0);
  const syncRunnerRef = useRef<((mode: "start" | "resume", full?: boolean, daysOverride?: number, pipelineId?: string) => Promise<void>) | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const bootstrapResponse = await fetch("/api/bootstrap", { cache: "no-store" });
      const bootstrap = await bootstrapResponse.json() as { configured: boolean; settings: DashboardSettings; sync: SyncState; providers: ProviderDiagnostic[]; error?: string };
      if (!bootstrapResponse.ok) throw new Error(bootstrap.error ?? "Dashboard yuklanmadi");
      setConfigured(bootstrap.configured); setSettings(bootstrap.settings); setSync(bootstrap.sync); setProviders(bootstrap.providers ?? []);
      if (bootstrap.configured) {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        const payload = await response.json() as { records: AnalyticsRecord[]; settings: DashboardSettings; sync: SyncState; providers: ProviderDiagnostic[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Dashboard ma’lumotlari yuklanmadi");
        setRecords(markDuplicates((payload.records ?? []).map(hydrateRecord))); setSettings(payload.settings); setSync(payload.sync); setProviders(payload.providers ?? []);
      }
    } catch (caught) { setLoadError(caught instanceof Error ? caught.message : "Dashboard yuklanmadi"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const { baseFiltered, cohortFiltered, wonFiltered, previousCohortFiltered, previousWonFiltered, detailFiltered } = useMemo(() => {
    const bounds = rangeBounds(filters); const search = filters.search.trim().toLowerCase();
    const from = bounds.from ? new Date(`${bounds.from}T00:00:00+05:00`).getTime() : -Infinity;
    const to = bounds.to ? new Date(`${bounds.to}T23:59:59+05:00`).getTime() : Infinity;
    const base = records.filter((row) => {
      if (filters.manager && row.assignedManagerId !== filters.manager && row.salesManagerId !== filters.manager) return false;
      if (filters.pipeline && row.originPipeline !== filters.pipeline) return false;
      if (filters.source && row.source !== filters.source) return false;
      if (filters.stage && row.stage !== filters.stage) return false;
      if (filters.period && row.creationPeriod !== filters.period) return false;
      if (filters.sla && row.slaStatus !== filters.sla) return false;
      if (filters.processing && row.processingSource !== filters.processing) return false;
      if (filters.outcome && row.firstCallOutcome !== filters.outcome) return false;
      if (filters.called && (row.outgoingCallCount > 0 ? "yes" : "no") !== filters.called) return false;
      if (filters.stageBeforeCall && (row.stageChangedBeforeCall ? "yes" : "no") !== filters.stageBeforeCall) return false;
      if (search && !`${row.dealId} ${row.title}`.toLowerCase().includes(search)) return false;
      return true;
    });
    const cohort = base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= from && created <= to; });
    const won = base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= from && new Date(row.wonAt).getTime() <= to);
    const span = Number.isFinite(from) && Number.isFinite(to) ? Math.max(86_400_000, to - from + 1) : 0;
    const previousTo = from - 1; const previousFrom = previousTo - span + 1;
    const previousCohort = span ? base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= previousFrom && created <= previousTo; }) : [];
    const previousWon = span ? base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= previousFrom && new Date(row.wonAt).getTime() <= previousTo) : [];
    return { baseFiltered: base, cohortFiltered: cohort, wonFiltered: won, previousCohortFiltered: previousCohort, previousWonFiltered: previousWon, detailFiltered: [...new Map([...cohort, ...won].map((row) => [row.dealId, row])).values()] };
  }, [records, filters]);

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
    if (!response.ok || !payload.settings) throw new Error(payload.error ?? "Sozlamalar saqlanmadi"); setSettings(payload.settings);
  }
  async function saveAndFullSync(next: DashboardSettings, pipelineId: string) {
    await saveSettings(next);
    setSyncPipelineId(pipelineId);
    await syncLoop("start", true, next.historyDays, pipelineId);
  }
  async function changeProvider(key: string, mode: string) {
    const response = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, mode }) });
    if (response.ok) setProviders((current) => current.map((provider) => provider.key === key ? { ...provider, mode: mode as ProviderDiagnostic["mode"] } : provider));
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
  const hasLegacyData = records.some((record) => record.analyticsVersion < 3);
  const syncOptions = settings.selectedPipelineIds.map((id, index) => ({ id, name: settings.selectedPipelineNames[index] ?? `Sales funnel #${id}` }));
  const activeSyncPipelineId = syncOptions.some((pipeline) => pipeline.id === syncPipelineId) ? syncPipelineId : syncOptions[0]?.id ?? "";

  return <div className="app-shell">
    <aside className={menuOpen ? "open" : ""}>
      <div className="brand"><div className="brand-mark">B24</div><div><strong>Deal Processing</strong><small>Sales analytics</small></div><button className="mobile-close" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
      <nav>{navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMenuOpen(false); }}><item.icon size={18} /><span>{item.label}</span>{item.id === "diagnostics" && sync.permissions.telephony === "warning" && <i />}</button>)}</nav>
      <div className="sidebar-status"><div><span className="live-dot" /><strong>Bitrix24 ulangan</strong></div><small>Oxirgi sync</small><p>{fmtDate(sync.lastSyncAt)}</p></div>
      <div className="sidebar-foot"><ShieldCheck size={16} /><span>Webhook server secret’da himoyalangan</span></div>
    </aside>
    {menuOpen && <button className="sidebar-backdrop" aria-label="Menyuni yopish" onClick={() => setMenuOpen(false)} />}
    <main className="content">
      <header className="topbar"><button className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><div><span>Bitrix24</span><small>/</small><strong>{title}</strong></div><div className="top-actions"><span className="sync-time">Oxirgi sync: <strong>{fmtDate(sync.lastSyncAt)}</strong></span><Select label="Sync funnel" value={activeSyncPipelineId} onChange={setSyncPipelineId}>{syncOptions.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</Select><button className="button secondary refresh" onClick={refresh}>{sync.status === "running" ? <TimerReset size={17} /> : refreshing ? <Loader2 size={17} className="spin" /> : <RefreshCw size={17} />}{sync.status === "running" ? "Pauza" : "Tanlangan funnelni sync"}</button><div className="avatar">IM</div></div></header>
      <div className="content-inner">
        {loadError && <div className="notice error page-notice"><XCircle size={18} />{loadError}<button onClick={() => setLoadError(null)}><X size={14} /></button></div>}
        {hasLegacyData && sync.status !== "running" && <div className="notice warning page-notice"><AlertTriangle size={18} /><span>Eski sync ma’lumotlari bor. Yangi sales analytics to‘liq ishlashi uchun Sozlamalarda CRM field’larini tekshirib, <strong>“To‘liq qayta sync”</strong>ni bosing.</span><button onClick={() => setView("settings")}>Sozlamalar</button></div>}
        {["running", "paused", "error"].includes(sync.status) && <SyncProgress sync={sync} busy={refreshing} onPause={() => void pauseCurrentSync()} onResume={() => void syncLoop("resume")} />}
        {view !== "settings" && view !== "diagnostics" && <FiltersBar filters={filters} setFilters={setFilters} records={records} />}
        {view === "dashboard" && <><div className="page-title dashboard-title"><div><p className="eyebrow">SALES ANALYTICS</p><h1>Sales performance dashboard</h1><p>Lead sifati, sotuv, menejer va processing muammolarini bitta joyda kuzating.</p></div><div className="period-summary"><CalendarDays size={17} /><span>{rangeBounds(filters).from} — {rangeBounds(filters).to}</span><strong>{cohortFiltered.length} yangi lead</strong></div></div><DashboardView records={cohortFiltered} salesRecords={wonFiltered} previousRecords={previousCohortFiltered} previousSalesRecords={previousWonFiltered} onManager={(manager) => { setSelectedManager(manager); setView("managerDetail"); }} /><TrendChart records={cohortFiltered} /></>}
        {view === "managers" && <><div className="page-title"><div><p className="eyebrow">TEAM PERFORMANCE</p><h1>Menejerlar</h1><p>Lead, sifatsizlik, sales loss, sotuv soni va Opportunity kesimida.</p></div></div><section className="panel"><SectionHeader title="Menejerlar reytingi" subtitle="Lead va cohort konversiya — yaratilgan sana; davr sotuv — Oplata sanasi bo‘yicha" /><ManagerTable rows={buildManagers(cohortFiltered, wonFiltered)} onSelect={(manager) => { setSelectedManager(manager); setView("managerDetail"); }} /></section></>}
        {view === "managerDetail" && selectedManager && <ManagerDetailView manager={selectedManager} cohortRecords={cohortFiltered} salesRecords={wonFiltered} onBack={() => setView("managers")} />}
        {view === "leadFlow" && <LeadFlowView records={cohortFiltered} />}
        {view === "quality" && <QualityView records={cohortFiltered} />}
        {view === "stages" && <StageControlView records={baseFiltered} />}
        {view === "deals" && <><div className="page-title"><div><p className="eyebrow">DETAIL REPORT</p><h1>Deal’lar</h1><p>Sotuv holati, sotuvchi attribution’i, stage yoshi va processing yagona jadvalda.</p></div></div><DealsTable records={detailFiltered} /></>}
        {view === "calls" && <CallsView records={cohortFiltered.filter((row) => row.operationalPipeline)} />}
        {view === "diagnostics" && <DiagnosticsView sync={sync} providers={providers} records={records} onProviderChange={changeProvider} />}
        {view === "settings" && <SettingsView settings={settings} syncing={refreshing || sync.status === "running"} onSave={saveSettings} onFullSync={saveAndFullSync} />}
        <footer><span>Bitrix24 Deal Processing Dashboard</span><span>Timezone: Asia/Tashkent · Business minutes only</span></footer>
      </div>
    </main>
  </div>;
}
