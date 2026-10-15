import type { ProjectKey } from "../sales-projects";

/**
 * Marketing workspace identity (owner decision, 2026-10-14).
 *
 * A workspace is a Bitrix sales funnel the business reports on. IBOX_UZ and
 * SD_UZ are today's dashboard projects (IBOX, SALES_DOCTOR). IBOX_KZ and SD_KZ
 * are reserved: their CRM analytics (stages, roster, quality, seller, SLA) are
 * configured later, but marketing attribution, ad identity and Meta spend already
 * keep them apart, so activating them needs no schema change. Everything else
 * (e.g. category 1) is NON_DASHBOARD.
 *
 * This is a marketing layer only. The accepted project registry
 * (lib/sales-projects.ts) and its business rules are untouched.
 */
export const MARKETING_WORKSPACES = [
  { key: "IBOX_UZ", project: "IBOX", categoryIds: ["3", "13"], activated: true },
  { key: "SD_UZ", project: "SALES_DOCTOR", categoryIds: ["5", "17"], activated: true },
  // Post-sale funnels for KZ are added here when the workspace is activated.
  { key: "IBOX_KZ", project: null, categoryIds: ["41"], activated: false },
  { key: "SD_KZ", project: null, categoryIds: ["33"], activated: false },
] as const satisfies readonly { key: string; project: ProjectKey | null; categoryIds: readonly string[]; activated: boolean }[];

export type WorkspaceKey = typeof MARKETING_WORKSPACES[number]["key"];
export const WORKSPACE_KEYS: readonly WorkspaceKey[] = MARKETING_WORKSPACES.map((workspace) => workspace.key);

export function isWorkspaceKey(value: unknown): value is WorkspaceKey {
  return typeof value === "string" && (WORKSPACE_KEYS as readonly string[]).includes(value);
}

/** The workspace a Bitrix category belongs to, or null (non-dashboard). */
export function workspaceForCategory(categoryId: unknown): WorkspaceKey | null {
  const id = String(categoryId ?? "").trim();
  return MARKETING_WORKSPACES.find((workspace) => (workspace.categoryIds as readonly string[]).includes(id))?.key ?? null;
}

/** An active dashboard project's workspace. */
export function workspaceForProject(project: ProjectKey): WorkspaceKey {
  const found = MARKETING_WORKSPACES.find((workspace) => workspace.project === project);
  if (!found) throw new Error(`No marketing workspace for project ${project}`);
  return found.key;
}
