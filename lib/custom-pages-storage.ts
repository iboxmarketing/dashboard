import { getD1 } from "@/db";
import { orderWidgets, type CustomPage, type PageWidget, type WidgetType } from "./custom-pages";

/**
 * D1 persistence for Custom Pages. Separate tables from both the analytics
 * cache and the projects module; ids are opaque UUIDs so a future share token
 * can reference a page without exposing anything else.
 */
export async function ensurePageSchema() {
  const db = getD1();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS custom_pages (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, audience TEXT, default_range TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS custom_page_widgets (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, widget_type TEXT NOT NULL, title TEXT, position INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS custom_pages_updated_idx ON custom_pages(updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS custom_page_widgets_page_idx ON custom_page_widgets(page_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS custom_page_widgets_position_idx ON custom_page_widgets(page_id, position)"),
  ]);
}

const pageRow = (row: Record<string, string | null>): CustomPage => ({
  id: String(row.id), name: String(row.name), description: String(row.description ?? ""),
  audience: String(row.audience ?? ""), defaultRange: String(row.default_range ?? "30"),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  archivedAt: row.archived_at ? String(row.archived_at) : null,
});

function widgetRow(row: Record<string, string | number | null>): PageWidget {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(String(row.config_json ?? "{}")) as Record<string, unknown>; } catch { config = {}; }
  return {
    id: String(row.id), pageId: String(row.page_id), widgetType: String(row.widget_type) as WidgetType,
    title: String(row.title ?? ""), position: Number(row.position ?? 0), config,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function listPages(): Promise<CustomPage[]> {
  await ensurePageSchema();
  const result = await getD1().prepare("SELECT * FROM custom_pages ORDER BY updated_at DESC").all<Record<string, string | null>>();
  return (result.results ?? []).map(pageRow);
}

export async function listPageWidgets(): Promise<PageWidget[]> {
  await ensurePageSchema();
  const result = await getD1().prepare("SELECT * FROM custom_page_widgets ORDER BY page_id, position").all<Record<string, string | number | null>>();
  return orderWidgets((result.results ?? []).map(widgetRow));
}

export async function createPage(input: { name: string; description: string; audience: string; defaultRange: string }) {
  await ensurePageSchema();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await getD1().prepare("INSERT INTO custom_pages(id, name, description, audience, default_range, created_at, updated_at, archived_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)")
    .bind(id, input.name, input.description, input.audience, input.defaultRange, now, now).run();
  return id;
}

export async function updatePage(id: string, input: { name: string; description: string; audience: string; defaultRange: string }) {
  await ensurePageSchema();
  await getD1().prepare("UPDATE custom_pages SET name = ?, description = ?, audience = ?, default_range = ?, updated_at = ? WHERE id = ?")
    .bind(input.name, input.description, input.audience, input.defaultRange, new Date().toISOString(), id).run();
}

export async function setPageArchived(id: string, archived: boolean) {
  await ensurePageSchema();
  const now = new Date().toISOString();
  await getD1().prepare("UPDATE custom_pages SET archived_at = ?, updated_at = ? WHERE id = ?")
    .bind(archived ? now : null, now, id).run();
}

/** Deleting a page removes its widgets; the UI confirms first. */
export async function deletePage(id: string) {
  await ensurePageSchema();
  const db = getD1();
  await db.batch([
    db.prepare("DELETE FROM custom_page_widgets WHERE page_id = ?").bind(id),
    db.prepare("DELETE FROM custom_pages WHERE id = ?").bind(id),
  ]);
}

async function touchPage(pageId: string) {
  await getD1().prepare("UPDATE custom_pages SET updated_at = ? WHERE id = ?").bind(new Date().toISOString(), pageId).run();
}

export async function addWidget(input: { pageId: string; widgetType: string; title: string; position: number; config: Record<string, unknown> }) {
  await ensurePageSchema();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const next = await getD1().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM custom_page_widgets WHERE page_id = ?")
    .bind(input.pageId).first<{ position: number }>();
  await getD1().prepare("INSERT INTO custom_page_widgets(id, page_id, widget_type, title, position, config_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.pageId, input.widgetType, input.title, Number(next?.position ?? 0), JSON.stringify(input.config), now, now).run();
  await touchPage(input.pageId);
  return id;
}

export async function updateWidget(id: string, input: { pageId: string; title: string; config: Record<string, unknown> }) {
  await ensurePageSchema();
  await getD1().prepare("UPDATE custom_page_widgets SET title = ?, config_json = ?, updated_at = ? WHERE id = ?")
    .bind(input.title, JSON.stringify(input.config), new Date().toISOString(), id).run();
  await touchPage(input.pageId);
}

export async function deleteWidget(id: string, pageId: string) {
  await ensurePageSchema();
  await getD1().prepare("DELETE FROM custom_page_widgets WHERE id = ?").bind(id).run();
  await touchPage(pageId);
}

/** Applies a densely renumbered order computed by `moveWidget`. */
export async function applyWidgetOrder(pageId: string, order: { id: string; position: number }[]) {
  await ensurePageSchema();
  if (!order.length) return;
  const db = getD1();
  const now = new Date().toISOString();
  await db.batch(order.map((row) =>
    db.prepare("UPDATE custom_page_widgets SET position = ?, updated_at = ? WHERE id = ? AND page_id = ?")
      .bind(row.position, now, row.id, pageId)));
  await touchPage(pageId);
}
