"use client";

import { BarChart3, CircleDollarSign, Gauge, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { IcpBreakdownRow, MarketingDataAdapter, MarketingDealRequest } from "./marketing-types";
import type { MarketingWorkspaceKey } from "./marketing-workspaces";
import { marketingWorkspace } from "./marketing-workspaces";
import { CostValue, formatMarketingRate, IcpBreakdownDrawer, MarketingDealDrawer } from "./marketing-shared";
import { defaultMarketingFilters } from "./marketing-url-state";
import { MarketingResourceNotice, useMarketingResource } from "./marketing-resource";
import { Drawer } from "../ui/drawer";
import { activateKpiCardOnKeyDown } from "@/lib/kpi-detail-routes";

function IcpResourceDrawer({ open, workspace, adapter, filters, onSelect, onClose }: {
  open: boolean;
  workspace: MarketingWorkspaceKey;
  adapter: MarketingDataAdapter;
  filters: ReturnType<typeof defaultMarketingFilters>;
  onSelect: (row: IcpBreakdownRow) => void;
  onClose: () => void;
}) {
  // Opened from the Overview: the whole CRM cohort, like the card it explains.
  const context = useMemo(() => ({ workspace, filters, scope: "workspace" as const }), [filters, workspace]);
  const resource = useMarketingResource({ key: `addition-icp:${JSON.stringify(context)}`, enabled: open, load: (signal) => adapter.getIcp(context, signal) });
  if (resource.state.status === "ready" && resource.state.data.status === "ENABLED") {
    return <IcpBreakdownDrawer open={open} breakdown={resource.state.data.breakdown} context="Dashboard · Marketing" onSelect={onSelect} onClose={onClose} />;
  }
  const state = resource.state.status === "ready" && resource.state.data.status === "ICP_NOT_APPLICABLE"
    ? { status: "not_applicable" as const, message: "ICP bu workspace uchun qo‘llanilmaydi" } : resource.state;
  return <Drawer open={open} title="ICP ga moslik" context={marketingWorkspace(workspace).label} onClose={onClose} footer={<button className="button secondary" onClick={onClose}>Yopish</button>}><MarketingResourceNotice state={state} onRetry={resource.retry} /></Drawer>;
}

/** The host page's own date range (Tashkent dates); the Marketing default when absent. */
export type MarketingRange = { from: string; to: string } | null | undefined;
function filtersForRange(range: MarketingRange) {
  const base = defaultMarketingFilters();
  return range?.from && range?.to ? { ...base, range: "custom" as const, startDate: range.from, endDate: range.to } : base;
}

/**
 * Overview ICP card (IBOX only — workspace capability). CMC/ROAS cards are
 * feature-gated off by default: the Marketing page is V1's home for cost analytics.
 */
export function MarketingOverviewAdditions({ workspace, adapter, range, showCosts = false, detailHref }: {
  workspace: MarketingWorkspaceKey; adapter: MarketingDataAdapter; range?: MarketingRange; showCosts?: boolean; detailHref?: string;
}) {
  const filters = useMemo(() => filtersForRange(range), [range]);
  // The Overview is the whole CRM cohort: workspace scope (its ICP is every IBOX Lead).
  const context = useMemo(() => ({ workspace, filters, scope: "workspace" as const }), [filters, workspace]);
  const summaryResource = useMarketingResource({ key: `overview-summary:${JSON.stringify(context)}`, load: (signal) => adapter.getSummary(context, signal), isEmpty: (response) => response.summary.leadCount === 0 });
  const [icpOpen, setIcpOpen] = useState(false);
  const [dealRequest, setDealRequest] = useState<MarketingDealRequest | null>(null);
  const response = summaryResource.state.status === "ready" || summaryResource.state.status === "empty" ? summaryResource.state.data : null;
  const summary = response?.summary ?? null;
  const showIcp = response?.capabilities.icp === true;
  const openSegment = (row: IcpBreakdownRow) => {
    setIcpOpen(false);
    setDealRequest({ workspace, scope: "workspace", metric: row.metric, metricLabel: row.label, expectedCount: row.count, filters, entity: null });
  };
  return <>
    <MarketingResourceNotice state={summaryResource.state} onRetry={summaryResource.retry} compact empty="Marketing cohort bo‘sh." />
    {summary && (showIcp || showCosts) ? <section className="marketing-overview-additions" aria-label="Marketing qo‘shimcha ko‘rsatkichlari">
      {showIcp ? detailHref ? <a className="kpi-card violet marketing-kpi-button kpi-card-link" href={detailHref} onKeyDown={activateKpiCardOnKeyDown}>
        <span className="kpi-top"><span>ICP ga moslik</span><span className="kpi-icon"><Gauge size={18} /></span></span>
        <strong>{formatMarketingRate(summary.icpFitRate)}</strong><small>{summary.icpFitCount ?? "—"} / {summary.icpEvaluatedCount ?? "—"} belgilangan{summary.icpUnsetCount !== null ? <span className="card-note">{summary.icpUnsetCount} ta belgilanmagan</span> : null}{summary.icpEvaluationShare !== null ? <span className={`card-note marketing-icp-coverage ${summary.icpEvaluationShare < 0.5 ? "warning-text" : ""}`}>Faqat {formatMarketingRate(summary.icpEvaluationShare)} Lead baholangan</span> : null}</small>
      </a> : <button className="kpi-card violet marketing-kpi-button" onClick={() => setIcpOpen(true)}>
        <span className="kpi-top"><span>ICP ga moslik</span><span className="kpi-icon"><Gauge size={18} /></span></span>
        <strong>{formatMarketingRate(summary.icpFitRate)}</strong><small>{summary.icpFitCount ?? "—"} / {summary.icpEvaluatedCount ?? "—"} belgilangan{summary.icpUnsetCount !== null ? <span className="card-note">{summary.icpUnsetCount} ta belgilanmagan</span> : null}{summary.icpEvaluationShare !== null ? <span className={`card-note marketing-icp-coverage ${summary.icpEvaluationShare < 0.5 ? "warning-text" : ""}`}>Faqat {formatMarketingRate(summary.icpEvaluationShare)} Lead baholangan</span> : null}</small>
      </button> : null}
      {showCosts ? <><article className="kpi-card cyan"><div className="kpi-top"><span>CMC</span><div className="kpi-icon"><CircleDollarSign size={18} /></div></div><strong><CostValue costs={summary.costs} metric="cmc" /></strong><small>1 mijoz uchun marketing xarajati</small></article>
      <article className="kpi-card green"><div className="kpi-top"><span>ROAS</span><div className="kpi-icon"><BarChart3 size={18} /></div></div><strong><CostValue costs={summary.costs} metric="roas" /></strong><small>Reklamaga sarflangan 1 so‘m necha so‘m revenue qaytardi</small></article></> : null}
    </section> : null}
    {showIcp ? <IcpResourceDrawer open={icpOpen} workspace={workspace} adapter={adapter} filters={filters} onSelect={openSegment} onClose={() => setIcpOpen(false)} /> : null}
    <MarketingDealDrawer request={dealRequest} adapter={adapter} showIcp={showIcp} onClose={() => setDealRequest(null)} />
  </>;
}

export function ManagerIcpAdditions({ workspace, adapter, range }: { workspace: MarketingWorkspaceKey; adapter: MarketingDataAdapter; range?: MarketingRange }) {
  const filters = useMemo(() => filtersForRange(range), [range]);
  // Managers own every CRM Lead, not only Meta-attributed ones: workspace scope.
  const context = useMemo(() => ({ workspace, filters, scope: "workspace" as const }), [filters, workspace]);
  const [open, setOpen] = useState(false);
  const summaryResource = useMarketingResource({ key: `manager-summary:${JSON.stringify(context)}`, load: (signal) => adapter.getSummary(context, signal) });
  const summary = summaryResource.state.status === "ready" || summaryResource.state.status === "empty" ? summaryResource.state.data : null;
  const showIcp = summary?.capabilities.icp === true;
  const icpResource = useMarketingResource({
    key: `manager-icp:${JSON.stringify(context)}`,
    enabled: showIcp && open,
    load: (signal) => adapter.getIcp(context, signal),
    isEmpty: (response) => response.status === "ENABLED" && response.byManager.length === 0,
  });
  const rows = (icpResource.state.status === "ready" || icpResource.state.status === "empty") && icpResource.state.data.status === "ENABLED"
    ? icpResource.state.data.byManager : [];

  if (summaryResource.state.status === "loading" || summaryResource.state.status === "error" || summaryResource.state.status === "not_applicable") {
    return <MarketingResourceNotice state={summaryResource.state} onRetry={summaryResource.retry} compact />;
  }
  if (!showIcp) return null;
  return <section className="panel marketing-manager-panel">
    <div className="section-header"><div><h2>ICP intizomi</h2><p>Lead sifati va ICP maydoni to‘ldirilishi · marketing ko‘rsatkichi, menejer xarajati emas</p></div>
      <button className={`button secondary small ${open ? "active" : ""}`} onClick={() => setOpen((current) => !current)}><SlidersHorizontal size={15} />{open ? "ICP view’ni yopish" : "ICP view’ni ko‘rsatish"}</button></div>
    {open ? <MarketingResourceNotice state={icpResource.state} onRetry={icpResource.retry} compact empty="Menejer ICP qatori yo‘q." /> : null}
    {open && rows.length > 0 ? <div className="table-wrap"><table className="data-table marketing-manager-table"><thead><tr><th>Menejer</th><th>ICP baholangan</th><th>ICP mos</th><th>ICP %</th><th>Belgilanmagan</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.managerId}><td className="sticky-col"><strong>{row.managerName}</strong></td><td>{row.evaluatedCount}</td><td>{row.fitCount}</td><td><span className="pill success">{formatMarketingRate(row.fitRate)}</span></td><td><strong className={row.unsetCount ? "warning-text" : ""}>{row.unsetCount}</strong></td></tr>)}</tbody>
    </table></div> : null}
  </section>;
}
