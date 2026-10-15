"use client";

import { ExternalLink, Search, X } from "lucide-react";
import { useState } from "react";
import type {
  KpiBreakdown,
  KpiDeal,
  KpiDealFilter,
  KpiDealsBlock,
  KpiDetailResponse,
  KpiDistribution,
  KpiFunnelStep,
} from "@/lib/kpi-detail-contract";
import { Drawer } from "@/app/ui/drawer";

export type KpiTemplateProps = {
  data: KpiDetailResponse;
  activeFilter?: { key: string; value: string } | null;
  search?: string;
  onFilter: (filter: KpiDealFilter | null) => void;
  onDeal: (deal: KpiDeal) => void;
  onPage: (page: number) => void;
  onSearch: (search: string) => void;
  onSegment: (segment: string) => void;
  onSort: (sort: string) => void;
};

function Hero({ data }: { data: KpiDetailResponse }) {
  if (!data.hero) return null;
  return <section className="kpi-detail-hero" aria-label={`${data.title} asosiy ko‘rsatkichi`}>
    <div>
      <span>{data.title}</span>
      <strong>{data.hero.value}{data.hero.unit ? <small>{data.hero.unit}</small> : null}</strong>
      {data.hero.rate ? <p><b>{data.hero.rate.value}</b> {data.hero.rate.label}</p> : null}
    </div>
    {data.hero.comparison ? <div className={`kpi-detail-comparison ${data.hero.comparison.direction ?? "flat"}`}>
      <strong>{data.hero.comparison.value}</strong><span>{data.hero.comparison.label}</span>
    </div> : null}
  </section>;
}

function Summary({ data }: { data: KpiDetailResponse }) {
  const rows = data.summary?.filter((row) => row.value !== "") ?? [];
  if (!rows.length) return null;
  return <section className="kpi-detail-summary" aria-label="Qisqa xulosa">
    {rows.map((row) => <article key={row.id} className={row.tone ?? "neutral"}>
      <span>{row.label}</span><strong>{row.value}</strong>{row.note ? <small>{row.note}</small> : null}
    </article>)}
  </section>;
}

function activateRow(event: React.KeyboardEvent, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function Funnel({ steps, activeFilter, onFilter }: {
  steps?: KpiFunnelStep[];
  activeFilter?: { key: string; value: string } | null;
  onFilter: (filter: KpiDealFilter | null) => void;
}) {
  const visible = steps?.filter((step) => step.value !== "") ?? [];
  if (!visible.length) return null;
  return <section className="panel kpi-detail-section">
    <div className="section-header"><div><h2>Funnel</h2><p>Har bir foiz o‘z o‘tish bosqichi bilan ko‘rsatilgan</p></div></div>
    <div className="kpi-detail-funnel">
      {visible.map((step) => {
        const selected = Boolean(step.dealFilter && activeFilter?.key === step.dealFilter.key && activeFilter.value === step.dealFilter.value);
        const content = <><span>{step.label}</span><strong>{step.value}</strong></>;
        return <div className="kpi-detail-funnel-unit" key={step.id}>
          {step.dealFilter ? <button type="button" className={selected ? "active" : ""} aria-pressed={selected} onClick={() => onFilter(step.dealFilter ?? null)}>{content}</button> : <div>{content}</div>}
          {step.transition ? <p><b>{step.transition.value}</b><span>{step.transition.label}</span></p> : null}
        </div>;
      })}
    </div>
  </section>;
}

function displayCell(column: string, value: string | null | undefined) {
  if (column === "reason" && !value?.trim()) return "Sabab ko‘rsatilmagan";
  return value?.trim() || "—";
}

function Breakdowns({ breakdowns, activeFilter, onFilter }: {
  breakdowns?: KpiBreakdown[];
  activeFilter?: { key: string; value: string } | null;
  onFilter: (filter: KpiDealFilter | null) => void;
}) {
  const visible = breakdowns?.filter((breakdown) => breakdown.rows.length && breakdown.columns.length) ?? [];
  if (!visible.length) return null;
  return <div className="kpi-detail-breakdowns">
    {visible.map((breakdown) => <section className="panel kpi-detail-section" key={breakdown.id}>
      <div className="section-header"><div><h2>{breakdown.title}</h2>{breakdown.subtitle ? <p>{breakdown.subtitle}</p> : null}</div></div>
      <div className="table-wrap"><table className="data-table kpi-breakdown-table">
        <thead><tr>{breakdown.columns.map((column) => <th key={column.key} className={column.align === "right" ? "number" : undefined}>{column.label}</th>)}</tr></thead>
        <tbody>{breakdown.rows.map((row) => {
          const selected = Boolean(row.dealFilter && activeFilter?.key === row.dealFilter.key && activeFilter.value === row.dealFilter.value);
          const choose = () => row.dealFilter && onFilter(row.dealFilter);
          return <tr key={row.id} className={`${row.dealFilter ? "clickable" : ""} ${selected ? "selected" : ""}`}
            tabIndex={row.dealFilter ? 0 : undefined} role={row.dealFilter ? "button" : undefined} aria-pressed={row.dealFilter ? selected : undefined}
            onClick={choose} onKeyDown={(event) => row.dealFilter && activateRow(event, choose)}>
            {breakdown.columns.map((column) => <td key={column.key} className={column.align === "right" ? "number" : undefined}>
              {displayCell(column.key, row.cells[column.key])}
            </td>)}
          </tr>;
        })}</tbody>
      </table></div>
    </section>)}
  </div>;
}

function Distribution({ distribution, activeFilter, onFilter }: {
  distribution?: KpiDistribution | null;
  activeFilter?: { key: string; value: string } | null;
  onFilter: (filter: KpiDealFilter | null) => void;
}) {
  if (!distribution?.items.length) return null;
  return <section className="panel kpi-detail-section">
    <div className="section-header"><div><h2>{distribution.title}</h2>{distribution.subtitle ? <p>{distribution.subtitle}</p> : null}</div></div>
    <div className="kpi-distribution">
      {distribution.items.map((item) => {
        const selected = Boolean(item.dealFilter && activeFilter?.key === item.dealFilter.key && activeFilter.value === item.dealFilter.value);
        const content = <><span>{item.label}</span><strong>{item.value}</strong>{item.share ? <small>{item.share}</small> : null}</>;
        return item.dealFilter
          ? <button type="button" key={item.id} className={selected ? "active" : ""} aria-pressed={selected} onClick={() => onFilter(item.dealFilter ?? null)}>{content}</button>
          : <div key={item.id}>{content}</div>;
      })}
    </div>
  </section>;
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

export function DealList({ deals, search = "", activeFilter, onFilter, onDeal, onPage, onSearch, onSegment, onSort }: {
  deals: KpiDealsBlock;
  search?: string;
  activeFilter?: { key: string; value: string } | null;
  onFilter: (filter: KpiDealFilter | null) => void;
  onDeal: (deal: KpiDeal) => void;
  onPage: (page: number) => void;
  onSearch: (search: string) => void;
  onSegment: (segment: string) => void;
  onSort: (sort: string) => void;
}) {
  const [query, setQuery] = useState(search);
  const showOpportunity = deals.rows.some((row) => row.opportunity);
  return <section className="panel kpi-deal-list" aria-labelledby="kpi-deal-list-title">
    <div className="kpi-deal-list-head">
      <div><h2 id="kpi-deal-list-title">{deals.title}</h2><p>{deals.total} ta Deal · server-authoritative populyatsiya</p></div>
      <div className="kpi-deal-tools">
        {deals.searchable ? <form role="search" onSubmit={(event) => { event.preventDefault(); onSearch(query.trim()); }}>
          <Search size={15} aria-hidden="true" /><label className="sr-only" htmlFor="kpi-deal-search">Deal qidirish</label>
          <input id="kpi-deal-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Deal ID yoki nomi" />
          {query ? <button type="button" aria-label="Qidiruvni tozalash" onClick={() => { setQuery(""); onSearch(""); }}><X size={14} /></button> : null}
        </form> : null}
        {deals.sortableOpportunity ? <label className="kpi-sort">Tartib<select aria-label="Opportunity bo‘yicha tartiblash" onChange={(event) => onSort(event.target.value)} defaultValue=""><option value="">Standart</option><option value="opportunity_desc">Opportunity ↓</option><option value="opportunity_asc">Opportunity ↑</option></select></label> : null}
      </div>
    </div>
    {deals.segments?.length ? <div className="kpi-deal-segments" role="group" aria-label="Deal populyatsiyasi">
      {deals.segments.map((segment) => <button type="button" key={segment.id} className={deals.activeSegment === segment.id ? "active" : ""}
        aria-pressed={deals.activeSegment === segment.id} onClick={() => onSegment(segment.id)}>{segment.label}{segment.count ? <span>{segment.count}</span> : null}</button>)}
    </div> : null}
    {activeFilter ? <div className="kpi-active-breakdown"><span>Deal filtri: <strong>{activeFilter.value}</strong></span><button type="button" onClick={() => onFilter(null)}><X size={13} />Tozalash</button></div> : null}
    {deals.rows.length ? <div className="table-wrap kpi-deal-table-wrap"><table className="data-table kpi-deal-table">
      <thead><tr><th>Deal</th><th>Created</th><th>Manager</th><th>Source</th><th>Current Stage</th><th>Status</th>{showOpportunity ? <th className="number">Opportunity</th> : null}</tr></thead>
      <tbody>{deals.rows.map((deal) => {
        const open = () => onDeal(deal);
        return <tr key={deal.id} tabIndex={0} role="button" aria-label={`${deal.title} Deal tafsilotini ochish`} onClick={open} onKeyDown={(event) => activateRow(event, open)}>
          <td><strong>{deal.title}</strong><small>#{deal.id}</small></td><td>{formatDate(deal.createdAt)}</td><td>{deal.manager || "—"}</td><td>{deal.source || "—"}</td><td>{deal.stage || "—"}</td><td>{deal.status || "—"}</td>{showOpportunity ? <td className="number">{deal.opportunity || "—"}</td> : null}
        </tr>;
      })}</tbody>
    </table></div> : <div className="kpi-deal-empty">Bu filtrlar bo‘yicha Deal topilmadi</div>}
    {deals.pageCount > 1 ? <nav className="kpi-pagination" aria-label="Deal sahifalari">
      <button type="button" className="button secondary small" disabled={deals.page <= 1} onClick={() => onPage(deals.page - 1)}>Oldingi</button>
      <span>{deals.page} / {deals.pageCount}</span>
      <button type="button" className="button secondary small" disabled={deals.page >= deals.pageCount} onClick={() => onPage(deals.page + 1)}>Keyingi</button>
    </nav> : null}
  </section>;
}

function Analysis({ data, activeFilter, onFilter }: Pick<KpiTemplateProps, "data" | "activeFilter" | "onFilter">) {
  return <>
    <Distribution distribution={data.distribution} activeFilter={activeFilter} onFilter={onFilter} />
    <Breakdowns breakdowns={data.breakdowns} activeFilter={activeFilter} onFilter={onFilter} />
  </>;
}

function Deals(props: KpiTemplateProps) {
  if (!props.data.deals) return null;
  return <DealList key={props.search ?? ""} deals={props.data.deals} search={props.search} activeFilter={props.activeFilter} onFilter={props.onFilter}
    onDeal={props.onDeal} onPage={props.onPage} onSearch={props.onSearch} onSegment={props.onSegment} onSort={props.onSort} />;
}

export function PopulationDetailTemplate(props: KpiTemplateProps) {
  return <div data-kpi-template="population"><Hero data={props.data} /><Summary data={props.data} /><Analysis {...props} /><Deals {...props} /></div>;
}

export function SalesDetailTemplate(props: KpiTemplateProps) {
  return <div data-kpi-template="sales"><Hero data={props.data} /><Summary data={props.data} /><Funnel steps={props.data.funnel} activeFilter={props.activeFilter} onFilter={props.onFilter} /><Analysis {...props} /><Deals {...props} /></div>;
}

export function TimeDetailTemplate(props: KpiTemplateProps) {
  return <div data-kpi-template="time"><Hero data={props.data} /><Summary data={props.data} /><Analysis {...props} /><Deals {...props} /></div>;
}

export function FunnelQualityDetailTemplate(props: KpiTemplateProps) {
  return <div data-kpi-template="funnel"><Hero data={props.data} /><Summary data={props.data} /><Funnel steps={props.data.funnel} activeFilter={props.activeFilter} onFilter={props.onFilter} /><Analysis {...props} /><Deals {...props} /></div>;
}

function present(value: string | null | undefined) {
  return value !== null && value !== undefined && value !== "";
}

export function KpiDealDrawer({ deal, onClose }: { deal: KpiDeal | null; onClose: () => void }) {
  const fields = deal ? [
    ["Deal ID", `#${deal.id}`],
    ["Nomi", deal.title],
    ["Yaratilgan", deal.createdAt ? formatDate(deal.createdAt) : null],
    ["Menejer", deal.manager],
    ["Manba", deal.source],
    ["Bosqich", deal.stage],
    ["Status", deal.status],
    ["Opportunity", deal.opportunity],
  ].filter((entry): entry is [string, string] => present(entry[1])) : [];
  const safeBitrixUrl = deal?.bitrixUrl && /^https?:\/\//i.test(deal.bitrixUrl) ? deal.bitrixUrl : null;
  return <Drawer open={Boolean(deal)} title={deal?.title ?? "Deal"} context={deal ? `Deal #${deal.id}` : undefined} onClose={onClose}
    footer={<><button type="button" className="button secondary" onClick={onClose}>Yopish</button>{safeBitrixUrl ? <a className="button primary" href={safeBitrixUrl} target="_blank" rel="noreferrer">Bitrix’da ochish<ExternalLink size={15} /></a> : null}</>}>
    <div className="kpi-deal-drawer">{fields.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
  </Drawer>;
}
