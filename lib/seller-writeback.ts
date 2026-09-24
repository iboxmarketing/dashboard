import { canonicalDealFieldKey } from "./crm-fields";
import { normalizeSalesOwnerAtWonField } from "./stable-seller-field";

/**
 * Writing the canonical seller back into Bitrix.
 *
 * The dashboard is a reader of the CRM, so this module is the one place allowed
 * to write to it, and it may write exactly one field: the configured Sales Owner
 * at Won field (`lib/stable-seller-field.ts`). Stage, category, Responsible
 * person, Opportunity, Source and every other field are never included in the
 * update payload.
 *
 * Three rules make a write safe to retry:
 *
 *  - READ FIRST. The current value is fetched and a non-empty field is never
 *    overwritten automatically — the robot's capture at sale time outranks
 *    anything we could compute later. A field that already holds the intended
 *    seller reports ALREADY_SET, so re-running a backfill is free.
 *  - ONE RETRY CLASS. Only Bitrix's rate limit and transport failures are
 *    retried, with backoff; a validation error is returned as FAILED so a bad
 *    seller id can never be retried into success.
 *  - NO SILENT CERTIFICATION. A failed write returns FAILED and the caller must
 *    not record a confirmed seller, otherwise the dashboard would certify an
 *    attribution the CRM does not carry.
 *
 * The Bitrix client is injected rather than imported, so this module stays free
 * of `cloudflare:workers` and the write rules can be exercised directly by the
 * node test runner (same pattern as lib/share-store.ts).
 */

/** The slice of `lib/bitrix.ts` this module uses. */
export type BitrixCall = <T>(method: string, params?: Record<string, unknown>) => Promise<{ result?: T }>;

export type SellerWriteStatus = "WRITTEN" | "ALREADY_SET" | "SKIPPED_NOT_EMPTY" | "SKIPPED_NO_FIELD" | "FAILED";

export type SellerWriteResult = {
  dealId: string;
  status: SellerWriteStatus;
  /** What the field held before this call, when it could be read. */
  currentValue: string | null;
  sellerId: string;
  attempts: number;
  errorCode?: string;
};

const RETRYABLE = /QUERY_LIMIT_EXCEEDED|OPERATION_TIME_LIMIT|NETWORK_ERROR|INVALID_RESPONSE|HTTP_5\d\d/i;
const EMPLOYEE_ID = /^[1-9]\d*$/;

/** Bitrix employee-field values arrive as a scalar, an array or an object. */
export function employeeFieldValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) return employeeFieldValue(raw[0]);
  if (typeof raw === "object") {
    const candidate = (raw as Record<string, unknown>).ID ?? (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).VALUE;
    return employeeFieldValue(candidate);
  }
  const text = String(raw).trim();
  return EMPLOYEE_ID.test(text) ? text : "";
}

export type WriteOptions = {
  /** The Bitrix client — `bitrixCall` in the Worker, a stub in tests. */
  call: BitrixCall;
  /** Sequential pacing between calls, to stay inside Bitrix's rate limit. */
  pauseMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function writeSalesOwnerAtWon(
  input: { dealId: string; sellerId: string; field: string | null | undefined },
  options: WriteOptions,
): Promise<SellerWriteResult> {
  const call = options.call;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const field = normalizeSalesOwnerAtWonField(input.field);
  const base: SellerWriteResult = { dealId: input.dealId, status: "FAILED", currentValue: null, sellerId: input.sellerId, attempts: 0 };
  if (!field) return { ...base, status: "SKIPPED_NO_FIELD", errorCode: "NO_CANONICAL_FIELD" };
  if (!EMPLOYEE_ID.test(input.sellerId)) return { ...base, status: "FAILED", errorCode: "INVALID_SELLER_ID" };
  const key = canonicalDealFieldKey(field);

  let attempts = 0;
  let lastError = "UNKNOWN";
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const existing = await call<Record<string, unknown>>("crm.deal.get", { id: input.dealId });
      const deal = (existing.result ?? {}) as Record<string, unknown>;
      const current = employeeFieldValue(deal[key] ?? deal[field]);
      if (current && current === input.sellerId) return { ...base, status: "ALREADY_SET", currentValue: current, attempts };
      if (current) return { ...base, status: "SKIPPED_NOT_EMPTY", currentValue: current, attempts };
      await call("crm.deal.update", { id: input.dealId, fields: { [key]: input.sellerId } });
      if (options.pauseMs) await sleep(options.pauseMs);
      return { ...base, status: "WRITTEN", currentValue: "", attempts };
    } catch (error) {
      const code = errorCode(error);
      lastError = code;
      if (!RETRYABLE.test(code) || attempts >= maxAttempts) return { ...base, status: "FAILED", attempts, errorCode: code };
      await sleep(Math.min(4_000, 500 * 2 ** (attempts - 1)));
    }
  }
  return { ...base, status: "FAILED", attempts, errorCode: lastError };
}

function errorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code) return code;
  return error instanceof Error && error.message ? error.message.slice(0, 60) : "UNKNOWN";
}
