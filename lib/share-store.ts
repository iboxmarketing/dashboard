import { orderWidgets, type CustomPage, type PageWidget, type WidgetType } from "./custom-pages";
import { generateShareToken, hashShareToken, normalizeShareToken, shareStatus, type PageShare } from "./share-tokens";

/**
 * SQL layer for share links, written against the minimum D1 surface it needs
 * rather than against the binding itself.
 *
 * Injecting the handle keeps this module free of `cloudflare:workers`, so the
 * hash lookup, revocation, expiry and archived-page rules can be exercised
 * against a real SQL engine in tests instead of being asserted by inspection.
 */
export type ShareStatement = {
  bind(...values: unknown[]): ShareStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type ShareDb = {
  prepare(sql: string): ShareStatement;
  batch(statements: ShareStatement[]): Promise<unknown>;
};

export async function ensureShareSchema(db: ShareDb) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS page_share_tokens (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES custom_pages(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_accessed_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS page_share_widgets (share_id TEXT NOT NULL REFERENCES page_share_tokens(id) ON DELETE CASCADE, widget_id TEXT NOT NULL REFERENCES custom_page_widgets(id) ON DELETE CASCADE, PRIMARY KEY (share_id, widget_id))"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS page_share_tokens_hash_idx ON page_share_tokens(token_hash)"),
    db.prepare("CREATE INDEX IF NOT EXISTS page_share_tokens_page_idx ON page_share_tokens(page_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS page_share_widgets_share_idx ON page_share_widgets(share_id)"),
  ]);
}

/** Explicit column list: `token_hash` is never selected onto a caller path. */
const SHARE_COLUMNS = "id, page_id, label, created_at, expires_at, revoked_at, last_accessed_at";

const shareRow = (row: Record<string, unknown>, widgetIds: string[]): PageShare => ({
  id: String(row.id), pageId: String(row.page_id), label: String(row.label ?? ""),
  createdAt: String(row.created_at),
  expiresAt: row.expires_at ? String(row.expires_at) : null,
  revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
  widgetIds,
});

async function widgetIdsByShare(db: ShareDb): Promise<Map<string, string[]>> {
  const result = await db.prepare("SELECT share_id, widget_id FROM page_share_widgets")
    .all<{ share_id: string; widget_id: string }>();
  const map = new Map<string, string[]>();
  for (const row of result.results ?? []) {
    const list = map.get(row.share_id) ?? [];
    list.push(row.widget_id);
    map.set(row.share_id, list);
  }
  return map;
}

/** Management listing. Returns metadata only — never a token or a hash. */
export async function listShares(db: ShareDb): Promise<PageShare[]> {
  await ensureShareSchema(db);
  const [result, widgets] = await Promise.all([
    db.prepare(`SELECT ${SHARE_COLUMNS} FROM page_share_tokens ORDER BY created_at DESC`).all(),
    widgetIdsByShare(db),
  ]);
  return (result.results ?? []).map((row) => shareRow(row, (widgets.get(String(row.id)) ?? []).slice().sort()));
}

async function setShareWidgets(db: ShareDb, shareId: string, widgetIds: string[]) {
  await db.batch([
    db.prepare("DELETE FROM page_share_widgets WHERE share_id = ?").bind(shareId),
    ...widgetIds.map((widgetId) =>
      db.prepare("INSERT OR IGNORE INTO page_share_widgets(share_id, widget_id) VALUES(?, ?)").bind(shareId, widgetId)),
  ]);
}

/**
 * Creates a share and returns the raw token exactly once. Only the hash is
 * bound to the INSERT, so the token has no representation in the database.
 */
export async function createShare(
  db: ShareDb,
  input: { pageId: string; label: string; expiresAt: string | null; widgetIds: string[] },
  ids: { id?: string; token?: string; now?: string } = {},
) {
  await ensureShareSchema(db);
  const token = ids.token ?? generateShareToken();
  const id = ids.id ?? crypto.randomUUID();
  await db.prepare("INSERT INTO page_share_tokens(id, page_id, token_hash, label, created_at, expires_at, revoked_at, last_accessed_at) VALUES(?, ?, ?, ?, ?, ?, NULL, NULL)")
    .bind(id, input.pageId, await hashShareToken(token), input.label, ids.now ?? new Date().toISOString(), input.expiresAt).run();
  await setShareWidgets(db, id, input.widgetIds);
  return { id, token };
}

/** Label, expiry and widget visibility are editable; the token is not. */
export async function updateShare(db: ShareDb, id: string, input: { label: string; expiresAt: string | null; widgetIds: string[] }) {
  await ensureShareSchema(db);
  await db.prepare("UPDATE page_share_tokens SET label = ?, expires_at = ? WHERE id = ?")
    .bind(input.label, input.expiresAt, id).run();
  await setShareWidgets(db, id, input.widgetIds);
}

/** Irreversible by design: revoking is the kill switch for a leaked link. */
export async function revokeShare(db: ShareDb, id: string, now: string = new Date().toISOString()) {
  await ensureShareSchema(db);
  await db.prepare("UPDATE page_share_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(now, id).run();
}

export async function getShare(db: ShareDb, id: string): Promise<PageShare | null> {
  await ensureShareSchema(db);
  const row = await db.prepare(`SELECT ${SHARE_COLUMNS} FROM page_share_tokens WHERE id = ?`).bind(id).first();
  if (!row) return null;
  const widgets = await db.prepare("SELECT widget_id FROM page_share_widgets WHERE share_id = ?")
    .bind(id).all<{ widget_id: string }>();
  return shareRow(row, (widgets.results ?? []).map((widget) => widget.widget_id).sort());
}

export type ResolvedShare = { share: PageShare; page: CustomPage; widgets: PageWidget[] };

/**
 * The public lookup: raw token → SHA-256 → row. Anything unusable — unknown,
 * revoked, expired, or belonging to an archived page — resolves to null with
 * no distinction, so a probe learns nothing about which tokens exist.
 */
export async function resolveShareByToken(db: ShareDb, rawToken: string, now: Date = new Date()): Promise<ResolvedShare | null> {
  const token = normalizeShareToken(rawToken);
  if (!token) return null;
  await ensureShareSchema(db);

  const row = await db.prepare(`SELECT ${SHARE_COLUMNS} FROM page_share_tokens WHERE token_hash = ?`)
    .bind(await hashShareToken(token)).first();
  if (!row) return null;

  const shareId = String(row.id);
  const [widgetRows, page] = await Promise.all([
    db.prepare("SELECT widget_id FROM page_share_widgets WHERE share_id = ?").bind(shareId).all<{ widget_id: string }>(),
    db.prepare("SELECT * FROM custom_pages WHERE id = ?").bind(String(row.page_id)).first(),
  ]);

  const share = shareRow(row, (widgetRows.results ?? []).map((widget) => widget.widget_id));
  if (shareStatus(share, now) !== "ACTIVE") return null;
  if (!page || page.archived_at) return null;

  const widgets = await db.prepare("SELECT * FROM custom_page_widgets WHERE page_id = ? ORDER BY position")
    .bind(String(page.id)).all();

  return {
    share,
    page: {
      id: String(page.id), name: String(page.name), description: String(page.description ?? ""),
      audience: String(page.audience ?? ""), defaultRange: String(page.default_range ?? "30"),
      createdAt: String(page.created_at), updatedAt: String(page.updated_at), archivedAt: null,
    },
    widgets: orderWidgets((widgets.results ?? []).map((widget) => {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(String(widget.config_json ?? "{}")) as Record<string, unknown>; } catch { config = {}; }
      return {
        id: String(widget.id), pageId: String(widget.page_id), widgetType: String(widget.widget_type) as WidgetType,
        title: String(widget.title ?? ""), position: Number(widget.position ?? 0), config,
        createdAt: String(widget.created_at), updatedAt: String(widget.updated_at),
      };
    })),
  };
}

/** Best-effort access stamp. Never records the token, the path or the caller. */
export async function touchShareAccess(db: ShareDb, shareId: string, now: string = new Date().toISOString()) {
  try {
    await db.prepare("UPDATE page_share_tokens SET last_accessed_at = ? WHERE id = ?").bind(now, shareId).run();
  } catch {
    /* a shared page must still render if the stamp cannot be written */
  }
}

/** Called before a page or widget row disappears, for stores without cascade. */
export async function deleteSharesForPage(db: ShareDb, pageId: string) {
  await ensureShareSchema(db);
  await db.batch([
    db.prepare("DELETE FROM page_share_widgets WHERE share_id IN (SELECT id FROM page_share_tokens WHERE page_id = ?)").bind(pageId),
    db.prepare("DELETE FROM page_share_tokens WHERE page_id = ?").bind(pageId),
  ]);
}

export async function deleteShareWidgetLinks(db: ShareDb, widgetId: string) {
  await ensureShareSchema(db);
  await db.prepare("DELETE FROM page_share_widgets WHERE widget_id = ?").bind(widgetId).run();
}
