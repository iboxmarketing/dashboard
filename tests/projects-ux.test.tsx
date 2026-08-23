import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  activityAt, dayKey, deadlineState, isOverdue, sortUpdates, summarizeProjects,
  statusOptions, validateProjectInput, validateUpdateInput, wasEdited,
  type Project, type ProjectUpdate,
} from "../lib/projects";
import { isSettingsDirty } from "../lib/settings-readiness";
import { normalizeSettings } from "../lib/settings-safety";
import { StatusCombobox } from "../app/ui/combobox";
import type { DashboardSettings } from "../lib/types";

/**
 * Sprint 24 — Projects UX and project-domain correctness.
 *
 * Status stays arbitrary free text: the suggestion list is drawn from data and
 * must never become a validation rule.
 */

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../app/ui/drawer.tsx", import.meta.url), "utf8");
const combobox = readFileSync(new URL("../app/ui/combobox.tsx", import.meta.url), "utf8");

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1", name: "CAPI ulash", description: "", status: "Jarayonda", deadline: null,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", archivedAt: null, ...over,
});
const update = (over: Partial<ProjectUpdate> = {}): ProjectUpdate => ({
  id: "u1", projectId: "p1", title: "Birinchi", description: "", status: "Jarayonda", deadline: null,
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", ...over,
});

// ------------------------------------------------------- free-text status ---

test("any status is accepted; suggestions never constrain", () => {
  for (const status of ["Jarayonda", "Blocked", "完了", "Согласование", "!!! urgent", "a".repeat(60)]) {
    const parsed = validateProjectInput({ name: "X", status });
    assert.equal(parsed.ok, true, `status must be accepted: ${status}`);
    if (parsed.ok) assert.equal(parsed.value.status, status.trim().slice(0, 60));
  }
  // Nothing anywhere enumerates permitted statuses.
  const projects = readFileSync(new URL("../lib/projects.ts", import.meta.url), "utf8");
  assert.doesNotMatch(projects, /"TODO"|"IN_PROGRESS"|"DONE"|STATUS_ENUM|ALLOWED_STATUSES/);
  assert.equal(validateUpdateInput({ projectId: "p", title: "t", status: "Nimadir yangi" }).ok, true);
});

test("suggestions come from real data only", () => {
  const options = statusOptions([project({ status: "Blocked" })], [update({ status: "Kutilmoqda" })]);
  assert.deepEqual(options, ["Blocked", "Kutilmoqda"]);
  assert.deepEqual(statusOptions([], []), [], "no data means no suggestions, not a default list");
});

test("the combobox offers suggestions without restricting input", () => {
  const html = renderToStaticMarkup(
    <StatusCombobox value="" options={["Jarayonda", "Blocked"]} onChange={() => {}} />);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="false"/, "closed until focused");
  assert.match(html, /aria-autocomplete="list"/);
  assert.doesNotMatch(html, /<select/, "not a fixed choice list");
  assert.doesNotMatch(html, /pattern=/, "no value pattern constrains what may be typed");
  assert.doesNotMatch(html, /<datalist/, "native datalist replaced");
  // Keyboard contract lives in the component.
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) assert.ok(combobox.includes(`"${key}"`), key);
  assert.match(combobox, /aria-activedescendant/);
  assert.match(combobox, /role="listbox"/);
  assert.match(combobox, /role="option"/);
});

// --------------------------------------------------- Tashkent date semantics ---

test("today is the Tashkent calendar date, not the UTC one", () => {
  // 2026-08-23T20:30Z is already 2026-08-24 in Tashkent (UTC+5).
  const lateUtc = new Date("2026-08-23T20:30:00.000Z");
  assert.equal(dayKey(lateUtc), "2026-08-24");
  assert.notEqual(dayKey(lateUtc), lateUtc.toISOString().slice(0, 10));
  // 00:30 Tashkent == 19:30Z the previous day.
  const justAfterMidnight = new Date("2026-08-23T19:30:00.000Z");
  assert.equal(dayKey(justAfterMidnight), "2026-08-24");
});

test("a deadline does not flip overdue a day early or late across midnight", () => {
  const deadline = "2026-08-23";
  // 23:30 Tashkent on the 23rd (18:30Z) — still due today.
  const beforeMidnight = new Date("2026-08-23T18:30:00.000Z");
  assert.equal(deadlineState(deadline, beforeMidnight), "SOON", "due today is not yet overdue");
  assert.equal(isOverdue({ deadline, archivedAt: null }, beforeMidnight), false);

  // 00:30 Tashkent on the 24th (19:30Z) — now overdue.
  const afterMidnight = new Date("2026-08-23T19:30:00.000Z");
  assert.equal(deadlineState(deadline, afterMidnight), "OVERDUE");
  assert.equal(isOverdue({ deadline, archivedAt: null }, afterMidnight), true);

  // The old UTC logic would still have said "due today" at 00:30 Tashkent.
  assert.notEqual(afterMidnight.toISOString().slice(0, 10), "2026-08-24");
});

test("an archived project is never reported overdue", () => {
  const now = new Date("2026-08-23T19:30:00.000Z");
  assert.equal(isOverdue({ deadline: "2026-01-01", archivedAt: "2026-02-01" }, now), false);
});

test("summary windows are rolling 7 days and are named as such", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const summary = summarizeProjects([
    project({ id: "a", updatedAt: "2026-08-20T00:00:00.000Z", deadline: "2026-08-26" }),
    project({ id: "b", updatedAt: "2026-06-01T00:00:00.000Z", deadline: "2026-12-01" }),
  ], now);
  assert.equal(summary.total, 2);
  assert.equal(summary.updatedLast7Days, 1);
  assert.equal(summary.deadlineNext7Days, 1);
  assert.ok(!("updatedThisWeek" in summary), "the misleading calendar-week name is gone");
  assert.match(client, /Oxirgi 7 kunda yangilangan/);
  assert.match(client, /Keyingi 7 kun deadline/);
  assert.doesNotMatch(client, /Shu hafta yangilangan|Shu hafta deadline/, "no calendar-week claim remains");
});

// ------------------------------------------------------- activity ordering ---

test("an edited update surfaces as the most recent activity", () => {
  const older = update({ id: "old", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
  const newer = update({ id: "new", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" });
  assert.deepEqual(sortUpdates([newer, older]).map((u) => u.id), ["old", "new"],
    "edited-later beats created-later");
  assert.equal(activityAt(older), "2026-08-20T00:00:00.000Z");
  assert.equal(activityAt(newer), "2026-08-10T00:00:00.000Z");
});

test("edited and never-edited updates are labelled differently", () => {
  assert.equal(wasEdited(update()), false, "created == updated means never edited");
  assert.equal(wasEdited(update({ updatedAt: "2026-08-20T00:00:00.000Z" })), true);
  assert.match(client, /Yangilangan: \$\{fmtDate\(update\.updatedAt\)\}/);
  assert.match(client, /Yaratilgan: \$\{fmtDate\(update\.createdAt\)\}/);
});

test("update edit and delete touch the parent project", () => {
  const storage = readFileSync(new URL("../lib/projects-storage.ts", import.meta.url), "utf8");
  const edit = storage.slice(storage.indexOf("export async function updateProjectUpdate"), storage.indexOf("export async function deleteProjectUpdate"));
  const remove = storage.slice(storage.indexOf("export async function deleteProjectUpdate"));
  for (const [name, body] of [["edit", edit], ["delete", remove]] as const) {
    assert.match(body, /UPDATE projects SET updated_at/, `${name} moves the parent's activity time`);
    assert.match(body, /SELECT project_id FROM project_updates WHERE id = \?/, `${name} resolves the parent from the row, not the caller`);
    assert.match(body, /db\.batch\(/, `${name} writes both statements together`);
  }
});

// ------------------------------------------------------------- list + UI ----

test("empty-because-nothing-exists differs from empty-because-filtered", () => {
  assert.match(client, /Loyihalar hali yo‘q/);
  assert.match(client, /Marketing, Product yoki boshqa yo‘nalishdagi ishni yaratishingiz mumkin\./);
  assert.match(client, /Filtrga mos loyiha topilmadi/);
  assert.match(client, /const noProjectsAtAll = projects\.length === 0;/);
  // Scoped to ProjectsView: the Custom Pages PROJECTS_LIST widget keeps its own
  // copy and is out of scope for this sprint.
  const view = client.slice(client.indexOf("function ProjectsView"), client.indexOf("function ProjectDetailView"));
  assert.doesNotMatch(view, /Loyiha topilmadi\./, "the ambiguous single message is gone from the Projects list");
});

test("archived state reads as a state, never as an error", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const tag = css.slice(css.indexOf(".archive-tag"), css.indexOf(".archive-tag") + 260);
  assert.doesNotMatch(tag, /#b42318|#d14343|--danger/, "archived is neutral, not red");
  assert.match(client, /Arxivlangan/);
  assert.match(client, /Arxivdan chiqarish/);
  assert.doesNotMatch(client, /deleteProject"/, "no hard project delete in the UI");
});

test("filters expose a reset affordance only when something is filtering", () => {
  assert.match(client, /const filtersActive = Boolean\(filters\.search \|\| filters\.status \|\| filters\.deadline \|\| filters\.includeArchived\)/);
  assert.match(client, /Filtrni tozalash/);
  assert.match(client, /statuses\.length \? "Barcha statuslar" : "Status yo‘q"/, "status filter reads sanely with no data");
});

test("project cards are real buttons, not clickable divs", () => {
  const list = client.slice(client.indexOf('<div className="project-list">'), client.indexOf("</section></>;"));
  assert.match(list, /<button key=\{project\.id\} type="button" className=\{`project-card/);
  assert.doesNotMatch(list, /<div[^>]*className="project-card"[^>]*onClick/);
});

// ---------------------------------------------------------------- drawer ----

test("editors are a right-side drawer with the expected accessibility hooks", () => {
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby=\{headingId\}/);
  assert.match(drawer, /event\.key === "Escape"/, "Escape closes");
  assert.match(drawer, /event\.key !== "Tab"/, "focus is trapped");
  assert.match(drawer, /restoreTo\.current\?\.focus\?\.\(\)/, "focus returns to the trigger");
  assert.match(drawer, /data-autofocus/, "first useful field is focused");
  assert.match(drawer, /Saqlanmagan o‘zgarishlar bor/, "dirty close is confirmed");
  // Backdrop and Escape share the guarded path.
  assert.match(drawer, /onClick=\{requestClose\}/);

  // Both project and update editors go through it, and the old inline panels are gone.
  assert.match(client, /<Drawer open=\{Boolean\(projectDraft\)\}/);
  assert.match(client, /<Drawer open=\{Boolean\(updateDraft\)\}/);
  assert.doesNotMatch(client, /className="panel editor-panel"><SectionHeader title=\{projectDraft/);
  assert.match(client, /data-autofocus value=\{projectDraft\.name\}/);
});

test("the drawer is a side sheet on desktop and full width on mobile", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const panel = css.slice(css.indexOf(".drawer-panel {"), css.indexOf("@keyframes drawer-in"));
  assert.match(panel, /width:\s*min\(460px,\s*100%\)/, "420-480px desktop, never wider than the viewport");
  const mobile = css.slice(css.indexOf("@media (max-width: 560px)", css.indexOf(".drawer-panel")));
  assert.match(mobile.slice(0, 240), /\.drawer-panel \{ width: 100%/);
});

// -------------------------------------------------- settings dirty-state ----

test("toggling a selection off and on again is not an unsaved change", () => {
  const saved = normalizeSettings({
    selectedPipelineIds: ["3"], qualifiedStageIds: ["C3:A", "C3:B"],
    dashboardMetricIds: ["leads", "sql", "revenue"],
    paymentStageIds: ["C3:WON"], closedLostStageIds: ["C3:LOSE"], lowQualityStageIds: ["C3:LOW"],
  }) as DashboardSettings;

  // Toggle "C3:A" off, then back on — it lands at the end of the array.
  const toggled = { ...saved, qualifiedStageIds: ["C3:B", "C3:A"] };
  assert.deepEqual([...toggled.qualifiedStageIds].sort(), [...saved.qualifiedStageIds].sort(), "same selection");
  assert.equal(isSettingsDirty(saved, toggled), false, "order-only difference is not a change");

  // Same for the metric picker.
  assert.equal(isSettingsDirty(saved, { ...saved, dashboardMetricIds: ["revenue", "leads", "sql"] }), false);

  // A real change is still detected.
  assert.equal(isSettingsDirty(saved, { ...saved, qualifiedStageIds: ["C3:A"] }), true, "removal is a change");
  assert.equal(isSettingsDirty(saved, { ...saved, qualifiedStageIds: ["C3:A", "C3:B", "C3:C"] }), true, "addition is a change");
  assert.equal(isSettingsDirty(saved, { ...saved, slaMinutes: 45 }), true);
});

test("order-significant arrays are still compared positionally", () => {
  const saved = normalizeSettings({
    selectedPipelineIds: ["3", "5"], selectedPipelineNames: ["IBOX sales", "SD sales"],
    holidays: ["2026-01-01", "2026-03-08"],
  }) as DashboardSettings;
  // Names are positionally paired with their ids — reordering them is a real change.
  assert.equal(isSettingsDirty(saved, { ...saved, selectedPipelineNames: ["SD sales", "IBOX sales"] }), true,
    "pipeline names must not be sorted; they pair with the id array");
  assert.equal(isSettingsDirty(saved, { ...saved, holidays: ["2026-03-08", "2026-01-01"] }), true,
    "holidays are stored sorted; a different order is a real difference");
});
