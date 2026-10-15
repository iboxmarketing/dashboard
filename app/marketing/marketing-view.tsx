"use client";

import {
  CalendarDays, Check, ChevronDown, ChevronRight, CircleDollarSign, Database,
  ExternalLink, Filter, Gauge, Layers3, RefreshCw, Target, X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { fixtureMarketingAdapter, nextMarketingLevel } from "./marketing-adapter";
import {
  EMPTY_MARKETING_FILTERS,
  type CreativeRankingMetric, type IcpBreakdownRow, type MarketingDataAdapter, type MarketingDealRequest,
  type MarketingEntityLevel, type MarketingEntityRow, type MarketingFilters, type MarketingMetric,
} from "./marketing-types";
import type { ProjectKey } from "@/lib/sales-projects";
import { Drawer } from "../ui/drawer";
import { CostValue, formatMarketingMoney, IcpBreakdownDrawer, MarketingDealDrawer } from "./marketing-shared";

const LEVELS: { id: MarketingEntityLevel; label: string }[] = [
  { id: "CAMPAIGN", label: "Campaign" },
  { id: "AD_SET", label: "Ad Set" },
  { id: "AD", label: "Ad / Creative" },
  { id: "PLACEMENT", label: "Placement" },
  { id: "LANDING_FORM", label: "Landing / Form" },
];

const LEVEL_LABELS = Object.fromEntries(LEVELS.map((item) => [item.id, item.label])) as Record<MarketingEntityLevel, string>;
export type MarketingNavigation = { level: MarketingEntityLevel; parentId: string | null; trail: MarketingEntityRow[] };
export const INITIAL_MARKETING_NAVIGATION: MarketingNavigation = { level: "CAMPAIGN", parentId: null, trail: [] };

/** Pure navigation transition: filters live outside this state and are retained. */
export function drillMarketingEntity(current: MarketingNavigation, row: MarketingEntityRow): MarketingNavigation {
  const level = nextMarketingLevel(row);
  if (!level) return current;
  return { level, parentId: row.id, trail: [...current.trail, row] };
}

function SelectFilter({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  return <label className={`marketing-filter ${value ? "active" : ""}`}><span>{label}</span><div><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Barchasi</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select><ChevronDown size={13} /></div></label>;
}

function MarketingFiltersBar({ filters, setFilters, options }: {
  filters: MarketingFilters;
  setFilters: React.Dispatch<React.SetStateAction<MarketingFilters>>;
  options: ReturnType<MarketingDataAdapter["getSnapshot"]>["options"];
}) {
  const set = (key: keyof MarketingFilters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const selections = [
    filters.marketingSource && options.marketingSources.find((item) => item.id === filters.marketingSource)?.name,
    filters.platform && options.platforms.find((item) => item.id === filters.platform)?.name,
    filters.campaignId && options.campaigns.find((item) => item.id === filters.campaignId)?.name,
    filters.adSetId && options.adSets.find((item) => item.id === filters.adSetId)?.name,
    filters.adId && options.ads.find((item) => item.id === filters.adId)?.name,
    filters.placement && options.placements.find((item) => item.id === filters.placement)?.name,
    filters.landingId && options.landingForms.find((item) => item.id === filters.landingId)?.name,
  ].filter((value): value is string => Boolean(value));
  const dateLabel = filters.range === "custom" ? `${filters.from || "…"} — ${filters.to || "…"}` : filters.range === "month" ? "Shu oy" : filters.range === "lastMonth" ? "O‘tgan oy" : `Oxirgi ${filters.range} kun`;
  return <section className="marketing-filters" aria-label="Marketing filtrlari">
    <div className="marketing-filter-scroll">
      <label className="marketing-filter active"><span>Date</span><div><select value={filters.range} onChange={(event) => set("range", event.target.value)}><option value="7">Oxirgi 7 kun</option><option value="30">Oxirgi 30 kun</option><option value="month">Shu oy</option><option value="lastMonth">O‘tgan oy</option><option value="custom">Custom</option></select><CalendarDays size={13} /></div></label>
      <SelectFilter label="Marketing Source" value={filters.marketingSource} options={options.marketingSources} onChange={(value) => set("marketingSource", value)} />
      <SelectFilter label="Platform" value={filters.platform} options={options.platforms} onChange={(value) => set("platform", value)} />
      <SelectFilter label="Campaign" value={filters.campaignId} options={options.campaigns} onChange={(value) => set("campaignId", value)} />
      <SelectFilter label="Ad Set" value={filters.adSetId} options={options.adSets} onChange={(value) => set("adSetId", value)} />
      <SelectFilter label="Ad / Creative" value={filters.adId} options={options.ads} onChange={(value) => set("adId", value)} />
      <SelectFilter label="Placement" value={filters.placement} options={options.placements} onChange={(value) => set("placement", value)} />
      <SelectFilter label="Landing / Form" value={filters.landingId} options={options.landingForms} onChange={(value) => set("landingId", value)} />
      {selections.length > 0 && <button className="marketing-clear" onClick={() => setFilters(EMPTY_MARKETING_FILTERS)}><X size={14} />Tozalash</button>}
    </div>
    {filters.range === "custom" && <div className="marketing-custom-dates"><label>Boshlanish<input type="date" value={filters.from} onChange={(event) => set("from", event.target.value)} /></label><label>Tugash<input type="date" value={filters.to} onChange={(event) => set("to", event.target.value)} /></label></div>}
    <div className="marketing-filter-chips"><span><Filter size={13} />Faol filtrlar</span><b>{dateLabel}</b>{selections.map((value) => <b key={value}>{value}</b>)}</div>
  </section>;
}

function SummaryCard({ label, value, detail, icon: Icon, tone, onClick }: {
  label: string; value: string; detail: React.ReactNode; icon: typeof Database; tone: string; onClick: () => void;
}) {
  return <button className={`kpi-card marketing-summary-card ${tone}`} onClick={onClick}><span className="kpi-top"><span>{label}</span><span className="kpi-icon"><Icon size={18} /></span></span><strong>{value}</strong><small>{detail}</small><span className="marketing-card-action">Deal’larni ko‘rish <ExternalLink size={12} /></span></button>;
}

function MarketingBreadcrumb({ navigation, onRoot, onAt }: { navigation: MarketingNavigation; onRoot: () => void; onAt: (index: number) => void }) {
  if (!navigation.trail.length) return null;
  return <nav className="marketing-breadcrumb" aria-label="Marketing drilldown"><button onClick={onRoot}>Campaign</button>{navigation.trail.map((item, index) => <span key={item.id}><ChevronRight size={13} />{index < navigation.trail.length - 1 ? <button onClick={() => onAt(index)}>{item.name}</button> : <strong>{item.name}</strong>}</span>)}<span><ChevronRight size={13} /><b>{LEVEL_LABELS[navigation.level]}</b></span></nav>;
}

function MarketingAttributionTable({ rows, level, showIcp, onEntity, onMetric }: {
  rows: MarketingEntityRow[];
  level: MarketingEntityLevel;
  showIcp: boolean;
  onEntity: (row: MarketingEntityRow) => void;
  onMetric: (row: MarketingEntityRow, metric: MarketingMetric, label: string, count: number) => void;
}) {
  return <div className="table-wrap marketing-table-wrap"><table className="data-table marketing-table">
    <thead><tr><th className="sticky-col">Name</th><th>Lead</th>{showIcp && <><th>ICP mos</th><th>ICP %</th></>}<th>SQL</th><th>Jarayonda</th><th>Sotuv</th><th>Revenue</th><th>Spend</th><th>CMC</th><th>ROAS</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id}>
      <td className="sticky-col"><button className="marketing-entity-link" onClick={() => onEntity(row)}><span>{row.name}</span><small>{row.secondary}{row.landingType === "INSTANT_FORM" ? " · Instant Form" : row.landingType === "WEBSITE" ? " · Website" : ""}</small></button></td>
      <td><button className="marketing-count" onClick={() => onMetric(row, "LEAD", "Lead", row.leadCount)}>{row.leadCount}</button></td>
      {showIcp && <><td><button className="marketing-count" onClick={() => onMetric(row, "ICP_FIT", "ICP mos", row.icpFitCount)}>{row.icpFitCount}</button></td>
        <td><span className="pill success">{row.icpFitRate}%</span><small>{row.icpFitCount} / {row.icpEvaluatedCount}</small></td></>}
      <td><button className="marketing-count" onClick={() => onMetric(row, "SQL", "SQL", row.sqlCount)}>{row.sqlCount}</button><small>{row.sqlRate}% Leaddan</small></td>
      <td><button className="marketing-count" onClick={() => onMetric(row, "PIPELINE", "Jarayonda", row.pipelineCount)}>{row.pipelineCount}</button></td>
      <td><button className="marketing-count success" onClick={() => onMetric(row, "SALE", "Sotuv", row.saleCount)}>{row.saleCount}</button><small>{row.sqlToSaleRate}% SQL’dan</small></td>
      <td><strong>{formatMarketingMoney(row.revenue, row.costs.currency)}</strong></td>
      <td><CostValue costs={row.costs} metric="spend" /></td><td><CostValue costs={row.costs} metric="cmc" /></td><td><CostValue costs={row.costs} metric="roas" /></td>
    </tr>)}</tbody>
  </table>{!rows.length && <div className="marketing-empty">{LEVEL_LABELS[level]} bo‘yicha fixture qatori yo‘q.</div>}</div>;
}

function CreativeRanking({ project, adapter, spendAvailable, showIcp, onOpen }: { project: ProjectKey; adapter: MarketingDataAdapter; spendAvailable: boolean; showIcp: boolean; onOpen: (adId: string) => void }) {
  const [metric, setMetric] = useState<CreativeRankingMetric>("SALES");
  const effectiveMetric = !showIcp && metric === "ICP_FIT_RATE" ? "SALES" : metric;
  const rows = useMemo(() => adapter.getCreativeRanking(project, effectiveMetric), [adapter, effectiveMetric, project]);
  const value = (row: (typeof rows)[number]) => effectiveMetric === "SALES" ? `${row.sales} ta` : effectiveMetric === "ICP_FIT_RATE" ? `${row.icpFitRate}%` : effectiveMetric === "SQL" ? `${row.sql} ta` : effectiveMetric === "ROAS" ? row.roas === null ? "—" : `${row.roas}x` : formatMarketingMoney(row.cmc, row.currency);
  return <section className="panel marketing-ranking"><div className="section-header"><div><h2>Creative Ranking</h2><p>V1 identity: Ad ID · backend creative_id / video_id bersa shu blok asset-level grouping’ni qabul qiladi</p></div><label className="marketing-ranking-select">Saralash<select value={effectiveMetric} onChange={(event) => setMetric(event.target.value as CreativeRankingMetric)}><option value="SALES">Sales</option>{showIcp && <option value="ICP_FIT_RATE">ICP fit %</option>}<option value="SQL">SQL</option>{spendAvailable && <><option value="ROAS">ROAS</option><option value="CMC">CMC</option></>}</select></label></div>
    <div className="marketing-ranking-list">{rows.slice(0, 5).map((row, index) => <button key={`${row.adId}-${row.adName}`} onClick={() => onOpen(row.adId)}><span className="marketing-rank">{index + 1}</span><span><strong>{row.adName}</strong><small>{row.adId === "—" ? "Ad ID noma’lum" : `Ad ID ${row.adId}`} · {row.campaignName}</small></span><b>{value(row)}</b></button>)}</div>
  </section>;
}

function CreativeDetailDrawer({ row, showIcp, onClose }: { row: MarketingEntityRow | null; showIcp: boolean; onClose: () => void }) {
  return <Drawer open={Boolean(row)} title="Ad / Creative detail" context={row?.name} onClose={onClose} footer={<button className="button secondary" onClick={onClose}>Yopish</button>}>
    {row && <div className="marketing-creative-detail">
      <div className="marketing-detail-block"><h3>Identity</h3><dl><div><dt>Campaign</dt><dd>{row.campaignName ?? "—"}</dd></div><div><dt>Ad Set</dt><dd>{row.adSetName ?? "—"}</dd></div><div><dt>Ad ID</dt><dd>{row.adId ?? "Attribution topilmadi"}</dd></div><div><dt>Ad name</dt><dd>{row.name}</dd></div><div><dt>Placement</dt><dd>{row.placement ?? "—"}</dd></div><div><dt>Landing / Form</dt><dd>{row.landingLabel ?? "Attribution topilmadi"}{row.landingType === "INSTANT_FORM" ? <small>Meta Instant Form</small> : row.landingType === "WEBSITE" ? <small>Website landing page</small> : null}</dd></div></dl></div>
      <div className="marketing-detail-block"><h3>Funnel</h3><div className="marketing-detail-metrics"><div><span>Lead</span><strong>{row.leadCount}</strong></div><div><span>Saralangan</span><strong>{row.classifiedCount}</strong></div>{showIcp && <div><span>ICP fit</span><strong>{row.icpFitCount} · {row.icpFitRate}%</strong></div>}<div><span>SQL</span><strong>{row.sqlCount}</strong></div><div><span>Pipeline</span><strong>{row.pipelineCount}</strong></div><div><span>Sale</span><strong>{row.saleCount}</strong></div></div></div>
      <div className="marketing-detail-block"><h3>Business</h3><div className="marketing-hero-value"><span>Revenue</span><strong>{formatMarketingMoney(row.revenue, row.costs.currency)}</strong></div></div>
      <div className="marketing-detail-block"><h3>Cost</h3><div className="marketing-detail-metrics cost"><div><span>Spend</span><strong><CostValue costs={row.costs} metric="spend" /></strong></div><div><span>CPL</span><strong><CostValue costs={row.costs} metric="cpl" /></strong></div>{showIcp && <div><span>Cost / ICP</span><strong><CostValue costs={row.costs} metric="costPerIcp" /></strong></div>}<div><span>Cost / SQL</span><strong><CostValue costs={row.costs} metric="costPerSql" /></strong></div><div><span>CMC</span><strong><CostValue costs={row.costs} metric="cmc" /></strong></div><div><span>ROAS</span><strong><CostValue costs={row.costs} metric="roas" /></strong></div></div></div>
    </div>}
  </Drawer>;
}

export function MarketingView({ project, adapter = fixtureMarketingAdapter }: { project: ProjectKey; adapter?: MarketingDataAdapter }) {
  const [filters, setFilters] = useState<MarketingFilters>(EMPTY_MARKETING_FILTERS);
  const [navigation, setNavigation] = useState<MarketingNavigation>(INITIAL_MARKETING_NAVIGATION);
  const [dealRequest, setDealRequest] = useState<MarketingDealRequest | null>(null);
  const [icpOpen, setIcpOpen] = useState(false);
  const [detail, setDetail] = useState<MarketingEntityRow | null>(null);
  const snapshot = adapter.getSnapshot({ project, filters, level: navigation.level, parentId: navigation.parentId });
  const allAds = adapter.getSnapshot({ project, filters, level: "AD", parentId: null }).rows;
  const summary = snapshot.summary;
  const showIcp = snapshot.capabilities.icp;
  const spendAvailable = summary.costs.status === "AVAILABLE";

  const openDeals = (metric: MarketingMetric, metricLabel: string, expectedCount: number, entity: MarketingEntityRow | null = null) => setDealRequest({ project, metric, metricLabel, expectedCount, filters, entity });
  const openIcpSegment = (row: IcpBreakdownRow) => {
    setIcpOpen(false);
    setDealRequest({ project, metric: "ICP_SEGMENT", metricLabel: row.label, expectedCount: row.count, filters, entity: null, icpSegment: row.segment });
  };
  const openEntity = (row: MarketingEntityRow) => {
    const next = nextMarketingLevel(row);
    if (next) setNavigation((current) => drillMarketingEntity(current, row));
    else setDetail(row);
  };
  const setLevel = (level: MarketingEntityLevel) => setNavigation({ level, parentId: null, trail: [] });
  const navigateAt = (index: number) => {
    const parent = navigation.trail[index];
    const level = nextMarketingLevel(parent);
    if (level) setNavigation({ level, parentId: parent.id, trail: navigation.trail.slice(0, index + 1) });
  };

  return <div className="marketing-page">
    <MarketingFiltersBar filters={filters} setFilters={setFilters} options={snapshot.options} />
    <div className="page-title marketing-title"><div><p className="eyebrow">MARKETING ANALYTICS</p><h1>Marketing performance</h1><p>{snapshot.projectName} · Lead sifati, attribution va reklama samaradorligi bitta kontekstda.</p></div><div className="marketing-data-state"><RefreshCw size={15} /><span>Typed fixture preview</span><small>Backend adapter kutilmoqda</small></div></div>

    <section className="kpi-grid marketing-summary-grid">
      <SummaryCard label="Lead" value={String(summary.leadCount)} detail="Tanlangan marketing cohort" icon={Database} tone="blue" onClick={() => openDeals("LEAD", "Lead", summary.leadCount)} />
      <SummaryCard label="Saralangan" value={String(summary.classifiedCount)} detail={showIcp ? `${summary.icpUnsetCount} ta ICP belgilanmagan` : "Tanlangan marketing cohort"} icon={Check} tone="green" onClick={() => openDeals("CLASSIFIED", "Saralangan", summary.classifiedCount)} />
      {showIcp && <button className="kpi-card marketing-summary-card violet" onClick={() => setIcpOpen(true)}><span className="kpi-top"><span>ICP ga moslik</span><span className="kpi-icon"><Gauge size={18} /></span></span><strong>{summary.icpFitRate}%</strong><small>{summary.icpFitCount} / {summary.icpEvaluatedCount} belgilangan<span className="card-note">{summary.icpUnsetCount} ta belgilanmagan</span></small><span className="marketing-card-action">Breakdown <ChevronRight size={12} /></span></button>}
      <SummaryCard label="SQL" value={String(summary.sqlCount)} detail={`${summary.sqlRate}% Leaddan`} icon={Target} tone="green" onClick={() => openDeals("SQL", "SQL", summary.sqlCount)} />
      <SummaryCard label="Jarayonda" value={String(summary.pipelineCount)} detail="Aktiv marketing cohort" icon={Layers3} tone="amber" onClick={() => openDeals("PIPELINE", "Jarayonda", summary.pipelineCount)} />
      <SummaryCard label="Sotuv" value={String(summary.saleCount)} detail={`${summary.sqlToSaleRate}% SQL’dan`} icon={CircleDollarSign} tone="cyan" onClick={() => openDeals("SALE", "Sotuv", summary.saleCount)} />
    </section>

    <section className="panel marketing-efficiency"><div className="section-header"><div><h2>Marketing Efficiency</h2><p>Spend integration holati aniq ko‘rsatiladi; ulanmagan xarajat 0 deb berilmaydi</p></div>{!spendAvailable && <span className="marketing-status warning">{summary.costs.message}</span>}</div>
      <div className="marketing-efficiency-grid"><div><span>Spend</span><strong><CostValue costs={summary.costs} metric="spend" /></strong><small>Reklama xarajati</small></div><div><span>CMC</span><strong><CostValue costs={summary.costs} metric="cmc" /></strong><small>1 mijoz uchun marketing xarajati</small></div><div><span>ROAS</span><strong><CostValue costs={summary.costs} metric="roas" /></strong><small>1 so‘m reklama xarajati qaytargan revenue</small></div></div>
    </section>

    <section className="panel marketing-attribution"><div className="section-header"><div><h2>Attribution</h2><p>CRM manba, Marketing source va Platform alohida tushunchalar sifatida saqlanadi</p></div><div className="marketing-source-legend"><span>CRM manba</span><span>Marketing source</span><span>Platform</span></div></div>
      <div className="marketing-level-switch" role="tablist" aria-label="Attribution darajasi">{LEVELS.map((level) => <button role="tab" aria-selected={navigation.level === level.id} key={level.id} onClick={() => setLevel(level.id)}>{level.label}</button>)}</div>
      <MarketingBreadcrumb navigation={navigation} onRoot={() => setLevel("CAMPAIGN")} onAt={navigateAt} />
      <MarketingAttributionTable rows={snapshot.rows} level={navigation.level} showIcp={showIcp} onEntity={openEntity} onMetric={(row, metric, label, count) => openDeals(metric, label, count, row)} />
    </section>

    <CreativeRanking project={project} adapter={adapter} spendAvailable={spendAvailable} showIcp={showIcp} onOpen={(adId) => setDetail(allAds.find((row) => row.adId === adId) ?? null)} />

    {showIcp && <IcpBreakdownDrawer open={icpOpen} breakdown={summary.icp} context={`${snapshot.projectName} · ${summary.icpFitRate}%`} onSelect={openIcpSegment} onClose={() => setIcpOpen(false)} />}
    <MarketingDealDrawer request={dealRequest} adapter={adapter} showIcp={showIcp} onClose={() => setDealRequest(null)} />
    <CreativeDetailDrawer row={detail} showIcp={showIcp} onClose={() => setDetail(null)} />
  </div>;
}
