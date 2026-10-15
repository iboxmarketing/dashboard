"use client";

import { ArrowLeft, CalendarDays, CircleSlash2, LayoutDashboard, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KpiDeal, KpiDetailMetric, KpiDetailResponse } from "@/lib/kpi-detail-contract";
import { applyDealFilterSearch, dashboardHref, updateKpiDetailSearch } from "@/lib/kpi-detail-routes";
import { hasPermission } from "@/lib/auth/permissions";
import { SALES_PROJECTS, type ProjectKey } from "@/lib/sales-projects";
import { AuthGate, type AuthSession } from "@/app/auth/auth-shell";
import { ProfileMenu } from "@/app/auth/profile-menu";
import { ProjectSwitcher } from "@/app/project-context";
import { HttpKpiDetailAdapter, loadKpiDetailResource, type KpiDetailAdapter, type KpiDetailResourceState } from "./kpi-detail-adapter";
import {
  FunnelQualityDetailTemplate,
  KpiDealDrawer,
  PopulationDetailTemplate,
  SalesDetailTemplate,
  TimeDetailTemplate,
  type KpiTemplateProps,
} from "./kpi-detail-templates";

const httpKpiDetailAdapter = new HttpKpiDetailAdapter();

function assertAdapterAllowed(adapter: KpiDetailAdapter) {
  if (adapter.source === "fixtures" && process.env.NODE_ENV === "production") {
    throw new Error("KPI detail fixtures are not usable in a production build.");
  }
}

function DetailHeader({ data, project, backHref }: { data: KpiDetailResponse; project: ProjectKey; backHref: string }) {
  return <>
    <nav className="kpi-breadcrumb" aria-label="Breadcrumb"><a href={backHref}>Dashboard</a><span>/</span><strong>{data.title}</strong></nav>
    <div className="page-title kpi-detail-title"><div>
      <p className="eyebrow">KPI DETAIL · {SALES_PROJECTS[project].name.toUpperCase()}</p>
      <h1>{data.title}</h1>
      {data.subtitle ? <p>{data.subtitle}</p> : null}
      {data.definition ? <p className="kpi-definition">{data.definition}</p> : null}
    </div>
      <a className="button secondary kpi-back-link" href={backHref}><ArrowLeft size={15} />Dashboardga qaytish</a>
    </div>
    {(data.period || data.appliedFilters?.length) ? <div className="kpi-context-bar">
      {data.period ? <span className="kpi-period-chip"><CalendarDays size={14} />{data.period.label}</span> : null}
      {data.appliedFilters?.map((filter) => <span className="kpi-filter-chip" key={filter.id}><small>{filter.label}</small>{filter.value}</span>)}
    </div> : null}
  </>;
}

export function KpiDetailState({ state, message, onRetry }: { state: "loading" | "error" | "empty" | "not_applicable"; message?: string; onRetry?: () => void }) {
  if (state === "loading") return <div className="kpi-detail-state loading" role="status"><Loader2 className="spin" size={23} /><strong>KPI tafsilotlari yuklanmoqda…</strong><span className="kpi-state-skeleton" /><span className="kpi-state-skeleton short" /></div>;
  if (state === "empty") return <div className="kpi-detail-state empty"><LayoutDashboard size={23} /><strong>Bu filtrlar bo‘yicha Deal topilmadi</strong><p>Filtrlarni o‘zgartiring yoki Dashboardga qayting.</p></div>;
  if (state === "not_applicable") return <div className="kpi-detail-state not-applicable"><CircleSlash2 size={23} /><strong>Bu workspace uchun ICP qo‘llanilmaydi</strong><p>{message || "Bu kutilgan capability holati; nol qiymat emas."}</p></div>;
  return <div className="kpi-detail-state error" role="alert"><TriangleAlert size={23} /><strong>Ma’lumotni yuklab bo‘lmadi</strong><p>{message || "API xatosi KPI qiymati sifatida 0 ko‘rsatilmaydi."}</p>{onRetry ? <button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} />Qayta urinish</button> : null}</div>;
}

const TEMPLATES: Record<KpiDetailResponse["template"], (props: KpiTemplateProps) => React.ReactNode> = {
  population: PopulationDetailTemplate,
  sales: SalesDetailTemplate,
  time: TimeDetailTemplate,
  funnel: FunnelQualityDetailTemplate,
};

function KpiDetailWorkspace({ session, project, metric, adapter }: {
  session: AuthSession;
  project: ProjectKey;
  metric: KpiDetailMetric;
  adapter: KpiDetailAdapter;
}) {
  const [search, setSearch] = useState(() => typeof window === "undefined" ? "" : window.location.search.slice(1));
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<{ key: string; state: KpiDetailResourceState }>({ key: "", state: { status: "loading" } });
  const [selectedDeal, setSelectedDeal] = useState<KpiDeal | null>(null);
  const requestKey = `${project}:${metric}:${search}:${attempt}`;

  useEffect(() => {
    const onPopState = () => setSearch(window.location.search.slice(1));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void loadKpiDetailResource(() => adapter.getDetail({ project, metric, search }, controller.signal)).then((state) => {
      if (active && !controller.signal.aborted) setResource({ key: requestKey, state });
    });
    return () => { active = false; controller.abort(); };
  }, [adapter, metric, project, requestKey, search]);

  const state: KpiDetailResourceState = resource.key === requestKey ? resource.state : { status: "loading" };
  const backHref = dashboardHref(project, search);
  const activeFilter = useMemo(() => {
    const params = new URLSearchParams(search);
    const key = params.get("breakdown");
    const value = params.get("breakdownValue");
    return key && value ? { key, value } : null;
  }, [search]);
  const dealSearch = useMemo(() => new URLSearchParams(search).get("q") ?? "", [search]);
  const dealSort = useMemo(() => new URLSearchParams(search).get("sort") ?? "", [search]);

  const navigate = useCallback((next: string) => {
    window.history.pushState(null, "", `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`);
    setSearch(next);
  }, []);
  const patch = useCallback((next: Record<string, string | number | null | undefined>) => navigate(updateKpiDetailSearch(search, next)), [navigate, search]);

  const templateProps = state.status === "ready" ? {
    data: state.data,
    activeFilter,
    search: dealSearch,
    sort: dealSort,
    onFilter: (filter) => navigate(applyDealFilterSearch(search, filter)),
    onDeal: setSelectedDeal,
    onPage: (page) => patch({ page }),
    onPageSize: (pageSize) => patch({ pageSize, page: 1 }),
    onSearch: (value) => patch({ q: value, page: 1 }),
    onSegment: (segment) => patch({ segment, breakdown: null, breakdownValue: null, page: 1 }),
    onSort: (sort) => patch({ sort, page: 1 }),
  } satisfies KpiTemplateProps : null;

  const responseData = state.status === "ready" || state.status === "empty" || state.status === "not_applicable" ? state.data : undefined;
  const Template = responseData ? TEMPLATES[responseData.template] : null;

  return <div className="kpi-detail-shell">
    <header className="kpi-detail-topbar">
      <a className="kpi-detail-brand" href={backHref}><span>IB</span><strong>Bitrix24 Dashboard</strong></a>
      <div><ProjectSwitcher project={project} /><ProfileMenu user={session.user} onChangePassword={session.changePassword} onLogout={session.logout} /></div>
    </header>
    <main className="kpi-detail-main">
      {responseData ? <DetailHeader data={responseData} project={project} backHref={backHref} /> : <nav className="kpi-breadcrumb" aria-label="Breadcrumb"><a href={backHref}>Dashboard</a><span>/</span><strong>KPI</strong></nav>}
      {state.status === "loading" ? <KpiDetailState state="loading" /> : null}
      {state.status === "error" ? <KpiDetailState state="error" message={state.message} onRetry={() => setAttempt((value) => value + 1)} /> : null}
      {state.status === "empty" ? <KpiDetailState state="empty" /> : null}
      {state.status === "not_applicable" ? <KpiDetailState state="not_applicable" message={state.message} /> : null}
      {state.status === "ready" && Template && templateProps ? <Template {...templateProps} /> : null}
      <KpiDealDrawer deal={selectedDeal} onClose={() => setSelectedDeal(null)} />
    </main>
  </div>;
}

export function KpiDetailClient({ project, metric, adapter = httpKpiDetailAdapter }: {
  project: ProjectKey;
  metric: KpiDetailMetric;
  adapter?: KpiDetailAdapter;
}) {
  assertAdapterAllowed(adapter);
  return <AuthGate>{(session) => hasPermission(session.user.role, session.user.permissions, "dashboard")
    ? <KpiDetailWorkspace session={session} project={project} metric={metric} adapter={adapter} />
    : <div className="kpi-detail-forbidden"><TriangleAlert size={24} /><strong>Dashboard ruxsati kerak</strong><p>Bu KPI tafsilotlarini ko‘rish uchun Dashboard bo‘limiga ruxsat so‘rang.</p></div>}</AuthGate>;
}
