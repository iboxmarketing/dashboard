import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalizeFieldOptions, normalizeCrmField, normalizeCrmFields } from "../lib/crm-fields";
import { normalizeSettings } from "../lib/settings-safety";
import { DEFAULT_DASHBOARD_METRIC_IDS } from "../lib/dashboard-metrics";
import type { CrmFieldOption } from "../lib/types";

const CLIENT = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");

/** The exact legacy cached field from the brief: options intentionally absent. */
const LEGACY_FIELD = { key: "UF_CRM_1748329407554", title: "причина провала", type: "enumeration" } as CrmFieldOption;

test("legacy cached field without options normalizes instead of throwing", () => {
  const field = normalizeCrmField(LEGACY_FIELD);
  assert.deepEqual(field.options, []);
  assert.equal(field.key, "UF_CRM_1748329407554");
  assert.equal(field.title, "причина провала");
  assert.equal(field.type, "enumeration");
  // The expression that crashed Settings is now safe on this input.
  assert.doesNotThrow(() => [field].filter((f) => /enum/i.test(f.type) || (f.options ?? []).length > 0));
});

test("options missing / null / empty all render", () => {
  for (const options of [undefined, null, []]) {
    const fields = normalizeCrmFields([{ ...LEGACY_FIELD, options }]);
    assert.equal(fields.length, 1);
    assert.deepEqual(fields[0].options, []);
    assert.doesNotThrow(() => canonicalizeFieldOptions(fields));
  }
});

test("missing title falls back to key, missing type to unknown", () => {
  const field = normalizeCrmField({ key: "UF_CRM_9" } as CrmFieldOption);
  assert.equal(field.title, "UF_CRM_9");
  assert.equal(field.type, "unknown");
  assert.deepEqual(field.options, []);
});

test("normalizeCrmFields tolerates junk payloads", () => {
  assert.deepEqual(normalizeCrmFields(undefined), []);
  assert.deepEqual(normalizeCrmFields(null), []);
  assert.deepEqual(normalizeCrmFields("nope"), []);
  assert.deepEqual(normalizeCrmFields([null, {}, { key: "" }]), [], "keyless entries dropped");
  const mixed = normalizeCrmFields([{ key: "UF_CRM_1", options: [{ id: "1", value: "a" }, null, { id: "", value: "b" }] }]);
  assert.deepEqual(mixed[0].options, [{ id: "1", value: "a" }], "broken options dropped, not thrown on");
});

test("settings draft: every iterated collection is guaranteed", () => {
  const arrays = ["holidays", "selectedPipelineIds", "selectedPipelineNames", "postSalePipelineIds",
    "postSalePipelineNames", "qualifiedStageIds", "lowQualityStageIds", "paymentStageIds",
    "closedLostStageIds", "routingReasonPatterns", "dashboardMetricIds"] as const;
  for (const raw of [undefined, null, {}, { selectedPipelineIds: null }, { qualifiedStageIds: "x" }]) {
    const safe = normalizeSettings(raw as never);
    for (const key of arrays) assert.ok(Array.isArray(safe[key]), `${key} must be an array`);
    for (const key of ["failureReasonFieldByPipeline", "stageLimits", "schedule"] as const) {
      assert.equal(typeof safe[key], "object");
      assert.notEqual(safe[key], null);
    }
    assert.deepEqual(Object.keys(safe.schedule).sort(), ["0", "1", "2", "3", "4", "5", "6"]);
    assert.deepEqual(safe.dashboardMetricIds, DEFAULT_DASHBOARD_METRIC_IDS);
    // No .map/.filter/.join on an untrusted value can throw after this.
    assert.doesNotThrow(() => safe.routingReasonPatterns.join(", ") + safe.holidays.map(String).join(""));
  }
});

test("normalizeSettings preserves real configuration", () => {
  const safe = normalizeSettings({ selectedPipelineIds: ["3"], qualifiedStageIds: ["C3:UC_9SUEMM"], slaMinutes: 7 } as never);
  assert.deepEqual(safe.selectedPipelineIds, ["3"]);
  assert.deepEqual(safe.qualifiedStageIds, ["C3:UC_9SUEMM"]);
  assert.equal(safe.slaMinutes, 7);
});

test("the crash is fixed: canonicalizeFieldOptions is imported where it is used", () => {
  assert.ok(/import \{[^}]*canonicalizeFieldOptions[^}]*\} from "@\/lib\/crm-fields"/.test(CLIENT),
    "missing import was the exact runtime ReferenceError");
  assert.ok(CLIENT.includes("normalizeCrmFields(payload.fields)"), "fields normalized at the API boundary");
  assert.ok(CLIENT.includes("normalizeSettings(settings)"), "draft normalized before render");
});

test("an error boundary protects the view switch", () => {
  assert.ok(CLIENT.includes("class ViewErrorBoundary"));
  assert.ok(CLIENT.includes("getDerivedStateFromError"));
  // Sprint 23 made the message view-agnostic: the boundary wraps every view,
  // so Settings-specific wording was wrong for the other twelve.
  assert.ok(CLIENT.includes("Sahifani ko‘rsatishda xato yuz berdi"));
  assert.equal(CLIENT.includes("Sozlamalarni ochishda xato"), false, "eski Sozlamalar-only matni olib tashlandi");
  assert.ok(CLIENT.includes("Dashboardga qaytish"));
  assert.ok(CLIENT.includes("Sahifani yangilash"));
  assert.ok(CLIENT.includes("<ViewErrorBoundary"), "wraps the rendered views");
});

test("Settings still contains its required panels", () => {
  // Sprint 23 renamed two panel titles to Uzbek ("fieldi" -> "maydoni",
  // "History" -> "Tarix oralig‘i"); the panels themselves must still be there.
  for (const panel of ["Sotuv loyihasi", "Bosqich ma’nolari", "Proval sababi maydoni", "Dashboard ko‘rsatkichlari", "Tarix oralig‘i"]) {
    assert.ok(CLIENT.includes(panel), `${panel} panel kerak`);
  }
});
