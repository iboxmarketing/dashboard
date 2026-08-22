import { getD1 } from "@/db";
import type { Project, ProjectUpdate } from "./projects";

/**
 * D1 persistence for Projects & Updates.
 *
 * Separate tables and a separate module from the analytics cache: nothing here
 * reads or writes `analytics_records`.
 */
export async function ensureProjectSchema() {
  const db = getD1();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS project_updates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS projects_status_idx ON projects(status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS projects_deadline_idx ON projects(deadline)"),
    db.prepare("CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS project_updates_project_idx ON project_updates(project_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS project_updates_status_idx ON project_updates(status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS project_updates_deadline_idx ON project_updates(deadline)"),
    db.prepare("CREATE INDEX IF NOT EXISTS project_updates_updated_idx ON project_updates(updated_at)"),
  ]);
}

const projectRow = (row: Record<string, string | null>): Project => ({
  id: String(row.id), name: String(row.name), description: String(row.description ?? ""),
  status: String(row.status), deadline: row.deadline ? String(row.deadline) : null,
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  archivedAt: row.archived_at ? String(row.archived_at) : null,
});

const updateRow = (row: Record<string, string | null>): ProjectUpdate => ({
  id: String(row.id), projectId: String(row.project_id), title: String(row.title),
  description: String(row.description ?? ""), status: String(row.status),
  deadline: row.deadline ? String(row.deadline) : null,
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

export async function listProjects(): Promise<Project[]> {
  await ensureProjectSchema();
  const result = await getD1().prepare("SELECT * FROM projects ORDER BY updated_at DESC").all<Record<string, string | null>>();
  return (result.results ?? []).map(projectRow);
}

export async function listProjectUpdates(): Promise<ProjectUpdate[]> {
  await ensureProjectSchema();
  const result = await getD1().prepare("SELECT * FROM project_updates ORDER BY created_at DESC").all<Record<string, string | null>>();
  return (result.results ?? []).map(updateRow);
}

export async function createProject(input: { name: string; description: string; status: string; deadline: string | null }) {
  await ensureProjectSchema();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await getD1().prepare("INSERT INTO projects(id, name, description, status, deadline, created_at, updated_at, archived_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)")
    .bind(id, input.name, input.description, input.status, input.deadline, now, now).run();
  return id;
}

export async function updateProject(id: string, input: { name: string; description: string; status: string; deadline: string | null }) {
  await ensureProjectSchema();
  await getD1().prepare("UPDATE projects SET name = ?, description = ?, status = ?, deadline = ?, updated_at = ? WHERE id = ?")
    .bind(input.name, input.description, input.status, input.deadline, new Date().toISOString(), id).run();
}

/** Archive is reversible and never deletes updates. */
export async function setProjectArchived(id: string, archived: boolean) {
  await ensureProjectSchema();
  const now = new Date().toISOString();
  await getD1().prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
    .bind(archived ? now : null, now, id).run();
}

export async function createProjectUpdate(input: { projectId: string; title: string; description: string; status: string; deadline: string | null }) {
  await ensureProjectSchema();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const db = getD1();
  await db.batch([
    db.prepare("INSERT INTO project_updates(id, project_id, title, description, status, deadline, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.projectId, input.title, input.description, input.status, input.deadline, now, now),
    // Keep the parent's updated_at meaningful for "recently active" ordering.
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now, input.projectId),
  ]);
  return id;
}

export async function updateProjectUpdate(id: string, input: { title: string; description: string; status: string; deadline: string | null }) {
  await ensureProjectSchema();
  await getD1().prepare("UPDATE project_updates SET title = ?, description = ?, status = ?, deadline = ?, updated_at = ? WHERE id = ?")
    .bind(input.title, input.description, input.status, input.deadline, new Date().toISOString(), id).run();
}

export async function deleteProjectUpdate(id: string) {
  await ensureProjectSchema();
  await getD1().prepare("DELETE FROM project_updates WHERE id = ?").bind(id).run();
}
