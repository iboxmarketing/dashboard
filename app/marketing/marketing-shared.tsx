"use client";

import { Database, ExternalLink } from "lucide-react";
import { useMemo } from "react";
import type { MarketingDataAdapter, MarketingDealRequest, MarketingCosts, IcpBreakdown, IcpBreakdownRow } from "./marketing-types";
import { Drawer } from "../ui/drawer";

const compactNumber = new Intl.NumberFormat("uz-UZ", { notation: "compact", maximumFractionDigits: 1 });

export function formatMarketingMoney(value: number | null, currency = "UZS") {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${compactNumber.format(value)} ${currency}`;
}

export function formatMarketingRate(value: number | null, suffix = "%") {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 }).format(value)}${suffix}`;
}

export function CostValue({ costs, metric }: { costs: MarketingCosts; metric: "spend" | "cpl" | "costPerIcp" | "costPerSql" | "cmc" | "roas" }) {
  if (costs.status !== "AVAILABLE") return <span className="marketing-unavailable">{costs.message}</span>;
  const value = costs[metric];
  if (value === null) return <span className="marketing-unavailable">{metric === "cmc" ? "Sotuv yo‘q" : "Hisoblash uchun ma’lumot yetarli emas"}</span>;
  return <>{metric === "roas" ? formatMarketingRate(value, "x") : formatMarketingMoney(value, costs.currency)}</>;
}

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

export function MarketingDealDrawer({ request, adapter, showIcp, onClose }: {
  request: MarketingDealRequest | null;
  adapter: MarketingDataAdapter;
  showIcp: boolean;
  onClose: () => void;
}) {
  const deals = useMemo(() => request ? adapter.getDeals(request) : [], [adapter, request]);
  const activeFilters = request ? [
    request.filters.marketingSource,
    request.filters.platform,
    request.filters.campaignId,
    request.filters.adSetId,
    request.filters.adId,
    request.filters.placement,
    request.filters.landingId,
  ].filter(Boolean) : [];
  return <Drawer open={Boolean(request)} title={request ? `${request.metricLabel} · ${deals.length} ta Deal` : "Deal’lar"}
    context={request?.entity?.name ?? "Marketing summary"} onClose={onClose}
    footer={<button className="button secondary" onClick={onClose}>Yopish</button>}>
    <div className="marketing-deal-drawer">
      <div className="marketing-drawer-context">
        <Database size={16} />
        <div><strong>{request?.project === "IBOX" ? "IBOX" : "Sales Doctor"}</strong><small>Parent count konteksti saqlandi · {request?.filters.range === "custom" ? `${request.filters.from || "—"} — ${request.filters.to || "—"}` : `Oxirgi ${request?.filters.range ?? "30"} kun`}</small></div>
      </div>
      {activeFilters.length > 0 && <div className="marketing-filter-chips drawer-chips"><span>Faol filtrlar</span>{activeFilters.map((filter) => <b key={filter}>{filter}</b>)}</div>}
      <div className="table-wrap marketing-deals-wrap"><table className="data-table marketing-deals-table">
        <thead><tr><th>Deal</th><th>Manager</th><th>Current Stage</th><th>Quality</th>{showIcp && <th>ICP</th>}<th>CRM manba</th><th>Marketing source</th><th>Platform</th><th>Campaign</th><th>Ad Set</th><th>Ad</th><th>Created date</th><th>Sale date</th><th>Revenue</th></tr></thead>
        <tbody>{deals.map((deal) => <tr key={deal.dealId}>
          <td className="sticky-col"><strong>#{deal.dealId}</strong><small>{deal.title}</small></td><td>{deal.manager}</td><td>{deal.currentStage}</td><td>{deal.quality}</td>{showIcp && <td><span className={`marketing-icp-tag ${deal.icp.toLowerCase()}`}>{deal.icp === "UNSET" ? "Belgilanmagan" : deal.icp === "OTHER" ? "Other" : deal.icp}</span></td>}<td>{deal.crmSource}</td><td>{deal.marketingSource}</td><td>{deal.platform}</td><td>{deal.campaign}</td><td>{deal.adSet}</td><td>{deal.ad}</td><td>{fmtDate(deal.createdAt)}</td><td>{fmtDate(deal.saleAt)}</td><td>{formatMarketingMoney(deal.revenue, deal.currency)}</td>
        </tr>)}</tbody>
      </table></div>
      {!deals.length && <div className="marketing-empty">Bu kontekstda Deal topilmadi.</div>}
    </div>
  </Drawer>;
}

export function IcpBreakdownDrawer({ open, breakdown, context, onSelect, onClose }: {
  open: boolean;
  breakdown: IcpBreakdown;
  context: string;
  onSelect: (row: IcpBreakdownRow) => void;
  onClose: () => void;
}) {
  return <Drawer open={open} title="ICP ga moslik" context={context} onClose={onClose}
    footer={<button className="button secondary" onClick={onClose}>Yopish</button>}>
    <div className="marketing-icp-drawer">
      <div className="marketing-icp-total"><div><span>ICP fit</span><strong>{breakdown.icpFitRate}%</strong></div><p><b>{breakdown.icpFitCount} / {breakdown.icpEvaluatedCount}</b> belgilangan · <b>{breakdown.icpUnsetCount} ta</b> belgilanmagan</p></div>
      <p className="marketing-contract-note">P1/P2/P3 = Mos · Other = Mos emas · Belgilanmagan fit foizi maxrajiga kirmaydi.</p>
      <div className="marketing-icp-list">{breakdown.rows.map((row) => <button key={row.segment} onClick={() => onSelect(row)}>
        <span className={`marketing-icp-tag ${row.segment.toLowerCase()}`}>{row.label}</span>
        <span><strong>{row.count} ta</strong><small>{row.meaning}</small></span>
        <b>{row.share}%</b><ExternalLink size={14} />
      </button>)}</div>
    </div>
  </Drawer>;
}
