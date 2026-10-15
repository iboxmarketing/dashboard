import { SessionLostError, authFetch } from "@/lib/auth-fetch";
import { isKpiDetailMetric, type KpiDetailRequest, type KpiDetailResponse } from "@/lib/kpi-detail-contract";

/** Single read binding for the parallel server/data implementation. */
export const KPI_DETAIL_ENDPOINT = "/api/sales/kpi-detail";

export interface KpiDetailAdapter {
  readonly source: "http" | "fixtures";
  getDetail(request: KpiDetailRequest, signal?: AbortSignal): Promise<KpiDetailResponse>;
}
export type KpiDetailAdapterErrorCode =
  | "NOT_APPLICABLE"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR";

export class KpiDetailAdapterError extends Error {
  constructor(message: string, readonly code: KpiDetailAdapterErrorCode, readonly status?: number) {
    super(message);
    this.name = "KpiDetailAdapterError";
  }
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown; code?: unknown } | null;
  const message = typeof payload?.message === "string" && payload.message
    ? payload.message
    : typeof payload?.error === "string" && payload.error
      ? payload.error
      : `KPI detail API xatosi (${response.status})`;
  const notApplicable = payload?.code === "NOT_APPLICABLE" || payload?.code === "KPI_NOT_APPLICABLE" || payload?.code === "ICP_NOT_APPLICABLE";
  return new KpiDetailAdapterError(message, notApplicable ? "NOT_APPLICABLE" : "HTTP_ERROR", response.status);
}

function validateEnvelope(payload: unknown, request: KpiDetailRequest): KpiDetailResponse {
  if (!payload || typeof payload !== "object") throw new KpiDetailAdapterError("KPI detail API JSON qaytarmadi", "INVALID_RESPONSE");
  const candidate = payload as Partial<KpiDetailResponse>;
  if (candidate.project !== request.project || candidate.metric !== request.metric || !isKpiDetailMetric(candidate.metric ?? "")) {
    throw new KpiDetailAdapterError("KPI detail API boshqa loyiha yoki metrikaning javobini qaytardi", "INVALID_RESPONSE");
  }
  if (!["population", "sales", "time", "funnel"].includes(candidate.template ?? "")
    || !["READY", "EMPTY", "NOT_APPLICABLE"].includes(candidate.status ?? "")
    || typeof candidate.title !== "string") {
    throw new KpiDetailAdapterError("KPI detail API shartnomasi noto‘g‘ri", "INVALID_RESPONSE");
  }
  return candidate as KpiDetailResponse;
}

/** HTTP-first production adapter. It forwards inherited query state unchanged. */
export class HttpKpiDetailAdapter implements KpiDetailAdapter {
  readonly source = "http" as const;

  constructor(private readonly fetchImpl: typeof fetch = authFetch, private readonly timeoutMs = 15_000) {}

  async getDetail(request: KpiDetailRequest, signal?: AbortSignal): Promise<KpiDetailResponse> {
    const params = new URLSearchParams(request.search);
    // Route identity is authoritative and cannot be overridden by the query.
    params.set("project", request.project);
    params.set("metric", request.metric);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${KPI_DETAIL_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response);
      return validateEnvelope(await response.json().catch(() => null), request);
    } catch (error) {
      if (error instanceof KpiDetailAdapterError || error instanceof SessionLostError) throw error;
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new KpiDetailAdapterError("KPI detail so‘rovi bekor qilindi", "ABORTED");
        throw new KpiDetailAdapterError("KPI detail API javob berish vaqti tugadi", "TIMEOUT");
      }
      throw new KpiDetailAdapterError("KPI detail API bilan aloqa yo‘q", "NETWORK");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export type KpiDetailResourceState =
  | { status: "loading" }
  | { status: "ready"; data: KpiDetailResponse }
  | { status: "empty"; data: KpiDetailResponse }
  | { status: "not_applicable"; data?: KpiDetailResponse; message: string }
  | { status: "error"; message: string };

/** Pure resource loader used by the UI and deterministic error-state tests. */
export async function loadKpiDetailResource(load: () => Promise<KpiDetailResponse>): Promise<KpiDetailResourceState> {
  try {
    const data = await load();
    if (data.status === "NOT_APPLICABLE") {
      return { status: "not_applicable", data, message: data.message || "Bu workspace uchun ushbu KPI qo‘llanilmaydi" };
    }
    if (data.status === "EMPTY") return { status: "empty", data };
    return { status: "ready", data };
  } catch (error) {
    if (error instanceof KpiDetailAdapterError && error.code === "NOT_APPLICABLE") {
      return { status: "not_applicable", message: error.message };
    }
    if (error instanceof KpiDetailAdapterError && error.code === "ABORTED") {
      return { status: "error", message: "So‘rov bekor qilindi" };
    }
    return { status: "error", message: error instanceof Error ? error.message : "KPI detail ma’lumotlari yuklanmadi" };
  }
}
