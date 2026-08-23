import assert from "node:assert/strict";
import test from "node:test";
import {
  canFullSync, fullSyncBlockers, fullSyncConfirmation, isSettingsDirty, settingsReadiness,
} from "../lib/settings-readiness";
import { normalizeSettings } from "../lib/settings-safety";
import type { DashboardSettings } from "../lib/types";

/**
 * Sprint 23 — Full Sync rebuilds a whole cohort, so it must not be offered
 * while the configuration that drives classification is incomplete or
 * self-contradictory.
 */

const ready = (over: Partial<DashboardSettings> = {}): DashboardSettings => normalizeSettings({
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["IBOX Обучение"],
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"],
  paymentStageIds: ["C3:WON"], closedLostStageIds: ["C3:LOSE"],
  failureReasonField: "UF_CRM_1748329407554",
  failureReasonFieldByPipeline: { "3": "UF_CRM_1748329407554" },
  historyDays: 90, autoSyncMinutes: 0,
  ...over,
}) as DashboardSettings;

test("a complete configuration reports 4/4, no conflicts, and allows Full Sync", () => {
  const readiness = settingsReadiness(ready(), 1);
  assert.equal(readiness.stages.configured, 4);
  assert.equal(readiness.stages.total, 4);
  assert.equal(readiness.stages.complete, true);
  assert.equal(readiness.conflicts.count, 0);
  assert.equal(readiness.failureReason.configured, 1);
  assert.equal(readiness.failureReason.total, 1);
  assert.equal(readiness.pairing.valid, true);
  assert.equal(readiness.historyDays, 90);
  assert.equal(readiness.autoSync.enabled, false);
  assert.equal(readiness.tone, "ok");
  assert.deepEqual(fullSyncBlockers(readiness), []);
  assert.equal(canFullSync(readiness), true);
});

test("incomplete stage semantics gate Full Sync", () => {
  const readiness = settingsReadiness(ready({ paymentStageIds: [] }), 1);
  assert.equal(readiness.stages.configured, 3);
  assert.equal(readiness.stages.complete, false);
  assert.equal(readiness.tone, "warning");
  assert.equal(canFullSync(readiness), false);
  assert.ok(fullSyncBlockers(readiness).some((blocker) => /Bosqich ma’nolari/.test(blocker)));
});

test("a stage claimed by two meanings gates Full Sync", () => {
  // C3:WON as both payment and closed-lost is contradictory.
  const readiness = settingsReadiness(ready({ closedLostStageIds: ["C3:WON"] }), 1);
  assert.ok(readiness.conflicts.count > 0);
  assert.ok(readiness.conflicts.stageIds.includes("C3:WON"));
  assert.equal(canFullSync(readiness), false);
  assert.ok(fullSyncBlockers(readiness).some((blocker) => /konflikt/i.test(blocker)));
});

test("a missing failure-reason field gates Full Sync", () => {
  const readiness = settingsReadiness(ready({ failureReasonFieldByPipeline: {} }), 1);
  assert.equal(readiness.failureReason.complete, false);
  assert.equal(readiness.failureReason.configured, 0);
  assert.deepEqual(readiness.failureReason.missing, ["IBOX sales"]);
  assert.equal(canFullSync(readiness), false);
  assert.ok(fullSyncBlockers(readiness).some((blocker) => /Proval sababi/.test(blocker)));
});

test("an unpaired Sales funnel gates Full Sync", () => {
  const readiness = settingsReadiness(ready(), 0);
  assert.equal(readiness.pairing.valid, false);
  assert.equal(canFullSync(readiness), false);
  assert.ok(fullSyncBlockers(readiness).some((blocker) => /post-sale/.test(blocker)));
});

test("every blocker is listed at once, so the user sees all of them", () => {
  const readiness = settingsReadiness(ready({ paymentStageIds: [], failureReasonFieldByPipeline: {} }), 0);
  assert.equal(fullSyncBlockers(readiness).length, 3);
  assert.equal(canFullSync(readiness), false);
});

test("the Full Sync confirmation names the funnel, the range, and the rebuild", () => {
  const text = fullSyncConfirmation("IBOX sales", 90);
  assert.match(text, /IBOX sales/);
  assert.match(text, /90 kun/);
  assert.match(text, /qayta/i);
});

test("dirty detection ignores key order but catches real edits", () => {
  const saved = ready();
  assert.equal(isSettingsDirty(saved, { ...saved }), false, "an identical copy is not dirty");
  assert.equal(isSettingsDirty(saved, ready({ slaMinutes: 45 })), true, "a changed value is dirty");
  assert.equal(isSettingsDirty(saved, ready({ holidays: ["2026-01-01"] })), true, "an added array item is dirty");

  const reordered = Object.fromEntries(Object.entries(saved).reverse()) as DashboardSettings;
  assert.equal(isSettingsDirty(saved, reordered), false, "key order alone is not a change");
});
