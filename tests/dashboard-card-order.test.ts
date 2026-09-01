import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DASHBOARD_METRICS, DEFAULT_DASHBOARD_METRIC_IDS, resolveDashboardMetricIds, type DashboardMetricId } from "../lib/dashboard-metrics";
import { mergeSettingsPayload } from "../lib/settings-payload";
import { defaultSettings } from "../lib/business-time";
import { isSettingsDirty } from "../lib/settings-readiness";

const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("A: saved order is preserved, not re-sorted into registry order", () => {
  assert.deepEqual(resolveDashboardMetricIds(["revenue", "leads", "sql"]), ["revenue", "leads", "sql"]);
  // The registry order would have produced leads, sql, revenue — the old bug.
  assert.notDeepEqual(resolveDashboardMetricIds(["revenue", "leads", "sql"]), ["leads", "sql", "revenue"]);
  assert.deepEqual(resolveDashboardMetricIds(["sla", "revenue"]), ["sla", "revenue"]);
});

test("B: invalid ids are dropped without disturbing the surviving order", () => {
  assert.deepEqual(resolveDashboardMetricIds(["revenue", "bad-id", "leads"]), ["revenue", "leads"]);
  assert.deepEqual(resolveDashboardMetricIds(["nope", "sql", "", "leads"]), ["sql", "leads"]);
  assert.deepEqual(resolveDashboardMetricIds([1, "sql", null, "leads"]), ["sql", "leads"]);
});

test("C: duplicates collapse to their first occurrence", () => {
  assert.deepEqual(resolveDashboardMetricIds(["sql", "leads", "sql", "revenue"]), ["sql", "leads", "revenue"]);
  assert.deepEqual(resolveDashboardMetricIds(["revenue", "revenue", "revenue"]), ["revenue"]);
});

test("D: empty or invalid saved values fall back to the defaults", () => {
  for (const value of [undefined, null, [], "leads", 42, {}, ["bad", "worse"]])
    assert.deepEqual(resolveDashboardMetricIds(value), DEFAULT_DASHBOARD_METRIC_IDS, `input ${JSON.stringify(value)}`);
});

/** Mirrors the Settings component's reorder/check/uncheck operations. */
const move = (ids: DashboardMetricId[], id: DashboardMetricId, offset: number) => {
  const from = ids.indexOf(id), to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};
const dropOn = (ids: DashboardMetricId[], dragged: DashboardMetricId, target: DashboardMetricId) => {
  if (dragged === target) return ids;
  const next = ids.filter((entry) => entry !== dragged);
  next.splice(next.indexOf(target), 0, dragged);
  return next;
};

test("E: reordering updates the draft order", () => {
  const before: DashboardMetricId[] = ["leads", "sql", "revenue"];
  // Drag revenue onto the first row.
  assert.deepEqual(dropOn(before, "revenue", "leads"), ["revenue", "leads", "sql"]);
  // The keyboard controls reach the same place.
  assert.deepEqual(move(move(before, "revenue", -1), "revenue", -1), ["revenue", "leads", "sql"]);
  assert.deepEqual(move(before, "leads", 1), ["sql", "leads", "revenue"]);
  // Moves at the ends are no-ops rather than errors.
  assert.deepEqual(move(before, "leads", -1), before);
  assert.deepEqual(move(before, "revenue", 1), before);
});

test("F/G: unchecking removes, re-checking appends to the end", () => {
  const start: DashboardMetricId[] = ["leads", "sql", "revenue"];
  const removed = start.filter((id) => id !== "sql");
  assert.deepEqual(removed, ["leads", "revenue"], "removal keeps the rest in order");
  const readded: DashboardMetricId[] = [...removed, "sql"];
  assert.deepEqual(readded, ["leads", "revenue", "sql"], "re-checking appends, never restores the old slot");
  assert.deepEqual(resolveDashboardMetricIds(readded), ["leads", "revenue", "sql"]);
});

test("H: an order-only change is a real change the dirty check can see", () => {
  const before: DashboardMetricId[] = ["leads", "sql", "revenue"];
  const after = dropOn(before, "revenue", "leads");
  assert.notDeepEqual(after, before);
  // Same members, different sequence — a set comparison would miss this, which
  // is why dirty state must compare the serialised draft.
  assert.deepEqual([...after].sort(), [...before].sort());
  assert.notEqual(JSON.stringify(after), JSON.stringify(before));
  // The real check: isSettingsDirty must not sort dashboardMetricIds away.
  const base = { ...defaultSettings, dashboardMetricIds: before };
  assert.equal(isSettingsDirty(base, { ...base, dashboardMetricIds: after }), true, "reordering must enable Save");
  assert.equal(isSettingsDirty(base, { ...base, dashboardMetricIds: [...before] }), false, "an identical order is not an edit");
  // Genuinely unordered selections still ignore sequence.
  assert.equal(isSettingsDirty(base, { ...base, selectedPipelineIds: [...base.selectedPipelineIds].reverse() }), false);
});

test("I: the dashboard renders cards in the saved order", () => {
  const client = code("../app/dashboard-client.tsx");
  assert.doesNotMatch(client, /DASHBOARD_METRICS\.filter\(\(metric\) => selected\.includes/, "registry order must not drive rendering");
  assert.match(client, /selected\.map\(\(id\) =>/, "rendering follows the resolved saved order");
  // Labels come from one shared helper, not from a second copy of the registry.
  assert.match(client, /headlineCardLabel\(id\)/);
});

test("J: loading and saving settings does not reorder or drop a selection", () => {
  const custom: DashboardMetricId[] = ["revenue", "leads", "quality_accepted_rate", "sql"];
  const saved = mergeSettingsPayload({ ...defaultSettings, dashboardMetricIds: custom }, { dashboardMetricIds: custom });
  assert.deepEqual(saved.dashboardMetricIds, custom, "a save round-trip preserves order");
  assert.deepEqual(resolveDashboardMetricIds(saved.dashboardMetricIds), custom, "and a reload preserves it too");
  // Backward compatibility: settings written in registry order still resolve to
  // that same order, so nothing moves on deploy.
  const legacy = DASHBOARD_METRICS.map((metric) => metric.id);
  assert.deepEqual(resolveDashboardMetricIds(legacy), legacy);
  assert.deepEqual(resolveDashboardMetricIds(DEFAULT_DASHBOARD_METRIC_IDS), DEFAULT_DASHBOARD_METRIC_IDS);
});

test("the Settings list offers a handle, keyboard controls and cannot empty the dashboard", () => {
  const client = code("../app/dashboard-client.tsx");
  assert.match(client, /draggable/, "rows are draggable");
  assert.match(client, /GripVertical/, "a visible drag handle");
  assert.match(client, /yuqoriga/, "an Up control");
  assert.match(client, /pastga/, "a Down control");
  assert.match(client, /if \(selected\.length > 1\) onChange/, "the last card cannot be removed");
  assert.match(client, /onChange\(\[\.\.\.selected, id\]\)/, "re-checking appends to the end");
});
