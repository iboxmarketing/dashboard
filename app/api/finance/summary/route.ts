import { financeApiError } from "@/lib/finance/api";
import {
  listFinanceAccounts, listFinanceCategories, listFinanceProjects,
  listFinanceSubscriptions, listFinanceTransactions,
} from "@/lib/finance/storage";
import { buildFinanceSummary } from "@/lib/finance/summary";
import { normalizeFinanceDate, validateFinanceRange } from "@/lib/finance/validation";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
});

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const range = validateFinanceRange(params.get("from"), params.get("to"));
    if (!range.ok) return Response.json({ error: range.error }, { status: 400 });
    const asOf = params.get("asOf") ? normalizeFinanceDate(params.get("asOf")) : dayFormatter.format(new Date());
    if (!asOf) return Response.json({ error: "asOf date is invalid" }, { status: 400 });
    const rawProject = params.get("projectId");
    const projectId = rawProject === "none" ? null : rawProject ?? undefined;
    const [accounts, transactions, categories, projects, subscriptions] = await Promise.all([
      listFinanceAccounts(true), listFinanceTransactions(), listFinanceCategories(true),
      listFinanceProjects(true), listFinanceSubscriptions(true),
    ]);
    if (typeof projectId === "string" && !projects.some((project) => project.id === projectId)) {
      return Response.json({ error: "Finance project was not found" }, { status: 404 });
    }
    return Response.json({ summary: buildFinanceSummary({
      accounts, transactions, categories, projects, subscriptions,
      range: range.value, asOf, projectId,
    }) });
  } catch (error) { return financeApiError(error); }
}
