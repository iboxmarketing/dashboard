export const STAGE_HISTORY_METHOD = "crm.stagehistory.list";
export const STAGE_HISTORY_RETRY_DELAYS_MS = [750, 1500, 3000] as const;
export const STAGE_HISTORY_MAX_RETRIES = STAGE_HISTORY_RETRY_DELAYS_MS.length;

export type StageHistoryRetryState = {
  cursor: number;
  retryCount: number;
  nextAttemptAt: string;
  method: typeof STAGE_HISTORY_METHOD;
  code: string;
  statusClass: string | null;
};

export type StageHistoryDiagnostics = {
  method: typeof STAGE_HISTORY_METHOD;
  lastCode: string;
  lastStatusClass: string | null;
  retryCount: number;
  transientFailures: number;
  permissionFailures: number;
  exhausted: boolean;
  cursor: number;
};

type ErrorShape = { code?: unknown; message?: unknown; statusClass?: unknown };

function safeLabel(raw: unknown, fallback: string) {
  const shown = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return (shown.replace(/[^A-Z0-9_.-]/g, "_").slice(0, 64) || fallback);
}

function errorShape(error: unknown): ErrorShape {
  return error && typeof error === "object" ? error as ErrorShape : {};
}

function inferredStatusClass(code: string) {
  const http = /^HTTP_(\d{3})$/.exec(code);
  if (http) return `HTTP_${http[1][0]}XX`;
  if (code === "NETWORK_ERROR") return "NETWORK";
  if (code === "TIMEOUT") return "TIMEOUT";
  if (code === "INVALID_RESPONSE") return "INVALID_RESPONSE";
  return "BITRIX";
}

export function classifyStageHistoryFailure(error: unknown) {
  const shape = errorShape(error);
  const code = safeLabel(shape.code, "UNKNOWN");
  const statusClass = shape.statusClass === null
    ? null
    : safeLabel(shape.statusClass, inferredStatusClass(code));
  const message = typeof shape.message === "string" ? shape.message : "";
  const definitivePermission = code === "ACCESS_DENIED"
    || code === "INSUFFICIENT_PERMISSION"
    || code === "PERMISSION_DENIED"
    || code === "HTTP_403"
    || /(?:access|permission) denied|insufficient permissions?|not enough rights|доступ запрещен|недостаточно прав/i.test(message);
  return {
    kind: definitivePermission ? "DEFINITIVE_PERMISSION_FAILURE" as const : "TRANSIENT" as const,
    method: STAGE_HISTORY_METHOD,
    code,
    statusClass,
  };
}

export type StageHistoryFailureDecision =
  | { action: "RETRY"; retry: StageHistoryRetryState; diagnostics: StageHistoryDiagnostics }
  | { action: "DEGRADE_PERMISSION"; diagnostics: StageHistoryDiagnostics }
  | { action: "FAIL_EXHAUSTED"; safeError: string; diagnostics: StageHistoryDiagnostics };

export function decideStageHistoryFailure(input: {
  error: unknown;
  cursor: number;
  previousRetry?: StageHistoryRetryState | null;
  previousDiagnostics?: StageHistoryDiagnostics | null;
  nowMs?: number;
}): StageHistoryFailureDecision {
  const failure = classifyStageHistoryFailure(input.error);
  const previous = input.previousDiagnostics;
  if (failure.kind === "DEFINITIVE_PERMISSION_FAILURE") {
    return {
      action: "DEGRADE_PERMISSION",
      diagnostics: {
        method: STAGE_HISTORY_METHOD,
        lastCode: failure.code,
        lastStatusClass: failure.statusClass,
        retryCount: previous?.retryCount ?? 0,
        transientFailures: previous?.transientFailures ?? 0,
        permissionFailures: (previous?.permissionFailures ?? 0) + 1,
        exhausted: false,
        cursor: input.cursor,
      },
    };
  }

  const sameBatch = input.previousRetry?.cursor === input.cursor;
  const retryCount = (sameBatch ? input.previousRetry?.retryCount ?? 0 : 0) + 1;
  const diagnostics: StageHistoryDiagnostics = {
    method: STAGE_HISTORY_METHOD,
    lastCode: failure.code,
    lastStatusClass: failure.statusClass,
    retryCount: (previous?.retryCount ?? 0) + (retryCount <= STAGE_HISTORY_MAX_RETRIES ? 1 : 0),
    transientFailures: (previous?.transientFailures ?? 0) + 1,
    permissionFailures: previous?.permissionFailures ?? 0,
    exhausted: retryCount > STAGE_HISTORY_MAX_RETRIES,
    cursor: input.cursor,
  };
  if (retryCount > STAGE_HISTORY_MAX_RETRIES) {
    return {
      action: "FAIL_EXHAUSTED",
      safeError: `Stage history ${STAGE_HISTORY_METHOD} vaqtinchalik xatosi ${STAGE_HISTORY_MAX_RETRIES} retry'dan keyin ham davom etdi (${failure.code}; ${failure.statusClass ?? "UNKNOWN"}).`,
      diagnostics,
    };
  }
  const delay = STAGE_HISTORY_RETRY_DELAYS_MS[retryCount - 1];
  return {
    action: "RETRY",
    retry: {
      cursor: input.cursor,
      retryCount,
      nextAttemptAt: new Date((input.nowMs ?? Date.now()) + delay).toISOString(),
      method: STAGE_HISTORY_METHOD,
      code: failure.code,
      statusClass: failure.statusClass,
    },
    diagnostics,
  };
}

/** Extracts any per-command Batch failure before a cursor can advance. */
export function stageHistoryBatchFailure(response: Record<string, unknown>) {
  const outer = response.result && typeof response.result === "object"
    ? response.result as Record<string, unknown>
    : {};
  const rawErrors = outer.result_error && typeof outer.result_error === "object"
    ? outer.result_error as Record<string, unknown>
    : {};
  for (const raw of Object.values(rawErrors)) {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const code = safeLabel(row.error, "BATCH_COMMAND_ERROR");
    const message = typeof row.error_description === "string"
      ? row.error_description.replace(/https?:\/\/\S+/gi, "[hidden]").slice(0, 240)
      : "Bitrix batch command failed";
    return { code, message, statusClass: "BITRIX" };
  }
  return null;
}
