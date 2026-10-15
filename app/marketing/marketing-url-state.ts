"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketingEntityLevel, MarketingFilters } from "./marketing-types";
import { isMarketingWorkspaceKey, type MarketingWorkspaceKey } from "./marketing-workspaces";

export type MarketingUrlState = {
  workspace: MarketingWorkspaceKey;
  filters: MarketingFilters;
  level: MarketingEntityLevel;
};

const LEVELS = new Set<MarketingEntityLevel>(["campaign", "adset", "ad", "creative", "placement", "landing"]);
const MARKETING_QUERY_KEYS = [
  "workspace", "startDate", "endDate", "source", "platform", "campaignId", "adsetId", "adId", "placement", "landing", "level",
] as const;

function tashkentDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function shiftedDate(now: Date, days: number) {
  return tashkentDate(new Date(now.getTime() + days * 86_400_000));
}

export function marketingRange(range: MarketingFilters["range"], now = new Date()) {
  const today = tashkentDate(now);
  if (range === "7") return { startDate: shiftedDate(now, -6), endDate: today };
  if (range === "30") return { startDate: shiftedDate(now, -29), endDate: today };
  if (range === "month") return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
  if (range === "lastMonth") {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const start = new Date(Date.UTC(year, month - 2, 1, 7));
    const end = new Date(Date.UTC(year, month - 1, 0, 7));
    return { startDate: tashkentDate(start), endDate: tashkentDate(end) };
  }
  return { startDate: "", endDate: "" };
}

export function defaultMarketingFilters(now = new Date()): MarketingFilters {
  return {
    range: "30",
    ...marketingRange("30", now),
    source: "",
    platform: "",
    campaignId: "",
    adsetId: "",
    adId: "",
    placement: "",
    landing: "",
  };
}

/** Backward-compatible test/import name; use defaultMarketingFilters for fresh dates. */
export const EMPTY_MARKETING_FILTERS = defaultMarketingFilters(new Date("2026-10-15T00:00:00Z"));

function detectedRange(startDate: string, endDate: string, now: Date): MarketingFilters["range"] {
  for (const range of ["7", "30", "month", "lastMonth"] as const) {
    const bounds = marketingRange(range, now);
    if (bounds.startDate === startDate && bounds.endDate === endDate) return range;
  }
  return "custom";
}

export function parseMarketingUrlState(search: string | URLSearchParams, fallbackWorkspace: MarketingWorkspaceKey, now = new Date()): MarketingUrlState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const defaults = defaultMarketingFilters(now);
  const rawWorkspace = params.get("workspace");
  const workspace = isMarketingWorkspaceKey(rawWorkspace) ? rawWorkspace : fallbackWorkspace;
  const startDate = params.get("startDate") || defaults.startDate;
  const endDate = params.get("endDate") || defaults.endDate;
  const rawLevel = params.get("level");
  const level = rawLevel && LEVELS.has(rawLevel as MarketingEntityLevel) ? rawLevel as MarketingEntityLevel : "campaign";
  return {
    workspace,
    level,
    filters: {
      range: detectedRange(startDate, endDate, now),
      startDate,
      endDate,
      source: params.get("source") ?? "",
      platform: params.get("platform") ?? "",
      campaignId: params.get("campaignId") ?? "",
      adsetId: params.get("adsetId") ?? "",
      adId: params.get("adId") ?? "",
      placement: params.get("placement") ?? "",
      landing: params.get("landing") ?? "",
    },
  };
}

export function serializeMarketingUrlState(state: MarketingUrlState, baseSearch: string | URLSearchParams = "") {
  const params = typeof baseSearch === "string" ? new URLSearchParams(baseSearch) : new URLSearchParams(baseSearch);
  for (const key of MARKETING_QUERY_KEYS) params.delete(key);
  params.set("view", "marketing");
  params.set("workspace", state.workspace);
  const { filters } = state;
  params.set("startDate", filters.startDate);
  params.set("endDate", filters.endDate);
  if (filters.source) params.set("source", filters.source);
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (filters.adsetId) params.set("adsetId", filters.adsetId);
  if (filters.adId) params.set("adId", filters.adId);
  if (filters.placement) params.set("placement", filters.placement);
  if (filters.landing) params.set("landing", filters.landing);
  if (state.level !== "campaign") params.set("level", state.level);
  return params.toString();
}

export function withMarketingRange(filters: MarketingFilters, range: MarketingFilters["range"], now = new Date()): MarketingFilters {
  if (range === "custom") return { ...filters, range };
  return { ...filters, range, ...marketingRange(range, now) };
}

export function marketingViewRequested(search: string | URLSearchParams) {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get("view") === "marketing";
}

export function searchForDashboardView(search: string, marketing: boolean) {
  const params = new URLSearchParams(search);
  if (marketing) params.set("view", "marketing"); else params.delete("view");
  return params.toString();
}

/** URL is the authority for Marketing filters and drill level. */
export function useMarketingUrlState(lockedWorkspace: MarketingWorkspaceKey) {
  const [state, setState] = useState<MarketingUrlState>(() => ({ workspace: lockedWorkspace, filters: defaultMarketingFilters(), level: "campaign" }));

  useEffect(() => {
    const read = () => {
      const parsed = parseMarketingUrlState(window.location.search, lockedWorkspace);
      return { ...parsed, workspace: lockedWorkspace };
    };
    const current = read();
    const query = serializeMarketingUrlState(current, window.location.search);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}${window.location.hash}`);
    let active = true;
    queueMicrotask(() => { if (active) setState(current); });
    const onPopState = () => setState(read());
    window.addEventListener("popstate", onPopState);
    return () => { active = false; window.removeEventListener("popstate", onPopState); };
  }, [lockedWorkspace]);

  const update = useCallback((next: MarketingUrlState | ((current: MarketingUrlState) => MarketingUrlState), replace = false) => {
    setState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      const locked = { ...resolved, workspace: lockedWorkspace };
      const query = serializeMarketingUrlState(locked, window.location.search);
      window.history[replace ? "replaceState" : "pushState"](null, "", `${window.location.pathname}?${query}${window.location.hash}`);
      return locked;
    });
  }, [lockedWorkspace]);

  return { state, update };
}
