"use client";

import { CircleSlash2, Database, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { MarketingAdapterError } from "./marketing-adapter";

export type MarketingResourceState<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: T }
  | { status: "empty"; data: T }
  | { status: "not_applicable"; message: string }
  | { status: "error"; message: string };

function resourceError(error: unknown): MarketingResourceState<never> {
  if (error instanceof MarketingAdapterError) {
    if (["WORKSPACE_NOT_ACTIVATED", "ICP_NOT_APPLICABLE", "NOT_APPLICABLE"].includes(error.code)) {
      return { status: "not_applicable", message: error.message };
    }
    return { status: "error", message: error.message };
  }
  return { status: "error", message: error instanceof Error ? error.message : "Marketing ma’lumotlari yuklanmadi" };
}

/** Exported for deterministic retry/error tests; the hook uses the same path. */
export async function loadMarketingResource<T>(load: () => Promise<T>, isEmpty: (data: T) => boolean = () => false): Promise<MarketingResourceState<T>> {
  try {
    const data = await load();
    return isEmpty(data) ? { status: "empty", data } : { status: "ready", data };
  } catch (error) {
    return resourceError(error);
  }
}

export function useMarketingResource<T>({ key, enabled = true, load, isEmpty }: {
  key: string;
  enabled?: boolean;
  load: (signal: AbortSignal) => Promise<T>;
  isEmpty?: (data: T) => boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${key}:${attempt}`;
  const [result, setResult] = useState<{ key: string; state: MarketingResourceState<T> }>(() => ({ key: "", state: { status: "idle" } }));
  const runLoad = useEffectEvent((signal: AbortSignal) => load(signal));
  const checkEmpty = useEffectEvent((data: T) => isEmpty?.(data) ?? false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    void loadMarketingResource(() => runLoad(controller.signal), checkEmpty).then((next) => {
      if (active && !controller.signal.aborted) setResult({ key: requestKey, state: next });
    });
    return () => { active = false; controller.abort(); };
  }, [enabled, requestKey]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const state: MarketingResourceState<T> = !enabled
    ? { status: "idle" }
    : result.key === requestKey ? result.state : { status: "loading" };

  return { state, retry };
}

export function MarketingResourceNotice({ state, onRetry, compact = false, empty = "Bu kontekstda ma’lumot yo‘q." }: {
  state: MarketingResourceState<unknown>;
  onRetry?: () => void;
  compact?: boolean;
  empty?: string;
}) {
  if (state.status === "idle" || state.status === "ready") return null;
  const className = `marketing-resource-state ${compact ? "compact" : ""} ${state.status}`;
  if (state.status === "loading") return <div className={className} role="status"><Loader2 size={17} className="spin" /><span>Marketing ma’lumotlari yuklanmoqda…</span></div>;
  if (state.status === "empty") return <div className={className}><Database size={17} /><span>{empty}</span></div>;
  if (state.status === "not_applicable") return <div className={className}><CircleSlash2 size={17} /><span>{state.message}</span></div>;
  if (state.status !== "error") return null;
  return <div className={className} role="alert"><TriangleAlert size={17} /><span>{state.message}</span>{onRetry ? <button type="button" className="button secondary small" onClick={onRetry}><RefreshCw size={14} />Qayta urinish</button> : null}</div>;
}
