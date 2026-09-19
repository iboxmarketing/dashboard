import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TRANSFER_OUT_REASONS,
  EvidenceError,
  callWithTransientRetry,
  classifyDealEvidence,
  countUnresolvedByCode,
  createBitrixClient,
  discoverIboxDealIds,
  extractIboxLeadEvidence,
  fetchCurrentDeals,
  parseCliArgs,
  renderHumanSummary,
  tashkentDateBounds,
  writeAuditOutput,
} from "../scripts/ibox-lead-evidence.mjs";

const categoryId = "17";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const bounds = tashkentDateBounds("2026-08-01", "2026-08-31");
const stageNames = new Map([
  ["NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"],
  ["FAIL", "Сделка провалена"],
  ["NR", "Not relevant"],
  ["PROCESS", "ОБРАБОТКА"],
  ["PAID", "Оплата получена"],
]);
const reasonOptions = { fieldFound: true, byId: new Map([
  ["101", TRANSFER_OUT_REASONS[0]],
  ["102", TRANSFER_OUT_REASONS[1]],
  ["103", "Other reason"],
]) };

function event(dealId, stageId, at, id = `${dealId}-${stageId}-${at}`) {
  return { ID: id, OWNER_ID: dealId, CATEGORY_ID: categoryId, STAGE_ID: stageId, TYPE_ID: "2", CREATED_TIME: at };
}

function foundDeal(id, overrides = {}) {
  return {
    kind: "FOUND",
    deal: {
      ID: id,
      DATE_CREATE: "2026-08-15T12:00:00+05:00",
      CATEGORY_ID: categoryId,
      STAGE_ID: "NEW",
      [failureReasonField]: "",
      ...overrides,
    },
  };
}

function classify(id, lookup, history, overrides = {}) {
  return classifyDealEvidence({
    dealId: id,
    lookup,
    history,
    categoryId,
    failureReasonField,
    failureReasonOptions: reasonOptions,
    stageNames,
    bounds,
    ...overrides,
  });
}

test("stage-history discovery exhausts pagination beyond 50 rows and deduplicates Deal IDs", async () => {
  const rows = Array.from({ length: 60 }, (_, index) => event(String(index + 1), "NEW", `2026-08-01T10:${String(index % 60).padStart(2, "0")}:00+05:00`, String(index + 1)));
  rows.push(event("1", "PROCESS", "2026-08-02T10:00:00+05:00", "61"));
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (params.start === 0) return { result: rows.slice(0, 50), next: 50, total: rows.length };
    if (params.start === 50) return { result: rows.slice(50), total: rows.length };
    throw new Error("unexpected cursor");
  };

  const result = await discoverIboxDealIds(call, categoryId);

  assert.equal(result.historyRowCount, 61);
  assert.equal(result.dealIds.length, 60);
  assert.deepEqual(result.histories.get("1").map((row) => row.STAGE_ID), ["NEW", "PROCESS"]);
  assert.deepEqual(calls.map((item) => item.params.start), [0, 50]);
  for (const request of calls) {
    assert.equal(request.method, "crm.stagehistory.list");
    assert.deepEqual(request.params.filter, { CATEGORY_ID: categoryId });
    assert.equal(Object.hasOwn(request.params.filter, "OWNER_ID"), false);
  }
});

test("stage-history discovery refuses a response that ends before its declared total", async () => {
  const call = async () => ({ result: [event("1", "NEW", "2026-08-01T10:00:00+05:00")], total: 2 });
  await assert.rejects(() => discoverIboxDealIds(call, categoryId), (error) => {
    assert.equal(error.code, "INCOMPLETE_PAGINATION");
    return true;
  });
});

test("transient Deal lookup failure retries with injected backoff and then succeeds", async () => {
  let attempts = 0;
  const sleeps = [];
  const call = async () => {
    attempts += 1;
    if (attempts === 1) throw new EvidenceError("QUERY_LIMIT_EXCEEDED");
    return { result: foundDeal("10").deal };
  };
  const result = await fetchCurrentDeals(call, ["10"], {
    delaysMs: [25, 50],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [25]);
  assert.equal(result.get("10").kind, "FOUND");
});

test("transient Deal lookup stops at the bounded retry limit", async () => {
  let attempts = 0;
  const sleeps = [];
  const call = async () => {
    attempts += 1;
    throw new EvidenceError("HTTP_503");
  };
  const result = await fetchCurrentDeals(call, ["11"], {
    delaysMs: [10, 20],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.deepEqual(result.get("11"), {
    kind: "UNRESOLVED", code: "HTTP_503", retryExhausted: true, attempts: 3,
  });
});

test("non-transient Deal lookup errors are never retried", async () => {
  let attempts = 0;
  const sleeps = [];
  const call = async () => {
    attempts += 1;
    throw new EvidenceError("ACCESS_DENIED");
  };
  const result = await fetchCurrentDeals(call, ["12"], {
    delaysMs: [10, 20],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(result.get("12"), {
    kind: "UNRESOLVED", code: "ACCESS_DENIED", retryExhausted: false, attempts: 1,
  });
});

test("history pagination retries the failed cursor and resumes without restarting", async () => {
  const starts = [];
  const sleeps = [];
  let cursor50Attempts = 0;
  const call = async (_method, params) => {
    starts.push(params.start);
    if (params.start === 0) {
      return { result: [event("20", "NEW", "2026-08-01T10:00:00+05:00", "1")], next: 50, total: 2 };
    }
    cursor50Attempts += 1;
    if (cursor50Attempts === 1) throw new EvidenceError("HTTP_502");
    return { result: [event("21", "NEW", "2026-08-01T10:01:00+05:00", "2")], total: 2 };
  };
  const result = await discoverIboxDealIds(call, categoryId, {
    delaysMs: [100],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.deepEqual(starts, [0, 50, 50]);
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(result.dealIds, ["20", "21"]);
});

test("standalone retry helper does not retry definitive NOT_FOUND", async () => {
  let attempts = 0;
  await assert.rejects(() => callWithTransientRetry(async () => {
    attempts += 1;
    throw new EvidenceError("NOT_FOUND");
  }, "crm.deal.get", { id: "13" }, {
    delaysMs: [0, 0], sleep: async () => {},
  }), (error) => {
    assert.equal(error.code, "NOT_FOUND");
    return true;
  });
  assert.equal(attempts, 1);
});

test("a Deal created outside IBOX but later entering IBOX is included by Deal ID", () => {
  const result = classify("200", foundDeal("200", { CATEGORY_ID: "99" }), [event("200", "NEW", "2026-08-10T10:00:00+05:00")]);
  assert.equal(result.classification, "INCLUDED");
  assert.equal(result.reason, "IBOX_STAGE_ENTRY");
});

test("a transferred Deal with a later IBOX stage event is included once as a return", () => {
  const history = [
    event("201", "NR", "2026-08-10T10:00:00+05:00", "1"),
    event("201", "PROCESS", "2026-08-12T10:00:00+05:00", "2"),
  ];
  const result = classify("201", foundDeal("201", { CATEGORY_ID: "99", [failureReasonField]: "101" }), history);
  assert.equal(result.classification, "INCLUDED");
  assert.equal(result.reason, "RETURNED_TO_IBOX_AFTER_TRANSFER");
});

test("post-sale movement preserves a Deal that previously reached payment", () => {
  const history = [
    event("202", "NEW", "2026-08-10T10:00:00+05:00", "1"),
    event("202", "PAID", "2026-08-15T10:00:00+05:00", "2"),
  ];
  const result = classify("202", foundDeal("202", { CATEGORY_ID: "44", STAGE_ID: "POST_SALE" }), history);
  assert.equal(result.classification, "INCLUDED");
});

test("only either exact transfer reason excludes when no later IBOX return exists", () => {
  for (const [index, reasonId] of ["101", "102"].entries()) {
    const id = String(210 + index);
    const result = classify(id, foundDeal(id, { CATEGORY_ID: "99", [failureReasonField]: reasonId }), [
      event(id, index ? "FAIL" : "NR", "2026-08-20T10:00:00+05:00"),
    ]);
    assert.equal(result.classification, "EXCLUDED");
    assert.equal(result.reason, "TRANSFERRED_OUT_NO_RETURN");
    assert.equal(result.transferReason, TRANSFER_OUT_REASONS[index]);
  }

  const other = classify("212", foundDeal("212", { CATEGORY_ID: "99", [failureReasonField]: "103" }), [
    event("212", "NR", "2026-08-20T10:00:00+05:00"),
  ]);
  assert.equal(other.classification, "INCLUDED");
});

test("unmapped failure-reason evidence remains unresolved", () => {
  const result = classify("213", foundDeal("213", { CATEGORY_ID: "99", [failureReasonField]: "999" }), [
    event("213", "NR", "2026-08-20T10:00:00+05:00"),
  ]);
  assert.equal(result.classification, "UNRESOLVED");
  assert.equal(result.reason, "FAILURE_REASON_UNRESOLVED");
});

test("missing failure-reason metadata or Deal field remains unresolved", () => {
  const history = [event("214", "NEW", "2026-08-20T10:00:00+05:00")];
  const unknownField = classify("214", foundDeal("214"), history, {
    failureReasonOptions: { fieldFound: false, byId: new Map() },
  });
  assert.equal(unknownField.reason, "FAILURE_REASON_FIELD_NOT_FOUND");

  const lookup = foundDeal("215");
  delete lookup.deal[failureReasonField];
  const missingValue = classify("215", lookup, history);
  assert.equal(missingValue.reason, "FAILURE_REASON_FIELD_MISSING");
});

test("NOT_FOUND is excluded while ACCESS_DENIED and ambiguous failures are unresolved", () => {
  const history = [event("220", "NEW", "2026-08-01T10:00:00+05:00")];
  assert.deepEqual(classify("220", { kind: "DELETED", code: "NOT_FOUND" }, history), {
    classification: "EXCLUDED", dealId: "220", reason: "DELETED_NOT_FOUND",
  });
  assert.deepEqual(classify("221", { kind: "UNRESOLVED", code: "ACCESS_DENIED" }, history), {
    classification: "UNRESOLVED", dealId: "221", reason: "LOOKUP_ACCESS_DENIED", errorCode: "ACCESS_DENIED",
  });
  assert.deepEqual(classify("222", { kind: "UNRESOLVED", code: "HTTP_400" }, history), {
    classification: "UNRESOLVED", dealId: "222", reason: "LOOKUP_HTTP_400", errorCode: "HTTP_400",
  });
});

test("Asia/Tashkent range includes both boundary instants and excludes adjacent instants", () => {
  const history = [event("230", "NEW", "2026-08-01T00:00:00+05:00")];
  const cases = [
    ["2026-08-01T00:00:00+05:00", "INCLUDED", "IBOX_STAGE_ENTRY"],
    ["2026-08-31T23:59:59.999+05:00", "INCLUDED", "IBOX_STAGE_ENTRY"],
    ["2026-07-31T23:59:59.999+05:00", "EXCLUDED", "DATE_BEFORE_RANGE"],
    ["2026-09-01T00:00:00+05:00", "EXCLUDED", "DATE_AFTER_RANGE"],
  ];
  for (const [dateCreate, expectedClass, reason] of cases) {
    const result = classify("230", foundDeal("230", { DATE_CREATE: dateCreate }), history);
    assert.equal(result.classification, expectedClass, dateCreate);
    assert.equal(result.reason, reason, dateCreate);
  }
  assert.equal(bounds.fromInclusive, "2026-07-31T19:00:00.000Z");
  assert.equal(bounds.toExclusive, "2026-08-31T19:00:00.000Z");
});

test("full extraction fetches every discovered Deal and reports safe counts and config", async () => {
  const histories = [
    event("301", "NEW", "2026-08-01T10:00:00+05:00", "1"),
    event("302", "NEW", "2026-08-01T10:01:00+05:00", "2"),
    event("303", "NEW", "2026-08-01T10:02:00+05:00", "3"),
    event("304", "NEW", "2026-08-01T10:03:00+05:00", "4"),
    event("305", "NEW", "2026-08-01T10:04:00+05:00", "5"),
  ];
  const requestedDeals = [];
  const attempts = new Map();
  const call = async (method, params) => {
    if (method === "crm.stagehistory.list") return { result: histories };
    if (method === "crm.status.list") return { result: [...stageNames].map(([STATUS_ID, NAME]) => ({ STATUS_ID, NAME })) };
    if (method === "crm.deal.fields") return { result: { [failureReasonField]: { items: [] } } };
    if (method === "crm.deal.get") {
      requestedDeals.push(params.id);
      attempts.set(params.id, (attempts.get(params.id) ?? 0) + 1);
      if (params.id === "302") throw new EvidenceError("NOT_FOUND");
      if (params.id === "303") throw new EvidenceError("ACCESS_DENIED");
      if (params.id === "304") throw new EvidenceError("HTTP_400");
      if (params.id === "305") throw new EvidenceError("QUERY_LIMIT_EXCEEDED");
      return { result: foundDeal(params.id).deal };
    }
    throw new Error(`unexpected method ${method}`);
  };
  const clock = [new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:10Z")];
  const report = await extractIboxLeadEvidence({
    call,
    config: { categoryId, failureReasonField, from: "2026-08-01", to: "2026-08-31" },
    now: () => clock.shift(),
    retryOptions: { delaysMs: [0], sleep: async () => {} },
  });

  assert.deepEqual([...new Set(requestedDeals)].sort(), ["301", "302", "303", "304", "305"]);
  assert.equal(attempts.get("305"), 2);
  assert.deepEqual(report.counts, {
    discovered: 5,
    historyRows: 5,
    included: 1,
    excluded: 1,
    unresolved: 3,
    unresolvedByCode: {
      ACCESS_DENIED: 1,
      HTTP_400: 1,
      "QUERY_LIMIT_EXCEEDED after retries": 1,
    },
  });
  assert.deepEqual(report.includedIds, ["301"]);
  assert.equal(report.excluded[0].reason, "DELETED_NOT_FOUND");
  assert.equal(report.unresolved[0].reason, "LOOKUP_ACCESS_DENIED");
  assert.equal(report.unresolved[1].reason, "LOOKUP_HTTP_400");
  assert.equal(report.unresolved[2].retryExhausted, true);
  assert.deepEqual(countUnresolvedByCode(report.unresolved), report.counts.unresolvedByCode);
  assert.match(renderHumanSummary(report), /QUERY_LIMIT_EXCEEDED after retries: 1/);
  assert.equal(report.config.historyQuery.filter.CATEGORY_ID, categoryId);
  assert.equal(Object.hasOwn(report.config.historyQuery.filter, "OWNER_ID"), false);
  assert.equal(report.snapshot.startedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(report.snapshot.completedAt, "2026-09-01T00:00:10.000Z");
  assert.equal(report.config.retryPolicy.maximumAttempts, 2);
});

test("webhook credentials cannot enter errors, reports, summaries, or output files", async () => {
  const secret = "sensitive-credential-value";
  const webhook = `https://example.bitrix24.test/rest/123/${secret}/`;
  const client = createBitrixClient(webhook, async () => ({
    ok: false,
    status: 403,
    async json() { return { error: "ACCESS_DENIED", error_description: `Denied at ${webhook}` }; },
  }));
  await assert.rejects(() => client("crm.deal.get", { id: "1" }), (error) => {
    assert.equal(error.code, "ACCESS_DENIED");
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  await assert.rejects(() => client("crm.deal.update", { id: "1" }), (error) => {
    assert.equal(error.code, "METHOD_NOT_ALLOWED");
    return true;
  });

  const report = {
    schemaVersion: 1,
    result: "COMPLETE",
    snapshot: { startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:01.000Z" },
    config: {
      categoryId, failureReasonField, fromDateInclusive: "2026-08-01", toDateInclusive: "2026-08-31", timezone: "Asia/Tashkent",
    },
    counts: { discovered: 1, historyRows: 1, included: 1, excluded: 0, unresolved: 0 },
    discoveredIds: ["1"], includedIds: ["1"], excluded: [], unresolved: [],
  };
  const temp = await mkdtemp(path.join(tmpdir(), "ibox-lead-evidence-test-"));
  try {
    const files = await writeAuditOutput(report, temp);
    const serialized = `${JSON.stringify(report)}\n${renderHumanSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${await readFile(files.summaryPath, "utf8")}`;
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.equal(path.dirname(files.jsonPath), temp);
    assert.equal(path.dirname(files.summaryPath), temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("CLI requires category, date range, and failure-reason field", () => {
  assert.deepEqual(parseCliArgs([
    "--category-id", "17", "--failure-reason-field", failureReasonField,
    "--from", "2026-08-01", "--to", "2026-08-31",
  ]), {
    help: false, categoryId: "17", failureReasonField, from: "2026-08-01", to: "2026-08-31",
  });
  assert.throws(() => parseCliArgs(["--from", "2026-08-01", "--to", "2026-08-31"]), /category-id/);
  assert.throws(() => parseCliArgs([
    "--category-id", "17", "--failure-reason-field", failureReasonField,
    "--from", "2026-02-30", "--to", "2026-03-01",
  ]), /real YYYY-MM-DD/);
});

test("extractor source has no D1, Sync, Backfill, or mutation method path", async () => {
  const source = await readFile(new URL("../scripts/ibox-lead-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
});
