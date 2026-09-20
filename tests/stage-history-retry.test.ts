import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyStageHistoryFailure,
  decideStageHistoryFailure,
  stageHistoryBatchFailure,
  STAGE_HISTORY_MAX_RETRIES,
  STAGE_HISTORY_METHOD,
} from "../lib/stage-history-retry";

const networkError = { code: "NETWORK_ERROR", message: "connection failed", statusClass: "NETWORK" };

test("transient stage-history failure retries the same cursor with bounded backoff", () => {
  const first = decideStageHistoryFailure({ error: networkError, cursor: 1200, nowMs: 1_000 });
  assert.equal(first.action, "RETRY");
  if (first.action !== "RETRY") return;
  assert.equal(first.retry.cursor, 1200);
  assert.equal(first.retry.retryCount, 1);
  assert.equal(first.retry.nextAttemptAt, new Date(1_750).toISOString());
  assert.equal(first.diagnostics.method, STAGE_HISTORY_METHOD);
  assert.equal(first.diagnostics.lastCode, "NETWORK_ERROR");
  assert.equal(first.diagnostics.lastStatusClass, "NETWORK");
});

test("transient failure does not become permissions.error", () => {
  const failure = classifyStageHistoryFailure({ code: "HTTP_503", message: "temporary", statusClass: "HTTP_5XX" });
  assert.equal(failure.kind, "TRANSIENT");
  const decision = decideStageHistoryFailure({ error: networkError, cursor: 25 });
  assert.equal(decision.action, "RETRY");
  assert.equal("permissions" in decision, false, "retry decisions cannot mutate permissions");
});

test("explicit access denied becomes a definitive permission failure", () => {
  for (const error of [
    { code: "ACCESS_DENIED", message: "Access denied", statusClass: "BITRIX" },
    { code: "HTTP_403", message: "Forbidden", statusClass: "HTTP_4XX" },
    { code: "ERROR_CORE", message: "Insufficient permissions", statusClass: "BITRIX" },
  ]) {
    const decision = decideStageHistoryFailure({ error, cursor: 50 });
    assert.equal(decision.action, "DEGRADE_PERMISSION");
    assert.equal(decision.diagnostics.permissionFailures, 1);
    assert.equal(decision.diagnostics.retryCount, 0);
  }
});

test("retry exhaustion stops safely without leaking the raw error or moving the cursor", () => {
  let previousRetry;
  let previousDiagnostics;
  let decision;
  for (let attempt = 0; attempt <= STAGE_HISTORY_MAX_RETRIES; attempt += 1) {
    decision = decideStageHistoryFailure({
      error: { code: "HTTP_503", message: "https://secret.example/rest/1/token", statusClass: "HTTP_5XX" },
      cursor: 75,
      previousRetry,
      previousDiagnostics,
      nowMs: 5_000,
    });
    previousDiagnostics = decision.diagnostics;
    previousRetry = decision.action === "RETRY" ? decision.retry : previousRetry;
  }
  assert.equal(decision?.action, "FAIL_EXHAUSTED");
  if (decision?.action !== "FAIL_EXHAUSTED") return;
  assert.equal(decision.diagnostics.cursor, 75);
  assert.equal(decision.diagnostics.retryCount, STAGE_HISTORY_MAX_RETRIES);
  assert.equal(decision.diagnostics.exhausted, true);
  assert.match(decision.safeError, /HTTP_503/);
  assert.doesNotMatch(decision.safeError, /secret|token|https?:\/\//i);
});

test("batch command errors are caught before the stage-history cursor can advance", () => {
  const failure = stageHistoryBatchFailure({
    result: {
      result: { deal_41: [] },
      result_error: {
        deal_42: { error: "QUERY_LIMIT_EXCEEDED", error_description: "Try later" },
      },
    },
  });
  assert.deepEqual(failure, {
    code: "QUERY_LIMIT_EXCEEDED",
    message: "Try later",
    statusClass: "BITRIX",
  });
  const decision = decideStageHistoryFailure({ error: failure, cursor: 100, nowMs: 0 });
  assert.equal(decision.action, "RETRY");
  assert.equal(decision.diagnostics.cursor, 100, "the failed 25-Deal batch is not skipped");

  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const check = sync.indexOf("stageHistoryBatchFailure(response");
  const persist = sync.indexOf("await persistStageHistoryRows", check);
  const advance = sync.indexOf("const cursor = job.cursor + ids.length", check);
  assert.ok(check >= 0 && check < persist && persist < advance,
    "all command errors are checked before persistence and cursor advance");
});

test("stage-history diagnostics are safe labels, never arbitrary server text", () => {
  const classified = classifyStageHistoryFailure({
    code: "bad code https://secret/rest/1/token",
    message: "temporary",
    statusClass: "edge 5xx",
  });
  assert.equal(classified.code.includes("/"), false);
  assert.equal(classified.statusClass?.includes(" "), false);
  assert.equal(JSON.stringify(classified).includes("secret"), false);
});

test("stage-history recovery changes no analytics formulas", () => {
  const retry = readFileSync(new URL("../lib/stage-history-retry.ts", import.meta.url), "utf8");
  for (const forbidden of ["salesStatus", "isSql", "opportunity", "wonAt", "leadMembership", "revenue"]) {
    assert.doesNotMatch(retry, new RegExp(forbidden, "i"), `${forbidden} is outside retry policy`);
  }
});
