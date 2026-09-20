import { FinanceError } from "./storage";

export async function financePayload(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

export function financeId(payload: Record<string, unknown>) {
  return String(payload.id ?? "").trim();
}

export function financeApiError(error: unknown) {
  if (error instanceof FinanceError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return Response.json({ error: "Finance operation failed" }, { status: 500 });
}

export function includeArchived(request: Request) {
  return new URL(request.url).searchParams.get("includeArchived") === "true";
}
