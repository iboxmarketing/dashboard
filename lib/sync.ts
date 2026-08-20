import { getD1 } from "@/db";
import { buildAnalyticsRecords, discoverProviders, type RawActivity, type RawCallStat, type RawDeal, type RawStageHistory } from "./analytics";
import { bitrixCall, bitrixList, bitrixPage, getBitrixDomain, safeBitrixMessage } from "./bitrix";
import {
  clearUnselectedAnalytics, getDictionary, getProviderRules, getSettings, getSyncJob,
  getSyncState, getSalesSnapshots, saveDictionary, saveProviderDiagnostics, saveSalesSnapshots, saveSettings, saveSyncJob,
  saveSyncState, upsertAnalyticsRecords, type StoredSyncJob,
} from "./storage";
import type { CrmFieldOption, PipelineOption } from "./types";
export { normalizePipelineName, resolvePipelineSelection } from "./pipelines";
import { normalizePipelineName, resolvePipelineSelection, resolvePostSalePipelines } from "./pipelines";

const activitySelect = [
  "ID", "OWNER_ID", "OWNER_TYPE_ID", "BINDINGS", "TYPE_ID", "PROVIDER_ID", "PROVIDER_TYPE_ID",
  "DIRECTION", "CREATED", "START_TIME", "END_TIME", "COMPLETED", "STATUS", "RESPONSIBLE_ID",
  "SUBJECT", "SETTINGS", "RESULT_STATUS", "RESULT_VALUE",
];

function value(row: Record<string, unknown>, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined ? "" : String(raw);
}

function parseRows<T>(rows: { payload: string }[]) {
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.payload) as T]; } catch { return []; }
  });
}

export async function listPipelines(): Promise<PipelineOption[]> {
  const rows = await bitrixList<Record<string, unknown>>("crm.dealcategory.list", { order: { SORT: "ASC" } }, { maxPages: 20 });
  return rows.map((row) => ({ id: value(row, "ID"), name: value(row, "NAME") || `Pipeline #${value(row, "ID")}` })).filter((row) => row.id);
}

function localizedValue(raw: unknown) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "object") return String(raw);
  const labels = raw as Record<string, unknown>;
  return String(labels.ru ?? labels.uz ?? labels.en ?? Object.values(labels).find(Boolean) ?? "");
}

function crmFieldRows(result: unknown, discoverySource: CrmFieldOption["discoverySource"]): CrmFieldOption[] {
  let raw = result && typeof result === "object" && "result" in result ? (result as { result: unknown }).result : result;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "fields" in raw) raw = (raw as { fields: unknown }).fields;
  const entries = Array.isArray(raw) ? raw.map((row) => [value(row as Record<string, unknown>, "FIELD_NAME") || value(row as Record<string, unknown>, "fieldName"), row]) : Object.entries((raw ?? {}) as Record<string, unknown>);
  return entries.flatMap(([key, item]) => {
    const field = item as Record<string, unknown>;
    const title = localizedValue(field.title ?? field.formLabel ?? field.listLabel ?? field.EDIT_FORM_LABEL ?? field.LIST_COLUMN_LABEL) || String(key);
    const type = value(field, "type") || value(field, "USER_TYPE_ID") || value(field, "userTypeId") || "string";
    const rawOptions = Array.isArray(field.LIST) ? field.LIST : Array.isArray(field.items) ? field.items : [];
    return key ? [{ key: String(key), title, type, discoverySource, options: rawOptions.map((option) => {
      const row = option as Record<string, unknown>;
      return { id: value(row, "ID") || value(row, "id") || value(row, "VALUE") || value(row, "value"), value: value(row, "VALUE") || value(row, "value") || value(row, "NAME") || value(row, "name") };
    }).filter((option) => option.id) }] : [];
  });
}

async function sampleCustomFields(categoryIds: string[] = []): Promise<CrmFieldOption[]> {
  try {
    const page = await bitrixPage<RawDeal>("crm.deal.list", {
      order: { DATE_MODIFY: "DESC", ID: "DESC" },
      ...(categoryIds.length ? { filter: { CATEGORY_ID: categoryIds } } : {}),
      select: ["ID", "TITLE", "UF_*"],
    }, 0);
    const samples = new Map<string, string>();
    for (const deal of page.items) for (const [key, raw] of Object.entries(deal)) {
      if (!/^UF_CRM_/i.test(key)) continue;
      const shown = Array.isArray(raw) ? raw.map(String).join(", ") : raw === null || raw === undefined ? "" : String(raw);
      if (!samples.has(key) || shown) samples.set(key, shown.slice(0, 80));
    }
    return [...samples.entries()].map(([key, sampleValue]) => ({ key, title: `Custom field ${key}`, type: "unknown", options: [], sampleValue, discoverySource: "DEAL_SAMPLE" as const }));
  } catch { return []; }
}

export async function listCrmFields(categoryIds: string[] = []): Promise<CrmFieldOption[]> {
  const response = await bitrixCall<unknown>("crm.deal.fields", {});
  const fields = crmFieldRows(response, "DEAL_FIELDS");
  const [itemFields, custom, samples] = await Promise.all([
    bitrixCall<unknown>("crm.item.fields", { entityTypeId: 2 }).then((result) => crmFieldRows(result, "ITEM_FIELDS")).catch(() => []),
    bitrixList<Record<string, unknown>>("crm.deal.userfield.list", { order: { SORT: "ASC" } }, { maxPages: 20 }).then((result) => crmFieldRows(result, "USERFIELD_LIST")).catch(() => []),
    sampleCustomFields(categoryIds),
  ]);
  const merged = new Map<string, CrmFieldOption>();
  for (const field of [...samples, ...fields, ...itemFields, ...custom]) {
    const previous = merged.get(field.key);
    merged.set(field.key, { ...previous, ...field, sampleValue: field.sampleValue || previous?.sampleValue, options: field.options.length ? field.options : previous?.options ?? [] });
  }
  return [...merged.values()].sort((a, b) => (a.key.startsWith("UF_") === b.key.startsWith("UF_") ? a.title.localeCompare(b.title) : a.key.startsWith("UF_") ? -1 : 1));
}

function detectField(fields: CrmFieldOption[], pattern: RegExp, type?: RegExp) {
  return fields.find((field) => pattern.test(normalizePipelineName(field.title)) && (!type || type.test(field.type)))?.key ?? null;
}

function query(path: string, filter: Record<string, string>, select: string[] = [], order: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(filter)) params.set(`filter[${key}]`, raw);
  for (const [key, raw] of Object.entries(order)) params.set(`order[${key}]`, raw);
  for (const field of select) params.append("select[]", field);
  return `${path}?${params.toString()}`;
}

function batchItems(response: Record<string, unknown>, key: string) {
  const outer = response.result as Record<string, unknown> | undefined;
  const results = (outer?.result ?? outer) as Record<string, unknown> | undefined;
  const raw = results?.[key];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)) return (raw as { items: Record<string, unknown>[] }).items;
  return [];
}

function phaseProgress(phase: StoredSyncJob["phase"], processed: number, total: number) {
  const ranges: Record<StoredSyncJob["phase"], [number, number]> = {
    deals: [0, 20], activities: [20, 43], stageHistory: [43, 63], telephony: [63, 76],
    lookups: [76, 82], analytics: [82, 100], done: [100, 100],
  };
  const [start, end] = ranges[phase];
  const fraction = total > 0 ? Math.min(1, processed / total) : 0;
  return Math.round(start + (end - start) * fraction);
}

function move(job: StoredSyncJob, phase: StoredSyncJob["phase"], message: string, total = job.counts.deals ?? 0) {
  return { ...job, phase, cursor: 0, processed: 0, total, progress: phaseProgress(phase, 0, total), message };
}

async function upsertRaw(table: "raw_deals" | "raw_activities" | "raw_stage_history" | "raw_call_stats", rows: unknown[][]) {
  const db = getD1();
  for (let index = 0; index < rows.length; index += 40) {
    const statements = rows.slice(index, index + 40).map((bindings) => {
      if (table === "raw_deals") return db.prepare("INSERT OR REPLACE INTO raw_deals(deal_id, category_id, created_at, payload, synced_at) VALUES(?, ?, ?, ?, ?)").bind(...bindings);
      if (table === "raw_activities") return db.prepare("INSERT OR REPLACE INTO raw_activities(row_key, deal_id, activity_id, created_at, payload, synced_at) VALUES(?, ?, ?, ?, ?, ?)").bind(...bindings);
      if (table === "raw_stage_history") return db.prepare("INSERT OR REPLACE INTO raw_stage_history(row_key, deal_id, created_at, payload, synced_at) VALUES(?, ?, ?, ?, ?)").bind(...bindings);
      return db.prepare("INSERT OR REPLACE INTO raw_call_stats(row_key, activity_id, payload, synced_at) VALUES(?, ?, ?, ?)").bind(...bindings);
    });
    if (statements.length) await db.batch(statements);
  }
}

export async function startSync(options: { days?: number; full?: boolean } = {}) {
  let settings = await getSettings();
  const pipelines = await listPipelines();
  const selected = resolvePipelineSelection(pipelines, settings.selectedPipelineIds, settings.selectedPipelineNames);
  const reporting = resolvePostSalePipelines(pipelines, settings.postSalePipelineIds, settings.postSalePipelineNames);
  let crmFields: CrmFieldOption[] = [];
  try { crmFields = await listCrmFields(selected.map((item) => item.id)); } catch { /* Config remains editable by field code. */ }
  settings = {
    ...settings,
    failureReasonField: settings.failureReasonField ?? detectField(crmFields, /причин.*провал|prichin.*proval|failure.*reason/),
    marketingChannelField: settings.marketingChannelField ?? detectField(crmFields, /маркет.*канал|marketing.*kanal|marketing.*channel/),
    salesManagerField: settings.salesManagerField ?? detectField(crmFields, /менеджер.*продаж|sales.*manager|sotuv.*menejer/, /employee|user/),
  };
  const selectedIds = selected.map((item) => item.id);
  const stateRow = await getD1().prepare("SELECT last_sync_at FROM sync_state WHERE id = 'main'").first<{ last_sync_at: string }>();
  const now = new Date();
  const days = Math.min(365, Math.max(1, Number(options.days ?? settings.historyDays)));
  const mode = options.full || !stateRow?.last_sync_at ? "full" : "incremental";
  const lastSyncMs = Date.parse(stateRow?.last_sync_at ?? "");
  const from = mode === "full"
    ? new Date(now.getTime() - days * 86_400_000)
    : new Date(Math.max(now.getTime() - 86_400_000, (Number.isFinite(lastSyncMs) ? lastSyncMs : now.getTime()) - 10 * 60_000));
  const fromIso = from.toISOString();
  const runId = crypto.randomUUID();
  const permissions = { deals: "ok", activities: "ok", stageHistory: "ok", managers: "ok", telephony: "ok" };

  await saveSettings({ ...settings, selectedPipelineIds: selectedIds, selectedPipelineNames: selected.map((item) => item.name), postSalePipelineIds: reporting.map((item) => item.id), postSalePipelineNames: reporting.map((item) => item.name) });
  await saveDictionary("crmFields", crmFields);
  await clearUnselectedAnalytics([...selectedIds, ...reporting.map((item) => item.id)], mode === "full" ? fromIso : undefined);
  if (mode === "full") {
    const db = getD1();
    await db.batch([
      db.prepare("DELETE FROM analytics_records"),
      db.prepare("DELETE FROM raw_deals"), db.prepare("DELETE FROM raw_activities"),
      db.prepare("DELETE FROM raw_stage_history"), db.prepare("DELETE FROM raw_call_stats"),
    ]);
  }

  const timestamp = now.toISOString();
  const job: StoredSyncJob = {
    status: "running", phase: "deals", progress: 0, message: "Eng yangi Deal’lar yuklanmoqda…",
    processed: 0, total: 0, cursor: 0, fromIso, toIso: timestamp, mode, runId,
    selectedPipelines: selected, reportingPipelines: reporting, dealScope: "main", counts: {}, permissions, safeError: null,
    heartbeatAt: timestamp, updatedAt: timestamp,
  };
  await saveSyncJob(job);
  await saveSyncState({ status: "running", lastFrom: fromIso, counts: {}, permissions, safeError: null });
  return await getSyncState();
}

async function dealStep(job: StoredSyncJob) {
  const ids = (job.dealScope === "postSale" ? job.reportingPipelines : job.selectedPipelines).map((item) => item.id);
  if (!ids.length && job.dealScope === "postSale") return move(job, "activities", "Sales Deal activity’lari yuklanmoqda…", job.counts.deals ?? 0);
  const filter: Record<string, unknown> = { CATEGORY_ID: ids };
  if (job.mode === "full") {
    const dateField = job.dealScope === "postSale" ? "MOVED_TIME" : "DATE_CREATE";
    filter[`>=${dateField}`] = job.fromIso;
    filter[`<=${dateField}`] = job.toIso;
  } else {
    filter[">=DATE_MODIFY"] = job.fromIso;
    filter["<=DATE_MODIFY"] = job.toIso;
  }
  const settings = await getSettings();
  const customFields = [settings.failureReasonField, settings.marketingChannelField, settings.salesManagerField].filter((field): field is string => Boolean(field));
  const page = await bitrixPage<RawDeal>("crm.deal.list", {
    order: { DATE_CREATE: "DESC", ID: "DESC" }, filter,
    select: ["ID", "TITLE", "DATE_CREATE", "DATE_MODIFY", "MOVED_TIME", "MOVED_BY_ID", "ASSIGNED_BY_ID", "CATEGORY_ID", "STAGE_ID", "SOURCE_ID", "OPPORTUNITY", "CURRENCY_ID", ...customFields],
  }, job.cursor);
  await upsertRaw("raw_deals", page.items.map((deal) => [value(deal, "ID"), value(deal, "CATEGORY_ID") || "0", value(deal, "DATE_CREATE"), JSON.stringify(deal), job.runId]));
  const counts = { ...job.counts, deals: (job.counts.deals ?? 0) + page.items.length };
  if (page.next === null) {
    if (job.dealScope === "main" && job.reportingPipelines.length) return { ...job, dealScope: "postSale" as const, cursor: 0, processed: counts.deals, total: 0, counts, progress: phaseProgress("deals", counts.deals, Math.max(counts.deals, 1)), message: "Sotilgan Deal’lar post-sale funnel’dan tekshirilmoqda…" };
    return move({ ...job, counts }, "activities", "Faqat sales Deal’larining activity’lari yuklanmoqda…", counts.deals);
  }
  const total = page.total ?? Math.max(counts.deals, page.next + 50);
  return { ...job, cursor: page.next, processed: counts.deals, total, counts, progress: phaseProgress("deals", counts.deals, total), message: `${counts.deals} / ${total} ta Deal yuklandi` };
}

async function activityStep(job: StoredSyncJob) {
  const result = await getD1().prepare("SELECT deal_id FROM raw_deals WHERE synced_at = ? ORDER BY created_at DESC LIMIT 10 OFFSET ?").bind(job.runId, job.cursor).all<{ deal_id: string }>();
  const ids = (result.results ?? []).map((row) => String(row.deal_id));
  if (!ids.length) return move(job, "stageHistory", "Deal stage history ma’lumotlari yuklanmoqda…", job.counts.deals);
  const cmd = Object.fromEntries(ids.map((id) => [`deal_${id}`, query("crm.activity.list", { OWNER_TYPE_ID: "2", OWNER_ID: id }, activitySelect, { ID: "ASC" })]));
  const response = await bitrixCall<Record<string, unknown>>("batch", { halt: 0, cmd });
  const placeholders = ids.map(() => "?").join(", ");
  await getD1().prepare(`DELETE FROM raw_activities WHERE deal_id IN (${placeholders})`).bind(...ids).run();
  const rows: unknown[][] = [];
  for (const id of ids) for (const activity of batchItems(response as unknown as Record<string, unknown>, `deal_${id}`)) {
    const activityId = value(activity, "ID");
    rows.push([`${id}:${activityId}`, id, activityId, value(activity, "CREATED"), JSON.stringify(activity), job.runId]);
  }
  await upsertRaw("raw_activities", rows);
  const cursor = job.cursor + ids.length;
  const counts = { ...job.counts, activities: (job.counts.activities ?? 0) + rows.length };
  return { ...job, cursor, processed: cursor, total: job.counts.deals, counts, progress: phaseProgress("activities", cursor, job.counts.deals), message: `${Math.min(cursor, job.counts.deals)} / ${job.counts.deals} ta Deal activity’si tekshirildi` };
}

async function stageStep(job: StoredSyncJob) {
  const result = await getD1().prepare("SELECT deal_id FROM raw_deals WHERE synced_at = ? ORDER BY created_at DESC LIMIT 20 OFFSET ?").bind(job.runId, job.cursor).all<{ deal_id: string }>();
  const ids = (result.results ?? []).map((row) => String(row.deal_id));
  if (!ids.length) {
    const activityCount = await getD1().prepare("SELECT COUNT(*) AS count FROM raw_activities WHERE synced_at = ?").bind(job.runId).first<{ count: number }>();
    return move(job, "telephony", "Faqat sales Deal’laridagi qo‘ng‘iroqlar natijasi boyitilmoqda…", Number(activityCount?.count ?? 0));
  }
  const cmd = Object.fromEntries(ids.map((id) => [`deal_${id}`, query("crm.stagehistory.list", { OWNER_ID: id }, ["ID", "OWNER_ID", "CATEGORY_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "TYPE_ID", "CREATED_TIME"], { ID: "ASC" }).replace("?", "?entityTypeId=2&")]));
  const response = await bitrixCall<Record<string, unknown>>("batch", { halt: 0, cmd });
  const placeholders = ids.map(() => "?").join(", ");
  await getD1().prepare(`DELETE FROM raw_stage_history WHERE deal_id IN (${placeholders})`).bind(...ids).run();
  const rows: unknown[][] = [];
  for (const id of ids) for (const history of batchItems(response as unknown as Record<string, unknown>, `deal_${id}`)) {
    const createdAt = value(history, "CREATED_TIME");
    history.OWNER_ID = id;
    rows.push([`${id}:${value(history, "ID") || `${value(history, "STAGE_ID")}:${createdAt}`}`, id, createdAt, JSON.stringify(history), job.runId]);
  }
  await upsertRaw("raw_stage_history", rows);
  const cursor = job.cursor + ids.length;
  const counts = { ...job.counts, stageHistory: (job.counts.stageHistory ?? 0) + rows.length };
  return { ...job, cursor, processed: cursor, total: job.counts.deals, counts, progress: phaseProgress("stageHistory", cursor, job.counts.deals), message: `${Math.min(cursor, job.counts.deals)} / ${job.counts.deals} ta Deal stage history’si tekshirildi` };
}

async function telephonyStep(job: StoredSyncJob) {
  const result = await getD1().prepare("SELECT DISTINCT activity_id FROM raw_activities WHERE synced_at = ? AND activity_id != '' ORDER BY activity_id LIMIT 20 OFFSET ?").bind(job.runId, job.cursor).all<{ activity_id: string }>();
  const ids = (result.results ?? []).map((row) => String(row.activity_id));
  if (!ids.length) return move(job, "lookups", "Menejer, pipeline va status nomlari yangilanmoqda…", 1);
  const cmd = Object.fromEntries(ids.map((id) => [`activity_${id}`, `voximplant.statistic.get?FILTER%5BCRM_ACTIVITY_ID%5D=${encodeURIComponent(id)}`]));
  const response = await bitrixCall<Record<string, unknown>>("batch", { halt: 0, cmd });
  const placeholders = ids.map(() => "?").join(", ");
  await getD1().prepare(`DELETE FROM raw_call_stats WHERE activity_id IN (${placeholders})`).bind(...ids).run();
  const rows: unknown[][] = [];
  for (const id of ids) for (const stat of batchItems(response as unknown as Record<string, unknown>, `activity_${id}`)) {
    rows.push([`${id}:${value(stat, "ID") || "stat"}`, id, JSON.stringify(stat), job.runId]);
  }
  await upsertRaw("raw_call_stats", rows);
  const cursor = job.cursor + ids.length;
  const counts = { ...job.counts, telephony: (job.counts.telephony ?? 0) + rows.length };
  return { ...job, cursor, processed: cursor, counts, progress: phaseProgress("telephony", cursor, Math.max(job.total, cursor)), message: `${cursor} ta activity qo‘ng‘iroq natijasi bilan tekshirildi` };
}

async function lookupStep(job: StoredSyncJob) {
  let users: Record<string, unknown>[] = [];
  let statuses: Record<string, unknown>[] = [];
  const permissions = { ...job.permissions };
  try { users = await bitrixList<Record<string, unknown>>("user.get", { FILTER: { ACTIVE: true } }, { maxPages: 20 }); } catch { permissions.managers = "error"; }
  try { statuses = await bitrixList<Record<string, unknown>>("crm.status.list", { order: { SORT: "ASC" } }, { maxPages: 20 }); } catch { /* Raw IDs remain visible. */ }
  await saveDictionary("users", users);
  await saveDictionary("statuses", statuses);
  await saveDictionary("pipelines", [...job.selectedPipelines, ...job.reportingPipelines]);
  const activityResult = await getD1().prepare("SELECT payload FROM raw_activities WHERE synced_at = ?").bind(job.runId).all<{ payload: string }>();
  const activities = parseRows<RawActivity>(activityResult.results ?? []);
  const providerRules = await getProviderRules();
  await saveProviderDiagnostics(discoverProviders(activities).map((provider) => ({ ...provider, mode: (providerRules[provider.key] ?? "AUTO") as "AUTO" | "USE" | "IGNORE" })));
  return move({ ...job, permissions }, "analytics", "Dashboard ko‘rsatkichlari kichik paketlarda hisoblanmoqda…", job.counts.deals);
}

async function analyticsStep(job: StoredSyncJob) {
  const dealResult = await getD1().prepare("SELECT deal_id, payload FROM raw_deals WHERE synced_at = ? ORDER BY created_at DESC LIMIT 100 OFFSET ?").bind(job.runId, job.cursor).all<{ deal_id: string; payload: string }>();
  const rawDeals = dealResult.results ?? [];
  if (!rawDeals.length) {
    const completedAt = new Date().toISOString();
    const finished: StoredSyncJob = { ...job, status: "success", phase: "done", progress: 100, processed: job.counts.deals ?? 0, total: job.counts.deals ?? 0, cursor: 0, message: "Sinxronizatsiya yakunlandi", safeError: null };
    await saveSyncJob(finished);
    await saveSyncState({ status: "success", lastSyncAt: completedAt, lastFrom: job.fromIso, counts: job.counts, permissions: job.permissions, safeError: null });
    return finished;
  }
  const ids = rawDeals.map((row) => row.deal_id);
  const placeholders = ids.map(() => "?").join(", ");
  const activityResult = await getD1().prepare(`SELECT payload, activity_id FROM raw_activities WHERE deal_id IN (${placeholders})`).bind(...ids).all<{ payload: string; activity_id: string }>();
  const historyResult = await getD1().prepare(`SELECT payload FROM raw_stage_history WHERE deal_id IN (${placeholders})`).bind(...ids).all<{ payload: string }>();
  const activities = parseRows<RawActivity>(activityResult.results ?? []);
  const activityIds = [...new Set((activityResult.results ?? []).map((row) => row.activity_id).filter(Boolean))];
  let callStats: RawCallStat[] = [];
  if (activityIds.length) {
    const activityPlaceholders = activityIds.map(() => "?").join(", ");
    const callResult = await getD1().prepare(`SELECT payload FROM raw_call_stats WHERE activity_id IN (${activityPlaceholders})`).bind(...activityIds).all<{ payload: string }>();
    callStats = parseRows<RawCallStat>(callResult.results ?? []);
  }
  const userRows = await getDictionary<Record<string, unknown>[]>("users", []);
  const statusRows = await getDictionary<Record<string, unknown>[]>("statuses", []);
  const users = new Map(userRows.map((row) => [value(row, "ID"), [value(row, "NAME"), value(row, "LAST_NAME")].filter(Boolean).join(" ") || `Menejer #${value(row, "ID")}`]));
  const pipelines = new Map([...job.selectedPipelines, ...job.reportingPipelines].map((item) => [item.id, item.name]));
  const stages = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const status of statusRows) {
    const id = value(status, "STATUS_ID");
    const name = value(status, "NAME") || id;
    const entity = value(status, "ENTITY_ID");
    if (entity.startsWith("DEAL_STAGE")) stages.set(id, name);
    if (entity === "SOURCE") sources.set(id, name);
  }
  const settings = await getSettings();
  const providerRules = await getProviderRules();
  const crmFields = await getDictionary<CrmFieldOption[]>("crmFields", []);
  const fieldOptions = new Map(crmFields.map((field) => [field.key, new Map(field.options.map((option) => [option.id, option.value]))]));
  const snapshots = await getSalesSnapshots(ids);
  const records = buildAnalyticsRecords({
    deals: parseRows<RawDeal>(rawDeals), activities, stageHistories: parseRows<RawStageHistory>(historyResult.results ?? []), callStats,
    settings, providerRules, users, pipelines, stages, sources, fieldOptions, snapshots, domain: getBitrixDomain(),
    activitiesAvailable: job.permissions.activities === "ok", stageHistoryAvailable: job.permissions.stageHistory === "ok",
  });
  await upsertAnalyticsRecords(records);
  await saveSalesSnapshots(records);
  const cursor = job.cursor + rawDeals.length;
  const counts = {
    ...job.counts,
    outgoingCalls: (job.counts.outgoingCalls ?? 0) + records.reduce((sum, row) => sum + row.outgoingCallCount, 0),
    noProcessing: (job.counts.noProcessing ?? 0) + records.filter((row) => row.processingSource === "NO_PROCESSING").length,
    stageBeforeCall: (job.counts.stageBeforeCall ?? 0) + records.filter((row) => row.stageChangedBeforeCall).length,
  };
  return { ...job, cursor, processed: cursor, total: job.counts.deals, counts, progress: phaseProgress("analytics", cursor, job.counts.deals), message: `${Math.min(cursor, job.counts.deals)} / ${job.counts.deals} ta Deal ko‘rsatkichi hisoblandi` };
}

export async function runSyncStep() {
  const job = await getSyncJob();
  if (!job) throw new Error("Boshlanmagan sync topilmadi");
  if (job.status === "paused" || job.status === "success") return await getSyncState();
  if (job.status === "error") throw new Error(job.safeError ?? "Sync xatolikda to‘xtagan");
  try {
    let next: StoredSyncJob;
    if (job.phase === "deals") next = await dealStep(job);
    else if (job.phase === "activities") {
      try { next = await activityStep(job); } catch { next = move({ ...job, permissions: { ...job.permissions, activities: "error" } }, "stageHistory", "Activity API cheklangan; stage history davom etmoqda…", job.counts.deals); }
    } else if (job.phase === "stageHistory") {
      try { next = await stageStep(job); } catch { next = move({ ...job, permissions: { ...job.permissions, stageHistory: "error" } }, "telephony", "Stage history cheklangan; telephony davom etmoqda…", job.total); }
    } else if (job.phase === "telephony") {
      try { next = await telephonyStep(job); } catch { next = move({ ...job, permissions: { ...job.permissions, telephony: "warning" } }, "lookups", "Telephony cheklangan; asosiy SLA hisoblanmoqda…", 1); }
    } else if (job.phase === "lookups") next = await lookupStep(job);
    else if (job.phase === "analytics") next = await analyticsStep(job);
    else next = job;
    if (next.status === "running") await saveSyncJob(next);
    return await getSyncState();
  } catch (error) {
    const safe = safeBitrixMessage(error);
    const message = safe === "Kutilmagan xavfsiz server xatosi" && error instanceof Error ? error.message.slice(0, 240) : safe;
    await saveSyncJob({ ...job, status: "error", safeError: message, message: "Sync xatolik sabab to‘xtadi" });
    await saveSyncState({ status: "error", safeError: message, permissions: job.permissions });
    throw error;
  }
}

export async function pauseSync() {
  const job = await getSyncJob();
  if (job?.status === "running") await saveSyncJob({ ...job, status: "paused", message: "Sinxronizatsiya pauzada" });
  return await getSyncState();
}

export async function resumeSync() {
  const job = await getSyncJob();
  if (!job) throw new Error("Davom ettiriladigan sync topilmadi");
  if (job.status === "success") return await getSyncState();
  await saveSyncJob({ ...job, status: "running", safeError: null, message: `${job.message.replace(/\s*\(.*\)$/, "")} (davom etmoqda)` });
  return await getSyncState();
}

export async function runSync(options: { days?: number; full?: boolean } = {}) {
  return await startSync(options);
}
