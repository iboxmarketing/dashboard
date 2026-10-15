"use client";

import { BarChart3, CircleDollarSign, Gauge, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { fixtureMarketingAdapter } from "./marketing-adapter";
import { EMPTY_MARKETING_FILTERS, type IcpBreakdownRow, type MarketingDataAdapter, type MarketingDealRequest } from "./marketing-types";
import type { ProjectKey } from "@/lib/sales-projects";
import { CostValue, IcpBreakdownDrawer, MarketingDealDrawer } from "./marketing-shared";

export function MarketingOverviewAdditions({ project, adapter = fixtureMarketingAdapter }: { project: ProjectKey; adapter?: MarketingDataAdapter }) {
  const snapshot = adapter.getSnapshot({ project, filters: EMPTY_MARKETING_FILTERS, level: "CAMPAIGN", parentId: null });
  const summary = snapshot.summary;
  const showIcp = snapshot.capabilities.icp;
  const showCosts = summary.costs.status === "AVAILABLE";
  const [icpOpen, setIcpOpen] = useState(false);
  const [dealRequest, setDealRequest] = useState<MarketingDealRequest | null>(null);
  const openSegment = (row: IcpBreakdownRow) => {
    setIcpOpen(false);
    setDealRequest({ project, metric: "ICP_SEGMENT", metricLabel: row.label, expectedCount: row.count, filters: EMPTY_MARKETING_FILTERS, entity: null, icpSegment: row.segment });
  };
  if (!showIcp && !showCosts) return null;
  return <>
    <section className="marketing-overview-additions" aria-label="Marketing qo‘shimcha ko‘rsatkichlari">
      {showIcp && <button className="kpi-card violet marketing-kpi-button" onClick={() => setIcpOpen(true)}>
        <span className="kpi-top"><span>ICP ga moslik</span><span className="kpi-icon"><Gauge size={18} /></span></span>
        <strong>{summary.icpFitRate}%</strong><small>{summary.icpFitCount} / {summary.icpEvaluatedCount} belgilangan<span className="card-note">{summary.icpUnsetCount} ta belgilanmagan</span></small>
      </button>}
      {showCosts && <>
        <article className="kpi-card cyan"><div className="kpi-top"><span>CMC</span><div className="kpi-icon"><CircleDollarSign size={18} /></div></div><strong><CostValue costs={summary.costs} metric="cmc" /></strong><small>1 mijoz uchun marketing xarajati</small></article>
        <article className="kpi-card green"><div className="kpi-top"><span>ROAS</span><div className="kpi-icon"><BarChart3 size={18} /></div></div><strong><CostValue costs={summary.costs} metric="roas" /></strong><small>Reklamaga sarflangan 1 so‘m necha so‘m revenue qaytardi</small></article>
      </>}
    </section>
    {showIcp && <IcpBreakdownDrawer open={icpOpen} breakdown={summary.icp} context="Dashboard · Marketing" onSelect={openSegment} onClose={() => setIcpOpen(false)} />}
    {showIcp && <MarketingDealDrawer request={dealRequest} adapter={adapter} showIcp onClose={() => setDealRequest(null)} />}
  </>;
}

export function ManagerIcpAdditions({ project, adapter = fixtureMarketingAdapter }: { project: ProjectKey; adapter?: MarketingDataAdapter }) {
  const [open, setOpen] = useState(false);
  const snapshot = adapter.getSnapshot({ project, filters: EMPTY_MARKETING_FILTERS, level: "CAMPAIGN", parentId: null });
  const showIcp = snapshot.capabilities.icp;
  const rows = useMemo(() => showIcp ? adapter.getManagerIcp(project) : [], [adapter, project, showIcp]);
  if (!showIcp) return null;
  return <section className="panel marketing-manager-panel">
    <div className="section-header"><div><h2>ICP intizomi</h2><p>Lead sifati va ICP maydoni to‘ldirilishi · marketing ko‘rsatkichi, menejer xarajati emas</p></div>
      <button className={`button secondary small ${open ? "active" : ""}`} onClick={() => setOpen((current) => !current)}><SlidersHorizontal size={15} />{open ? "ICP view’ni yopish" : "ICP view’ni ko‘rsatish"}</button></div>
    {open && <div className="table-wrap"><table className="data-table marketing-manager-table"><thead><tr><th>Menejer</th><th>ICP baholangan</th><th>ICP mos</th><th>ICP %</th><th>Belgilanmagan</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.managerId}><td className="sticky-col"><strong>{row.managerName}</strong></td><td>{row.evaluatedCount}</td><td>{row.fitCount}</td><td><span className="pill success">{row.fitRate}%</span></td><td><strong className={row.unsetCount ? "warning-text" : ""}>{row.unsetCount}</strong></td></tr>)}</tbody>
    </table></div>}
  </section>;
}
