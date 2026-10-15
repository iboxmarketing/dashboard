"use client";

import { Database, ExternalLink } from "lucide-react";
import type { MarketingCosts, MarketingDataAdapter, MarketingDealRequest, IcpBreakdown, IcpBreakdownRow } from "./marketing-types";
import { Drawer } from "../ui/drawer";
import { MarketingResourceNotice, useMarketingResource } from "./marketing-resource";
import { marketingWorkspace } from "./marketing-workspaces";

const compactNumber = new Intl.NumberFormat("uz-UZ", { notation: "compact", maximumFractionDigits: 1 });

export function formatMarketingMoney(value: number | null, currency = "UZS") {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${compactNumber.format(value)} ${currency}`;
}

/** API rates are 0..1 ratios; converting that ratio to display percent is formatting only. */
export function formatMarketingRate(value: number | null, suffix = "%") {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 }).format(value * 100)}${suffix}`;
}

const COST_MESSAGES: Record<Exclude<MarketingCosts["status"], "AVAILABLE" | "NO_SALES">, string> = {
  NO_SPEND: "Spend yo‘q",
  META_NOT_CONNECTED: "Meta Insights ulanmagan",
  PENDING: "Spend ma’lumoti kutilmoqda",
  CURRENCY_UNAVAILABLE: "Currency rate unavailable",
  NOT_APPLICABLE: "Bu kesimda spend qo‘llanilmaydi",
};

export function CostValue({ costs, metric }: { costs: MarketingCosts; metric: "spend" | "cpl" | "costPerIcp" | "costPerSql" | "cmc" | "roas" }) {
  if (costs.status !== "AVAILABLE" && costs.status !== "NO_SALES") {
    return <span className="marketing-unavailable">{costs.message ?? COST_MESSAGES[costs.status]}</span>;
  }
  const value = costs[metric];
  if (value === null) {
    const message = metric === "cmc" && costs.status === "NO_SALES" ? "Sotuv yo‘q" : "Hisoblash uchun ma’lumot yetarli emas";
    return <span className="marketing-unavailable">{message}</span>;
  }
  return <>{metric === "roas" ? `${new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 2 }).format(value)}x` : formatMarketingMoney(value, costs.currency)}</>;
}

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function dealRequestKey(request: MarketingDealRequest | null) {
  if (!request) return "closed";
  return JSON.stringify({ workspace: request.workspace, metric: request.metric, filters: request.filters, entity: request.entity?.id ?? null });
}

export function MarketingDealDrawer({ request, adapter, showIcp, onClose }: {
  request: MarketingDealRequest | null;
  adapter: MarketingDataAdapter;
  showIcp: boolean;
  onClose: () => void;
}) {
  const resource = useMarketingResource({
    key: dealRequestKey(request),
    enabled: Boolean(request),
    load: (signal) => adapter.getDeals(request!, signal),
    isEmpty: (response) => response.deals.length === 0,
  });
  const filters = request?.filters;
  const activeFilters = filters ? [
    filters.source, filters.platform, filters.campaignId, filters.adsetId,
    filters.adId, filters.placement, filters.landing,
  ].filter(Boolean) : [];
  const response = resource.state.status === "ready" || resource.state.status === "empty" ? resource.state.data : null;
  return <Drawer open={Boolean(request)} title={request ? `${request.metricLabel} · ${response?.count ?? request.expectedCount ?? "…"} ta Deal` : "Deal’lar"}
    context={request?.entity?.name ?? "Marketing summary"} onClose={onClose}
    footer={<button className="button secondary" onClick={onClose}>Yopish</button>}>
    <div className="marketing-deal-drawer">
      <div className="marketing-drawer-context">
        <Database size={16} />
        <div><strong>{request ? marketingWorkspace(request.workspace).label : "Marketing"}</strong><small>Inherited context · {filters?.startDate ?? "—"} — {filters?.endDate ?? "—"}</small></div>
      </div>
      {activeFilters.length > 0 ? <div className="marketing-filter-chips drawer-chips"><span>Faol filtrlar</span>{activeFilters.map((filter) => <b key={filter}>{filter}</b>)}</div> : null}
      <MarketingResourceNotice state={resource.state} onRetry={resource.retry} empty="Bu kontekstda Deal topilmadi." />
      {response && response.deals.length > 0 ? <div className="table-wrap marketing-deals-wrap"><table className="data-table marketing-deals-table">
        <thead><tr><th>Deal</th><th>Manager</th><th>Current Stage</th><th>Quality</th>{showIcp ? <th>ICP</th> : null}<th>CRM manba</th><th>Marketing source</th><th>Platform</th><th>Campaign</th><th>Ad Set</th><th>Ad</th><th>Created date</th><th>Sale date</th><th>Revenue</th></tr></thead>
        <tbody>{response.deals.map((deal) => <tr key={deal.dealId}>
          <td className="sticky-col"><strong>#{deal.dealId}</strong><small>{deal.title}</small></td><td>{deal.manager}</td><td>{deal.currentStage}</td><td>{deal.quality}</td>{showIcp ? <td><span className={`marketing-icp-tag ${deal.icp.toLowerCase()}`}>{deal.icp === "UNSET" ? "Belgilanmagan" : deal.icp === "OTHER" ? "Other" : deal.icp}</span></td> : null}<td>{deal.crmSource}</td><td>{deal.marketingSource}</td><td>{deal.platform}</td><td>{deal.campaign}</td><td>{deal.adSet}</td><td>{deal.ad}</td><td>{fmtDate(deal.createdAt)}</td><td>{fmtDate(deal.saleAt)}</td><td>{formatMarketingMoney(deal.revenue, deal.currency)}</td>
        </tr>)}</tbody>
      </table>{response.truncated ? <p className="marketing-contract-note">Natija server limitida qisqartirilgan.</p> : null}</div> : null}
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
      <div className="marketing-icp-total"><div><span>ICP fit</span><strong>{formatMarketingRate(breakdown.icpFitRate)}</strong></div><p><b>{breakdown.icpFitCount} / {breakdown.icpEvaluatedCount}</b> belgilangan · <b>{breakdown.icpUnsetCount} ta</b> belgilanmagan</p></div>
      <p className="marketing-contract-note">P1/P2/P3 = Mos · Other = Mos emas · Belgilanmagan fit foizi maxrajiga kirmaydi.</p>
      <div className="marketing-icp-list">{breakdown.rows.map((row) => <button key={row.segment} onClick={() => onSelect(row)}>
        <span className={`marketing-icp-tag ${row.segment.toLowerCase()}`}>{row.label}</span>
        <span><strong>{row.count} ta</strong><small>{row.meaning}</small></span>
        <ExternalLink size={14} />
      </button>)}</div>
    </div>
  </Drawer>;
}
