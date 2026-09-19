#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TIMEZONE = "Asia/Tashkent";
export const TRANSFER_OUT_REASONS = Object.freeze([
  "передано Idokon (Not relevant)",
  "передано SD (Not relevant)",
]);
export const TRANSFER_TERMINAL_STAGE_NAMES = Object.freeze([
  "Сделка провалена",
  "Not relevant",
]);

const READ_ONLY_METHODS = new Set([
  "crm.stagehistory.list",
  "crm.deal.get",
  "crm.deal.fields",
  "crm.status.list",
]);
const DEFINITIVE_NOT_FOUND_CODES = new Set(["NOT_FOUND", "ERROR_NOT_FOUND"]);
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
export const TRANSIENT_ERROR_CODES = Object.freeze([
  "QUERY_LIMIT_EXCEEDED",
  "OPERATION_TIME_LIMIT",
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "HTTP_429",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
]);
export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000]);
const MAX_HISTORY_PAGES = 10_000;
const DEAL_LOOKUP_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 25_000;
const TASHKENT_OFFSET = "+05:00";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AUDIT_DIR = path.resolve(scriptDir, "../.audit/ibox-lead-evidence");

export class EvidenceError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "EvidenceError";
    this.code = String(code || "UNKNOWN").toUpperCase();
    this.retryExhausted = Boolean(details.retryExhausted);
    this.attempts = Number(details.attempts ?? 1);
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizedRetryOptions(options = {}) {
  const delaysMs = Array.isArray(options.delaysMs) ? options.delaysMs : DEFAULT_RETRY_DELAYS_MS;
  if (delaysMs.length > 10 || delaysMs.some((value) => !Number.isFinite(value) || value < 0 || value > 60_000)) {
    throw new EvidenceError("INVALID_RETRY_POLICY");
  }
  return {
    delaysMs: delaysMs.map(Number),
    sleep: typeof options.sleep === "function" ? options.sleep : defaultSleep,
  };
}

function errorCode(error) {
  return String(error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN").toUpperCase();
}

export function isTransientErrorCode(code) {
  return TRANSIENT_ERROR_CODES.includes(String(code || "").toUpperCase());
}

export async function callWithTransientRetry(call, method, params, options = {}) {
  const retry = normalizedRetryOptions(options);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call(method, params);
    } catch (error) {
      const code = errorCode(error);
      if (!isTransientErrorCode(code)) throw error;
      if (attempt >= retry.delaysMs.length) {
        throw new EvidenceError(code, code, { retryExhausted: true, attempts: attempt + 1 });
      }
      await retry.sleep(retry.delaysMs[attempt], { method, code, attempt: attempt + 1 });
    }
  }
}

function scalar(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeStageName(value) {
  return scalar(value).toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}

function compareDealIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  }
  return a.localeCompare(b);
}

function validDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

function nextDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

export function tashkentDateBounds(from, to) {
  if (!validDateKey(from) || !validDateKey(to)) {
    throw new EvidenceError("INVALID_DATE", "--from and --to must be real YYYY-MM-DD calendar dates");
  }
  if (from > to) throw new EvidenceError("INVALID_DATE_RANGE", "--from must not be after --to");
  const fromMs = Date.parse(`${from}T00:00:00${TASHKENT_OFFSET}`);
  const toExclusiveMs = Date.parse(`${nextDateKey(to)}T00:00:00${TASHKENT_OFFSET}`);
  return {
    from,
    to,
    timezone: TIMEZONE,
    fromMs,
    toExclusiveMs,
    fromInclusive: new Date(fromMs).toISOString(),
    toExclusive: new Date(toExclusiveMs).toISOString(),
  };
}

export function parseCliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!["--category-id", "--from", "--to", "--failure-reason-field"].includes(token)) {
      throw new EvidenceError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new EvidenceError("INVALID_ARGUMENT", `${token} requires a value`);
    values[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  if (!/^\d+$/.test(values.categoryId ?? "")) {
    throw new EvidenceError("INVALID_CATEGORY", "--category-id is required and must be numeric");
  }
  if (!/^[A-Za-z0-9_]+$/.test(values.failureReasonField ?? "")) {
    throw new EvidenceError("INVALID_FAILURE_REASON_FIELD", "--failure-reason-field is required and must be a Bitrix field key");
  }
  const bounds = tashkentDateBounds(values.from, values.to);
  return {
    help: false,
    categoryId: values.categoryId,
    failureReasonField: values.failureReasonField,
    from: bounds.from,
    to: bounds.to,
  };
}

function unwrapList(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.items)) return result.items;
  return [];
}

async function exhaustiveList(call, method, params, options = {}) {
  const rows = [];
  const visited = new Set();
  let declaredTotal = null;
  let start = 0;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    if (visited.has(start)) throw new EvidenceError("PAGINATION_LOOP", `${method} repeated cursor ${start}`);
    visited.add(start);
    const request = { ...params, start };
    const response = options.retryTransient
      ? await callWithTransientRetry(call, method, request, options.retryOptions)
      : await call(method, request);
    const items = unwrapList(response?.result);
    const responseTotal = Number(response?.total);
    if (Number.isSafeInteger(responseTotal) && responseTotal >= 0) declaredTotal = responseTotal;
    rows.push(...items);
    if (response?.next === undefined || response?.next === null) {
      if (declaredTotal !== null && rows.length < declaredTotal) {
        throw new EvidenceError("INCOMPLETE_PAGINATION", `${method} ended before its declared total`);
      }
      return rows;
    }
    if (!items.length) throw new EvidenceError("INCOMPLETE_PAGINATION", `${method} returned an empty page with a next cursor`);
    const next = Number(response.next);
    if (!Number.isSafeInteger(next) || next < 0) throw new EvidenceError("INVALID_PAGINATION", `${method} returned an invalid cursor`);
    start = next;
  }
  throw new EvidenceError("PAGE_LIMIT_EXCEEDED", `${method} exceeded the ${MAX_HISTORY_PAGES}-page safety limit`);
}

function historyTimestamp(row) {
  const parsed = Date.parse(scalar(row.CREATED_TIME));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function sortHistory(rows) {
  return [...rows].sort((left, right) => historyTimestamp(left) - historyTimestamp(right)
    || compareDealIds(scalar(left.ID), scalar(right.ID)));
}

export async function discoverIboxDealIds(call, categoryId, retryOptions = {}) {
  const query = {
    entityTypeId: 2,
    order: { ID: "ASC" },
    filter: { CATEGORY_ID: String(categoryId) },
    select: ["ID", "OWNER_ID", "CATEGORY_ID", "STAGE_ID", "TYPE_ID", "CREATED_TIME"],
  };
  const rows = await exhaustiveList(call, "crm.stagehistory.list", query, { retryTransient: true, retryOptions });
  const histories = new Map();
  for (const row of rows) {
    const dealId = scalar(row.OWNER_ID);
    if (!dealId
      || scalar(row.CATEGORY_ID) !== String(categoryId)
      || !scalar(row.STAGE_ID)
      || !Number.isFinite(Date.parse(scalar(row.CREATED_TIME)))) {
      throw new EvidenceError("INVALID_HISTORY_ROW", "Bitrix returned incomplete category-entry evidence");
    }
    histories.set(dealId, [...(histories.get(dealId) ?? []), row]);
  }
  for (const [dealId, dealRows] of histories) histories.set(dealId, sortHistory(dealRows));
  const dealIds = [...histories.keys()].sort(compareDealIds);
  return { dealIds, histories, historyRowCount: rows.length, query };
}

export async function loadStageCatalog(call, categoryId) {
  const entityId = String(categoryId) === "0" ? "DEAL_STAGE" : `DEAL_STAGE_${categoryId}`;
  const rows = await exhaustiveList(call, "crm.status.list", {
    order: { SORT: "ASC" },
    filter: { ENTITY_ID: entityId },
  });
  const byId = new Map();
  for (const row of rows) {
    const id = scalar(row.STATUS_ID || row.ID);
    if (id) byId.set(id, scalar(row.NAME) || id);
  }
  return { entityId, byId };
}

function optionRows(metadata) {
  if (!metadata || typeof metadata !== "object") return [];
  if (Array.isArray(metadata.items)) return metadata.items;
  if (Array.isArray(metadata.LIST)) return metadata.LIST;
  return [];
}

export async function loadFailureReasonOptions(call, fieldKey) {
  const response = await call("crm.deal.fields", {});
  const fields = response?.result && typeof response.result === "object" ? response.result : {};
  const actualKey = Object.keys(fields).find((key) => key.toUpperCase() === fieldKey.toUpperCase());
  const metadata = actualKey ? fields[actualKey] : null;
  const byId = new Map();
  for (const row of optionRows(metadata)) {
    const id = scalar(row.ID ?? row.id);
    const label = scalar(row.VALUE ?? row.value ?? row.NAME ?? row.name);
    if (id && label) byId.set(id, label);
  }
  return { fieldFound: Boolean(actualKey), byId };
}

function fieldScalars(raw) {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw)) return raw.flatMap(fieldScalars);
  if (typeof raw === "object") {
    const object = raw;
    const candidate = object.VALUE ?? object.value ?? object.ID ?? object.id;
    return candidate === undefined ? [""] : fieldScalars(candidate);
  }
  return [scalar(raw)];
}

export function resolveFailureReasons(raw, options) {
  const labels = [];
  const unresolvedValues = [];
  for (const value of fieldScalars(raw)) {
    if (!value) {
      unresolvedValues.push("UNSUPPORTED_VALUE");
      continue;
    }
    if (options.byId.has(value)) {
      labels.push(options.byId.get(value));
      continue;
    }
    if (/^\d+$/.test(value)) {
      unresolvedValues.push("UNMAPPED_ENUM_ID");
      continue;
    }
    labels.push(value);
  }
  return { labels, unresolvedValues };
}

function dealField(deal, fieldKey) {
  const actualKey = Object.keys(deal).find((key) => key.toUpperCase() === fieldKey.toUpperCase());
  return actualKey ? { present: true, value: deal[actualKey] } : { present: false, value: undefined };
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function lookupFailure(code) {
  const normalized = scalar(code || "UNKNOWN").toUpperCase();
  return DEFINITIVE_NOT_FOUND_CODES.has(normalized)
    ? { kind: "DELETED", code: normalized }
    : { kind: "UNRESOLVED", code: normalized };
}

export async function fetchCurrentDeals(call, dealIds, retryOptions = {}) {
  const entries = await mapWithConcurrency(dealIds, DEAL_LOOKUP_CONCURRENCY, async (dealId) => {
    try {
      const response = await callWithTransientRetry(call, "crm.deal.get", { id: dealId }, retryOptions);
      const deal = response?.result;
      if (!deal || typeof deal !== "object" || !scalar(deal.ID)) {
        return [dealId, { kind: "UNRESOLVED", code: "EMPTY_RESULT" }];
      }
      return [dealId, { kind: "FOUND", deal }];
    } catch (error) {
      const lookup = lookupFailure(errorCode(error));
      if (lookup.kind === "UNRESOLVED" && error instanceof EvidenceError) {
        lookup.retryExhausted = error.retryExhausted;
        lookup.attempts = error.attempts;
      }
      return [dealId, lookup];
    }
  });
  return new Map(entries);
}

function latestTransferEventIndex(history, stageNames) {
  const transferNames = new Set(TRANSFER_TERMINAL_STAGE_NAMES.map(normalizeStageName));
  let found = -1;
  for (let index = 0; index < history.length; index += 1) {
    const stageName = stageNames.get(scalar(history[index].STAGE_ID));
    if (stageName && transferNames.has(normalizeStageName(stageName))) found = index;
  }
  return found;
}

function classification(classificationName, dealId, reason, details = {}) {
  return { classification: classificationName, dealId: String(dealId), reason, ...details };
}

export function classifyDealEvidence({
  dealId,
  lookup,
  history,
  categoryId,
  failureReasonField,
  failureReasonOptions,
  stageNames,
  bounds,
}) {
  if (!lookup || lookup.kind === "UNRESOLVED") {
    return classification("UNRESOLVED", dealId, `LOOKUP_${lookup?.code ?? "MISSING"}`, {
      errorCode: lookup?.code ?? "MISSING",
      ...(lookup?.retryExhausted ? { retryExhausted: true, attempts: lookup.attempts } : {}),
    });
  }
  if (lookup.kind === "DELETED") {
    return classification("EXCLUDED", dealId, "DELETED_NOT_FOUND");
  }

  const deal = lookup.deal;
  const createdAtRaw = scalar(deal.DATE_CREATE);
  const createdAtMs = Date.parse(createdAtRaw);
  if (!createdAtRaw || !Number.isFinite(createdAtMs)) {
    return classification("UNRESOLVED", dealId, "DATE_CREATE_MISSING_OR_INVALID");
  }
  const createdAt = new Date(createdAtMs).toISOString();
  if (createdAtMs < bounds.fromMs) {
    return classification("EXCLUDED", dealId, "DATE_BEFORE_RANGE", { createdAt });
  }
  if (createdAtMs >= bounds.toExclusiveMs) {
    return classification("EXCLUDED", dealId, "DATE_AFTER_RANGE", { createdAt });
  }

  if (!failureReasonOptions.fieldFound) {
    return classification("UNRESOLVED", dealId, "FAILURE_REASON_FIELD_NOT_FOUND", { createdAt });
  }
  const failureField = dealField(deal, failureReasonField);
  if (!failureField.present) {
    return classification("UNRESOLVED", dealId, "FAILURE_REASON_FIELD_MISSING", { createdAt });
  }
  const failure = resolveFailureReasons(failureField.value, failureReasonOptions);
  if (failure.unresolvedValues.length) {
    return classification("UNRESOLVED", dealId, "FAILURE_REASON_UNRESOLVED", { createdAt });
  }
  const transferReason = failure.labels.find((label) => TRANSFER_OUT_REASONS.includes(label));
  if (!transferReason) {
    return classification("INCLUDED", dealId, "IBOX_STAGE_ENTRY", { createdAt });
  }

  const transferIndex = latestTransferEventIndex(history, stageNames);
  if (transferIndex < 0) {
    return classification("UNRESOLVED", dealId, "TRANSFER_EVENT_NOT_LOCATED", { createdAt });
  }
  if (history.slice(transferIndex + 1).some((row) => scalar(row.CATEGORY_ID) === String(categoryId))) {
    return classification("INCLUDED", dealId, "RETURNED_TO_IBOX_AFTER_TRANSFER", { createdAt });
  }
  return classification("EXCLUDED", dealId, "TRANSFERRED_OUT_NO_RETURN", { createdAt, transferReason });
}

function safeConfig(config, bounds, discovery, stageCatalog, retryOptions) {
  const retry = normalizedRetryOptions(retryOptions);
  return {
    categoryId: String(config.categoryId),
    failureReasonField: config.failureReasonField,
    dateBasis: "DATE_CREATE",
    timezone: TIMEZONE,
    fromDateInclusive: bounds.from,
    toDateInclusive: bounds.to,
    fromInstantInclusive: bounds.fromInclusive,
    toInstantExclusive: bounds.toExclusive,
    transferOutReasons: [...TRANSFER_OUT_REASONS],
    transferTerminalStageNames: [...TRANSFER_TERMINAL_STAGE_NAMES],
    historyQuery: {
      method: "crm.stagehistory.list",
      entityTypeId: discovery.query.entityTypeId,
      order: discovery.query.order,
      filter: discovery.query.filter,
      select: discovery.query.select,
      pagination: "exhaustive",
    },
    dealLookup: { method: "crm.deal.get", oneRequestPerDiscoveredDeal: true },
    failureReasonDictionary: { method: "crm.deal.fields" },
    stageDictionary: { method: "crm.status.list", entityId: stageCatalog.entityId },
    retryPolicy: {
      methods: ["crm.stagehistory.list", "crm.deal.get"],
      transientCodes: [...TRANSIENT_ERROR_CODES],
      backoffMs: retry.delaysMs,
      maximumAttempts: retry.delaysMs.length + 1,
    },
  };
}

function unresolvedCountKey(row) {
  const code = row.errorCode || row.reason;
  return row.retryExhausted ? `${code} after retries` : code;
}

export function countUnresolvedByCode(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = unresolvedCountKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

export async function extractIboxLeadEvidence({ call, config, now = () => new Date(), retryOptions = {} }) {
  const bounds = tashkentDateBounds(config.from, config.to);
  const snapshotStartedAt = now().toISOString();
  const discovery = await discoverIboxDealIds(call, config.categoryId, retryOptions);
  const [stageCatalog, failureReasonOptions, currentDeals] = await Promise.all([
    loadStageCatalog(call, config.categoryId),
    loadFailureReasonOptions(call, config.failureReasonField),
    fetchCurrentDeals(call, discovery.dealIds, retryOptions),
  ]);

  const classified = discovery.dealIds.map((dealId) => classifyDealEvidence({
    dealId,
    lookup: currentDeals.get(dealId),
    history: discovery.histories.get(dealId) ?? [],
    categoryId: config.categoryId,
    failureReasonField: config.failureReasonField,
    failureReasonOptions,
    stageNames: stageCatalog.byId,
    bounds,
  }));
  const includedIds = classified.filter((row) => row.classification === "INCLUDED").map((row) => row.dealId);
  const excluded = classified.filter((row) => row.classification === "EXCLUDED")
    .map((row) => {
      const evidence = { ...row };
      delete evidence.classification;
      return evidence;
    });
  const unresolved = classified.filter((row) => row.classification === "UNRESOLVED")
    .map((row) => {
      const evidence = { ...row };
      delete evidence.classification;
      return evidence;
    });
  const snapshotCompletedAt = now().toISOString();

  return {
    schemaVersion: 1,
    result: unresolved.length ? "COMPLETE_WITH_UNRESOLVED" : "COMPLETE",
    snapshot: { startedAt: snapshotStartedAt, completedAt: snapshotCompletedAt },
    config: safeConfig(config, bounds, discovery, stageCatalog, retryOptions),
    counts: {
      discovered: discovery.dealIds.length,
      historyRows: discovery.historyRowCount,
      included: includedIds.length,
      excluded: excluded.length,
      unresolved: unresolved.length,
      unresolvedByCode: countUnresolvedByCode(unresolved),
    },
    discoveredIds: discovery.dealIds,
    includedIds,
    excluded,
    unresolved,
  };
}

function linesForRows(rows) {
  return rows.length ? rows.map((row) => `- ${row.dealId}: ${row.reason}`).join("\n") : "- none";
}

function unresolvedCountLines(report) {
  const grouped = report.counts.unresolvedByCode ?? countUnresolvedByCode(report.unresolved ?? []);
  const entries = Object.entries(grouped);
  return entries.length ? entries.map(([code, count]) => `- ${code}: ${count}`).join("\n") : "- none";
}

export function renderHumanSummary(report) {
  return [
    "IBOX Lead evidence summary",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `Date filter: DATE_CREATE ${report.config.fromDateInclusive} — ${report.config.toDateInclusive} inclusive (${report.config.timezone})`,
    `IBOX category ID: ${report.config.categoryId}`,
    `Failure-reason field: ${report.config.failureReasonField}`,
    `Discovered IDs: ${report.counts.discovered}`,
    `History rows: ${report.counts.historyRows}`,
    `Included: ${report.counts.included}`,
    `Excluded: ${report.counts.excluded}`,
    `Unresolved: ${report.counts.unresolved}`,
    "",
    "INCLUDED",
    report.includedIds.length ? report.includedIds.map((id) => `- ${id}`).join("\n") : "- none",
    "",
    "EXCLUDED",
    linesForRows(report.excluded),
    "",
    "UNRESOLVED",
    unresolvedCountLines(report),
    "",
    "UNRESOLVED DEALS",
    linesForRows(report.unresolved),
    "",
  ].join("\n");
}

export async function writeAuditOutput(report, auditDir = DEFAULT_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const basename = `${stamp}_category-${report.config.categoryId}_${report.config.fromDateInclusive}_${report.config.toDateInclusive}`;
  const jsonPath = path.join(auditDir, `${basename}.json`);
  const summaryPath = path.join(auditDir, `${basename}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderHumanSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export function createBitrixClient(webhookValue, fetchImpl = globalThis.fetch) {
  let webhook;
  try {
    webhook = new URL(scalar(webhookValue).endsWith("/") ? scalar(webhookValue) : `${scalar(webhookValue)}/`);
  } catch {
    throw new EvidenceError("NOT_CONFIGURED", "BITRIX24_WEBHOOK_URL is missing or invalid");
  }
  if (webhook.protocol !== "https:" || !/\/rest\/[^/]+\/[^/]+\//.test(webhook.pathname)) {
    throw new EvidenceError("NOT_CONFIGURED", "BITRIX24_WEBHOOK_URL is missing or invalid");
  }
  if (typeof fetchImpl !== "function") throw new EvidenceError("FETCH_UNAVAILABLE");

  return async function call(method, params = {}) {
    if (!READ_ONLY_METHODS.has(method)) throw new EvidenceError("METHOD_NOT_ALLOWED", "Only allowlisted read methods may be called");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(new URL(method, webhook), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch {
      throw new EvidenceError(controller.signal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new EvidenceError(TRANSIENT_HTTP_STATUSES.has(response.status) ? `HTTP_${response.status}` : "INVALID_RESPONSE");
    }
    if (!response.ok || payload?.error) {
      const code = TRANSIENT_HTTP_STATUSES.has(response.status)
        ? `HTTP_${response.status}`
        : payload?.error || `HTTP_${response.status}`;
      throw new EvidenceError(code);
    }
    return payload;
  };
}

export function usage() {
  return [
    "Read-only IBOX Lead evidence extractor",
    "",
    "Usage:",
    "  npm run audit:ibox-leads -- --category-id <IBOX_CATEGORY_ID> --failure-reason-field <UF_CRM_FIELD> --from YYYY-MM-DD --to YYYY-MM-DD",
    "",
    `Output: ${path.relative(path.resolve(scriptDir, ".."), DEFAULT_AUDIT_DIR)}/ (git-ignored)`,
  ].join("\n");
}

export async function runCli(argv, environment = process.env) {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await extractIboxLeadEvidence({ call, config });
  const files = await writeAuditOutput(report);
  process.stdout.write(renderHumanSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`IBOX Lead evidence extraction failed (${code}).\n`);
    process.exitCode = 1;
  });
}
