import { bitrixCall, getBitrixDomain, safeBitrixMessage } from "@/lib/bitrix";
import { buildCurrentStageRecords, reconcileCurrentStages } from "@/lib/current-stages";
import { buildStatusMaps } from "@/lib/analytics-dictionaries";
import { getDictionary, getSettings, listAnalyticsRecords } from "@/lib/storage";
import { requestProject } from "@/lib/sales-http";
import { recordProject } from "@/lib/sales-projects";
import { listPipelineStages } from "@/lib/sync";
import { authorizePermission } from "@/lib/auth/http";
import { fetchOpenDealsKeyset, loadStageControl, STAGE_CONTROL_WORKSPACES } from "@/lib/stage-control-live";
import { readStageControlSnapshot, writeStageControlSnapshot } from "@/lib/stage-control-snapshot";
import type { DashboardSettings } from "@/lib/types";

/**
 * The slice of settings Stage Control renders with: funnel names and stage
 * semantics. A Stages-only member gets this instead of the full CRM settings,
 * which `/api/bootstrap` now releases only to `settings`.
 */
function stageSettings(settings: DashboardSettings) {
  return {
    selectedPipelineIds: settings.selectedPipelineIds, selectedPipelineNames: settings.selectedPipelineNames,
    qualifiedStageIds: settings.qualifiedStageIds, lowQualityStageIds: settings.lowQualityStageIds,
    paymentStageIds: settings.paymentStageIds, closedLostStageIds: settings.closedLostStageIds,
  };
}

function value(row: Record<string, unknown>, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined ? "" : String(raw);
}

/**
 * Live Stage Control. Every answer says what it is: `liveStatus` LIVE
 * (`dataSource` BITRIX_LIVE), DEGRADED (this project's last successful live
 * fetch, LAST_SUCCESSFUL_LIVE, with its age and the live error), or
 * UNAVAILABLE — a retryable 503 with no rows, never an empty list that would
 * read as "no open Deals". A Bitrix timeout is not a 500.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "stages");
  if (denied) return denied;
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  try {
    // LIVE open Deals of THIS project's Sales funnel only — category 5 for Sales
    // Doctor, 3 for IBOX — reconciled against this project's cached records only.
    const settings = await getSettings(scoped.project);
    const categoryIds = [...new Set(settings.selectedPipelineIds.map(String).filter(Boolean))];
    if (!categoryIds.length) {
      return Response.json({
        project: scoped.project, workspace: STAGE_CONTROL_WORKSPACES[scoped.project],
        liveStatus: "UNAVAILABLE", dataSource: null, fetchedAt: null, lastSuccessfulAt: null, staleAgeSeconds: null,
        liveErrorCode: "NO_SALES_FUNNEL", retryable: false, error: "Sales funnel tanlanmagan",
        records: null, rowCount: null, reconciliation: null, stageCatalog: [], truncated: false, stageSettings: stageSettings(settings),
      }, { status: 409 });
    }

    const [load, userRows, statusRows, cachedRecords] = await Promise.all([
      loadStageControl({
        project: scoped.project,
        categoryIds,
        fetchDeals: () => fetchOpenDealsKeyset((method, params, timeoutMs) => bitrixCall(method, params, { timeoutMs }), { categoryIds }),
        fetchStages: () => listPipelineStages(categoryIds),
        readSnapshot: () => readStageControlSnapshot(scoped.project),
        writeSnapshot: writeStageControlSnapshot,
        log: (message) => console.warn(message),
      }),
      getDictionary<Record<string, unknown>[]>("users", []),
      getDictionary<Record<string, unknown>[]>("statuses", []),
      listAnalyticsRecords().then((rows) => rows.filter((row) => recordProject(row) === scoped.project)),
    ]);

    const meta = {
      project: scoped.project, workspace: load.workspace,
      liveStatus: load.liveStatus, dataSource: load.dataSource, fetchedAt: load.fetchedAt, lastSuccessfulAt: load.lastSuccessfulAt,
      staleAgeSeconds: load.staleAgeSeconds, liveErrorCode: load.liveErrorCode, retryable: load.retryable,
    };
    if (load.liveStatus === "UNAVAILABLE") {
      return Response.json({
        ...meta, error: load.liveError,
        records: null, rowCount: null, reconciliation: null, stageCatalog: [], truncated: false, stageSettings: stageSettings(settings),
      }, { status: 503, headers: { "Retry-After": "30" } });
    }
    if (load.truncated) console.warn(`current-stages: ${scoped.project} ${load.deals.length} ta ochiq deal bilan uzildi (sahifa limiti).`);

    const pipelines = new Map(categoryIds.map((id, index) => [id, settings.selectedPipelineNames[index] ?? `Sales funnel #${id}`]));
    const stages = new Map<string, string>();
    for (const stage of load.stageCatalog) {
      stages.set(`${stage.categoryId}:${stage.id}`, stage.name);
      if (!stages.has(stage.id)) stages.set(stage.id, stage.name);
    }
    const users = new Map(userRows.map((row) => [value(row, "ID"), [value(row, "NAME"), value(row, "LAST_NAME")].filter(Boolean).join(" ") || `Menejer #${value(row, "ID")}`]));
    const { sources } = buildStatusMaps(statusRows);
    // Live Bitrix returns every non-closed Deal in the funnel; the canonical
    // workload is narrower (lib/current-stages.ts). Whatever is left out is
    // counted by reason and reported, so the number on screen can be explained.
    // A snapshot goes through the very same builder.
    const excluded: Record<string, string[]> = {};
    const records = buildCurrentStageRecords({
      deals: load.deals, settings, pipelines, stages, users, sources, domain: getBitrixDomain(),
      onExcluded: (reason, dealId) => { (excluded[reason] ??= []).push(dealId); },
    });
    const excludedCounts = Object.fromEntries(Object.entries(excluded).map(([reason, ids]) => [reason, ids.length]));
    // Live against cache only when the rows ARE live: a stale snapshot compared
    // with today's cache would report drift that is only the snapshot's age.
    // The full cache is handed over scoped by funnel only. Sales status must not
    // gate membership, otherwise an open deal that reached payment (cached as
    // WON, still CLOSED=N in Bitrix) is falsely reported as missing.
    const reconciliation = load.liveStatus === "LIVE"
      ? reconcileCurrentStages(records, cachedRecords, load.fetchedAt, { operationalCategoryIds: categoryIds, historyDays: settings.historyDays })
      : null;
    // The stage catalog travels beside the records so the client never has to
    // re-derive Bitrix funnel order: SORT lives here, not in React.
    const stageCatalog = load.stageCatalog.map((stage) => ({
      id: stage.id, name: stage.name, categoryId: stage.categoryId, sort: stage.sort, semantics: stage.semantics,
    }));
    return Response.json({
      ...meta,
      ...(load.liveStatus === "DEGRADED" ? { error: load.liveError } : { liveFetch: load.liveFetch, snapshotSaved: load.snapshotSaved }),
      records, rowCount: records.length, reconciliation, stageCatalog, truncated: load.truncated, stageSettings: stageSettings(settings),
      liveCandidates: load.deals.length, excludedCounts, excludedDealIds: excluded,
    });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
