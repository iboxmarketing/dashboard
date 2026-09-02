import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifySyncResponse, isTransientStatus, retryDelayMs, shouldRetry, SYNC_BUSY_MESSAGE,
  SYNC_EXHAUSTED_MESSAGE, SYNC_MAX_RETRIES, SYNC_RETRY_DELAYS_MS, SYNC_STEP_DELAY_MS,
  SYNC_STEPS_PER_REQUEST, transientFromNetworkError,
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
      assert.equal(shouldRetry(outcome, attempt), true, `attempt ${attempt} may retry`);
    }
    assert.equal(shouldRetry(outcome, SYNC_MAX_RETRIES), false, "the budget is bounded");
  }
  assert.deepEqual([...SYNC_RETRY_DELAYS_MS], [750, 1500, 3000]);
  assert.deepEqual([0, 1, 2].map(retryDelayMs), [750, 1500, 3000]);
  assert.equal(retryDelayMs(99), 3000, "the backoff clamps instead of running off the end");
});

test("E2: a network-level fetch failure retries on the same terms", () => {
  const outcome = transientFromNetworkError();
  assert.equal(outcome.kind, "transient");
  assert.equal(shouldRetry(outcome, 0), true);
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
      if (shouldRetry(outcome, attempt)) continue;
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
  assert.equal(shouldRetry(outcome, SYNC_MAX_RETRIES), false);
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
    assert.equal(shouldRetry(outcome, 0), false, `${status} must not retry`);
  }
});

test("I2: a non-JSON body on a non-gateway status is reported, not retried", () => {
  const outcome = classifySyncResponse({ ok: false, status: 500, contentType: "text/html", body: "<html>boom</html>" });
  assert.equal(outcome.kind, "invalid");
  assert.equal(shouldRetry(outcome, 0), false);
  assert.match(outcome.message, /HTTP 500/);
  assert.doesNotMatch(outcome.message, /boom|<html/i, "the body is never echoed");
});

test("K: the hotfix touches transport only — no sync semantics or settings", () => {
  const transport = readFileSync(new URL("../lib/sync-transport.ts", import.meta.url), "utf8");
  for (const forbidden of [/autoSyncMinutes/, /historyDays/, /analyticsDealBatchSize/, /stageDealBatchSize/, /runSyncStep/]) {
    assert.doesNotMatch(transport, forbidden, `transport must not touch ${forbidden}`);
  }
  // Server-side batch sizes are deliberately unchanged by this hotfix.
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /const stageDealBatchSize = 25;/);
  assert.match(sync, /const analyticsDealBatchSize = 80;/);
  assert.match(sync, /export async function runSyncSteps\(maxSteps = 4\)/,
    "the server default is untouched; the client simply asks for fewer");
});
