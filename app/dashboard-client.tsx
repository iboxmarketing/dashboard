"use client";

import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarDays, Check,
  ChevronDown, Clock3, Database, Download, ExternalLink, Gauge, LayoutDashboard,
  Loader2, Menu, PhoneCall, RefreshCw, Search, Settings, ShieldCheck,
  SlidersHorizontal, TimerReset, Users, X, XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyticsRecord, DashboardSettings, PipelineOption, ProviderDiagnostic, SyncProgressState } from "@/lib/types";

type View = "dashboard" | "managers" | "deals" | "calls" | "diagnostics" | "settings";
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
  stale: false, selectedPipelines: [], lastSyncAt: null, lastFrom: null,
  counts: {}, permissions: {}, safeError: null,
};

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "managers", label: "Menejerlar", icon: Users },
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
function fmtDate(value: string | null, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
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
    <div className="sync-progress-foot"><span>{sync.selectedPipelines.map((item) => item.name).join(" + ") || "IBOX Sales + SD Sales"}</span><span>{sync.processed}{sync.total ? ` / ${sync.total}` : ""}</span></div>
    {sync.status === "running" ? <button className="button small secondary" onClick={onPause}>Pauza</button> : <button className="button small primary" disabled={busy} onClick={onResume}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Davom ettirish</button>}
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

function KpiCard({ label, value, detail, tone = "blue", icon: Icon }: { label: string; value: string; detail: string; tone?: string; icon: typeof Activity }) {
  return <article className={`kpi-card ${tone}`}><div className="kpi-top"><span>{label}</span><div className="kpi-icon"><Icon size={18} /></div></div><strong>{value}</strong><small>{detail}</small></article>;
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
};

function buildManagers(records: AnalyticsRecord[]): ManagerRow[] {
  const grouped = new Map<string, AnalyticsRecord[]>();
  for (const record of records) {
    const key = record.assignedManagerId || record.assignedManager;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return [...grouped.entries()].map(([id, rows]) => ({
    id, name: rows[0]?.assignedManager ?? "Aniqlanmagan", deals: rows.length,
    avg: average(rows.map((row) => row.processingBusinessMinutes)),
    median: median(rows.map((row) => row.processingBusinessMinutes)),
    firstCall: average(rows.map((row) => row.firstCallBusinessMinutes)),
    callPct: pct(rows.filter((row) => row.outgoingCallCount > 0).length, rows.length),
    answeredPct: pct(rows.filter((row) => row.firstCallOutcome === "Ko‘tardi").length, rows.filter((row) => row.outgoingCallCount > 0).length),
    stageOnly: rows.filter((row) => row.processingSource === "STAGE_CHANGE").length,
    noProcessing: rows.filter((row) => row.processingSource === "NO_PROCESSING").length,
    beforeCall: rows.filter((row) => row.stageChangedBeforeCall).length,
    successTime: average(rows.map((row) => row.firstSuccessfulCallBusinessMinutes)),
  })).sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity));
}

function ManagerTable({ rows, onSelect }: { rows: ManagerRow[]; onSelect: (manager: ManagerRow) => void }) {
  const [sort, setSort] = useState<keyof ManagerRow>("avg");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
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
    <th>{header("Menejer", "name")}</th><th>{header("Deal", "deals")}</th><th>{header("Avg obrabotka", "avg")}</th>
    <th>{header("Median", "median")}</th><th>{header("Avg first call", "firstCall")}</th><th>{header("Call %", "callPct")}</th>
    <th>{header("Answered %", "answeredPct")}</th><th>{header("Stage only", "stageOnly")}</th><th>{header("No processing", "noProcessing")}</th><th>{header("Status → call", "beforeCall")}</th>
  </tr></thead><tbody>{sorted.map((row) => <tr key={row.id} onClick={() => onSelect(row)}>
    <td><div className="manager-cell"><span>{row.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span><strong>{row.name}</strong></div></td>
    <td>{row.deals}</td><td>{fmtMinutes(row.avg)}</td><td>{fmtMinutes(row.median)}</td><td>{fmtMinutes(row.firstCall)}</td>
    <td><span className="pill neutral">{row.callPct}%</span></td><td><span className="pill success">{row.answeredPct}%</span></td>
    <td>{row.stageOnly}</td><td><span className={row.noProcessing ? "danger-text" : ""}>{row.noProcessing}</span></td><td>{row.beforeCall}</td>
  </tr>)}</tbody></table>{!rows.length && <div className="empty-table">Tanlangan filtr bo‘yicha menejerlar topilmadi.</div>}</div>;
}

function FiltersBar({ filters, setFilters, records }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>; records: AnalyticsRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const managers = [...new Map(records.map((row) => [row.assignedManagerId, row.assignedManager])).entries()];
  const pipelines = [...new Set(records.map((row) => row.pipeline))].sort();
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

function DashboardView({ records, onManager }: { records: AnalyticsRecord[]; onManager: (manager: ManagerRow) => void }) {
  const processed = records.filter((row) => row.processingBusinessMinutes !== null);
  const called = records.filter((row) => row.outgoingCallCount > 0);
  const answered = records.filter((row) => row.firstCallOutcome === "Ko‘tardi");
  const noProcessing = records.filter((row) => row.processingSource === "NO_PROCESSING");
  const stageOnly = records.filter((row) => row.processingSource === "STAGE_CHANGE");
  const afterHours = records.filter((row) => row.creationPeriod === "AFTER_HOURS");
  const slaOnTime = processed.filter((row) => row.slaStatus === "ON_TIME");
  const managers = buildManagers(records);
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
    for (const row of records) { const key = row.createdAt.slice(0, 10); map.set(key, [...(map.get(key) ?? []), row]); }
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
    const headers = ["Deal ID", "Deal nomi", "Yaratilgan vaqt", "Ish vaqti", "SLA start", "Deal mas’uli", "Pipeline", "Source", "Current stage", "First outgoing call", "First call manager", "First call business minutes", "First call outcome", "First call duration", "First successful call", "Time to successful call", "First stage change", "Stage change business minutes", "Stage changed before call", "Processing source", "Processing business minutes", "SLA status"];
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines: unknown[][] = [headers, ...sorted.map((row) => [row.dealId, row.title, row.createdAt, row.creationPeriod, row.slaStart, row.assignedManager, row.pipeline, row.source, row.stage, row.firstCallAt, row.firstCallManager, row.firstCallBusinessMinutes, row.firstCallOutcome, row.firstCallDuration, row.firstSuccessfulCallAt, row.firstSuccessfulCallBusinessMinutes, row.firstStageChangeAt, row.firstStageChangeBusinessMinutes, row.stageChangedBeforeCall ? "Ha" : "Yo‘q", row.processingSource, row.processingBusinessMinutes, row.slaStatus])];
    const blob = new Blob(["\ufeff", lines.map((line) => line.map(quote).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `bitrix-deals-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="panel deals-panel"><SectionHeader title="Detailed Deal report" subtitle={`${records.length} ta Deal`} action={<div className="table-actions"><Select label="Saralash" value={sort} onChange={(value) => setSort(value as typeof sort)}><option value="createdAt">Yangi Deal</option><option value="processingBusinessMinutes">Eng tez obrabotka</option></Select><button className="button small secondary" onClick={exportCsv}><Download size={16} />CSV export</button></div>} />
    <div className="table-wrap"><table className="data-table deal-table"><thead><tr><th>Deal</th><th>Yaratilgan</th><th>Deal mas’uli</th><th>Pipeline / Stage</th><th>First call</th><th>Call manager / outcome</th><th>First stage change</th><th>Processing</th><th>SLA</th></tr></thead><tbody>{rows.map((row) => <tr key={row.dealId}>
      <td><div className="deal-name"><strong>{row.title}</strong>{row.bitrixUrl ? <a href={row.bitrixUrl} target="_blank" rel="noreferrer">#{row.dealId}<ExternalLink size={12} /></a> : <small>#{row.dealId}</small>}</div></td>
      <td><span>{fmtDate(row.createdAt)}</span><small className={`period-label ${row.creationPeriod === "WORK_HOURS" ? "work" : "after"}`}>{row.creationPeriod === "WORK_HOURS" ? "Ish vaqtida" : "Ish vaqtidan tashqari"}</small></td>
      <td>{row.assignedManager}</td><td><span>{row.pipeline}</span><small>{row.stage}</small></td>
      <td><span>{fmtDate(row.firstCallAt)}</span><small>{fmtMinutes(row.firstCallBusinessMinutes)}</small></td>
      <td><span>{row.firstCallManager ?? "—"}</span><small><i style={{ background: outcomeColors[row.firstCallOutcome] }} />{row.firstCallOutcome}{row.outcomeInferred ? " · taxmin" : ""}</small></td>
      <td><span>{fmtDate(row.firstStageChangeAt)}</span><small>{fmtMinutes(row.firstStageChangeBusinessMinutes)}{row.stageChangedBeforeCall ? " · call’dan oldin" : ""}</small></td>
      <td><span className="source-pill">{row.processingSource === "OUTGOING_CALL" ? "📞 Call" : row.processingSource === "STAGE_CHANGE" ? "🔄 Stage" : "⚠️ Yo‘q"}</span><small>{fmtMinutes(row.processingBusinessMinutes)}</small></td>
      <td><span className={`pill ${row.slaStatus === "ON_TIME" ? "success" : row.slaStatus === "LATE" ? "warning" : "danger"}`}>{row.slaStatus === "ON_TIME" ? "SLA ichida" : row.slaStatus === "LATE" ? "Kechikkan" : "Obrabotka yo‘q"}</span></td>
    </tr>)}</tbody></table>{!rows.length && <div className="empty-table">Tanlangan filtr bo‘yicha Deal topilmadi.</div>}</div>
    <div className="pagination"><span>{safePage} / {pages} sahifa</span><div><button disabled={safePage <= 1} onClick={() => setPage((value) => value - 1)}>Oldingi</button><button disabled={safePage >= pages} onClick={() => setPage((value) => value + 1)}>Keyingi</button></div></div>
  </section>;
}

function DiagnosticsView({ sync, providers, records, onProviderChange }: { sync: SyncState; providers: ProviderDiagnostic[]; records: AnalyticsRecord[]; onProviderChange: (key: string, mode: string) => void }) {
  const permissions = [["Deal API", sync.permissions.deals], ["Activity API", sync.permissions.activities], ["Stage history", sync.permissions.stageHistory], ["User API", sync.permissions.managers], ["Telephony / Call Statistics", sync.permissions.telephony]];
  const qualities = [["Deals without activities", records.filter((row) => row.outgoingCallCount === 0).length], ["Deals without stage history", records.filter((row) => !row.firstStageChangeAt).length], ["Calls without outcome data", records.filter((row) => row.outgoingCallCount > 0 && row.firstCallOutcome === "Noma’lum").length], ["Missing managers", records.filter((row) => row.assignedManager.startsWith("Menejer #") || row.assignedManager === "Aniqlanmagan").length], ["Stage changed before call", records.filter((row) => row.stageChangedBeforeCall).length], ["Data unavailable", records.filter((row) => row.dataUnavailable).length]] as const;
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

function SettingsView({ settings, onSave }: { settings: DashboardSettings; onSave: (settings: DashboardSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings); const [holiday, setHoliday] = useState("");
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]); const [pipelineError, setPipelineError] = useState<string | null>(null);
  const days = [[1, "Dushanba"], [2, "Seshanba"], [3, "Chorshanba"], [4, "Payshanba"], [5, "Juma"], [6, "Shanba"], [0, "Yakshanba"]] as const;
  useEffect(() => {
    void fetch("/api/pipelines", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { pipelines?: PipelineOption[]; selectedIds?: string[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Pipeline’lar yuklanmadi");
      const options = payload.pipelines ?? [];
      setPipelines(options);
      if (!settings.selectedPipelineIds.length && payload.selectedIds?.length) {
        const selected = options.filter((item) => payload.selectedIds?.includes(item.id));
        setDraft((current) => ({ ...current, selectedPipelineIds: selected.map((item) => item.id), selectedPipelineNames: selected.map((item) => item.name) }));
      }
    }).catch((caught) => setPipelineError(caught instanceof Error ? caught.message : "Pipeline’lar yuklanmadi"));
  }, [settings.selectedPipelineIds.length]);
  function togglePipeline(pipeline: PipelineOption, checked: boolean) {
    const selected = checked
      ? [...pipelines.filter((item) => draft.selectedPipelineIds.includes(item.id)), pipeline]
      : pipelines.filter((item) => draft.selectedPipelineIds.includes(item.id) && item.id !== pipeline.id);
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()].slice(0, 2);
    setDraft({ ...draft, selectedPipelineIds: unique.map((item) => item.id), selectedPipelineNames: unique.map((item) => item.name) });
  }
  async function save() { setSaving(true); setSaved(false); await onSave(draft); setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2500); }
  return <><div className="page-title"><div><p className="eyebrow">ADMIN</p><h1>Sozlamalar</h1><p>Sales pipeline, ish jadvali va SLA hisoblash qoidalari.</p></div><button className="button primary" onClick={save} disabled={saving || draft.selectedPipelineIds.length !== 2}>{saving ? <Loader2 size={17} className="spin" /> : saved ? <Check size={17} /> : <Settings size={17} />}{saved ? "Saqlandi" : "Sozlamalarni saqlash"}</button></div>
    <section className="panel pipeline-settings"><SectionHeader title="Sales pipeline’lar" subtitle="Aynan 2 ta funnel tanlanadi. Qolganlari, jumladan call center pipeline’lari sync qilinmaydi." />
      {pipelineError && <div className="notice error"><XCircle size={17} />{pipelineError}</div>}
      <div className="pipeline-options">{pipelines.map((pipeline) => { const checked = draft.selectedPipelineIds.includes(pipeline.id); return <label key={pipeline.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} disabled={!checked && draft.selectedPipelineIds.length >= 2} onChange={(event) => togglePipeline(pipeline, event.target.checked)} /><span><Check size={15} /></span><div><strong>{pipeline.name}</strong><small>ID: {pipeline.id}</small></div></label>; })}{!pipelines.length && !pipelineError && <small>Bitrix’dan pipeline’lar yuklanmoqda…</small>}</div>
      <div className={`pipeline-selection-note ${draft.selectedPipelineIds.length === 2 ? "ok" : "warning"}`}>{draft.selectedPipelineIds.length === 2 ? `Tanlangan: ${draft.selectedPipelineNames.join(" + ")}` : "Davom etish uchun aynan 2 ta sales pipeline tanlang."}</div>
    </section>
    <section className="settings-grid"><article className="panel"><SectionHeader title="Ish vaqti" subtitle={`Timezone: ${draft.timezone}`} /><div className="schedule-list">{days.map(([key, label]) => { const day = draft.schedule[key]; return <div key={key} className={!day.enabled ? "disabled" : ""}><label className="check-label"><input type="checkbox" checked={day.enabled} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, enabled: event.target.checked } } })} /><span><Check size={13} /></span><strong>{label}</strong></label><input type="time" value={day.start} disabled={!day.enabled} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, start: event.target.value } } })} /><span>—</span><input type="time" value={day.end} disabled={!day.enabled} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, [key]: { ...day, end: event.target.value } } })} /></div>; })}</div></article>
      <div className="settings-stack"><article className="panel"><SectionHeader title="SLA" subtitle="Obrabotka qilinmagan Deal alohida qoladi" /><label className="field-label">SLA target<input type="number" min="1" max="240" value={draft.slaMinutes} onChange={(event) => setDraft({ ...draft, slaMinutes: Number(event.target.value) })} /><span>business minutes</span></label></article><article className="panel"><SectionHeader title="History" subtitle="Birinchi va keyingi sync oralig‘i" /><label className="field-label">Import range<select value={draft.historyDays} onChange={(event) => setDraft({ ...draft, historyDays: Number(event.target.value) })}><option value="30">30 kun</option><option value="90">90 kun</option><option value="180">180 kun</option><option value="365">365 kun</option></select></label></article></div>
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
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [refreshing, setRefreshing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const syncLoopRef = useRef(false);

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
        setRecords(payload.records ?? []); setSettings(payload.settings); setSync(payload.sync); setProviders(payload.providers ?? []);
      }
    } catch (caught) { setLoadError(caught instanceof Error ? caught.message : "Dashboard yuklanmadi"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const bounds = rangeBounds(filters); const search = filters.search.trim().toLowerCase();
    const from = bounds.from ? new Date(`${bounds.from}T00:00:00+05:00`).getTime() : null;
    const to = bounds.to ? new Date(`${bounds.to}T23:59:59+05:00`).getTime() : null;
    return records.filter((row) => {
      const created = new Date(row.createdAt).getTime();
      if (from !== null && created < from) return false; if (to !== null && created > to) return false;
      if (filters.manager && row.assignedManagerId !== filters.manager) return false;
      if (filters.pipeline && row.pipeline !== filters.pipeline) return false;
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
  }, [records, filters]);

  async function postSync(body: Record<string, unknown>) {
    const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json() as SyncState & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Sinxronizatsiya bajarilmadi");
    setSync(payload);
    return payload;
  }
  async function syncLoop(mode: "start" | "resume", full = false) {
    if (!settings || syncLoopRef.current) return;
    syncLoopRef.current = true; setRefreshing(true); setLoadError(null);
    try {
      let state = await postSync(mode === "start" ? { action: "start", days: settings.historyDays, full } : { action: "resume" });
      while (syncLoopRef.current && state.status === "running") {
        state = await postSync({ action: "step" });
        if (state.status === "running") await new Promise((resolve) => window.setTimeout(resolve, 120));
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
    else if (sync.status === "paused" || sync.status === "error") void syncLoop("resume");
    else void syncLoop("start");
  }
  async function saveSettings(next: DashboardSettings) {
    const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    const payload = await response.json() as { settings?: DashboardSettings; error?: string };
    if (!response.ok || !payload.settings) throw new Error(payload.error ?? "Sozlamalar saqlanmadi"); setSettings(payload.settings);
  }
  async function changeProvider(key: string, mode: string) {
    const response = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, mode }) });
    if (response.ok) setProviders((current) => current.map((provider) => provider.key === key ? { ...provider, mode: mode as ProviderDiagnostic["mode"] } : provider));
  }

  if (loading) return <Skeleton />;
  if (!configured || (configured && !records.length && sync.status !== "success")) return <SetupScreen configured={configured} sync={sync} syncing={refreshing} externalError={loadError} onStart={() => void syncLoop("start", true)} onPause={() => void pauseCurrentSync()} onResume={() => void syncLoop("resume")} />;
  if (!settings) return <div className="fatal-error"><XCircle /><p>Sozlamalar yuklanmadi.</p></div>;
  const title = navItems.find((item) => item.id === view)?.label ?? "Dashboard";

  return <div className="app-shell">
    <aside className={menuOpen ? "open" : ""}>
      <div className="brand"><div className="brand-mark">B24</div><div><strong>Deal Processing</strong><small>Sales analytics</small></div><button className="mobile-close" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
      <nav>{navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMenuOpen(false); }}><item.icon size={18} /><span>{item.label}</span>{item.id === "diagnostics" && sync.permissions.telephony === "warning" && <i />}</button>)}</nav>
      <div className="sidebar-status"><div><span className="live-dot" /><strong>Bitrix24 ulangan</strong></div><small>Oxirgi sync</small><p>{fmtDate(sync.lastSyncAt)}</p></div>
      <div className="sidebar-foot"><ShieldCheck size={16} /><span>Webhook server secret’da himoyalangan</span></div>
    </aside>
    {menuOpen && <button className="sidebar-backdrop" aria-label="Menyuni yopish" onClick={() => setMenuOpen(false)} />}
    <main className="content">
      <header className="topbar"><button className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><div><span>Bitrix24</span><small>/</small><strong>{title}</strong></div><div className="top-actions"><span className="sync-time">Oxirgi sync: <strong>{fmtDate(sync.lastSyncAt)}</strong></span><button className="button secondary refresh" onClick={refresh}>{sync.status === "running" ? <TimerReset size={17} /> : refreshing ? <Loader2 size={17} className="spin" /> : <RefreshCw size={17} />}{sync.status === "running" ? "Pauza" : sync.status === "paused" || sync.status === "error" ? "Davom ettirish" : "Ma’lumotlarni yangilash"}</button><div className="avatar">IM</div></div></header>
      <div className="content-inner">
        {loadError && <div className="notice error page-notice"><XCircle size={18} />{loadError}<button onClick={() => setLoadError(null)}><X size={14} /></button></div>}
        {["running", "paused", "error"].includes(sync.status) && <SyncProgress sync={sync} busy={refreshing} onPause={() => void pauseCurrentSync()} onResume={() => void syncLoop("resume")} />}
        {view !== "settings" && view !== "diagnostics" && <FiltersBar filters={filters} setFilters={setFilters} records={records} />}
        {view === "dashboard" && <><div className="page-title dashboard-title"><div><p className="eyebrow">DEAL PROCESSING</p><h1>Sales response dashboard</h1><p>Yangi Deal’lar qanchalik tez real obrabotka qilinayotganini kuzating.</p></div><div className="period-summary"><CalendarDays size={17} /><span>{rangeBounds(filters).from} — {rangeBounds(filters).to}</span><strong>{filtered.length} Deal</strong></div></div><DashboardView records={filtered} onManager={(manager) => setFilters((current) => ({ ...current, manager: manager.id }))} /><TrendChart records={filtered} /></>}
        {view === "managers" && <><div className="page-title"><div><p className="eyebrow">TEAM PERFORMANCE</p><h1>Menejerlar</h1><p>Processing speed, call attempt va no-processing kesimida.</p></div></div><section className="panel"><SectionHeader title="Menejerlar reytingi" subtitle="Har bir raqam tanlangan global filtrga mos" /><ManagerTable rows={buildManagers(filtered)} onSelect={(manager) => { setFilters((current) => ({ ...current, manager: manager.id })); setView("dashboard"); }} /></section></>}
        {view === "deals" && <><div className="page-title"><div><p className="eyebrow">DETAIL REPORT</p><h1>Deal’lar</h1><p>First call, stage history va SLA natijasining yagona jadvali.</p></div></div><DealsTable records={filtered} /></>}
        {view === "calls" && <CallsView records={filtered} />}
        {view === "diagnostics" && <DiagnosticsView sync={sync} providers={providers} records={records} onProviderChange={changeProvider} />}
        {view === "settings" && <SettingsView settings={settings} onSave={saveSettings} />}
        <footer><span>Bitrix24 Deal Processing Dashboard</span><span>Timezone: Asia/Tashkent · Business minutes only</span></footer>
      </div>
    </main>
  </div>;
}
