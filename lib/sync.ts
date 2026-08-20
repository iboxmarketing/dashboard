import { buildAnalyticsRecords, discoverProviders, type RawActivity, type RawCallStat, type RawDeal, type RawStageHistory } from "./analytics";
import { bitrixCall, bitrixList, getBitrixDomain, safeBitrixMessage } from "./bitrix";
import { getProviderRules, getSettings, replaceAnalyticsRecords, saveProviderDiagnostics, saveSyncState } from "./storage";

type PermissionState = "ok" | "warning" | "error";

function value(row: Record<string, unknown>, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined ? "" : String(raw);
}

function stageHistoryQuery(dealId: string) {
  const query = new URLSearchParams();
  query.set("entityTypeId", "2");
  query.set("order[ID]", "ASC");
  query.set("filter[OWNER_ID]", dealId);
  for (const field of ["ID", "OWNER_ID", "STAGE_ID", "CREATED_TIME"]) query.append("select[]", field);
  return `crm.stagehistory.list?${query.toString()}`;
}

async function loadStageHistories(dealIds: string[]) {
  const rows: RawStageHistory[] = [];
  for (let index = 0; index < dealIds.length; index += 50) {
    const chunk = dealIds.slice(index, index + 50);
    const cmd = Object.fromEntries(chunk.map((id) => [`deal_${id}`, stageHistoryQuery(id)]));
    const response = await bitrixCall<Record<string, unknown>>("batch", { halt: 0, cmd });
    const outer = response.result as Record<string, unknown> | undefined;
    const results = (outer?.result ?? outer) as Record<string, unknown> | undefined;
    if (!results) continue;
    for (const id of chunk) {
      const raw = results[`deal_${id}`];
      const items = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
          ? ((raw as Record<string, unknown>).items as unknown[])
          : [];
      for (const item of items) rows.push({ ...(item as RawStageHistory), OWNER_ID: id });
    }
  }
  return rows;
}

export async function runSync(options: { days?: number; full?: boolean } = {}) {
  const settings = await getSettings();
  const days = Math.min(365, Math.max(1, Number(options.days ?? settings.historyDays)));
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);
  const fromIso = from.toISOString();
  await saveSyncState({ status: "running", lastFrom: fromIso, safeError: null });

  const permissions: Record<string, PermissionState> = {
    deals: "ok",
    activities: "ok",
    stageHistory: "ok",
    managers: "ok",
    telephony: "ok",
  };

  try {
    const deals = await bitrixList<RawDeal>("crm.deal.list", {
      order: { DATE_CREATE: "ASC", ID: "ASC" },
      filter: { ">=DATE_CREATE": fromIso },
      select: ["ID", "TITLE", "DATE_CREATE", "ASSIGNED_BY_ID", "CATEGORY_ID", "STAGE_ID", "SOURCE_ID"],
    });

    let activities: RawActivity[] = [];
    try {
      activities = await bitrixList<RawActivity>("crm.activity.list", {
        order: { ID: "ASC" },
        filter: { ">=CREATED": fromIso },
        select: [
          "ID", "OWNER_ID", "OWNER_TYPE_ID", "BINDINGS", "TYPE_ID", "PROVIDER_ID", "PROVIDER_TYPE_ID",
          "DIRECTION", "CREATED", "START_TIME", "END_TIME", "COMPLETED", "STATUS", "RESPONSIBLE_ID",
          "SUBJECT", "SETTINGS", "RESULT_STATUS", "RESULT_VALUE",
        ],
      }, { maxPages: 400 });
    } catch {
      permissions.activities = "error";
    }

    let histories: RawStageHistory[] = [];
    try {
      histories = await loadStageHistories(deals.map((deal) => value(deal, "ID")));
    } catch {
      permissions.stageHistory = "error";
    }

    let callStats: RawCallStat[] = [];
    try {
      callStats = await bitrixList<RawCallStat>("voximplant.statistic.get", {
        FILTER: { ">=CALL_START_DATE": fromIso },
        SORT: "ID",
        ORDER: "ASC",
      }, { maxPages: 400 });
    } catch {
      permissions.telephony = "warning";
    }

    const users = new Map<string, string>();
    try {
      const userRows = await bitrixList<Record<string, unknown>>("user.get", { FILTER: { ACTIVE: true } }, { maxPages: 100 });
      for (const user of userRows) {
        const id = value(user, "ID");
        const name = [value(user, "NAME"), value(user, "LAST_NAME")].filter(Boolean).join(" ");
        if (id) users.set(id, name || `Menejer #${id}`);
      }
    } catch {
      permissions.managers = "error";
    }

    const pipelines = new Map<string, string>([["0", "Asosiy pipeline"]]);
    try {
      const categories = await bitrixList<Record<string, unknown>>("crm.dealcategory.list", { order: { SORT: "ASC" } }, { maxPages: 20 });
      for (const category of categories) pipelines.set(value(category, "ID"), value(category, "NAME") || `Pipeline #${value(category, "ID")}`);
    } catch {
      // The default pipeline remains usable.
    }

    const stages = new Map<string, string>();
    const sources = new Map<string, string>();
    try {
      const statuses = await bitrixList<Record<string, unknown>>("crm.status.list", { order: { SORT: "ASC" } }, { maxPages: 100 });
      for (const status of statuses) {
        const id = value(status, "STATUS_ID");
        const name = value(status, "NAME") || id;
        const entity = value(status, "ENTITY_ID");
        if (entity.startsWith("DEAL_STAGE")) stages.set(id, name);
        if (entity === "SOURCE") sources.set(id, name);
      }
    } catch {
      // Raw IDs are shown when names cannot be retrieved.
    }

    const providerRules = await getProviderRules();
    const providers = discoverProviders(activities).map((provider) => ({
      ...provider,
      mode: (providerRules[provider.key] ?? "AUTO") as "AUTO" | "USE" | "IGNORE",
    }));
    await saveProviderDiagnostics(providers);

    const records = buildAnalyticsRecords({
      deals,
      activities,
      stageHistories: histories,
      callStats,
      settings,
      providerRules,
      users,
      pipelines,
      stages,
      sources,
      domain: getBitrixDomain(),
      activitiesAvailable: permissions.activities === "ok",
      stageHistoryAvailable: permissions.stageHistory === "ok",
    });

    await replaceAnalyticsRecords(records, fromIso);
    const counts = {
      deals: deals.length,
      activities: activities.length,
      outgoingCalls: records.reduce((sum, row) => sum + row.outgoingCallCount, 0),
      stageHistory: histories.length,
      telephony: callStats.length,
      noProcessing: records.filter((row) => row.processingSource === "NO_PROCESSING").length,
      stageBeforeCall: records.filter((row) => row.stageChangedBeforeCall).length,
    };
    const completedAt = new Date().toISOString();
    await saveSyncState({ status: "success", lastSyncAt: completedAt, lastFrom: fromIso, counts, permissions, safeError: null });
    return { records: records.length, counts, permissions, completedAt };
  } catch (error) {
    const message = safeBitrixMessage(error);
    await saveSyncState({ status: "error", safeError: message, permissions });
    throw error;
  }
}

