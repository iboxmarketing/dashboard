/**
 * The last completed sync of ONE project.
 *
 * The run itself is one global job (one sync at a time, whichever project), but
 * its outcome is recorded per project, so a workspace always shows its own last
 * Full Sync and analytics version — never the other product's.
 */
import type { ProjectKey } from "./sales-projects";

export type ProjectSyncRecord = {
  project: ProjectKey;
  lastSyncAt: string;
  mode: "full" | "incremental" | string;
  runId: string;
  analyticsVersion: number;
  deals: number;
};

export const projectSyncKey = (project: ProjectKey) => `projectSync:${project}`;
