import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "../lib/business-time";
import { buildCurrentStageRecords, reconcileCurrentStages } from "../lib/current-stages";
import type { AnalyticsRecord, CurrentStageRecord } from "../lib/types";

test("joriy stage snapshot DATE_CREATE eski bo‘lsa ham ochiq dealni saqlaydi", () => {
  const rows = buildCurrentStageRecords({
    deals: [{ ID: "42", TITLE: "Eski aktiv deal", DATE_CREATE: "2025-01-01T09:00:00+05:00", MOVED_TIME: "2026-08-20T09:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: "3", STAGE_ID: "UC_ABC" }],
    settings: { ...defaultSettings, selectedPipelineIds: ["3"], stageLimits: { UC_ABC: 24 } },
    pipelines: new Map([["3", "IBOX Sales"]]),
    stages: new Map([["3:UC_ABC", "ОБРАБОТКА"]]),
    users: new Map([["7", "Sotuvchi"]]), domain: "example.bitrix24.com",
    now: new Date("2026-08-21T10:00:00+05:00"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "ОБРАБОТКА");
  assert.equal(rows[0].assignedManager, "Sotuvchi");
  assert.equal(rows[0].stageAgeHours, 25);
  assert.equal(rows[0].stageOverdue, true);
});

test("reconciliation Bitrix 91 va cache 57 orasidagi 34 ta farqni ko‘rsatadi", () => {
  const live = Array.from({ length: 91 }, (_, index) => ({ dealId: String(index + 1), stageId: "PROCESS" }) as CurrentStageRecord);
  const cached = Array.from({ length: 57 }, (_, index) => ({ dealId: String(index + 1), stageId: "PROCESS" }) as AnalyticsRecord);
  const result = reconcileCurrentStages(live, cached, "2026-08-21T00:00:00.000Z");
  assert.equal(result.liveCount, 91);
  assert.equal(result.cachedCount, 57);
  assert.equal(result.missingCount, 34);
  assert.equal(result.staleCount, 0);
});
