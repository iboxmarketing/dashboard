import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mergeSettingsPayload } from "../lib/settings-payload";
import { normalizeSettings } from "../lib/settings-safety";
import { stageConfigReadiness } from "../lib/diagnostics";
import { settingsReadiness } from "../lib/settings-readiness";
import type { DashboardSettings } from "../lib/types";

/**
 * Sprint 23.1 — regression cover for a real production incident.
 *
 * `POST /api/settings {}` cleared `salesManagerField`, `failureReasonField`
 * and `marketingChannelField`, because the route treated an absent property as
 * an instruction to null the field. The contract is now:
 *   absent -> preserve, null -> clear, value -> validate.
 */

/** Mirrors the accepted production configuration. */
const stored = (): DashboardSettings => normalizeSettings({
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["IBOX Обучение/Сопровождение"],
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"],
  paymentStageIds: ["C3:WON"], closedLostStageIds: ["C3:LOSE"],
  failureReasonField: "UF_CRM_1748329407554",
  failureReasonFieldByPipeline: { "3": "UF_CRM_1748329407554" },
  marketingChannelField: "UF_CRM_1784823646",
  salesManagerField: "ASSIGNED_BY_ID",
  historyDays: 90, autoSyncMinutes: 0, slaMinutes: 30, defaultStageLimitHours: 240,
  holidays: ["2026-01-01"], stageLimits: { "C3:WON": 48 },
  routingReasonPatterns: ["idoko", "sd"],
  dashboardMetricIds: ["leads", "sql", "revenue"],
}) as DashboardSettings;

test("A. an empty payload preserves salesManagerField — the exact incident", () => {
  const current = stored();
  const next = mergeSettingsPayload(current, {});
  assert.equal(next.salesManagerField, "ASSIGNED_BY_ID");
});

test("B. an omitted failureReasonField is preserved", () => {
  const current = stored();
  const next = mergeSettingsPayload(current, { autoSyncMinutes: 15 });
  assert.equal(next.failureReasonField, "UF_CRM_1748329407554");
  assert.equal(next.marketingChannelField, "UF_CRM_1784823646");
  assert.deepEqual(next.failureReasonFieldByPipeline, { "3": "UF_CRM_1748329407554" });
});

test("an empty payload is a complete no-op across every setting", () => {
  const current = stored();
  const next = mergeSettingsPayload(current, {});
  assert.deepEqual(next, current, "POST {} must return the stored settings unchanged");
  // Also true for the shapes a hostile or broken client might send.
  for (const junk of [null, undefined, [], "", 0, "string", { unknownKey: "x" }]) {
    const result = mergeSettingsPayload(current, junk);
    assert.equal(result.salesManagerField, "ASSIGNED_BY_ID", `junk payload ${JSON.stringify(junk)}`);
    assert.equal(result.failureReasonField, "UF_CRM_1748329407554");
    assert.deepEqual(result.selectedPipelineIds, ["3"]);
    assert.deepEqual(result.qualifiedStageIds, ["C3:UC_9SUEMM"]);
  }
});

test("C. explicit null clears a nullable field, and only that field", () => {
  const current = stored();
  const next = mergeSettingsPayload(current, { salesManagerField: null });
  assert.equal(next.salesManagerField, null, "null is the explicit clear signal");
  assert.equal(next.failureReasonField, "UF_CRM_1748329407554", "neighbours untouched");
  assert.equal(next.marketingChannelField, "UF_CRM_1784823646");

  // An empty string is also a clear; a non-nullable field ignores nonsense.
  assert.equal(mergeSettingsPayload(current, { failureReasonField: "  " }).failureReasonField, null);
  // A non-nullable number must preserve on null, not coerce to 0 and clamp.
  assert.equal(mergeSettingsPayload(current, { historyDays: null }).historyDays, 90, "non-nullable numbers keep their value");
  assert.equal(mergeSettingsPayload(current, { slaMinutes: null }).slaMinutes, 30);
  assert.equal(mergeSettingsPayload({ ...current, autoSyncMinutes: 15 }, { autoSyncMinutes: null }).autoSyncMinutes, 15,
    "null must not silently disable auto-sync");
  assert.equal(mergeSettingsPayload(current, { selectedPipelineIds: null }).selectedPipelineIds.length, 1);
});

test("D. a partial update changes only the named field", () => {
  const current = stored();
  const next = mergeSettingsPayload(current, { autoSyncMinutes: 15 });
  assert.equal(next.autoSyncMinutes, 15);
  for (const key of Object.keys(current) as (keyof DashboardSettings)[]) {
    if (key === "autoSyncMinutes") continue;
    assert.deepEqual(next[key], current[key], `${key} must be identical`);
  }
});

test("D2. every single-field update leaves the rest identical", () => {
  const current = stored();
  const edits: Partial<DashboardSettings>[] = [
    { slaMinutes: 45 }, { historyDays: 30 }, { defaultStageLimitHours: 100 },
    { holidays: ["2026-03-08"] }, { routingReasonPatterns: ["передан"] },
    { dashboardMetricIds: ["leads"] }, { paymentStageIds: ["C3:FINAL_INVOICE"] },
    { salesManagerField: "UF_CRM_9" }, { stageLimits: { "C3:LOSE": 12 } },
  ];
  for (const edit of edits) {
    const key = Object.keys(edit)[0] as keyof DashboardSettings;
    const next = mergeSettingsPayload(current, edit);
    assert.notDeepEqual(next[key], current[key], `${key} should change`);
    for (const other of Object.keys(current) as (keyof DashboardSettings)[]) {
      if (other === key) continue;
      assert.deepEqual(next[other], current[other], `${String(key)} edit must not touch ${other}`);
    }
  }
});

test("values are still validated and normalized, not stored blindly", () => {
  const current = stored();
  assert.equal(mergeSettingsPayload(current, { slaMinutes: 9999 }).slaMinutes, 240, "clamped");
  assert.equal(mergeSettingsPayload(current, { slaMinutes: -5 }).slaMinutes, 1, "clamped");
  assert.equal(mergeSettingsPayload(current, { historyDays: "abc" }).historyDays, 90, "unparseable preserves");
  assert.equal(mergeSettingsPayload(current, { autoSyncMinutes: 7 }).autoSyncMinutes, 0, "off-list interval rejected");
  assert.deepEqual(mergeSettingsPayload(current, { holidays: ["nope", "2026-05-01"] }).holidays, ["2026-05-01"]);
  assert.equal(mergeSettingsPayload(current, { timezone: "UTC" }).timezone, "Asia/Tashkent", "timezone is not client-controlled");
  assert.deepEqual(mergeSettingsPayload(current, { schedule: "junk" }).schedule, current.schedule, "a malformed schedule is ignored");
  assert.equal(mergeSettingsPayload(current, { salesManagerField: "  ASSIGNED_BY_ID  " }).salesManagerField, "ASSIGNED_BY_ID", "trimmed");
});

test("E. merged output still satisfies the Settings UI readiness expectations", () => {
  const current = stored();
  const next = mergeSettingsPayload(current, {});
  const stageReady = stageConfigReadiness(next);
  assert.equal(stageReady.configured, 4);
  assert.equal(stageReady.complete, true);

  const readiness = settingsReadiness(next, 1);
  assert.equal(readiness.stages.complete, true);
  assert.equal(readiness.conflicts.count, 0);
  assert.equal(readiness.failureReason.complete, true);
  assert.equal(readiness.pairing.valid, true);
  assert.equal(readiness.tone, "ok");

  // normalizeSettings is what the UI drafts from; the round trip must be stable.
  assert.deepEqual(normalizeSettings(next), next, "server output is already UI-normalized");
});

test("the route delegates to the merge contract instead of re-implementing it", () => {
  const route = readFileSync(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
  assert.match(route, /mergeSettingsPayload\(current, payload\)/);
  assert.doesNotMatch(route, /\.\.\.payload/, "no raw payload spread can smuggle unvalidated keys");
  assert.doesNotMatch(route, /:\s*null,/, "no field defaults to null on an absent property");
});
