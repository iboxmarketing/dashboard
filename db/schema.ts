import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const analyticsRecords = sqliteTable("analytics_records", {
  dealId: text("deal_id").primaryKey(),
  createdAt: text("created_at").notNull(),
  assignedManagerId: text("assigned_manager_id").notNull(),
  categoryId: text("category_id").notNull(),
  stageId: text("stage_id").notNull(),
  sourceId: text("source_id").notNull(),
  creationPeriod: text("creation_period").notNull(),
  processingSource: text("processing_source").notNull(),
  processingMinutes: integer("processing_minutes"),
  slaStatus: text("sla_status").notNull(),
  callOutcome: text("call_outcome").notNull(),
  stageBeforeCall: integer("stage_before_call", { mode: "boolean" }).notNull(),
  payload: text("payload").notNull(),
  syncedAt: text("synced_at").notNull(),
});

export const providerRules = sqliteTable("provider_rules", {
  providerKey: text("provider_key").primaryKey(),
  mode: text("mode").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const providerDiagnostics = sqliteTable("provider_diagnostics", {
  providerKey: text("provider_key").primaryKey(),
  providerId: text("provider_id").notNull(),
  providerTypeId: text("provider_type_id").notNull(),
  typeId: text("type_id").notNull(),
  direction: text("direction").notNull(),
  count: integer("count").notNull(),
  sampleSubject: text("sample_subject").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const syncState = sqliteTable("sync_state", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  lastSyncAt: text("last_sync_at"),
  lastFrom: text("last_from"),
  counts: text("counts").notNull(),
  permissions: text("permissions").notNull(),
  safeError: text("safe_error"),
  updatedAt: text("updated_at").notNull(),
});

export const syncJobs = sqliteTable("sync_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// NOTE: `synced_at` holds the sync **run id** (a UUID), not a timestamp — it is
// how a run identifies the rows it wrote. The name is historical. Renaming it
// would rewrite every row of the largest table for a cosmetic gain, so the
// column keeps its name and this comment carries the meaning. Use
// sync_state.last_sync_at for "when".
export const rawDeals = sqliteTable("raw_deals", {
  dealId: text("deal_id").primaryKey(),
  categoryId: text("category_id").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
  syncedAt: text("synced_at").notNull(),
});

export const rawActivities = sqliteTable("raw_activities", {
  rowKey: text("row_key").primaryKey(),
  dealId: text("deal_id").notNull(),
  activityId: text("activity_id").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
  syncedAt: text("synced_at").notNull(),
});

export const rawStageHistory = sqliteTable("raw_stage_history", {
  rowKey: text("row_key").primaryKey(),
  dealId: text("deal_id").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
  syncedAt: text("synced_at").notNull(),
});

export const rawCallStats = sqliteTable("raw_call_stats", {
  rowKey: text("row_key").primaryKey(),
  activityId: text("activity_id").notNull(),
  payload: text("payload").notNull(),
  syncedAt: text("synced_at").notNull(),
});

export const crmDictionaries = sqliteTable("crm_dictionaries", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const dealSalesSnapshots = sqliteTable("deal_sales_snapshots", {
  dealId: text("deal_id").primaryKey(),
  wonAt: text("won_at").notNull(),
  managerId: text("manager_id"),
  managerName: text("manager_name"),
  attributionSource: text("attribution_source").notNull(),
  createdAt: text("created_at").notNull(),
});

// Projects & Updates — management reporting. Independent of the analytics
// pipeline: no Bitrix data and no metric depends on these tables.
// `status` is free text by design; departments define their own workflows.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  deadline: text("deadline"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
});

export const projectUpdates = sqliteTable("project_updates", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  deadline: text("deadline"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Custom Pages — audience-specific management dashboards assembled from a
// fixed widget registry. `config_json` holds per-widget settings only; never
// secrets and never a formula.
export const customPages = sqliteTable("custom_pages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  audience: text("audience"),
  defaultRange: text("default_range").notNull(),
  // Only set when default_range is "custom"; inclusive Tashkent calendar dates.
  defaultFrom: text("default_from"),
  defaultTo: text("default_to"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
});

export const customPageWidgets = sqliteTable("custom_page_widgets", {
  id: text("id").primaryKey(),
  pageId: text("page_id").notNull(),
  widgetType: text("widget_type").notNull(),
  title: text("title"),
  position: integer("position").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Read-only share links for a Custom Page. Only the SHA-256 hash of a token is
// stored: the raw token is shown once, at creation, and never persisted.
// Visibility belongs to the share, not the widget, so two shares of the same
// page can expose different subsets.
export const pageShareTokens = sqliteTable("page_share_tokens", {
  id: text("id").primaryKey(),
  pageId: text("page_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  lastAccessedAt: text("last_accessed_at"),
});

export const pageShareWidgets = sqliteTable("page_share_widgets", {
  shareId: text("share_id").notNull(),
  widgetId: text("widget_id").notNull(),
});
