import type { ProjectKey } from "../sales-projects";
import type { IcpConfig } from "./icp";

/**
 * ICP is a workspace capability. IBOX_UZ: the field its sellers fill (owner,
 * 2026-10-15). Everywhere else it is off — NOT_APPLICABLE, never "0%" — until a
 * definition is added here; no schema change is needed to enable it.
 */
const IBOX_UZ_ICP: IcpConfig = { enabled: true, fieldId: "UF_CRM_1787725980192", fitValues: ["P1", "P2", "P3"], notFitValues: ["Other"] };
const NO_ICP: IcpConfig = { enabled: false };

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
  { key: "IBOX_UZ", project: "IBOX", categoryIds: ["3", "13"], activated: true, icp: IBOX_UZ_ICP },
  { key: "SD_UZ", project: "SALES_DOCTOR", categoryIds: ["5", "17"], activated: true, icp: NO_ICP },
  // Post-sale funnels for KZ are added here when the workspace is activated.
  { key: "IBOX_KZ", project: null, categoryIds: ["41"], activated: false, icp: NO_ICP },
  { key: "SD_KZ", project: null, categoryIds: ["33"], activated: false, icp: NO_ICP },
] as const satisfies readonly { key: string; project: ProjectKey | null; categoryIds: readonly string[]; activated: boolean; icp: IcpConfig }[];

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

/** The workspace's ICP definition (disabled unless it defines one). */
export function workspaceIcp(workspace: string | null | undefined): IcpConfig {
  return MARKETING_WORKSPACES.find((item) => item.key === workspace)?.icp ?? { enabled: false };
}

/** Every Bitrix field some workspace's ICP reads, for the Deal select. */
export function icpFieldIds(): string[] {
  return [...new Set(MARKETING_WORKSPACES.flatMap((workspace) => (workspace.icp.enabled ? [workspace.icp.fieldId] : [])))];
}
