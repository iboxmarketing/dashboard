import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

/**
 * What the live Stage Control answer says about itself. Read only from the
 * explicit API fields: a response without `liveStatus` is not treated as
 * live, degraded or anything else — it is a protocol error.
 */
export type StageLiveMeta = {
  liveStatus: "LIVE" | "DEGRADED" | "UNAVAILABLE";
  dataSource: "BITRIX_LIVE" | "LAST_SUCCESSFUL_LIVE" | null;
  fetchedAt: string | null;
  lastSuccessfulAt: string | null;
  staleAgeSeconds: number | null;
  liveErrorCode: string | null;
  retryable: boolean;
};

const STATUSES = new Set(["LIVE", "DEGRADED", "UNAVAILABLE"]);
const SOURCES = new Set(["BITRIX_LIVE", "LAST_SUCCESSFUL_LIVE", null]);
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export function parseStageLiveMeta(payload: unknown): StageLiveMeta | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  if (!STATUSES.has(String(raw.liveStatus)) || !SOURCES.has((raw.dataSource ?? null) as string | null)) return null;
  const meta: StageLiveMeta = {
    liveStatus: raw.liveStatus as StageLiveMeta["liveStatus"],
    dataSource: (raw.dataSource ?? null) as StageLiveMeta["dataSource"],
    fetchedAt: text(raw.fetchedAt), lastSuccessfulAt: text(raw.lastSuccessfulAt),
    staleAgeSeconds: typeof raw.staleAgeSeconds === "number" && Number.isFinite(raw.staleAgeSeconds) ? raw.staleAgeSeconds : null,
    liveErrorCode: text(raw.liveErrorCode), retryable: raw.retryable === true,
  };
  // The three states are only meaningful with their own source.
  if (meta.liveStatus === "LIVE" && meta.dataSource !== "BITRIX_LIVE") return null;
  if (meta.liveStatus === "DEGRADED" && (meta.dataSource !== "LAST_SUCCESSFUL_LIVE" || !meta.lastSuccessfulAt)) return null;
  if (meta.liveStatus === "UNAVAILABLE" && meta.dataSource !== null) return null;
  return meta;
}

/** A failure the page itself saw (network, an unreadable answer): no rows, retryable. */
export function clientUnavailable(code: string): StageLiveMeta {
  return { liveStatus: "UNAVAILABLE", dataSource: null, fetchedAt: null, lastSuccessfulAt: null, staleAgeSeconds: null, liveErrorCode: code, retryable: true };
}

export function fmtStageTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function staleAgeLabel(seconds: number | null) {
  if (seconds === null) return null;
  if (seconds < 60) return "1 daqiqadan kam";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} daqiqa oldin`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} soat oldin`;
  return `${Math.floor(hours / 24)} kun oldin`;
}

/**
 * The one line that says where the Stage Control figures come from. Retry is
 * a button, never a loop: it runs once per click and is disabled while a
 * request is in flight.
 */
export function StageLiveStatus({ meta, loading, error, onRetry }: { meta: StageLiveMeta | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const retry = <button type="button" className="notice-action" onClick={onRetry} disabled={loading}>{loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Qayta urinish</button>;
  if (!meta) {
    return loading ? <div className="notice page-notice" role="status"><Loader2 size={17} className="spin" />Bitrix’dagi joriy stage’lar olinmoqda…</div> : null;
  }
  if (meta.liveStatus === "LIVE") return <p className="scope-flag live">Live Bitrix · {fmtStageTime(meta.fetchedAt)}</p>;
  if (meta.liveStatus === "DEGRADED") {
    const age = staleAgeLabel(meta.staleAgeSeconds);
    return <div className="notice warning page-notice stage-live-status" role="status"><AlertTriangle size={17} />
      <span><strong>Live ma’lumot olinmadi — oxirgi muvaffaqiyatli ma’lumot ko‘rsatilmoqda</strong>
        <small>Oxirgi muvaffaqiyatli yangilanish: {fmtStageTime(meta.lastSuccessfulAt)}{age ? ` · ${age}` : ""}</small></span>
      {retry}</div>;
  }
  return <div className="notice warning page-notice stage-live-status" role="alert"><AlertTriangle size={17} />
    <span><strong>Live ma’lumot olinmadi</strong>
      <small>{error ? `${error}. ` : ""}Saqlangan oxirgi muvaffaqiyatli ma’lumot hali yo‘q, shuning uchun raqamlar ko‘rsatilmaydi.</small></span>
    {retry}</div>;
}
