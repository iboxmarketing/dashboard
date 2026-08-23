import assert from "node:assert/strict";
import test from "node:test";
import {
  DEADLINE_STATES, deadlineState, filterProjects, isOverdue, latestUpdate, normalizeDeadline,
  projectUpdates, sortUpdates, statusBreakdown, statusOptions, summarizeProjects,
  validateProjectInput, validateUpdateInput, type Project, type ProjectUpdate,
} from "../lib/projects";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const iso = (day: string) => `2026-08-${day}T09:00:00.000Z`;

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1", name: "Marketing funnel", description: "", status: "Jarayonda", deadline: null,
    createdAt: iso("01"), updatedAt: iso("20"), archivedAt: null, ...over,
  };
}
function update(over: Partial<ProjectUpdate> = {}): ProjectUpdate {
  return {
    id: "u1", projectId: "p1", title: "Boshlandi", description: "", status: "Jarayonda",
    deadline: null, createdAt: iso("10"), updatedAt: iso("10"), ...over,
  };
}

test("create project: valid payload accepted, free-text status preserved", () => {
  const parsed = validateProjectInput({ name: "  CEO reporting  ", status: "CEO approval", description: "x", deadline: "2026-09-01" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.name, "CEO reporting");
  assert.equal(parsed.value.status, "CEO approval", "status is not restricted to an enum");
  assert.equal(parsed.value.deadline, "2026-09-01");
});

test("invalid API payloads rejected", () => {
  assert.deepEqual(validateProjectInput({ status: "Test" }), { ok: false, error: "Loyiha nomi kerak" });
  assert.deepEqual(validateProjectInput({ name: "X" }), { ok: false, error: "Status kerak" });
  assert.deepEqual(validateProjectInput({ name: "X", status: "   " }), { ok: false, error: "Status kerak" });
  assert.deepEqual(validateUpdateInput({ title: "X", status: "Test" }), { ok: false, error: "Loyiha tanlanmagan" });
  assert.deepEqual(validateUpdateInput({ projectId: "p1", status: "Test" }), { ok: false, error: "Update nomi kerak" });
  assert.equal(validateProjectInput(null).ok, false);
});

test("update project: any custom status is allowed", () => {
  for (const status of ["Kutilyapti", "Test", "CEO approval", "Tayyor", "内部レビュー"]) {
    const parsed = validateProjectInput({ name: "P", status });
    assert.equal(parsed.ok, true, status);
    if (parsed.ok) assert.equal(parsed.value.status, status);
  }
});

test("create/edit update: deadline normalized, description optional", () => {
  const parsed = validateUpdateInput({ projectId: "p1", title: "Demo", status: "Test", deadline: "2026-09-15T10:00:00Z" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.deadline, "2026-09-15");
  assert.equal(parsed.value.description, "");
  assert.equal(normalizeDeadline("nonsense"), null);
  assert.equal(normalizeDeadline(""), null);
  assert.equal(normalizeDeadline("2026-09-15"), "2026-09-15");
});

test("archived project hidden by default, visible on request", () => {
  const rows = [project({ id: "p1" }), project({ id: "p2", archivedAt: iso("21") })];
  assert.deepEqual(filterProjects(rows, {}, NOW).map((p) => p.id), ["p1"]);
  assert.deepEqual(filterProjects(rows, { includeArchived: true }, NOW).map((p) => p.id), ["p1", "p2"]);
  assert.equal(summarizeProjects(rows, NOW).total, 1);
  assert.equal(summarizeProjects(rows, NOW).archived, 1);
});

test("status filtering uses statuses actually present in data", () => {
  const rows = [project({ id: "p1", status: "Jarayonda" }), project({ id: "p2", status: "CEO approval" })];
  const updates = [update({ id: "u1", status: "Test" })];
  assert.deepEqual(statusOptions(rows, updates), ["CEO approval", "Jarayonda", "Test"]);
  assert.deepEqual(filterProjects(rows, { status: "CEO approval" }, NOW).map((p) => p.id), ["p2"]);
  assert.deepEqual(statusBreakdown(rows).map((r) => r.status).sort(), ["CEO approval", "Jarayonda"]);
});

test("deadline states and overdue indicator", () => {
  assert.equal(deadlineState("2026-08-20", NOW), "OVERDUE");
  assert.equal(deadlineState("2026-08-22", NOW), "SOON", "today is not overdue");
  assert.equal(deadlineState("2026-08-27", NOW), "SOON");
  assert.equal(deadlineState("2026-10-01", NOW), "FUTURE");
  assert.equal(deadlineState(null, NOW), "NONE");
  assert.equal(isOverdue(project({ deadline: "2026-08-20" }), NOW), true);
  assert.equal(isOverdue(project({ deadline: "2026-08-20", archivedAt: iso("21") }), NOW), false, "archived is never overdue");
  assert.deepEqual(DEADLINE_STATES.map((s) => s.id), ["", "OVERDUE", "SOON", "NONE"]);
});

test("deadline filtering", () => {
  const rows = [
    project({ id: "late", deadline: "2026-08-01" }),
    project({ id: "soon", deadline: "2026-08-25" }),
    project({ id: "none", deadline: null }),
  ];
  assert.deepEqual(filterProjects(rows, { deadline: "OVERDUE" }, NOW).map((p) => p.id), ["late"]);
  assert.deepEqual(filterProjects(rows, { deadline: "SOON" }, NOW).map((p) => p.id), ["soon"]);
  assert.deepEqual(filterProjects(rows, { deadline: "NONE" }, NOW).map((p) => p.id), ["none"]);
});

test("search filtering matches name, description and status", () => {
  const rows = [project({ id: "p1", name: "Marketing funnel" }), project({ id: "p2", name: "SD launch", status: "Kutilyapti" })];
  assert.deepEqual(filterProjects(rows, { search: "marketing" }, NOW).map((p) => p.id), ["p1"]);
  assert.deepEqual(filterProjects(rows, { search: "kutil" }, NOW).map((p) => p.id), ["p2"]);
});

test("project detail timeline is newest-first and scoped to the project", () => {
  const updates = [
    update({ id: "u1", createdAt: iso("10"), title: "eng eski" }),
    update({ id: "u3", createdAt: iso("18"), title: "eng yangi" }),
    update({ id: "u2", createdAt: iso("14"), title: "o‘rta" }),
    update({ id: "x1", projectId: "p2", createdAt: iso("19"), title: "boshqa loyiha" }),
  ];
  assert.deepEqual(projectUpdates(updates, "p1").map((u) => u.title), ["eng yangi", "o‘rta", "eng eski"]);
  assert.equal(latestUpdate(updates, "p1")?.title, "eng yangi");
  assert.equal(latestUpdate(updates, "p3"), null);
  // Equal timestamps fall back to a deterministic id order.
  const tied = sortUpdates([update({ id: "a", createdAt: iso("10") }), update({ id: "b", createdAt: iso("10") })]);
  assert.deepEqual(tied.map((u) => u.id), ["b", "a"]);
});

test("status-independent summary", () => {
  const rows = [
    project({ id: "p1", deadline: "2026-08-01", updatedAt: iso("21") }),
    project({ id: "p2", deadline: "2026-08-25", updatedAt: iso("02") }),
    project({ id: "p3", deadline: null, updatedAt: iso("22") }),
    project({ id: "p4", archivedAt: iso("20"), deadline: "2026-08-01" }),
  ];
  const summary = summarizeProjects(rows, NOW);
  assert.equal(summary.total, 3, "archived excluded");
  assert.equal(summary.overdue, 1);
  assert.equal(summary.deadlineNext7Days, 1);
  assert.equal(summary.updatedLast7Days, 2);
});
