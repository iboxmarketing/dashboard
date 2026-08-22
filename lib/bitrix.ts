import { env } from "cloudflare:workers";

type BitrixResponse<T> = {
  result?: T;
  next?: number;
  total?: number;
  error?: string;
  error_description?: string;
};

export class SafeBitrixError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function getWebhookUrl() {
  const value = (env as unknown as Record<string, string | undefined>).BITRIX24_WEBHOOK_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value.endsWith("/") ? value : `${value}/`);
    if (url.protocol !== "https:" || !url.pathname.includes("/rest/")) return null;
    return url;
  } catch {
    return null;
  }
}

export function getBitrixDomain() {
  return getWebhookUrl()?.hostname ?? null;
}

export async function bitrixCall<T>(method: string, params: Record<string, unknown> = {}) {
  const webhook = getWebhookUrl();
  if (!webhook) throw new SafeBitrixError("NOT_CONFIGURED", "Bitrix24 webhook ulanmagan");
  const endpoint = new URL(method, webhook);
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "IBOX-Deal-Processing-Dashboard/1.0",
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } catch {
    throw new SafeBitrixError("NETWORK_ERROR", controller.signal.aborted ? "Bitrix24 so‘rovi 25 soniyada javob bermadi" : "Bitrix24 bilan aloqa o‘rnatilmadi");
  } finally {
    clearTimeout(timeout);
  }

  let payload: BitrixResponse<T>;
  try {
    payload = (await response.json()) as BitrixResponse<T>;
  } catch {
    throw new SafeBitrixError("INVALID_RESPONSE", "Bitrix24 noto‘g‘ri javob qaytardi");
  }

  if (!response.ok || payload.error) {
    const safeCode = payload.error ?? `HTTP_${response.status}`;
    const raw = payload.error_description ?? "Bitrix24 API so‘rovi bajarilmadi";
    const safeMessage = raw.replace(/https?:\/\/\S+/gi, "[yashirilgan]").slice(0, 240);
    throw new SafeBitrixError(safeCode, safeMessage);
  }
  return payload;
}

export async function bitrixPage<T>(
  method: string,
  params: Record<string, unknown>,
  start = 0,
  startKey = "start",
) {
  const response = await bitrixCall<unknown>(method, { ...params, [startKey]: start });
  return {
    items: unwrapList<T>(response.result),
    next: response.next === undefined || response.next === null ? null : Number(response.next),
    total: response.total === undefined || response.total === null ? null : Number(response.total),
  };
}

function unwrapList<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object") {
    const object = result as Record<string, unknown>;
    if (Array.isArray(object.items)) return object.items as T[];
  }
  return [];
}

export async function bitrixList<T>(
  method: string,
  params: Record<string, unknown>,
  // `onTruncated` fires only when the page budget ran out while Bitrix still had
  // more rows, so callers can report a partial list instead of silently
  // presenting it as complete. Pagination behaviour itself is unchanged.
  options: { maxPages?: number; startKey?: string; onTruncated?: (info: { method: string; maxPages: number; loaded: number }) => void } = {},
) {
  const rows: T[] = [];
  let start = 0;
  const maxPages = options.maxPages ?? 200;
  const startKey = options.startKey ?? "start";
  for (let page = 0; page < maxPages; page += 1) {
    const response = await bitrixCall<unknown>(method, { ...params, [startKey]: start });
    const items = unwrapList<T>(response.result);
    rows.push(...items);
    if (response.next === undefined || response.next === null || items.length === 0) return rows;
    start = Number(response.next);
  }
  options.onTruncated?.({ method, maxPages, loaded: rows.length });
  return rows;
}

export function safeBitrixMessage(error: unknown) {
  if (error instanceof SafeBitrixError) return error.message;
  return "Kutilmagan xavfsiz server xatosi";
}
