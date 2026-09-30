"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ArrowLeftRight, Stethoscope, Store } from "lucide-react";

import { PROJECT_KEYS, SALES_PROJECTS, type ProjectKey } from "@/lib/sales-projects";

/**
 * The sales project a workspace shows. It comes from the URL (`/ibox`,
 * `/sales-doctor`), so it is known at the first render: a direct load of a Sales
 * Doctor route can never fetch or paint IBOX data, not even for one frame.
 */
const ProjectContext = createContext<ProjectKey | null>(null);

export function ProjectProvider({ project, children }: { project: ProjectKey; children: ReactNode }) {
  return <ProjectContext.Provider value={project}>{children}</ProjectContext.Provider>;
}

/** The workspace's project. Outside a workspace there is none. */
export function useProject(): ProjectKey | null {
  return useContext(ProjectContext);
}

const LAST_PROJECT_KEY = "dashboard:lastProject";

/** Best effort only: the URL is the authority, this merely highlights the last choice. */
export function rememberProject(project: ProjectKey) {
  try { window.localStorage.setItem(LAST_PROJECT_KEY, project); } catch { /* private mode, blocked storage */ }
}

export function lastProject(): ProjectKey | null {
  try {
    const value = window.localStorage.getItem(LAST_PROJECT_KEY);
    return (PROJECT_KEYS as readonly string[]).includes(value ?? "") ? (value as ProjectKey) : null;
  } catch { return null; }
}

export const projectHref = (project: ProjectKey) => `/${SALES_PROJECTS[project].slug}`;

const ICONS: Record<ProjectKey, typeof Store> = { IBOX: Store, SALES_DOCTOR: Stethoscope };

/** The entry screen: choose a project. Nothing is loaded until one is chosen. */
export function ProjectSelector({ highlighted }: { highlighted?: ProjectKey | null }) {
  return (
    <main className="project-select" aria-label="Loyihani tanlang">
      <div className="project-select-card">
        <p className="eyebrow">DASHBOARD</p>
        <h1>Loyihani tanlang</h1>
        <div className="project-select-options">
          {PROJECT_KEYS.map((key) => {
            const Icon = ICONS[key];
            return (
              <a key={key} className={`project-option ${highlighted === key ? "last" : ""}`} href={projectHref(key)}>
                <Icon size={22} aria-hidden="true" />
                <strong>{SALES_PROJECTS[key].name}</strong>
                {highlighted === key && <small>Oxirgi tanlangan</small>}
              </a>
            );
          })}
        </div>
      </div>
    </main>
  );
}

/**
 * The compact switcher in the workspace header. Switching is a navigation to the
 * other workspace's route, which mounts a fresh dashboard: no stage, manager,
 * filter or cached answer of one project survives into the other.
 */
export function ProjectSwitcher({ project }: { project: ProjectKey }) {
  const other = PROJECT_KEYS.find((key) => key !== project)!;
  return (
    <div className="project-switcher">
      <span className="project-current" aria-label="Joriy loyiha"><strong>{SALES_PROJECTS[project].name}</strong></span>
      <a className="project-switch-link" href={projectHref(other)} title={`${SALES_PROJECTS[other].name} loyihasiga o‘tish`}>
        <ArrowLeftRight size={13} aria-hidden="true" />{SALES_PROJECTS[other].name}
      </a>
    </div>
  );
}
