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
