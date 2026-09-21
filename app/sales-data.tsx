"use client";

import { useEffect, useState } from "react";

import { SessionLostError, authFetch } from "@/lib/auth-fetch";
import { FORBIDDEN_MESSAGE } from "@/lib/auth-adapter";
import type { FilterOptions } from "@/lib/sales-sections";

/**
 * Browser side of the Sales sections: one fetch per open section, through the
 * shared authenticated path, with the section's own status.
 */

export type SectionCommon = { options: FilterOptions; coverageStart: string | null; dataAsOf: string | null };
export type SectionState<T> = { data: T | null; loading: boolean; notReady: boolean; error: string | null; forbidden: boolean; code: string | null };

type Stored<T> = { key: string; data: T | null; notReady: boolean; error: string | null; forbidden: boolean; code?: string | null };

/**
 * Fetches `url` while it is non-null. The last good data stays on screen while
 * a new filter combination loads, so a filter click does not blank the view.
 * 401 is handled centrally by `authFetch` (the shell signs out); 403 becomes a
 * forbidden state; anything else is an error — never a sign-out.
 */
export function useSectionFetch<T>(url: string | null, reloadToken = 0): SectionState<T> {
  const [stored, setStored] = useState<Stored<T> | null>(null);
  const key = url ? `${url}#${reloadToken}` : "";
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const run = async () => {
      try {
        const response = await authFetch(url, { cache: "no-store" });
        const payload = await response.json().catch(() => null) as (T & { ready?: boolean; error?: string; code?: string }) | null;
        if (cancelled) return;
        if (response.status === 403) { setStored({ key, data: null, notReady: false, error: FORBIDDEN_MESSAGE, forbidden: true, code: payload?.code ?? null }); return; }
        if (!response.ok) { setStored({ key, data: null, notReady: false, error: payload?.error ?? "Ma’lumot yuklanmadi", forbidden: false }); return; }
        if (payload && payload.ready === false) { setStored({ key, data: null, notReady: true, error: null, forbidden: false }); return; }
        setStored({ key, data: payload as T, notReady: false, error: null, forbidden: false });
      } catch (error) {
        if (cancelled || error instanceof SessionLostError) return;
        setStored({ key, data: null, notReady: false, error: "Serverga ulanmadi. Qayta urinib ko‘ring.", forbidden: false });
      }
    };
    // A short delay coalesces rapid filter changes into one request.
    const timer = window.setTimeout(() => { void run(); }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [url, key]);
  if (!url) return { data: null, loading: false, notReady: false, error: null, forbidden: false, code: null };
  const current = stored?.key === key ? stored : null;
  const data = current ? current.data : stored?.key.startsWith(url.split("?")[0]) ? stored.data : null;
  return { data, loading: !current, notReady: current?.notReady ?? false, error: current?.error ?? null, forbidden: current?.forbidden ?? false, code: current?.code ?? null };
}

export function useSalesSection<T>(section: string | null, query: string, reloadToken: number) {
  return useSectionFetch<T>(section ? `/api/sales/${section}?${query}` : null, reloadToken);
}

/** Loading, not-ready, forbidden and error states for a section. */
export function SectionStatus({ state }: { state: SectionState<unknown> }) {
  if (state.notReady) return <div className="notice warning page-notice"><span>Sales ma’lumotlari hali tayyor emas. Administrator Sync’ni ishga tushirishi kerak.</span></div>;
  if (state.error) return <div className={`notice ${state.forbidden ? "warning" : "error"} page-notice`} role="alert"><span>{state.error}</span></div>;
  if (state.loading && !state.data) return <div className="section-loading" aria-busy="true"><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
  return null;
}
