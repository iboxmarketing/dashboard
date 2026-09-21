import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
  /** Whose current access a public read is re-checked against (0010). */
  ownerUserId: text("owner_user_id"),
});

export const pageShareWidgets = sqliteTable("page_share_widgets", {
  shareId: text("share_id").notNull(),
  widgetId: text("widget_id").notNull(),
});

// Finance is an independent ledger domain. No Finance table references CRM,
// analytics_records, Sales snapshots, or the management `projects` table.
export const financeCurrencies = sqliteTable("finance_currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  minorUnit: integer("minor_unit").notNull(),
  symbol: text("symbol").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  check("finance_currencies_minor_unit_check", sql`${table.minorUnit} BETWEEN 0 AND 6`),
]);

export const financeAccounts = sqliteTable("finance_accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  currencyCode: text("currency_code").notNull().references(() => financeCurrencies.code, { onDelete: "restrict", onUpdate: "restrict" }),
  openingBalanceMinor: integer("opening_balance_minor").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const financeCategories = sqliteTable("finance_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  parentId: text("parent_id").references((): AnySQLiteColumn => financeCategories.id, { onDelete: "restrict", onUpdate: "restrict" }),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  index("finance_categories_parent_idx").on(table.parentId),
  index("finance_categories_kind_idx").on(table.kind),
]);

export const financeProjects = sqliteTable("finance_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const financeTransactions = sqliteTable("finance_transactions", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  note: text("note").notNull().default(""),
  projectId: text("project_id").references(() => financeProjects.id, { onDelete: "restrict", onUpdate: "restrict" }),
  accountId: text("account_id").references(() => financeAccounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  amountMinor: integer("amount_minor"),
  currencyCode: text("currency_code").references(() => financeCurrencies.code, { onDelete: "restrict", onUpdate: "restrict" }),
  categoryId: text("category_id").references(() => financeCategories.id, { onDelete: "restrict", onUpdate: "restrict" }),
  fromAccountId: text("from_account_id").references(() => financeAccounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  toAccountId: text("to_account_id").references(() => financeAccounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  sourceAmountMinor: integer("source_amount_minor"),
  sourceCurrencyCode: text("source_currency_code").references(() => financeCurrencies.code, { onDelete: "restrict", onUpdate: "restrict" }),
  destinationAmountMinor: integer("destination_amount_minor"),
  destinationCurrencyCode: text("destination_currency_code").references(() => financeCurrencies.code, { onDelete: "restrict", onUpdate: "restrict" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("finance_transactions_date_idx").on(table.date),
  index("finance_transactions_account_idx").on(table.accountId),
  index("finance_transactions_from_account_idx").on(table.fromAccountId),
  index("finance_transactions_to_account_idx").on(table.toAccountId),
  index("finance_transactions_category_idx").on(table.categoryId),
  index("finance_transactions_project_idx").on(table.projectId),
]);

export const financeSubscriptions = sqliteTable("finance_subscriptions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  direction: text("direction").notNull(),
  accountId: text("account_id").notNull().references(() => financeAccounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  categoryId: text("category_id").notNull().references(() => financeCategories.id, { onDelete: "restrict", onUpdate: "restrict" }),
  projectId: text("project_id").references(() => financeProjects.id, { onDelete: "restrict", onUpdate: "restrict" }),
  amountMinor: integer("amount_minor").notNull(),
  currencyCode: text("currency_code").notNull().references(() => financeCurrencies.code, { onDelete: "restrict", onUpdate: "restrict" }),
  cadence: text("cadence").notNull(),
  intervalMonths: integer("interval_months"),
  nextDueDate: text("next_due_date").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("finance_subscriptions_next_due_idx").on(table.nextDueDate),
  index("finance_subscriptions_account_idx").on(table.accountId),
  index("finance_subscriptions_category_idx").on(table.categoryId),
  index("finance_subscriptions_project_idx").on(table.projectId),
]);

// Authentication is isolated from CRM analytics and Finance. Password hashes
// are one-way KDF outputs; raw session tokens never enter this schema.
export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastLoginAt: text("last_login_at"),
}, (table) => [
  uniqueIndex("app_users_email_idx").on(table.email),
  check("app_users_role_check", sql`${table.role} IN ('ADMIN', 'MEMBER')`),
]);

export const appUserPermissions = sqliteTable("app_user_permissions", {
  userId: text("user_id").notNull().references(() => appUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
  permissionKey: text("permission_key").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("app_user_permissions_user_key_idx").on(table.userId, table.permissionKey),
  index("app_user_permissions_user_idx").on(table.userId),
  check("app_user_permissions_key_check", sql`${table.permissionKey} IN ('dashboard','managers','leadFlow','quality','stages','deals','finance','projects','pages','diagnostics','settings','users')`),
]);

export const appSessions = sqliteTable("app_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userId: text("user_id").notNull().references(() => appUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("app_sessions_token_hash_idx").on(table.tokenHash),
  index("app_sessions_user_idx").on(table.userId),
  index("app_sessions_expiry_idx").on(table.expiresAt),
]);

export const appLoginAttempts = sqliteTable("app_login_attempts", {
  keyHash: text("key_hash").primaryKey(),
  failureCount: integer("failure_count").notNull(),
  windowStartedAt: text("window_started_at").notNull(),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
});
