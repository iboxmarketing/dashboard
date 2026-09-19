import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TRANSFER_OUT_REASONS,
  EvidenceError,
  buildIncludedSourceBreakdown,
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

const categoryId = "3";
const postSaleCategoryId = "13";
const idokonCategoryId = "1";
const sdCategoryId = "9";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const bounds = tashkentDateBounds("2026-08-01", "2026-08-31");
const reasonOptions = { fieldFound: true, byId: new Map([
  ["101", TRANSFER_OUT_REASONS[0]],
  ["102", TRANSFER_OUT_REASONS[1]],
  ["103", "Other reason"],
]) };
const sourceLabels = new Map([
  ["CRM_FORM", "CRM-форма"],
  ["REFERRAL", "Recommendation"],
]);

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
      SOURCE_ID: "CRM_FORM",
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
    postSaleCategoryId,
    failureReasonField,
    failureReasonOptions: reasonOptions,
    sourceLabels,
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

test("a Deal created outside IBOX but later entering IBOX Sales is included by Deal ID", () => {
  const result = classify("200", foundDeal("200"), [event("200", "NEW", "2026-08-10T10:00:00+05:00")]);
  assert.equal(result.classification, "INCLUDED");
  assert.equal(result.reason, "IBOX_STAGE_ENTRY");
  assert.equal(result.currentCategoryId, categoryId);
});

test("IBOX -> IDOKON with no return is EXCLUDED", () => {
  const result = classify("43281", foundDeal("43281", { CATEGORY_ID: idokonCategoryId }), [
    event("43281", "NEW", "2026-08-10T10:00:00+05:00"),
  ]);
  assert.equal(result.classification, "EXCLUDED");
  assert.equal(result.reason, "MOVED_TO_OTHER_FUNNEL_NO_RETURN");
  assert.equal(result.currentCategoryId, idokonCategoryId);
});

test("IBOX -> SD with no return is EXCLUDED", () => {
  const result = classify("310", foundDeal("310", { CATEGORY_ID: sdCategoryId }), [
    event("310", "NEW", "2026-08-10T10:00:00+05:00"),
    event("310", "PROCESS", "2026-08-11T10:00:00+05:00"),
  ]);
  assert.equal(result.classification, "EXCLUDED");
  assert.equal(result.reason, "MOVED_TO_OTHER_FUNNEL_NO_RETURN");
  assert.equal(result.currentCategoryId, sdCategoryId);
});

test("IBOX -> other project -> IBOX return is INCLUDED once by Deal ID", () => {
  // Discovery sees only IBOX rows, so both IBOX entries arrive under one Deal ID.
  const history = [
    event("311", "NEW", "2026-08-10T10:00:00+05:00", "1"),
    event("311", "NEW", "2026-08-20T10:00:00+05:00", "2"),
  ];
  const result = classify("311", foundDeal("311", { CATEGORY_ID: categoryId }), history);
  assert.equal(result.classification, "INCLUDED");
  assert.equal(result.reason, "IBOX_STAGE_ENTRY");
  assert.equal(result.currentCategoryId, categoryId);
});

test("IBOX -> category 13 post-sale is INCLUDED, including a Deal that reached payment", () => {
  const result = classify("202", foundDeal("202", { CATEGORY_ID: postSaleCategoryId, STAGE_ID: "POST_SALE" }), [
    event("202", "NEW", "2026-08-10T10:00:00+05:00", "1"),
    event("202", "PAID", "2026-08-15T10:00:00+05:00", "2"),
  ]);
  assert.equal(result.classification, "INCLUDED");
  assert.equal(result.reason, "IBOX_ENTRY_NOW_POST_SALE");
  assert.equal(result.currentCategoryId, postSaleCategoryId);
});

test("orphan failure-reason enum ID while currently in IBOX is INCLUDED with diagnostics (Deal 43205, raw 11151)", () => {
  const history = [
    event("43205", "NEW", "2026-08-20T10:00:00+05:00"),
    event("43205", "NR", "2026-08-21T10:00:00+05:00"),
  ];
  const result = classify("43205", foundDeal("43205", { [failureReasonField]: "11151" }), history);
  assert.equal(result.classification, "INCLUDED");
  assert.equal(result.reason, "IBOX_STAGE_ENTRY");
  assert.deepEqual(result.orphanFailureReasonIds, ["11151"]);
  assert.equal(Object.hasOwn(result, "transferReason"), false);

  const beside = classify("43206", foundDeal("43206", { [failureReasonField]: ["103", "11151"] }), history);
  assert.equal(beside.classification, "INCLUDED");
  assert.deepEqual(beside.orphanFailureReasonIds, ["11151"]);

  // An orphan alone never excludes, even once the Deal sits in another funnel it is only
  // excluded because of the funnel, and the orphan stays visible.
  const elsewhere = classify("43207", foundDeal("43207", { CATEGORY_ID: idokonCategoryId, [failureReasonField]: "11151" }), history);
  assert.equal(elsewhere.classification, "EXCLUDED");
  assert.equal(elsewhere.reason, "MOVED_TO_OTHER_FUNNEL_NO_RETURN");
  assert.deepEqual(elsewhere.orphanFailureReasonIds, ["11151"]);

  // An unreadable (empty) dictionary proves nothing, so no orphan is reported.
  const emptyDictionary = classify("43208", foundDeal("43208", { [failureReasonField]: "11151" }), history, {
    failureReasonOptions: { fieldFound: true, byId: new Map() },
  });
  assert.equal(emptyDictionary.classification, "INCLUDED");
  assert.equal(Object.hasOwn(emptyDictionary, "orphanFailureReasonIds"), false);
});

test("a transfer failure reason is supporting evidence only and never decides membership", () => {
  const history = [event("320", "NR", "2026-08-20T10:00:00+05:00")];
  for (const [index, reasonId] of ["101", "102"].entries()) {
    // Still in IBOX (transfer pending): included, with the label kept for review.
    const pending = classify(`32${index}`, foundDeal(`32${index}`, { [failureReasonField]: reasonId }), history);
    assert.equal(pending.classification, "INCLUDED");
    assert.equal(pending.transferReason, TRANSFER_OUT_REASONS[index]);

    // Moved to another project's funnel: excluded by the funnel, label kept as support.
    const moved = classify(`33${index}`, foundDeal(`33${index}`, { CATEGORY_ID: idokonCategoryId, [failureReasonField]: reasonId }), history);
    assert.equal(moved.classification, "EXCLUDED");
    assert.equal(moved.transferReason, TRANSFER_OUT_REASONS[index]);
  }
  // Moved elsewhere with no reason at all: still excluded by the funnel.
  const noReason = classify("340", foundDeal("340", { CATEGORY_ID: idokonCategoryId }), history);
  assert.equal(noReason.classification, "EXCLUDED");
});

test("Deal 43205 with an empty, not-selected or missing failure reason and valid IBOX history is included", () => {
  const history = [event("43205", "NEW", "2026-08-10T10:00:00+05:00")];
  for (const emptyValue of ["", "   ", null, [], {}]) {
    const result = classify("43205", foundDeal("43205", { [failureReasonField]: emptyValue }), history);
    assert.equal(result.classification, "INCLUDED");
    assert.equal(result.reason, "IBOX_STAGE_ENTRY");
  }
  const missingField = foundDeal("43205");
  delete missingField.deal[failureReasonField];
  assert.equal(classify("43205", missingField, history).classification, "INCLUDED");
  const unknownDictionary = classify("43205", foundDeal("43205"), history, {
    failureReasonOptions: { fieldFound: false, byId: new Map() },
  });
  assert.equal(unknownDictionary.classification, "INCLUDED");
});

test("a Deal with no current category or no IBOX history is unresolved, never guessed", () => {
  const history = [event("350", "NEW", "2026-08-10T10:00:00+05:00")];
  const noCategory = foundDeal("350");
  delete noCategory.deal.CATEGORY_ID;
  assert.equal(classify("350", noCategory, history).reason, "CURRENT_CATEGORY_MISSING");
  assert.equal(classify("351", foundDeal("351"), []).reason, "IBOX_HISTORY_MISSING");
});

test("orphan failure-reason IDs stay visible in the report and summary", async () => {
  const call = async (method, params) => {
    if (method === "crm.stagehistory.list") return { result: { items: [event("43205", "NR", "2026-08-21T10:00:00+05:00")] } };
    if (method === "crm.status.list") return { result: [] };
    if (method === "crm.deal.fields") return { result: { [failureReasonField]: { items: [{ ID: "101", VALUE: TRANSFER_OUT_REASONS[0] }] } } };
    if (method === "crm.deal.get") return { result: foundDeal("43205", { [failureReasonField]: "11151" }).deal };
    throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
  };
  const report = await extractIboxLeadEvidence({
    call, config: { categoryId, postSaleCategoryId, failureReasonField, from: "2026-08-01", to: "2026-08-31" },
  });
  assert.deepEqual(report.includedIds, ["43205"]);
  assert.equal(report.counts.orphanFailureReasonDeals, 1);
  assert.deepEqual(report.dataQuality.orphanFailureReasons, [
    { dealId: "43205", classification: "INCLUDED", orphanFailureReasonIds: ["11151"] },
  ]);
  assert.match(renderHumanSummary(report), /43205: INCLUDED \(orphan failure-reason ID 11151\)/);
});

test("verified CRM-форма benchmark: 423 IBOX Sales + 25 post-sale resolve to 448, IDOKON deals excluded", async () => {
  const salesIds = ["43205", ...Array.from({ length: 422 }, (_, index) => String(50001 + index))];
  const postSaleIds = Array.from({ length: 25 }, (_, index) => String(60001 + index));
  const idokonIds = ["43281", "44071"];
  const currentCategory = new Map([
    ...salesIds.map((id) => [id, categoryId]),
    ...postSaleIds.map((id) => [id, postSaleCategoryId]),
    ...idokonIds.map((id) => [id, idokonCategoryId]),
  ]);
  // Every Deal entered IBOX Sales; discovery is by stage history, not current funnel.
  const histories = [...currentCategory.keys()].map((id, index) => event(id, "NEW", "2026-09-05T10:00:00+05:00", String(index + 1)));
  const call = async (method, params) => {
    if (method === "crm.stagehistory.list") return { result: histories };
    if (method === "crm.status.list") return { result: [...sourceLabels].map(([STATUS_ID, NAME]) => ({ STATUS_ID, NAME })) };
    if (method === "crm.deal.fields") return { result: { [failureReasonField]: { items: [{ ID: "101", VALUE: TRANSFER_OUT_REASONS[0] }] } } };
    if (method === "crm.deal.get") {
      return { result: foundDeal(params.id, {
        DATE_CREATE: "2026-09-10T12:00:00+05:00",
        CATEGORY_ID: currentCategory.get(params.id),
        SOURCE_ID: "CRM_FORM",
        [failureReasonField]: params.id === "43205" ? "11151" : "",
      }).deal };
    }
    throw new Error(`unexpected method ${method}`);
  };

  const report = await extractIboxLeadEvidence({
    call, config: { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" },
  });

  assert.equal(report.result, "COMPLETE");
  assert.equal(report.counts.discovered, 450);
  assert.equal(report.counts.included, 448);
  assert.equal(report.counts.excluded, 2);
  assert.equal(report.counts.unresolved, 0);
  assert.equal(new Set(report.includedIds).size, 448);
  assert.deepEqual(report.currentCategoryBreakdown, {
    included: { [categoryId]: 423, [postSaleCategoryId]: 25 },
    excluded: { [idokonCategoryId]: 2 },
  });
  assert.ok(report.includedIds.includes("43205"));
  assert.deepEqual(report.excluded.map((row) => row.dealId).sort(), idokonIds);
  assert.deepEqual(report.includedBySource, [{
    sourceId: "CRM_FORM", sourceLabel: "CRM-форма", count: 448, dealIds: [...report.includedIds].sort((a, b) => a.length - b.length || a.localeCompare(b)),
  }]);
  assert.match(renderHumanSummary(report), /Included: 448 \(by current category — 3: 423, 13: 25\)/);
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

test("included source breakdown totals equal the canonical population and CRM-форма remains a subset", () => {
  const included = [
    classify("240", foundDeal("240", { SOURCE_ID: "CRM_FORM" }), [event("240", "NEW", "2026-08-01T10:00:00+05:00")]),
    classify("241", foundDeal("241", { SOURCE_ID: "CRM_FORM" }), [event("241", "NEW", "2026-08-01T10:01:00+05:00")]),
    classify("242", foundDeal("242", { SOURCE_ID: "REFERRAL" }), [event("242", "NEW", "2026-08-01T10:02:00+05:00")]),
  ];
  assert.ok(included.every((row) => row.classification === "INCLUDED"));

  const breakdown = buildIncludedSourceBreakdown(included);
  assert.equal(breakdown.reduce((sum, group) => sum + group.count, 0), included.length);
  assert.deepEqual(breakdown.find((group) => group.sourceId === "CRM_FORM"), {
    sourceId: "CRM_FORM", sourceLabel: "CRM-форма", count: 2, dealIds: ["240", "241"],
  });
  assert.ok(breakdown.find((group) => group.sourceId === "CRM_FORM").count < included.length);
  assert.deepEqual(included.map((row) => row.dealId), ["240", "241", "242"]);
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
    if (method === "crm.status.list") {
      if (params.filter.ENTITY_ID === "SOURCE") {
        return { result: [...sourceLabels].map(([STATUS_ID, NAME]) => ({ STATUS_ID, NAME })) };
      }
      throw new Error(`unexpected status entity ${params.filter.ENTITY_ID}`);
    }
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
    config: { categoryId, postSaleCategoryId, failureReasonField, from: "2026-08-01", to: "2026-08-31" },
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
    orphanFailureReasonDeals: 0,
  });
  assert.deepEqual(report.includedIds, ["301"]);
  assert.deepEqual(report.includedBySource, [{
    sourceId: "CRM_FORM", sourceLabel: "CRM-форма", count: 1, dealIds: ["301"],
  }]);
  assert.equal(report.includedBySource.reduce((sum, group) => sum + group.count, 0), report.counts.included);
  assert.equal(report.excluded[0].reason, "DELETED_NOT_FOUND");
  assert.equal(report.unresolved[0].reason, "LOOKUP_ACCESS_DENIED");
  assert.equal(report.unresolved[1].reason, "LOOKUP_HTTP_400");
  assert.equal(report.unresolved[2].retryExhausted, true);
  assert.deepEqual(countUnresolvedByCode(report.unresolved), report.counts.unresolvedByCode);
  assert.match(renderHumanSummary(report), /QUERY_LIMIT_EXCEEDED after retries: 1/);
  assert.equal(report.config.historyQuery.filter.CATEGORY_ID, categoryId);
  assert.equal(report.config.sourceDictionary.entityId, "SOURCE");
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

test("CLI requires category, post-sale category, date range, and failure-reason field", () => {
  const valid = [
    "--category-id", categoryId, "--post-sale-category-id", postSaleCategoryId, "--failure-reason-field", failureReasonField,
    "--from", "2026-08-01", "--to", "2026-08-31",
  ];
  assert.deepEqual(parseCliArgs(valid), {
    help: false, categoryId, postSaleCategoryId, failureReasonField, from: "2026-08-01", to: "2026-08-31",
  });
  assert.throws(() => parseCliArgs(["--from", "2026-08-01", "--to", "2026-08-31"]), /category-id/);
  assert.throws(() => parseCliArgs([
    "--category-id", categoryId, "--failure-reason-field", failureReasonField, "--from", "2026-08-01", "--to", "2026-08-31",
  ]), /post-sale-category-id/);
  assert.throws(() => parseCliArgs([
    "--category-id", categoryId, "--post-sale-category-id", categoryId, "--failure-reason-field", failureReasonField,
    "--from", "2026-08-01", "--to", "2026-08-31",
  ]), /post-sale-category-id/);
  assert.throws(() => parseCliArgs([
    "--category-id", categoryId, "--post-sale-category-id", postSaleCategoryId, "--failure-reason-field", failureReasonField,
    "--from", "2026-02-30", "--to", "2026-03-01",
  ]), /real YYYY-MM-DD/);
});

test("extractor source has no D1, Sync, Backfill, or mutation method path", async () => {
  const source = await readFile(new URL("../scripts/ibox-lead-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
});
