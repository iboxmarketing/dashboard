"use client";

import {
  CalendarDays, Check, ChevronDown, ChevronRight, CircleDollarSign, Database,
  ExternalLink, Filter, Gauge, Info, Layers3, RefreshCw, Target, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { inheritedMarketingFilters, nextMarketingLevel } from "./marketing-adapter";
import {
  EMPTY_MARKETING_OPTIONS,
  type CreativeRankingMetric, type IcpBreakdownRow, type MarketingDataAdapter, type MarketingDealRequest,
  type MarketingEntityLevel, type MarketingEntityRow, type MarketingFilterOptions, type MarketingFilters, type MarketingMetric,
  type MarketingSummaryResponse,
} from "./marketing-types";
import type { MarketingWorkspaceKey } from "./marketing-workspaces";
import { marketingWorkspace } from "./marketing-workspaces";
import { Drawer } from "../ui/drawer";
import { CostValue, formatMarketingMoney, formatMarketingRate, formatMarketingRoas, IcpBreakdownDrawer, MarketingDealDrawer } from "./marketing-shared";
import { defaultMarketingFilters, useMarketingUrlState, withMarketingRange, type MarketingUrlState } from "./marketing-url-state";
import { MarketingResourceNotice, useMarketingResource } from "./marketing-resource";

const LEVELS: { id: MarketingEntityLevel; label: string }[] = [
  { id: "campaign", label: "Campaign" },
  { id: "adset", label: "Ad Set" },
  { id: "ad", label: "Ad / Creative" },
  { id: "placement", label: "Placement" },
  { id: "landing", label: "Landing / Form" },
];
const LEVEL_LABELS = Object.fromEntries(LEVELS.map((item) => [item.id, item.label])) as Record<MarketingEntityLevel, string>;

/** Owner copy (2026-10): why CMC/ROAS can look high — never hide the limitation. */
export const ATTRIBUTED_SPEND_HELP = "CMC va ROAS faqat workspace'ga ishonchli biriktirilgan reklama xarajatidan hisoblanadi. Biriktirilmagan yoki mixed xarajatlar hisobga kiritilmaydi.";

/**
 * A child filter (Ad Set, Ad) left over from another parent must not stay
 * silently active: once the API's options for the current parent are known,
 * any child the options do not contain is cleared. Pure, for tests.
 */
export function reconcileMarketingFilters(filters: MarketingFilters, options: MarketingFilterOptions): MarketingFilters {
  const next = { ...filters };
  if (next.adsetId && options.adSets.length > 0 && !options.adSets.some((item) => item.id === next.adsetId)) { next.adsetId = ""; next.adId = ""; }
  if (next.adId && options.ads.length > 0 && !options.ads.some((item) => item.id === next.adId)) next.adId = "";
  return next.adsetId === filters.adsetId && next.adId === filters.adId ? filters : next;
}

function fmtStamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Pure transition used by click handlers and regression tests. */
export function drillMarketingEntity(current: MarketingUrlState, row: MarketingEntityRow): MarketingUrlState {
  const level = nextMarketingLevel(row);
  if (!level) return current;
  return { ...current, level, filters: inheritedMarketingFilters(current.filters, row) };
}

/** One request builder for KPI and entity-table Deal clicks. */
export function marketingDealRequest(
  current: Pick<MarketingUrlState, "workspace" | "filters">,
  metric: MarketingMetric,
  metricLabel: string,
  expectedCount: number,
  entity: MarketingEntityRow | null = null,
): MarketingDealRequest {
  return {
    workspace: current.workspace,
    metric,
    metricLabel,
    expectedCount,
    filters: entity ? inheritedMarketingFilters(current.filters, entity) : current.filters,
    entity,
  };
}

function SelectFilter({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  const currentIsMissing = Boolean(value) && !options.some((option) => option.id === value);
  return <label className={`marketing-filter ${value ? "active" : ""}`}><span>{label}</span><div><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Barchasi</option>{currentIsMissing ? <option value={value}>{value}</option> : null}{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select><ChevronDown size={13} /></div></label>;
}

function MarketingFiltersBar({ filters, onChange, options }: {
  filters: MarketingFilters;
  onChange: (filters: MarketingFilters) => void;
  options: typeof EMPTY_MARKETING_OPTIONS;
}) {
  const set = (key: keyof MarketingFilters, value: string) => {
    const next = { ...filters, [key]: value };
    if (key === "campaignId") { next.adsetId = ""; next.adId = ""; }
    if (key === "adsetId") next.adId = "";
    onChange(next);
  };
  const selections = [
    filters.source && (options.marketingSources.find((item) => item.id === filters.source)?.name ?? filters.source),
    filters.platform && (options.platforms.find((item) => item.id === filters.platform)?.name ?? filters.platform),
    filters.campaignId && (options.campaigns.find((item) => item.id === filters.campaignId)?.name ?? filters.campaignId),
    filters.adsetId && (options.adSets.find((item) => item.id === filters.adsetId)?.name ?? filters.adsetId),
    filters.adId && (options.ads.find((item) => item.id === filters.adId)?.name ?? filters.adId),
    filters.placement && (options.placements.find((item) => item.id === filters.placement)?.name ?? filters.placement),
    filters.landing && (options.landingForms.find((item) => item.id === filters.landing)?.name ?? filters.landing),
  ].filter((value): value is string => Boolean(value));
  const dateLabel = `${filters.startDate || "…"} — ${filters.endDate || "…"}`;
  return <section className="marketing-filters" aria-label="Marketing filtrlari">
    <div className="marketing-filter-scroll">
      <label className="marketing-filter active"><span>Date</span><div><select value={filters.range} onChange={(event) => onChange(withMarketingRange(filters, event.target.value as MarketingFilters["range"]))}><option value="7">Oxirgi 7 kun</option><option value="30">Oxirgi 30 kun</option><option value="month">Shu oy</option><option value="lastMonth">O‘tgan oy</option><option value="custom">Custom</option></select><CalendarDays size={13} /></div></label>
      <SelectFilter label="Marketing Source" value={filters.source} options={options.marketingSources} onChange={(value) => set("source", value)} />
      {options.platforms.length > 0 || filters.platform ? <SelectFilter label="Platform" value={filters.platform} options={options.platforms} onChange={(value) => set("platform", value)} /> : null}
      <SelectFilter label="Campaign" value={filters.campaignId} options={options.campaigns} onChange={(value) => set("campaignId", value)} />
      <SelectFilter label="Ad Set" value={filters.adsetId} options={options.adSets} onChange={(value) => set("adsetId", value)} />
      <SelectFilter label="Ad / Creative" value={filters.adId} options={options.ads} onChange={(value) => set("adId", value)} />
      <SelectFilter label="Placement" value={filters.placement} options={options.placements} onChange={(value) => set("placement", value)} />
      <SelectFilter label="Landing / Form" value={filters.landing} options={options.landingForms} onChange={(value) => set("landing", value)} />
      {selections.length > 0 ? <button className="marketing-clear" onClick={() => onChange(defaultMarketingFilters())}><X size={14} />Tozalash</button> : null}
    </div>
    {filters.range === "custom" ? <div className="marketing-custom-dates"><label>Boshlanish<input type="date" value={filters.startDate} onChange={(event) => set("startDate", event.target.value)} /></label><label>Tugash<input type="date" value={filters.endDate} onChange={(event) => set("endDate", event.target.value)} /></label></div> : null}
    <div className="marketing-filter-chips"><span><Filter size={13} />Faol filtrlar</span><b>{dateLabel}</b>{selections.map((value) => <b key={value}>{value}</b>)}</div>
  </section>;
}

function SummaryCard({ label, value, detail, icon: Icon, tone, onClick }: {
  label: string; value: string; detail: React.ReactNode; icon: typeof Database; tone: string; onClick?: () => void;
}) {
  return <button className={`kpi-card marketing-summary-card ${tone}`} onClick={onClick} disabled={!onClick}><span className="kpi-top"><span>{label}</span><span className="kpi-icon"><Icon size={18} /></span></span><strong>{value}</strong><small>{detail}</small>{onClick ? <span className="marketing-card-action">Deal’larni ko‘rish <ExternalLink size={12} /></span> : null}</button>;
}

function MarketingBreadcrumb({ state, options, onChange }: { state: MarketingUrlState; options: typeof EMPTY_MARKETING_OPTIONS; onChange: (state: MarketingUrlState) => void }) {
  if (state.level === "campaign") return null;
  const campaign = options.campaigns.find((item) => item.id === state.filters.campaignId)?.name ?? state.filters.campaignId;
  const adset = options.adSets.find((item) => item.id === state.filters.adsetId)?.name ?? state.filters.adsetId;
  const root = () => onChange({ ...state, level: "campaign", filters: { ...state.filters, campaignId: "", adsetId: "", adId: "" } });
  const campaignLevel = () => onChange({ ...state, level: "adset", filters: { ...state.filters, adsetId: "", adId: "" } });
  return <nav className="marketing-breadcrumb" aria-label="Marketing drilldown"><button onClick={root}>Campaign</button>
    {campaign ? <span><ChevronRight size={13} />{state.level === "ad" ? <button onClick={campaignLevel}>{campaign}</button> : <strong>{campaign}</strong>}</span> : null}
    {state.level === "ad" && adset ? <span><ChevronRight size={13} /><strong>{adset}</strong></span> : null}
    <span><ChevronRight size={13} /><b>{LEVEL_LABELS[state.level]}</b></span>
  </nav>;
}

function MarketingAttributionTable({ rows, level, showIcp, onEntity, onMetric }: {
  rows: MarketingEntityRow[];
  level: MarketingEntityLevel;
  showIcp: boolean;
  onEntity: (row: MarketingEntityRow) => void;
  onMetric: (row: MarketingEntityRow, metric: MarketingMetric, label: string, count: number) => void;
}) {
  return <div className="table-wrap marketing-table-wrap"><table className="data-table marketing-table">
    <thead><tr><th className="sticky-col">Name</th><th>Lead</th>{showIcp ? <><th>ICP mos</th><th>ICP %</th></> : null}<th>SQL</th><th>Jarayonda</th><th>Sotuv</th><th>Revenue</th><th title={ATTRIBUTED_SPEND_HELP}>Biriktirilgan spend</th><th title={ATTRIBUTED_SPEND_HELP}>CMC</th><th title={ATTRIBUTED_SPEND_HELP}>ROAS</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id}>
      <td className="sticky-col"><button className="marketing-entity-link" onClick={() => onEntity(row)}><span>{row.name}</span><small>{row.secondary}{row.landingType === "INSTANT_FORM" ? " · Instant Form" : row.landingType === "WEBSITE" ? " · Website" : ""}</small></button></td>
      <td><button className="marketing-count" onClick={() => onMetric(row, "lead", "Lead", row.leadCount)}>{row.leadCount}</button></td>
      {showIcp ? <><td><button className="marketing-count" onClick={() => onMetric(row, "icp_fit", "ICP mos", row.icpFitCount ?? 0)}>{row.icpFitCount ?? "—"}</button></td>
        <td><span className="pill success">{formatMarketingRate(row.icpFitRate)}</span><small>{row.icpFitCount ?? "—"} / {row.icpEvaluatedCount ?? "—"}</small></td></> : null}
      <td><button className="marketing-count" onClick={() => onMetric(row, "sql", "SQL", row.sqlCount)}>{row.sqlCount}</button>{row.sqlRate !== null ? <small>{formatMarketingRate(row.sqlRate)} Saralangandan</small> : null}</td>
      <td><button className="marketing-count" onClick={() => onMetric(row, "pipeline", "Jarayonda", row.pipelineCount)}>{row.pipelineCount}</button></td>
      <td><button className="marketing-count success" onClick={() => onMetric(row, "sale", "Sotuv", row.saleCount)}>{row.saleCount}</button>{row.sqlToSaleRate !== null ? <small>{formatMarketingRate(row.sqlToSaleRate)} SQL’dan</small> : null}</td>
      <td><strong>{formatMarketingMoney(row.revenue, row.costs.currency)}</strong></td>
      <td><CostValue costs={row.costs} metric="spend" /></td><td><CostValue costs={row.costs} metric="cmc" /></td><td><CostValue costs={row.costs} metric="roas" /></td>
    </tr>)}</tbody>
  </table>{rows.length === 0 ? <div className="marketing-empty">{LEVEL_LABELS[level]} bo‘yicha qator yo‘q.</div> : null}</div>;
}

function rankValue(row: MarketingEntityRow, metric: CreativeRankingMetric) {
  if (metric === "SALES") return row.saleCount;
  if (metric === "ICP_FIT_RATE") return row.icpFitRate ?? -1;
  if (metric === "SQL") return row.sqlCount;
  if (metric === "ROAS") return row.costs.roas ?? -1;
  return row.costs.cmc ?? Number.POSITIVE_INFINITY;
}

function CreativeRanking({ context, adapter, spendAvailable, showIcp, onOpen }: {
  context: { workspace: MarketingWorkspaceKey; filters: MarketingFilters };
  adapter: MarketingDataAdapter;
  spendAvailable: boolean;
  showIcp: boolean;
  onOpen: (row: MarketingEntityRow) => void;
}) {
  const [metric, setMetric] = useState<CreativeRankingMetric>("SALES");
  const effectiveMetric = !showIcp && metric === "ICP_FIT_RATE" ? "SALES" : metric;
  const resource = useMarketingResource({
    key: `ranking:${JSON.stringify(context)}`,
    load: (signal) => adapter.getEntities({ ...context, level: "ad" }, signal),
    isEmpty: (response) => response.rows.length === 0,
  });
  const rows = useMemo(() => {
    if (resource.state.status !== "ready" && resource.state.status !== "empty") return [];
    const copy = [...resource.state.data.rows];
    return copy.sort((left, right) => effectiveMetric === "CMC"
      ? rankValue(left, effectiveMetric) - rankValue(right, effectiveMetric)
      : rankValue(right, effectiveMetric) - rankValue(left, effectiveMetric));
  }, [effectiveMetric, resource.state]);
  const value = (row: MarketingEntityRow) => effectiveMetric === "SALES" ? `${row.saleCount} ta` : effectiveMetric === "ICP_FIT_RATE" ? formatMarketingRate(row.icpFitRate) : effectiveMetric === "SQL" ? `${row.sqlCount} ta` : effectiveMetric === "ROAS" ? formatMarketingRoas(row.costs.roas) : formatMarketingMoney(row.costs.cmc, row.costs.currency);
  return <section className="panel marketing-ranking"><div className="section-header"><div><h2>Ad / Creative ranking</h2><p>V1 identity: Ad ID. Bir xil video bir nechta Ad’da alohida qator bo‘ladi — asset bo‘yicha guruhlash creative_id / video_id kelganda qo‘shiladi</p></div><label className="marketing-ranking-select">Saralash<select value={effectiveMetric} onChange={(event) => setMetric(event.target.value as CreativeRankingMetric)}><option value="SALES">Sales</option>{showIcp ? <option value="ICP_FIT_RATE">ICP fit %</option> : null}<option value="SQL">SQL</option>{spendAvailable ? <><option value="ROAS">ROAS</option><option value="CMC">CMC</option></> : null}</select></label></div>
    <MarketingResourceNotice state={resource.state} onRetry={resource.retry} compact empty="Creative qatori yo‘q." />
    {rows.length > 0 ? <div className="marketing-ranking-list">{rows.slice(0, 5).map((row, index) => <button key={`${row.id}-${row.name}`} onClick={() => onOpen(row)}><span className="marketing-rank">{index + 1}</span><span><strong>{row.name}</strong><small>{row.adId ? `Ad ID ${row.adId}` : "Ad ID noma’lum"} · {row.campaignName ?? "Attribution topilmadi"}</small></span><b>{value(row)}</b></button>)}</div> : null}
  </section>;
}

function CreativeDetailDrawer({ row, showIcp, onClose }: { row: MarketingEntityRow | null; showIcp: boolean; onClose: () => void }) {
  return <Drawer open={Boolean(row)} title="Ad / Creative detail" context={row?.name} onClose={onClose} footer={<button className="button secondary" onClick={onClose}>Yopish</button>}>
    {row ? <div className="marketing-creative-detail">
      <div className="marketing-detail-block"><h3>Identity</h3><dl><div><dt>Campaign</dt><dd>{row.campaignName ?? "—"}</dd></div><div><dt>Ad Set</dt><dd>{row.adSetName ?? "—"}</dd></div><div><dt>Ad ID</dt><dd>{row.adId ?? "Attribution topilmadi"}</dd></div><div><dt>Ad name</dt><dd>{row.name}</dd></div><div><dt>Placement</dt><dd>{row.placement ?? "—"}</dd></div><div><dt>Landing / Form</dt><dd>{row.landingLabel ?? "Attribution topilmadi"}</dd></div></dl></div>
      <div className="marketing-detail-block"><h3>Funnel</h3><div className="marketing-detail-metrics"><div><span>Lead</span><strong>{row.leadCount}</strong></div><div><span>Saralangan</span><strong>{row.classifiedCount}</strong></div>{showIcp ? <div><span>ICP fit</span><strong>{row.icpFitCount ?? "—"} · {formatMarketingRate(row.icpFitRate)}</strong></div> : null}<div><span>SQL</span><strong>{row.sqlCount}</strong></div><div><span>Pipeline</span><strong>{row.pipelineCount}</strong></div><div><span>Sale</span><strong>{row.saleCount}</strong></div></div></div>
      <div className="marketing-detail-block"><h3>Business</h3><div className="marketing-hero-value"><span>Revenue</span><strong>{formatMarketingMoney(row.revenue, row.costs.currency)}</strong></div></div>
      <div className="marketing-detail-block"><h3>Cost</h3><div className="marketing-detail-metrics cost"><div><span>Spend</span><strong><CostValue costs={row.costs} metric="spend" /></strong></div><div><span>CPL</span><strong><CostValue costs={row.costs} metric="cpl" /></strong></div>{showIcp ? <div><span>Cost / ICP</span><strong><CostValue costs={row.costs} metric="costPerIcp" /></strong></div> : null}<div><span>Cost / SQL</span><strong><CostValue costs={row.costs} metric="costPerSql" /></strong></div><div><span>CMC</span><strong><CostValue costs={row.costs} metric="cmc" /></strong></div><div><span>ROAS</span><strong><CostValue costs={row.costs} metric="roas" /></strong></div></div></div>
    </div> : null}
  </Drawer>;
}

function SpendBucketRow({ label, bucket, note }: { label: string; bucket: { ads: number; spendUzs: number | null } | undefined; note?: string }) {
  return <div><span>{label}</span><strong>{bucket ? formatMarketingMoney(bucket.spendUzs) : "—"}</strong><small>{bucket ? `${bucket.ads} ta Ad` : ""}{note ? ` · ${note}` : ""}</small></div>;
}

function MarketingCoverageDetails({ resource, adIdCoverage, summary }: {
  resource: ReturnType<typeof useMarketingResource<Awaited<ReturnType<MarketingDataAdapter["getCoverage"]>>>>;
  adIdCoverage: number | null;
  summary: MarketingSummaryResponse | null;
}) {
  const data = resource.state.status === "ready" || resource.state.status === "empty" ? resource.state.data.coverage : null;
  const spend = summary?.spendAttribution ?? null;
  const meta = summary?.meta ?? null;
  const population = summary?.population ?? null;
  const excludedLabels: [keyof NonNullable<typeof population>["excluded"], string][] = [
    ["NO_META_IDS", "Meta ID yo‘q"], ["CAMPAIGN_ONLY", "Faqat campaign ID"], ["CONFLICT", "Attribution conflict"],
    ["MIXED_AD", "Mixed Ad"], ["OTHER_WORKSPACE_AD", "Boshqa workspace Ad’i"], ["NON_DASHBOARD_AD", "Non-dashboard Ad"], ["UNASSIGNED_AD", "Biriktirilmagan Ad"],
  ];
  return <details className="marketing-coverage"><summary><span>Data quality / Attribution coverage</span>{spend ? <b>Biriktirilmagan {formatMarketingMoney(spend.unassigned.spendUzs)}</b> : null}{adIdCoverage !== null ? <b>Ad ID coverage {formatMarketingRate(adIdCoverage)}</b> : null}{data ? <><b>Unknown {data.unknown}</b><b>Conflicts {data.conflicts}</b></> : null}</summary>
    {population ? <div className="marketing-population"><div className="marketing-coverage-grid">
        <div><span>CRM Leadlar</span><strong>{population.workspaceLeads}</strong><small>workspace cohort · Dashboard</small></div>
        <div><span>Meta attribution mavjud</span><strong>{population.metaAttributedLeads}</strong><small>Marketing funnel populyatsiyasi</small></div>
        <div><span>Attribution coverage</span><strong>{formatMarketingRate(population.coverage)}</strong><small>Meta ÷ CRM Leadlar</small></div>
        {excludedLabels.filter(([key]) => population.excluded[key] > 0).map(([key, label]) => <div key={key}><span>{label}</span><strong>{population.excluded[key]}</strong><small>funnel’ga kirmaydi</small></div>)}
      </div></div> : null}
    {spend ? <div className="marketing-spend-attribution"><p className="marketing-contract-note"><Info size={13} /> {ATTRIBUTED_SPEND_HELP}</p>
      <div className="marketing-coverage-grid">
        <SpendBucketRow label="Biriktirilgan reklama xarajati" bucket={spend.assigned} note="CMC/ROAS shundan" />
        <SpendBucketRow label="Biriktirilmagan" bucket={spend.unassigned} note="Deal hali bog‘lanmagan" />
        <SpendBucketRow label="Mixed" bucket={spend.mixed} note="bir nechta workspace" />
        <SpendBucketRow label="Non-dashboard funnel" bucket={spend.nonDashboard} />
        <SpendBucketRow label="Boshqa workspace’lar" bucket={spend.otherWorkspaces} />
      </div></div> : meta ? <p className="marketing-contract-note">Tanlangan davr uchun Meta spend taqsimoti mavjud emas ({meta.status}).</p> : null}
    <MarketingResourceNotice state={resource.state} onRetry={resource.retry} compact empty="Coverage ma’lumoti yo‘q." />
    {data ? <div className="marketing-coverage-grid"><div><span>Deal</span><strong>{data.deals}</strong></div><div><span>Campaign ID</span><strong>{data.withCampaignId}</strong></div><div><span>Ad Set ID</span><strong>{data.withAdsetId}</strong></div><div><span>Ad ID</span><strong>{data.withAdId}</strong></div><div><span>Unknown attribution</span><strong>{data.unknown}</strong></div><div><span>Not yet attributed</span><strong>{data.notYetAttributed}</strong></div><div><span>Conflicts</span><strong>{data.conflicts}</strong></div></div> : null}
    {meta || summary?.usdToUzs ? <p className="marketing-contract-note">{meta ? `Meta Insights: ${meta.since ?? "—"} — ${meta.until ?? "—"} · ${meta.accounts} ta hisob · ${meta.status}` : ""}{summary?.usdToUzs ? ` · Marketing kursi: 1 USD = ${summary.usdToUzs.toLocaleString("en-US").replace(/,/g, " ")} UZS (Finance kursi emas)` : ""}</p> : null}
  </details>;
}

function MarketingIcpDrawer({ open, context, adapter, onSelect, onClose }: {
  open: boolean;
  context: { workspace: MarketingWorkspaceKey; filters: MarketingFilters };
  adapter: MarketingDataAdapter;
  onSelect: (row: IcpBreakdownRow) => void;
  onClose: () => void;
}) {
  const resource = useMarketingResource({ key: `icp:${JSON.stringify(context)}`, enabled: open, load: (signal) => adapter.getIcp(context, signal) });
  if (resource.state.status === "ready" && resource.state.data.status === "ENABLED") {
    return <IcpBreakdownDrawer open={open} breakdown={resource.state.data.breakdown} context={marketingWorkspace(context.workspace).label} onSelect={onSelect} onClose={onClose} />;
  }
  const notApplicable = resource.state.status === "ready" && resource.state.data.status === "ICP_NOT_APPLICABLE"
    ? { status: "not_applicable" as const, message: "ICP bu workspace uchun qo‘llanilmaydi" } : resource.state;
  return <Drawer open={open} title="ICP ga moslik" context={marketingWorkspace(context.workspace).label} onClose={onClose} footer={<button className="button secondary" onClick={onClose}>Yopish</button>}><MarketingResourceNotice state={notApplicable} onRetry={resource.retry} /></Drawer>;
}

export function MarketingView({ workspace, adapter }: { workspace: MarketingWorkspaceKey; adapter: MarketingDataAdapter }) {
  const { state, update } = useMarketingUrlState(workspace);
  const [dealRequest, setDealRequest] = useState<MarketingDealRequest | null>(null);
  const [icpOpen, setIcpOpen] = useState(false);
  const [detail, setDetail] = useState<MarketingEntityRow | null>(null);
  const context = useMemo(() => ({ workspace, filters: state.filters }), [state.filters, workspace]);
  const contextKey = JSON.stringify(context);
  const summaryResource = useMarketingResource({
    key: `summary:${contextKey}`,
    load: (signal) => adapter.getSummary(context, signal),
    isEmpty: (response) => response.summary.leadCount === 0,
  });
  const entitiesResource = useMarketingResource({
    key: `entities:${state.level}:${contextKey}`,
    load: (signal) => adapter.getEntities({ ...context, level: state.level }, signal),
    isEmpty: (response) => response.rows.length === 0,
  });
  const coverageResource = useMarketingResource({
    key: `coverage:${contextKey}`,
    load: (signal) => adapter.getCoverage(context, signal),
    isEmpty: (response) => response.coverage.deals === 0,
  });
  const summaryResponse = summaryResource.state.status === "ready" || summaryResource.state.status === "empty" ? summaryResource.state.data : null;
  const entitiesResponse = entitiesResource.state.status === "ready" || entitiesResource.state.status === "empty" ? entitiesResource.state.data : null;
  const summary = summaryResponse?.summary ?? null;
  const options = summaryResponse?.options ?? EMPTY_MARKETING_OPTIONS;
  const showIcp = summaryResponse?.capabilities.icp === true;
  const spendAvailable = summary ? summary.costs.status === "AVAILABLE" || summary.costs.status === "NO_SALES" : false;

  const openDeals = (metric: MarketingMetric, metricLabel: string, expectedCount: number, entity: MarketingEntityRow | null = null) => {
    setDealRequest(marketingDealRequest({ workspace, filters: state.filters }, metric, metricLabel, expectedCount, entity));
  };
  const openIcpSegment = (row: IcpBreakdownRow) => {
    setIcpOpen(false);
    openDeals(row.metric, row.label, row.count);
  };
  const openEntity = (row: MarketingEntityRow) => {
    if (nextMarketingLevel(row)) update((current) => drillMarketingEntity(current, row));
    else setDetail(row);
  };
  const updateFilters = (filters: MarketingFilters) => update((current) => ({ ...current, filters }));
  useEffect(() => {
    if (!summaryResponse || adapter.source !== "http") return;
    const reconciled = reconcileMarketingFilters(state.filters, summaryResponse.options);
    if (reconciled !== state.filters) update((current) => ({ ...current, filters: reconciled }));
  }, [adapter.source, state.filters, summaryResponse, update]);

  return <div className="marketing-page">
    <MarketingFiltersBar filters={state.filters} onChange={updateFilters} options={options} />
    <div className="page-title marketing-title"><div><p className="eyebrow">MARKETING ANALYTICS</p><h1>Marketing performance</h1><p>{summaryResponse?.workspaceName ?? marketingWorkspace(workspace).label} · Faqat Meta orqali biriktirilgan Leadlar — reklama xarajati bilan bir xil populyatsiya. Barcha CRM Leadlar Dashboard’da.</p></div><div className="marketing-data-state"><RefreshCw size={15} /><span>{adapter.source === "http" ? `Marketing ma’lumoti yangilangan: ${fmtStamp(summaryResponse?.meta?.updatedAt)}` : "Typed fixture preview"}</span><small>{summaryResponse?.meta ? `Meta ${summaryResponse.meta.since ?? "—"} — ${summaryResponse.meta.until ?? "—"}` : "Meta Insights —"} · CRM sync {fmtStamp(summaryResponse?.dataAsOf)}</small></div></div>

    <MarketingResourceNotice state={summaryResource.state} onRetry={summaryResource.retry} empty="Tanlangan marketing cohort bo‘sh." />
    {summary && summary.leadCount > 0 ? <section className="kpi-grid marketing-summary-grid">
      <SummaryCard label="Meta orqali biriktirilgan Leadlar" value={String(summary.leadCount)} detail={summaryResponse?.population ? `${summaryResponse.population.workspaceLeads} ta CRM Leaddan · ${formatMarketingRate(summaryResponse.population.coverage)} attribution` : "Meta attribution mavjud Leadlar"} icon={Database} tone="blue" onClick={() => openDeals("lead", "Meta orqali biriktirilgan Leadlar", summary.leadCount)} />
      <SummaryCard label="Saralangan" value={String(summary.classifiedCount)} detail={summary.classifiedRate !== null ? `${formatMarketingRate(summary.classifiedRate)} Leaddan` : "Tanlangan marketing cohort"} icon={Check} tone="green" />
      {showIcp ? <button className="kpi-card marketing-summary-card violet" onClick={() => setIcpOpen(true)}><span className="kpi-top"><span>ICP ga moslik</span><span className="kpi-icon"><Gauge size={18} /></span></span><strong>{formatMarketingRate(summary.icpFitRate)}</strong><small>{summary.icpFitCount ?? "—"} / {summary.icpEvaluatedCount ?? "—"} belgilangan{summary.icpUnsetCount !== null ? <span className="card-note">{summary.icpUnsetCount} ta belgilanmagan</span> : null}{summary.icpEvaluationShare !== null ? <span className={`card-note marketing-icp-coverage ${summary.icpEvaluationShare < 0.5 ? "warning-text" : ""}`}>Faqat {formatMarketingRate(summary.icpEvaluationShare)} Lead baholangan</span> : null}</small><span className="marketing-card-action">Breakdown <ChevronRight size={12} /></span></button> : null}
      <SummaryCard label="SQL" value={String(summary.sqlCount)} detail={summary.sqlRate !== null ? `${formatMarketingRate(summary.sqlRate)} Saralangandan` : "Marketing cohort"} icon={Target} tone="green" onClick={() => openDeals("sql", "SQL", summary.sqlCount)} />
      <SummaryCard label="Jarayonda" value={String(summary.pipelineCount)} detail="Aktiv marketing cohort" icon={Layers3} tone="amber" onClick={() => openDeals("pipeline", "Jarayonda", summary.pipelineCount)} />
      <SummaryCard label="Sotuv" value={String(summary.saleCount)} detail={summary.sqlToSaleRate !== null ? `${formatMarketingRate(summary.sqlToSaleRate)} SQL’dan` : "Marketing cohort"} icon={CircleDollarSign} tone="cyan" onClick={() => openDeals("sale", "Sotuv", summary.saleCount)} />
    </section> : null}

    {summary ? <section className="panel marketing-efficiency"><div className="section-header"><div><h2>Marketing Efficiency</h2><p>Spend integratsiyasi holati aniq ko‘rsatiladi; unavailable qiymat 0 deb berilmaydi</p></div>{summary.costs.status !== "AVAILABLE" ? <span className="marketing-status warning">{summary.costs.message}</span> : null}</div>
      <div className="marketing-efficiency-grid"><div><span>Biriktirilgan reklama xarajati <span className="marketing-help" title={ATTRIBUTED_SPEND_HELP} aria-label={ATTRIBUTED_SPEND_HELP}><Info size={13} /></span></span><strong><CostValue costs={summary.costs} metric="spend" /></strong><small>Faqat shu workspace’ga biriktirilgan Ad’lar — Meta hisobining umumiy xarajati emas</small></div><div><span>CMC <span className="marketing-help" title={ATTRIBUTED_SPEND_HELP} aria-label={ATTRIBUTED_SPEND_HELP}><Info size={13} /></span></span><strong><CostValue costs={summary.costs} metric="cmc" /></strong><small>1 mijoz uchun marketing xarajati</small></div><div><span>ROAS</span><strong><CostValue costs={summary.costs} metric="roas" /></strong><small>1 so‘m reklama xarajati qaytargan revenue</small></div></div>
    </section> : null}

    <section className="panel marketing-attribution"><div className="section-header"><div><h2>Attribution</h2><p>CRM manba, Marketing source va Platform alohida tushunchalar sifatida saqlanadi</p></div><div className="marketing-source-legend"><span>CRM manba</span><span>Marketing source</span><span>Platform</span></div></div>
      <div className="marketing-level-switch" role="tablist" aria-label="Attribution darajasi">{LEVELS.map((level) => <button role="tab" aria-selected={state.level === level.id} key={level.id} onClick={() => update((current) => ({ ...current, level: level.id }))}>{level.label}</button>)}</div>
      <MarketingBreadcrumb state={state} options={options} onChange={update} />
      <MarketingResourceNotice state={entitiesResource.state} onRetry={entitiesResource.retry} empty={`${LEVEL_LABELS[state.level]} bo‘yicha qator yo‘q.`} />
      {entitiesResponse && entitiesResponse.rows.length > 0 ? <MarketingAttributionTable rows={entitiesResponse.rows} level={state.level} showIcp={showIcp} onEntity={openEntity} onMetric={(row, metric, label, count) => openDeals(metric, label, count, row)} /> : null}
    </section>

    <MarketingCoverageDetails resource={coverageResource} adIdCoverage={summary?.coverage.adIdCoverage ?? null} summary={summaryResponse} />
    <CreativeRanking context={context} adapter={adapter} spendAvailable={spendAvailable} showIcp={showIcp} onOpen={setDetail} />

    {showIcp ? <MarketingIcpDrawer open={icpOpen} context={context} adapter={adapter} onSelect={openIcpSegment} onClose={() => setIcpOpen(false)} /> : null}
    <MarketingDealDrawer request={dealRequest} adapter={adapter} showIcp={showIcp} onClose={() => setDealRequest(null)} />
    <CreativeDetailDrawer row={detail} showIcp={showIcp} onClose={() => setDetail(null)} />
  </div>;
}
