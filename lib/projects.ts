/**
 * Projects & Updates domain.
 *
 * A management-reporting module, deliberately independent of the sales
 * analytics pipeline: it shares the app shell and D1 database, but no Bitrix
 * data, no metric definition and no sync path.
 *
 * Status is free text on purpose — departments run different workflows, so a
 * fixed enum would force Marketing and Product into the same vocabulary.
 * Existing values are offered as suggestions, never as a restriction.
 *
 * Kept free of Cloudflare imports so validation, filtering and ordering are
 * directly testable.
 */

export type Project = {
  id: string;
  name: string;
  description: string;
  status: string;
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ProjectUpdate = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
};

const NAME_LIMIT = 200;
const TEXT_LIMIT = 4000;
const STATUS_LIMIT = 60;

function text(value: unknown, limit: number) {
  return String(value ?? "").trim().slice(0, limit);
}

/** Normalises to `YYYY-MM-DD`; anything unparseable counts as no deadline. */
export function normalizeDeadline(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

export const DEADLINE_STATES = [
  { id: "", label: "Barchasi" },
  { id: "OVERDUE", label: "Muddati o‘tgan" },
  { id: "SOON", label: "Yaqinlashmoqda" },
  { id: "NONE", label: "Deadline yo‘q" },
] as const;

export type DeadlineState = "OVERDUE" | "SOON" | "FUTURE" | "NONE";

const SOON_DAYS = 7;

/**
 * Calendar date in the timezone the business actually works in.
 *
 * `toISOString().slice(0,10)` is UTC, so between 19:00 and 24:00 UTC — which is
 * 00:00-05:00 the *next* day in Tashkent — a deadline was judged against
 * yesterday's date and flipped overdue a day late. Sales business-time keeps
 * its own timezone handling; this is the projects module only.
 */
export const PROJECT_TIMEZONE = "Asia/Tashkent";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PROJECT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

/** YYYY-MM-DD as seen in Tashkent, not in UTC. */
export const dayKey = (date: Date) => dayFormatter.format(date);

/**
 * Deadline state relative to today. Completion is never inferred from status
 * text, so an archived item is the only thing exempt from being overdue.
 */
export function deadlineState(deadline: string | null | undefined, now: Date = new Date()): DeadlineState {
  const value = normalizeDeadline(deadline);
  if (!value) return "NONE";
  const today = dayKey(now);
  if (value < today) return "OVERDUE";
  const horizon = new Date(now.getTime() + SOON_DAYS * 86_400_000);
  return value <= dayKey(horizon) ? "SOON" : "FUTURE";
}

export function isOverdue(item: { deadline: string | null; archivedAt?: string | null }, now: Date = new Date()) {
  if (item.archivedAt) return false;
  return deadlineState(item.deadline, now) === "OVERDUE";
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateProjectInput(payload: unknown): ValidationResult<{
  name: string; description: string; status: string; deadline: string | null;
}> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const name = text(input.name, NAME_LIMIT);
  if (!name) return { ok: false, error: "Loyiha nomi kerak" };
  const status = text(input.status, STATUS_LIMIT);
  if (!status) return { ok: false, error: "Status kerak" };
  return {
    ok: true,
    value: { name, description: text(input.description, TEXT_LIMIT), status, deadline: normalizeDeadline(input.deadline) },
  };
}

export function validateUpdateInput(payload: unknown): ValidationResult<{
  projectId: string; title: string; description: string; status: string; deadline: string | null;
}> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const projectId = text(input.projectId, 64);
  if (!projectId) return { ok: false, error: "Loyiha tanlanmagan" };
  const title = text(input.title, NAME_LIMIT);
  if (!title) return { ok: false, error: "Update nomi kerak" };
  const status = text(input.status, STATUS_LIMIT);
  if (!status) return { ok: false, error: "Status kerak" };
  return {
    ok: true,
    value: { projectId, title, description: text(input.description, TEXT_LIMIT), status, deadline: normalizeDeadline(input.deadline) },
  };
}

export type ProjectFilters = { status?: string; deadline?: string; search?: string; includeArchived?: boolean };

/** Archived projects are hidden unless explicitly requested. */
export function filterProjects(projects: Project[], filters: ProjectFilters = {}, now: Date = new Date()) {
  const search = String(filters.search ?? "").trim().toLowerCase();
  return projects.filter((project) => {
    if (!filters.includeArchived && project.archivedAt) return false;
    if (filters.status && project.status !== filters.status) return false;
    if (filters.deadline && deadlineState(project.deadline, now) !== filters.deadline) return false;
    if (search && !`${project.name} ${project.description} ${project.status}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

/**
 * Latest activity on an update: when it was last edited, else when it was
 * created. Management wants "what moved recently", so an edited update
 * resurfaces rather than staying pinned to its creation date.
 */
export function activityAt(update: Pick<ProjectUpdate, "createdAt" | "updatedAt">) {
  return update.updatedAt && update.updatedAt > update.createdAt ? update.updatedAt : update.createdAt;
}

/** True once an update has been edited after creation. */
export function wasEdited(update: Pick<ProjectUpdate, "createdAt" | "updatedAt">) {
  return Boolean(update.updatedAt) && update.updatedAt > update.createdAt;
}

/** Newest activity first, with the id as a deterministic tie-break. */
export function sortUpdates(updates: ProjectUpdate[]) {
  return [...updates].sort((a, b) => activityAt(b).localeCompare(activityAt(a)) || b.id.localeCompare(a.id));
}

export function projectUpdates(updates: ProjectUpdate[], projectId: string) {
  return sortUpdates(updates.filter((update) => update.projectId === projectId));
}

export function latestUpdate(updates: ProjectUpdate[], projectId: string): ProjectUpdate | null {
  return projectUpdates(updates, projectId)[0] ?? null;
}

/**
 * Status-independent summary: with free-text statuses, counting "Jarayonda" or
 * "Blocked" would break the moment a team invents its own vocabulary.
 *
 * The two 7-day figures are rolling windows from `now`, not calendar weeks —
 * the field names and the UI labels say so, because "this week" would be a
 * different number on a Monday than on a Friday.
 */
export function summarizeProjects(projects: Project[], now: Date = new Date()) {
  const active = projects.filter((project) => !project.archivedAt);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const sevenDaysAhead = dayKey(new Date(now.getTime() + 7 * 86_400_000));
  const today = dayKey(now);
  return {
    total: active.length,
    overdue: active.filter((project) => isOverdue(project, now)).length,
    updatedLast7Days: active.filter((project) => project.updatedAt >= sevenDaysAgo).length,
    deadlineNext7Days: active.filter((project) => {
      const deadline = normalizeDeadline(project.deadline);
      return Boolean(deadline && deadline >= today && deadline <= sevenDaysAhead);
    }).length,
    archived: projects.length - active.length,
  };
}

/** Distinct statuses actually present in the data — drives filters and suggestions. */
export function statusOptions(...collections: { status: string }[][]) {
  return [...new Set(collections.flat().map((item) => item.status).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Dynamic breakdown over whatever statuses the team actually uses. */
export function statusBreakdown(projects: Project[]) {
  const counts = new Map<string, number>();
  for (const project of projects) {
    if (project.archivedAt) continue;
    const status = project.status || "—";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}
