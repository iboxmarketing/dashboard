import type { ProjectKey } from "@/lib/sales-projects";

export const MARKETING_WORKSPACES = [
  { key: "IBOX_UZ", label: "IBOX Uzbekistan", project: "IBOX", navigationEnabled: true, capabilities: { icp: true } },
  { key: "SD_UZ", label: "Sales Doctor Uzbekistan", project: "SALES_DOCTOR", navigationEnabled: true, capabilities: { icp: false } },
  { key: "IBOX_KZ", label: "IBOX Kazakhstan", project: null, navigationEnabled: false, capabilities: { icp: false } },
  { key: "SD_KZ", label: "Sales Doctor Kazakhstan", project: null, navigationEnabled: false, capabilities: { icp: false } },
] as const satisfies readonly {
  key: string;
  label: string;
  project: ProjectKey | null;
  navigationEnabled: boolean;
  capabilities: { icp: boolean };
}[];

export type MarketingWorkspaceKey = (typeof MARKETING_WORKSPACES)[number]["key"];

export function isMarketingWorkspaceKey(value: unknown): value is MarketingWorkspaceKey {
  return typeof value === "string" && MARKETING_WORKSPACES.some((workspace) => workspace.key === value);
}

export function marketingWorkspace(workspace: MarketingWorkspaceKey) {
  return MARKETING_WORKSPACES.find((item) => item.key === workspace)!;
}

export function marketingWorkspaceForProject(project: ProjectKey): MarketingWorkspaceKey {
  const workspace = MARKETING_WORKSPACES.find((item) => item.project === project);
  if (!workspace) throw new Error(`Marketing workspace is not configured for ${project}`);
  return workspace.key;
}

export function marketingProjectForWorkspace(workspace: MarketingWorkspaceKey): ProjectKey | null {
  return marketingWorkspace(workspace).project;
}
