/**
 * Scopes an API path to a sales project. Pure, so it is testable and shared by
 * every browser fetch that reads project data.
 */
import type { ProjectKey } from "./sales-projects";

export function withProject(url: string, project: ProjectKey) {
  const parsed = new URL(url, "http://workspace.local");
  parsed.searchParams.set("project", project);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Does a response belong to the workspace on screen? A response that names a
 * different project is refused, so a late answer for one project can never paint
 * over the other. A response that names none (an older endpoint) is accepted.
 */
export function responseMatchesProject(payload: unknown, project: ProjectKey) {
  if (!payload || typeof payload !== "object") return true;
  const named = (payload as { project?: unknown }).project;
  return named === undefined || named === null || named === project;
}
