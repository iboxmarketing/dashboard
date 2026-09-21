import { getD1 } from "@/db";
import { buildFieldOptionMap, buildStatusMaps, buildUserMap } from "./analytics-dictionaries";
import { buildAnalyticsRecords, type RawDeal, type RawStageHistory } from "./analytics";
import { bitrixCall, bitrixList, bitrixPage, getBitrixDomain, SafeBitrixError, safeBitrixMessage } from "./bitrix";
import {
  getDictionary, getSettings, getSyncJob,
  getSyncState, getSalesSnapshots, saveDictionary, saveSalesSnapshots, saveSettings, saveSyncJob,
  saveSyncState, upsertAnalyticsRecords, type StoredSyncJob,
} from "./storage";
import type { CrmFieldOption, PipelineOption, PipelineStageOption } from "./types";
export { normalizePipelineName, resolvePipelineSelection } from "./pipelines";
import { normalizePipelineName, pairPostSalePipeline, resolvePipelineSelection, resolvePostSalePipelines } from "./pipelines";
import { resolveSyncWindow } from "./sync-window";
import { canonicalDealFieldKey, canonicalizeFieldOptions } from "./crm-fields";
import { normalizeSafeStableSellerField } from "./stable-seller-field";
import { runPostSyncReconciliation } from "./post-sync-reconciliation";
import {
  persistStageHistoryRows,
  stageHistoryRowKey,
  type StageHistoryPersistenceRow,
} from "./stage-history-persistence";
import {
  buildPeriodSalesDiscoveryRequest,
  nextDealDiscoveryScope,
  uniqueDiscoveryIds,
} from "./period-sales-coverage";
import { attachDealObservers, buildDealObserverRead, observerItemIds } from "./deal-observers";
import {
  decideStageHistoryFailure,
  stageHistoryBatchFailure,
  STAGE_HISTORY_MAX_RETRIES,
} from "./stage-history-retry";
import { analyticsPageSql, safeD1WriteQuotaError } from "./sync-recovery";
import { planAnalyticsBatch } from "./analytics-runtime";

const stageDealBatchSize = 25;
const analyticsDealBatchSize = 80;

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

export async function listPipelineStages(categoryIds: string[]): Promise<PipelineStageOption[]> {
  const uniqueIds = [...new Set(categoryIds.map(String).filter(Boolean))];
  const groups = await Promise.all(uniqueIds.map(async (categoryId) => {
    const entityId = categoryId === "0" ? "DEAL_STAGE" : `DEAL_STAGE_${categoryId}`;
    const rows = await bitrixList<Record<string, unknown>>("crm.status.list", {
      filter: { ENTITY_ID: entityId },
      order: { SORT: "ASC" },
    }, { maxPages: 20 });
    return rows.flatMap((row) => {
      const id = value(row, "STATUS_ID") || value(row, "ID");
      if (!id) return [];
      return [{
        id,
        name: value(row, "NAME") || id,
        categoryId,
        sort: Number(row.SORT ?? 0),
        semantics: value(row, "SEMANTICS") || value(row, "SYSTEM_STATUS_ID"),
      }];
    });
  }));
  return [...new Map(groups.flat().map((stage) => [`${stage.categoryId}:${stage.id}`, stage])).values()]
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.sort - b.sort || a.name.localeCompare(b.name));
}

function localizedValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "object") return String(raw);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const shown = localizedValue(item);
      if (shown) return shown;
    }
    return "";
  }
  const labels = raw as Record<string, unknown>;
  for (const key of ["ru", "uz", "en", "RU", "UZ", "EN", "VALUE", "value", "NAME", "name", "TITLE", "title"]) {
    const shown = localizedValue(labels[key]);
    if (shown) return shown;
  }
  for (const candidate of Object.values(labels)) {
    const shown = localizedValue(candidate);
    if (shown) return shown;
  }
  return "";
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
  return canonicalizeFieldOptions([...merged.values()]).sort((a, b) => (a.key.startsWith("UF_") === b.key.startsWith("UF_") ? a.title.localeCompare(b.title) : a.key.startsWith("UF_") ? -1 : 1));
}

function detectField(fields: CrmFieldOption[], pattern: RegExp, type?: RegExp) {
  return fields.find((field) => pattern.test(normalizePipelineName(`${field.title} ${field.key}`)) && (!type || type.test(field.type)))?.key ?? null;
}

export function detectFailureReasonField(fields: CrmFieldOption[]) {
  return detectField(fields, /причин.*(провал|отказ|закрыт)|prichin.*proval|failure.*reason|loss.*reason|rad.*sabab|sotilma.*sabab/);
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
    deals: [0, 30], stageHistory: [30, 70], lookups: [70, 78], analytics: [78, 100], done: [100, 100],
  };
  const [start, end] = ranges[phase];
  const fraction = total > 0 ? Math.min(1, processed / total) : 0;
  return Math.round(start + (end - start) * fraction);
}

function move(job: StoredSyncJob, phase: StoredSyncJob["phase"], message: string, total = job.counts.deals ?? 0) {
  return { ...job, phase, cursor: 0, processed: 0, total, progress: phaseProgress(phase, 0, total), message };
}

async function upsertRaw(table: "raw_deals" | "raw_activities" | "raw_call_stats", rows: unknown[][]) {
  const db = getD1();
  for (let index = 0; index < rows.length; index += 40) {
    const statements = rows.slice(index, index + 40).map((bindings) => {
      if (table === "raw_deals") return db.prepare("INSERT OR REPLACE INTO raw_deals(deal_id, category_id, created_at, payload, synced_at) VALUES(?, ?, ?, ?, ?)").bind(...bindings);
      if (table === "raw_activities") return db.prepare("INSERT OR REPLACE INTO raw_activities(row_key, deal_id, activity_id, created_at, payload, synced_at) VALUES(?, ?, ?, ?, ?, ?)").bind(...bindings);
      return db.prepare("INSERT OR REPLACE INTO raw_call_stats(row_key, activity_id, payload, synced_at) VALUES(?, ?, ?, ?)").bind(...bindings);
    });
    if (statements.length) await db.batch(statements);
  }
}

async function clearPipelineScope(categoryIds: string[]) {
  if (!categoryIds.length) return;
  const db = getD1(); const placeholders = categoryIds.map(() => "?").join(", ");
  await db.batch([
    db.prepare(`DELETE FROM raw_call_stats WHERE activity_id IN (SELECT activity_id FROM raw_activities WHERE deal_id IN (SELECT deal_id FROM raw_deals WHERE category_id IN (${placeholders})))`).bind(...categoryIds),
    db.prepare(`DELETE FROM raw_activities WHERE deal_id IN (SELECT deal_id FROM raw_deals WHERE category_id IN (${placeholders}))`).bind(...categoryIds),
    db.prepare(`DELETE FROM raw_stage_history WHERE deal_id IN (SELECT deal_id FROM raw_deals WHERE category_id IN (${placeholders}))`).bind(...categoryIds),
    db.prepare(`DELETE FROM analytics_records WHERE category_id IN (${placeholders})`).bind(...categoryIds),
    db.prepare(`DELETE FROM raw_deals WHERE category_id IN (${placeholders})`).bind(...categoryIds),
  ]);
}

async function idsNotFetchedInRun(runId: string, dealIds: string[]) {
  if (!dealIds.length) return [];
  const placeholders = dealIds.map(() => "?").join(", ");
  const existing = await getD1()
    .prepare(`SELECT deal_id FROM raw_deals WHERE synced_at = ? AND deal_id IN (${placeholders})`)
    .bind(runId, ...dealIds)
    .all<{ deal_id: string }>();
  const seen = new Set((existing.results ?? []).map((row) => String(row.deal_id)));
  return dealIds.filter((id) => !seen.has(id));
}

/**
 * Legacy Deal reads remain the canonical sync path. Only current post-sale
 * Deals need the universal `observers` field, so enrich that bounded subset
 * with one documented crm.item.list read per Deal page.
 */
async function enrichPostSaleObservers(deals: RawDeal[], postSaleCategoryIds: string[]) {
  const postSale = new Set(postSaleCategoryIds.map(String));
  const ids = deals
    .filter((deal) => postSale.has(value(deal, "CATEGORY_ID")))
    .map((deal) => value(deal, "ID"))
    .filter(Boolean);
  if (!ids.length) return deals;

  const request = buildDealObserverRead(ids);
  const items = await bitrixList<Record<string, unknown>>(request.method, request.params, {
    maxPages: Math.ceil(request.dealIds.length / 50) + 1,
  });
  const returned = observerItemIds(items);
  if (request.dealIds.some((id) => !returned.has(id))) {
    throw new SafeBitrixError("OBSERVER_READ_INCOMPLETE", "Post-sale Deal kuzatuvchilari to‘liq yuklanmadi");
  }
  return attachDealObservers(deals, items) as RawDeal[];
}

function advanceDealDiscovery(job: StoredSyncJob, paymentStageIds: string[]) {
  const next = nextDealDiscoveryScope(job.dealScope, {
    hasPaymentStages: paymentStageIds.length > 0,
    hasPostSale: job.reportingPipelines.length > 0,
  });
  if (!next) return move(job, "stageHistory", "Deal stage history ma’lumotlari yuklanmoqda…", job.counts.deals ?? 0);
  const messages = {
    paymentHistory: "Tanlangan davrdagi payment-stage kirishlari tekshirilmoqda…",
    currentPayment: "Joriy payment stage Deal’lari MOVED_TIME bo‘yicha tekshirilmoqda…",
    postSale: "Tanlangan davrdagi post-sale kirishlari tekshirilmoqda…",
  } as const;
  return { ...job, dealScope: next, cursor: 0, processed: 0, total: 0, message: messages[next] };
}

export async function startSync(options: { days?: number; full?: boolean; pipelineId?: string } = {}) {
  let settings = await getSettings();
  const pipelines = await listPipelines();
  const allSelected = resolvePipelineSelection(pipelines, settings.selectedPipelineIds, settings.selectedPipelineNames);
  const configuredReporting = resolvePostSalePipelines(pipelines, settings.postSalePipelineIds, settings.postSalePipelineNames);
  const autoReporting = resolvePostSalePipelines(pipelines, [], allSelected.map((item) => item.name));
  const allReporting = [...new Map(allSelected.flatMap((main) => {
    const paired = pairPostSalePipeline(main, configuredReporting) ?? pairPostSalePipeline(main, autoReporting);
    return paired ? [[paired.id, paired] as const] : [];
  })).values()];
  const scopedMain = allSelected.find((pipeline) => pipeline.id === String(options.pipelineId ?? "")) ?? allSelected[0];
  if (options.pipelineId && scopedMain.id !== String(options.pipelineId)) throw new Error("Tanlangan sales funnel sozlamalarda topilmadi");
  const scopedPostSale = pairPostSalePipeline(scopedMain, allReporting);
  if (!scopedPostSale) throw new Error(`${scopedMain.name} uchun mos Обучение / Сопровождение funnel topilmadi`);
  const selected = [scopedMain]; const reporting = [scopedPostSale];
  let crmFields: CrmFieldOption[] = [];
  try { crmFields = await listCrmFields(selected.map((item) => item.id)); } catch { /* Config remains editable by field code. */ }
  const knownFieldKeys = new Set(crmFields.map((field) => field.key));
  settings = {
    ...settings,
    failureReasonField: settings.failureReasonField && knownFieldKeys.has(settings.failureReasonField)
      ? settings.failureReasonField
      : detectFailureReasonField(crmFields),
    marketingChannelField: settings.marketingChannelField ?? detectField(crmFields, /маркет.*канал|marketing.*kanal|marketing.*channel/),
    salesManagerField: normalizeSafeStableSellerField(settings.salesManagerField)
      ?? normalizeSafeStableSellerField(detectField(
        crmFields.filter((field) => normalizeSafeStableSellerField(field.key)),
        /менеджер.*продаж|sales.*manager|sotuv.*menejer/,
        /employee|user/,
      )),
  };
  const selectedIds = allSelected.map((item) => item.id);
  const scopeState = await getDictionary<{ lastSyncAt: string | null }>(`syncScope:${scopedMain.id}`, { lastSyncAt: null });
  const now = new Date();
  const window = resolveSyncWindow({
    lastSuccessfulSyncAt: scopeState.lastSyncAt,
    now,
    bootstrapDays: Number(options.days ?? settings.historyDays),
    full: options.full,
  });
  const mode = window.mode;
  const from = window.from;
  const fromIso = from.toISOString();
  const runId = crypto.randomUUID();
  const permissions = { deals: "ok", stageHistory: "ok", managers: "ok" };

  await saveSettings({ ...settings, selectedPipelineIds: selectedIds, selectedPipelineNames: allSelected.map((item) => item.name), postSalePipelineIds: allReporting.map((item) => item.id), postSalePipelineNames: allReporting.map((item) => item.name) });
  await saveDictionary("crmFields", crmFields);
  if (mode === "full") await clearPipelineScope([scopedMain.id, scopedPostSale.id]);

  const timestamp = now.toISOString();
  const job: StoredSyncJob = {
    status: "running", phase: "deals", progress: 0, message: `${scopedMain.name} Deal’lari yuklanmoqda…`,
    processed: 0, total: 0, cursor: 0, fromIso, toIso: timestamp, mode, runId,
    selectedPipelines: selected, scopePipelineId: scopedMain.id, reportingPipelines: reporting, dealScope: "main", counts: {}, permissions, safeError: null,
    heartbeatAt: timestamp, updatedAt: timestamp,
  };
  await saveSyncJob(job);
  await saveSyncState({ status: "running", lastFrom: fromIso, counts: {}, permissions, safeError: null });
  return await getSyncState();
}

async function dealStep(job: StoredSyncJob) {
  const settings = await getSettings();
  const salesCategoryIds = job.selectedPipelines.map((item) => item.id);
  const postSaleCategoryIds = job.reportingPipelines.map((item) => item.id);
  const paymentStageIds = [...new Set(settings.paymentStageIds.map(String).filter(Boolean))];
  // Source comes from SOURCE_ID; the legacy marketing-channel field is no longer read.
  const customFields = [...new Set([
    settings.failureReasonField,
    ...Object.values(settings.failureReasonFieldByPipeline ?? {}),
    normalizeSafeStableSellerField(settings.salesManagerField),
  ])]
    .filter((field): field is string => Boolean(field)).map(canonicalDealFieldKey);
  // CLOSED is current-state evidence for reconciliation only. Won/lost
  // classification stays with the canonical stage and stage-history rules;
  // nothing derives salesStatus from this flag.
  const select = ["ID", "TITLE", "DATE_CREATE", "DATE_MODIFY", "CLOSED", "CLOSEDATE", "MOVED_TIME", "MOVED_BY_ID", "ASSIGNED_BY_ID", "CATEGORY_ID", "STAGE_ID", "SOURCE_ID", "CONTACT_ID", "CONTACT_IDS", "COMPANY_ID", "OPPORTUNITY", "CURRENCY_ID", ...customFields];

  if (job.dealScope !== "main") {
    const request = buildPeriodSalesDiscoveryRequest({
      scope: job.dealScope,
      salesCategoryIds,
      postSaleCategoryIds,
      paymentStageIds,
      fromIso: job.fromIso,
      toIso: job.toIso,
      dealSelect: select,
    });
    if (!request) return advanceDealDiscovery(job, paymentStageIds);
    const page = await bitrixPage<Record<string, unknown>>(request.method, request.params, job.cursor);
    const candidateIds = uniqueDiscoveryIds(page.items, request.idField);
    const pendingIds = await idsNotFetchedInRun(job.runId, candidateIds);
    let deals: RawDeal[];
    if (request.kind === "deals") {
      const pending = new Set(pendingIds);
      deals = page.items.filter((deal) => pending.has(value(deal, "ID")));
    } else if (pendingIds.length) {
      const dealPage = await bitrixPage<RawDeal>("crm.deal.list", {
        order: { ID: "ASC" }, filter: { "@ID": pendingIds }, select,
      }, 0);
      deals = dealPage.items;
    } else {
      deals = [];
    }
    deals = await enrichPostSaleObservers(deals, postSaleCategoryIds);
    await upsertRaw("raw_deals", deals.map((deal) => [value(deal, "ID"), value(deal, "CATEGORY_ID") || "0", value(deal, "DATE_CREATE"), JSON.stringify(deal), job.runId]));
    const scopeCount = `${job.dealScope}Deals`;
    const counts = {
      ...job.counts,
      deals: (job.counts.deals ?? 0) + deals.length,
      [scopeCount]: (job.counts[scopeCount] ?? 0) + deals.length,
    };
    if (page.next === null) return advanceDealDiscovery({ ...job, counts }, paymentStageIds);
    const total = page.total ?? Math.max(job.processed + page.items.length, page.next + 50);
    return {
      ...job,
      cursor: page.next,
      processed: job.processed + page.items.length,
      total,
      counts,
      progress: phaseProgress("deals", job.processed + page.items.length, total),
      message: `${counts.deals} ta noyob Deal topildi; davr sotuvlari tekshirilmoqda…`,
    };
  }

  const filter: Record<string, unknown> = { CATEGORY_ID: salesCategoryIds };
  if (job.mode === "full") {
    filter[">=DATE_CREATE"] = job.fromIso;
    filter["<=DATE_CREATE"] = job.toIso;
  } else {
    filter[">=DATE_MODIFY"] = job.fromIso;
    filter["<=DATE_MODIFY"] = job.toIso;
  }
  const page = await bitrixPage<RawDeal>("crm.deal.list", {
    order: { DATE_CREATE: "DESC", ID: "DESC" }, filter,
    select,
  }, job.cursor);
  const deals = await enrichPostSaleObservers(page.items, postSaleCategoryIds);
  // The last bind is the run id, not a timestamp; the column name `synced_at`
    // is historical. See db/schema.ts.
    await upsertRaw("raw_deals", deals.map((deal) => [value(deal, "ID"), value(deal, "CATEGORY_ID") || "0", value(deal, "DATE_CREATE"), JSON.stringify(deal), job.runId]));
  const counts = { ...job.counts, deals: (job.counts.deals ?? 0) + page.items.length };
  if (page.next === null) {
    return advanceDealDiscovery({ ...job, counts }, paymentStageIds);
  }
  const total = page.total ?? Math.max(counts.deals, page.next + 50);
  return { ...job, cursor: page.next, processed: counts.deals, total, counts, progress: phaseProgress("deals", counts.deals, total), message: `${counts.deals} / ${total} ta Deal yuklandi` };
}

async function stageStep(job: StoredSyncJob) {
  const cleanJob = { ...job, stageHistoryRetry: undefined };
  const result = await getD1().prepare(`SELECT deal_id FROM raw_deals WHERE synced_at = ? ORDER BY created_at DESC LIMIT ${stageDealBatchSize} OFFSET ?`).bind(job.runId, job.cursor).all<{ deal_id: string }>();
  const ids = (result.results ?? []).map((row) => String(row.deal_id));
  if (!ids.length) return move(cleanJob, "lookups", "Menejer, pipeline va status nomlari yangilanmoqda…", 1);
  const cmd = Object.fromEntries(ids.map((id) => [`deal_${id}`, query("crm.stagehistory.list", { OWNER_ID: id }, ["ID", "OWNER_ID", "CATEGORY_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "TYPE_ID", "CREATED_TIME"], { ID: "ASC" }).replace("?", "?entityTypeId=2&")]));
  const response = await bitrixCall<Record<string, unknown>>("batch", { halt: 0, cmd });
  const commandFailure = stageHistoryBatchFailure(response as unknown as Record<string, unknown>);
  if (commandFailure) throw new SafeBitrixError(commandFailure.code, commandFailure.message, commandFailure.statusClass);
  const rows: StageHistoryPersistenceRow[] = [];
  for (const id of ids) for (const history of batchItems(response as unknown as Record<string, unknown>, `deal_${id}`)) {
    const createdAt = value(history, "CREATED_TIME");
    history.OWNER_ID = id;
    rows.push({
      rowKey: stageHistoryRowKey(id, value(history, "ID"), value(history, "STAGE_ID"), createdAt),
      dealId: id,
      createdAt,
      payload: JSON.stringify(history),
      syncedAt: job.runId,
    });
  }
  await persistStageHistoryRows(getD1(), ids, rows);
  const cursor = job.cursor + ids.length;
  const counts = { ...job.counts, stageHistory: (job.counts.stageHistory ?? 0) + rows.length };
  return { ...cleanJob, cursor, processed: cursor, total: job.counts.deals, counts, progress: phaseProgress("stageHistory", cursor, job.counts.deals), message: `${Math.min(cursor, job.counts.deals)} / ${job.counts.deals} ta Deal stage history’si tekshirildi` };
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
  return move({ ...job, permissions }, "analytics", "Dashboard ko‘rsatkichlari kichik paketlarda hisoblanmoqda…", job.counts.deals);
}

async function analyticsStep(job: StoredSyncJob) {
  const dealResult = await getD1().prepare(analyticsPageSql(analyticsDealBatchSize)).bind(job.runId, job.cursor).all<{ deal_id: string; payload: string }>();
  const rawDeals = dealResult.results ?? [];
  if (!rawDeals.length) {
    const completedAt = new Date().toISOString();
    const finished: StoredSyncJob = { ...job, status: "success", phase: "done", progress: 100, processed: job.counts.deals ?? 0, total: job.counts.deals ?? 0, cursor: 0, message: "Sinxronizatsiya yakunlandi", safeError: null };
    await saveSyncJob(finished);
    // The checkpoint is the watermark this run actually queried (`toIso`), not
    // the moment it finished. A long run would otherwise skip everything
    // modified while it was still working.
    await saveDictionary(`syncScope:${job.scopePipelineId}`, { lastSyncAt: job.toIso, pipelineName: job.selectedPipelines[0]?.name ?? "" });
    await saveSyncState({ status: "success", lastSyncAt: completedAt, lastFrom: job.fromIso, counts: job.counts, permissions: job.permissions, safeError: null });
    // The single completion point for every sync path — the UI's step loop and
    // the scheduled handler both land here — so reconciliation applies
    // identically to manual and cron runs. It never throws and never downgrades
    // this successful result; its own state records any problem.
    await runPostSyncReconciliation(await getSettings());
    return finished;
  }
  const candidateIds = rawDeals.map((row) => row.deal_id);
  const candidatePlaceholders = candidateIds.map(() => "?").join(", ");
  const historyResult = await getD1().prepare(`SELECT deal_id, payload FROM raw_stage_history WHERE deal_id IN (${candidatePlaceholders})`).bind(...candidateIds).all<{ deal_id: string; payload: string }>();
  const candidateHistories = historyResult.results ?? [];
  const runtime = planAnalyticsBatch({
    cursor: job.cursor,
    rawDeals,
    stageHistories: candidateHistories,
    previous: job.analyticsRuntime,
  });
  // Persist the attempt before CPU-heavy parsing/calculation/writes. Cloudflare
  // 1102 cannot be caught inside this invocation; if it terminates us, the next
  // request sees this exact cursor/attempt and deterministically halves it.
  await saveSyncJob({ ...job, analyticsRuntime: runtime });
  const batchDeals = rawDeals.slice(0, runtime.batchSize);
  const ids = batchDeals.map((row) => row.deal_id);
  const selectedIds = new Set(ids);
  const selectedHistories = candidateHistories.filter((row) => selectedIds.has(row.deal_id));
  const userRows = await getDictionary<Record<string, unknown>[]>("users", []);
  const statusRows = await getDictionary<Record<string, unknown>[]>("statuses", []);
  const users = buildUserMap(userRows);
  const pipelines = new Map([...job.selectedPipelines, ...job.reportingPipelines].map((item) => [item.id, item.name]));
  const { stages, sources, stageMeta } = buildStatusMaps(statusRows);
  const settings = await getSettings();
  const crmFields = await getDictionary<CrmFieldOption[]>("crmFields", []);
  const fieldOptions = buildFieldOptionMap(crmFields);
  const snapshots = await getSalesSnapshots(ids);
  const records = buildAnalyticsRecords({
    deals: parseRows<RawDeal>(batchDeals), stageHistories: parseRows<RawStageHistory>(selectedHistories),
    settings, users, pipelines, stages, sources, stageMeta, fieldOptions, snapshots, domain: getBitrixDomain(),
    stageHistoryAvailable: job.permissions.stageHistory === "ok",
  });
  await upsertAnalyticsRecords(records);
  await saveSalesSnapshots(records);
  const cursor = job.cursor + batchDeals.length;
  const counts = {
    ...job.counts,
    noProcessing: (job.counts.noProcessing ?? 0) + records.filter((row) => row.processingSource === "NO_PROCESSING").length,
  };
  return {
    ...job,
    cursor,
    processed: cursor,
    total: job.counts.deals,
    counts,
    analyticsRuntime: { ...runtime, state: "completed" as const },
    progress: phaseProgress("analytics", cursor, job.counts.deals),
    message: `${Math.min(cursor, job.counts.deals)} / ${job.counts.deals} ta Deal ko‘rsatkichi hisoblandi`,
  };
}

export async function runSyncStep() {
  const job = await getSyncJob();
  if (!job) throw new Error("Boshlanmagan sync topilmadi");
  if (job.status === "paused" || job.status === "success") return await getSyncState();
  if (job.status === "error") throw new Error(job.safeError ?? "Sync xatolikda to‘xtagan");
  try {
    let next: StoredSyncJob;
    if (job.phase === "deals") next = await dealStep(job);
    else if (job.phase === "stageHistory") {
      const retryAt = job.stageHistoryRetry?.cursor === job.cursor
        ? Date.parse(job.stageHistoryRetry.nextAttemptAt)
        : Number.NaN;
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        next = {
          ...job,
          message: `Stage history vaqtinchalik xatodan keyin qayta urinadi (${job.stageHistoryRetry?.retryCount ?? 0}/${STAGE_HISTORY_MAX_RETRIES})…`,
        };
      } else try {
        next = await stageStep(job);
      } catch (error) {
        const decision = decideStageHistoryFailure({
          error,
          cursor: job.cursor,
          previousRetry: job.stageHistoryRetry,
          previousDiagnostics: job.stageHistoryDiagnostics,
        });
        if (decision.action === "RETRY") {
          next = {
            ...job,
            stageHistoryRetry: decision.retry,
            stageHistoryDiagnostics: decision.diagnostics,
            message: `Stage history vaqtinchalik xato; shu paket qayta urinadi (${decision.retry.retryCount}/${STAGE_HISTORY_MAX_RETRIES})…`,
          };
        } else if (decision.action === "DEGRADE_PERMISSION") {
          next = move({
            ...job,
            stageHistoryRetry: undefined,
            stageHistoryDiagnostics: decision.diagnostics,
            permissions: { ...job.permissions, stageHistory: "error" },
          }, "lookups", "Stage history uchun ruxsat yo‘q; nomlar yangilanmoqda…", job.total);
        } else {
          const failed: StoredSyncJob = {
            ...job,
            status: "error",
            stageHistoryRetry: undefined,
            stageHistoryDiagnostics: decision.diagnostics,
            safeError: decision.safeError,
            message: "Stage history vaqtinchalik xatolari tugamadi; sync xavfsiz to‘xtadi",
          };
          await saveSyncJob(failed);
          await saveSyncState({ status: "error", safeError: decision.safeError, permissions: job.permissions });
          return await getSyncState();
        }
      }
    } else if (job.phase === "lookups") next = await lookupStep(job);
    else if (job.phase === "analytics") next = await analyticsStep(job);
    else next = job;
    if (next.status === "running") await saveSyncJob(next);
    return await getSyncState();
  } catch (error) {
    const quotaError = safeD1WriteQuotaError(error);
    if (quotaError) throw quotaError;
    const safe = safeBitrixMessage(error);
    const message = safe === "Kutilmagan xavfsiz server xatosi" && error instanceof Error ? error.message.slice(0, 240) : safe;
    await saveSyncJob({ ...job, status: "error", safeError: message, message: "Sync xatolik sabab to‘xtadi" });
    await saveSyncState({ status: "error", safeError: message, permissions: job.permissions });
    throw error;
  }
}

export async function runSyncSteps(maxSteps = 4) {
  let state = await getSyncState();
  const safeSteps = Math.min(6, Math.max(1, Math.floor(maxSteps)));
  for (let index = 0; index < safeSteps && state.status === "running"; index += 1) state = await runSyncStep();
  return state;
}

export async function pauseSync() {
  const job = await getSyncJob();
  if (job?.status === "running") await saveSyncJob({ ...job, status: "paused", message: "Sinxronizatsiya pauzada" });
  return await getSyncState();
}

export async function resumeSync() {
  const job = await getSyncJob();
  if (!job) throw new Error("Davom ettiriladigan sync topilmadi");
  if (job.selectedPipelines.length > 1) throw new Error("Eski combined sync davom ettirilmaydi. Bitta funnel tanlab yangi sync boshlang.");
  if (job.status === "success") return await getSyncState();
  await saveSyncJob({ ...job, status: "running", safeError: null, message: `${job.message.replace(/\s*\(.*\)$/, "")} (davom etmoqda)` });
  return await getSyncState();
}

export async function runSync(options: { days?: number; full?: boolean; pipelineId?: string } = {}) {
  return await startSync(options);
}
