import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyStartRecovery, classifySyncResponse, isRetryableAction, isTransientStatus, retryDelayMs,
  RETRYABLE_ACTIONS, shouldRetry, SYNC_BUSY_MESSAGE, SYNC_EXHAUSTED_MESSAGE, SYNC_MAX_RETRIES,
  SYNC_RETRY_DELAYS_MS, SYNC_START_UNCONFIRMED_MESSAGE, SYNC_STEP_DELAY_MS, SYNC_STEPS_PER_REQUEST,
  transientFromNetworkError,
} from "../lib/sync-transport";

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");

/** The Cloudflare 503 body that used to reach the user as `Unexpected token '<'`. */
const CF_HTML = `<!DOCTYPE html><html><head><title>503 Service Temporarily Unavailable</title></head>
<body><h1>Service Temporarily Unavailable</h1><p>cloudflare</p></body></html>`;

test("A: the sync loop asks for one step per request, not four", () => {
  assert.equal(SYNC_STEPS_PER_REQUEST, 1);
  assert.match(client, /action: "step", steps: SYNC_STEPS_PER_REQUEST/,
    "the loop must send the shared constant");
  assert.doesNotMatch(client, /action: "step", steps: 4/, "the 4-step payload is gone");
  // One POST now covers 1 x 80 analytics deals instead of 4 x 80.
  assert.ok(SYNC_STEPS_PER_REQUEST * 80 <= 80);
});

test("A2: the loop pauses between steps instead of hammering at 40ms", () => {
  assert.ok(SYNC_STEP_DELAY_MS >= 150 && SYNC_STEP_DELAY_MS <= 250, "documented 150-250ms band");
  assert.match(client, /window\.setTimeout\(resolve, SYNC_STEP_DELAY_MS\)/);
  assert.doesNotMatch(client, /window\.setTimeout\(resolve, 40\)/);
});

test("B: a JSON 200 parses normally", () => {
  const outcome = classifySyncResponse<{ status: string }>({
    ok: true, status: 200, contentType: "application/json", body: '{"status":"running"}',
  });
  assert.equal(outcome.kind, "ok");
  assert.deepEqual(outcome.kind === "ok" ? outcome.payload : null, { status: "running" });
});

test("C: a JSON error response surfaces the server's own message", () => {
  const outcome = classifySyncResponse({
    ok: false, status: 400, contentType: "application/json", body: '{"error":"Noma’lum amal"}',
  });
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.kind === "error" ? outcome.message : "", "Noma’lum amal");
});

test("C2: a JSON error with no message still reads as a sync failure", () => {
  const outcome = classifySyncResponse({ ok: false, status: 500, contentType: "application/json", body: "{}" });
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.kind === "error" ? outcome.message : "", "Sinxronizatsiya bajarilmadi");
});

test("D: an HTML 503 never produces `Unexpected token '<'`", () => {
  const outcome = classifySyncResponse({ ok: false, status: 503, contentType: "text/html; charset=UTF-8", body: CF_HTML });
  assert.equal(outcome.kind, "transient");
  assert.equal(outcome.message, SYNC_BUSY_MESSAGE);
  assert.doesNotMatch(outcome.message, /Unexpected token/);
  assert.doesNotMatch(outcome.message, /DOCTYPE|cloudflare|<html/i, "the raw HTML body never reaches the UI");
  // The old code path is what produced the user-visible SyntaxError.
  assert.throws(() => JSON.parse(CF_HTML), /Unexpected token/, "proves the previous behaviour");
});

test("E: 502/503/504 are transient and retried within a bounded budget", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(isTransientStatus(status), true, `${status} is transient`);
    const outcome = classifySyncResponse({ ok: false, status, contentType: "text/html", body: CF_HTML });
    assert.equal(outcome.kind, "transient");
    for (let attempt = 0; attempt < SYNC_MAX_RETRIES; attempt += 1) {
      assert.equal(shouldRetry(outcome, attempt, "step"), true, `attempt ${attempt} may retry`);
    }
    assert.equal(shouldRetry(outcome, SYNC_MAX_RETRIES, "step"), false, "the budget is bounded");
  }
  assert.deepEqual([...SYNC_RETRY_DELAYS_MS], [750, 1500, 3000]);
  assert.deepEqual([0, 1, 2].map(retryDelayMs), [750, 1500, 3000]);
  assert.equal(retryDelayMs(99), 3000, "the backoff clamps instead of running off the end");
});

test("E2: a network-level fetch failure retries on the same terms", () => {
  const outcome = transientFromNetworkError();
  assert.equal(outcome.kind, "transient");
  assert.equal(shouldRetry(outcome, 0, "step"), true);
});

test("F/G/J: a retry replays the SAME action and never starts a second sync", async () => {
  // Drive the real postSync loop shape: two 503s, then a 200.
  const sent: { body: string }[] = [];
  const responses = [
    { ok: false, status: 503, contentType: "text/html", body: CF_HTML },
    { ok: false, status: 503, contentType: "text/html", body: CF_HTML },
    { ok: true, status: 200, contentType: "application/json", body: '{"status":"success"}' },
  ];
  async function post(body: Record<string, unknown>) {
    for (let attempt = 0; ; attempt += 1) {
      sent.push({ body: JSON.stringify(body) });
      const outcome = classifySyncResponse<{ status: string }>(responses[sent.length - 1]);
      if (outcome.kind === "ok") return outcome.payload;
      if (shouldRetry(outcome, attempt, body.action)) continue;
      throw new Error(outcome.kind === "transient" ? SYNC_EXHAUSTED_MESSAGE : outcome.message);
    }
  }
  const result = await post({ action: "step", steps: SYNC_STEPS_PER_REQUEST });
  assert.equal(result.status, "success", "G: the sync continues after a successful retry");
  assert.equal(sent.length, 3);
  assert.deepEqual([...new Set(sent.map((r) => r.body))], ['{"action":"step","steps":1}'],
    "F: every attempt replayed the identical body");
  assert.equal(sent.some((r) => /"start"/.test(r.body)), false, "J: no retry ever escalates to start");
});

test("H: exhausted transient retries return a friendly, resumable message", () => {
  const outcome = classifySyncResponse({ ok: false, status: 503, contentType: "text/html", body: CF_HTML });
  assert.equal(shouldRetry(outcome, SYNC_MAX_RETRIES, "step"), false);
  // Mirrors what postSync throws once the retry budget is spent.
  assert.equal(outcome.kind, "transient");
  const surfaced = outcome.kind === "transient" ? SYNC_EXHAUSTED_MESSAGE : "unreachable";
  assert.match(surfaced, /Davom ettirish/, "it points at resume rather than a new sync");
  assert.doesNotMatch(surfaced, /Unexpected token|DOCTYPE|<html/i);
  assert.match(client, /SYNC_EXHAUSTED_MESSAGE/, "the client surfaces it");
});

test("I: a permanent 4xx is never retried", () => {
  for (const status of [400, 401, 403, 404, 422, 500]) {
    const outcome = classifySyncResponse({ ok: false, status, contentType: "application/json", body: '{"error":"nope"}' });
    assert.notEqual(outcome.kind, "transient", `${status} must not be transient`);
    assert.equal(shouldRetry(outcome, 0, "step"), false, `${status} must not retry`);
  }
});

test("I2: a non-JSON body on a non-gateway status is reported, not retried", () => {
  const outcome = classifySyncResponse({ ok: false, status: 500, contentType: "text/html", body: "<html>boom</html>" });
  assert.equal(outcome.kind, "invalid");
  assert.equal(shouldRetry(outcome, 0, "step"), false);
  assert.match(outcome.message, /HTTP 500/);
  assert.doesNotMatch(outcome.message, /boom|<html/i, "the body is never echoed");
});

test("K: the hotfix touches transport only — no sync semantics or settings", () => {
  const transport = readFileSync(new URL("../lib/sync-transport.ts", import.meta.url), "utf8");
  // No coupling: the module imports nothing and calls nothing from the server.
  assert.doesNotMatch(transport, /^\s*import\s/m, "transport is standalone");
  for (const forbidden of [/autoSyncMinutes/, /historyDays/, /analyticsDealBatchSize\s*[=:]/, /stageDealBatchSize\s*[=:]/, /runSyncStep\s*\(/]) {
    assert.doesNotMatch(transport, forbidden, `transport must not touch ${forbidden}`);
  }
  // Server-side batch sizes are deliberately unchanged by this hotfix.
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /const stageDealBatchSize = 25;/);
  assert.match(sync, /const analyticsDealBatchSize = 80;/);
  assert.match(sync, /export async function runSyncSteps\(maxSteps = 4\)/,
    "the server default is untouched; the client simply asks for fewer");
});

// ============================ SAFETY CORRECTION: never retry `start` ==========

/**
 * Mirrors postSync's control flow exactly, including the read-only recovery a
 * lost `start` performs. `bootstrap` returns whatever the scenario supplies.
 */
async function drivePostSync(body: Record<string, unknown>, opts: {
  responses: { ok: boolean; status: number; contentType: string; body: string }[];
  bootstrap?: () => { sync?: { status?: unknown; scopePipelineId?: unknown } } | null;
}) {
  const sent: string[] = [];
  const action = body.action;
  for (let attempt = 0; ; attempt += 1) {
    sent.push(JSON.stringify(body));
    const outcome = classifySyncResponse<{ status: string }>(opts.responses[Math.min(sent.length - 1, opts.responses.length - 1)]);
    if (outcome.kind === "ok") return { sent, result: outcome.payload as { status: string } | null, error: null as string | null };
    if (shouldRetry(outcome, attempt, action)) continue;
    if (outcome.kind === "transient" && action === "start") {
      const payload = opts.bootstrap ? opts.bootstrap() : null;
      const decision = classifyStartRecovery({
        state: payload?.sync, requestedPipelineId: body.pipelineId ? String(body.pipelineId) : null,
      });
      if (decision.kind === "recovered" && payload?.sync) return { sent, result: payload.sync as { status: string }, error: null };
      return { sent, result: null, error: SYNC_START_UNCONFIRMED_MESSAGE };
    }
    return { sent, result: null, error: outcome.kind === "transient" ? SYNC_EXHAUSTED_MESSAGE : outcome.message };
  }
}

const HTML503 = { ok: false, status: 503, contentType: "text/html", body: CF_HTML };
const OK200 = { ok: true, status: 200, contentType: "application/json", body: '{"status":"running"}' };

test("M: a transient STEP retries and replays the identical body", async () => {
  const run = await drivePostSync({ action: "step", steps: SYNC_STEPS_PER_REQUEST }, { responses: [HTML503, HTML503, OK200] });
  assert.equal(run.error, null);
  assert.equal(run.sent.length, 3);
  assert.deepEqual([...new Set(run.sent)], ['{"action":"step","steps":1}']);
});

test("N: the retry policy is explicit per action, not inferred from the method", () => {
  assert.deepEqual([...RETRYABLE_ACTIONS], ["step", "resume", "pause"]);
  for (const action of ["step", "resume", "pause"]) assert.equal(isRetryableAction(action), true, `${action} replays safely`);
  assert.equal(isRetryableAction("start"), false, "start is never replayed");
  for (const junk of [undefined, null, 1, {}, "", "START"]) assert.equal(isRetryableAction(junk), false);
  // resume/pause are safe because neither creates a run nor resets a cursor.
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /export async function resumeSync/);
  assert.doesNotMatch(sync.split("export async function resumeSync")[1].split("export async function")[0], /crypto\.randomUUID|clearPipelineScope/);
  assert.doesNotMatch(sync.split("export async function pauseSync")[1].split("export async function")[0], /crypto\.randomUUID|clearPipelineScope/);
});

test("O: a transient START sends exactly ONE start POST", async () => {
  const run = await drivePostSync({ action: "start", days: 30, full: false, pipelineId: "3" }, { responses: [HTML503] });
  assert.equal(run.sent.filter((b) => /"action":"start"/.test(b)).length, 1, "exactly one start");
  assert.equal(run.sent.length, 1, "no replay of any kind");
  assert.equal(run.error, SYNC_START_UNCONFIRMED_MESSAGE);
});

test("P: a transient FULL START sends exactly ONE start POST", async () => {
  // full: true is the dangerous one — startSync calls clearPipelineScope().
  const run = await drivePostSync({ action: "start", days: 90, full: true, pipelineId: "3" }, { responses: [HTML503, HTML503, HTML503, OK200] });
  assert.equal(run.sent.length, 1, "a full start is never repeated, whatever the edge does");
  assert.equal(run.sent.filter((b) => /"full":true/.test(b)).length, 1);
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /if \(mode === "full"\) await clearPipelineScope/, "the destructive call this protects");
});

test("Q: start transient + bootstrap running on the requested pipeline recovers and continues", async () => {
  const run = await drivePostSync({ action: "start", days: 30, full: false, pipelineId: "3" }, {
    responses: [HTML503],
    bootstrap: () => ({ sync: { status: "running", scopePipelineId: "3" } }),
  });
  assert.equal(run.error, null, "treated as started");
  assert.equal(run.result?.status, "running");
  assert.equal(run.sent.length, 1, "recovery is read-only — no second start");
});

test("R: start transient + bootstrap not running stops gracefully", async () => {
  for (const state of [
    { status: "idle" }, { status: "success" }, { status: "error" },
    { status: "running", scopePipelineId: "9" },
  ]) {
    const run = await drivePostSync({ action: "start", days: 30, full: false, pipelineId: "3" }, {
      responses: [HTML503], bootstrap: () => ({ sync: state }),
    });
    assert.equal(run.error, SYNC_START_UNCONFIRMED_MESSAGE, `${JSON.stringify(state)} must not be adopted`);
    assert.equal(run.sent.length, 1, "still exactly one start");
  }
});

test("S: start transient + bootstrap failure stops gracefully", async () => {
  const run = await drivePostSync({ action: "start", days: 30, full: false, pipelineId: "3" }, {
    responses: [HTML503], bootstrap: () => null,
  });
  assert.equal(run.error, SYNC_START_UNCONFIRMED_MESSAGE);
  assert.equal(run.sent.length, 1);
  assert.equal(classifyStartRecovery({ state: null }).kind, "unconfirmed");
  assert.equal(classifyStartRecovery({ state: undefined }).kind, "unconfirmed");
});

test("T: no code path turns a failed start into an automatic start retry", () => {
  const transport = readFileSync(new URL("../lib/sync-transport.ts", import.meta.url), "utf8");
  assert.doesNotMatch(transport, /"start"\s*,/, "start is not in the retryable list");
  assert.equal((RETRYABLE_ACTIONS as readonly string[]).includes("start"), false);
  // The client guards the retry on shouldRetry(..., action) and only ever
  // recovers a start by reading state.
  assert.match(client, /shouldRetry\(outcome, attempt, action\)/);
  assert.match(client, /recoverStartedSync/);
  const recover = client.split("async function recoverStartedSync")[1].split("async function postSync")[0];
  assert.doesNotMatch(recover, /method:\s*"POST"/, "recovery is a read-only GET");
  assert.match(recover, /\/api\/bootstrap/);
  // Only one postSync call site can send start, and it is not inside a retry loop.
  assert.equal((client.match(/action: "start"/g) ?? []).length, 1);
});

test("U/V: raw HTML is never surfaced and the parser error cannot return", async () => {
  const run = await drivePostSync({ action: "step", steps: 1 }, { responses: [HTML503, HTML503, HTML503, HTML503] });
  assert.equal(run.error, SYNC_EXHAUSTED_MESSAGE);
  for (const text of [run.error ?? "", SYNC_START_UNCONFIRMED_MESSAGE, SYNC_BUSY_MESSAGE]) {
    assert.doesNotMatch(text, /Unexpected token/, "V");
    assert.doesNotMatch(text, /DOCTYPE|<html|cloudflare/i, "U");
  }
});

test("W/X: steps stays 1 and server batch sizes are untouched", () => {
  assert.equal(SYNC_STEPS_PER_REQUEST, 1);
  assert.equal(SYNC_STEP_DELAY_MS, 200);
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /const stageDealBatchSize = 25;/);
  assert.match(sync, /const analyticsDealBatchSize = 80;/);
});
