-- Sales Owner at Won migration: admin seller confirmations and the append-only
-- attribution audit trail.
--
-- Both tables are also created by `ensureSchema()` at runtime, so a database
-- that never ran migrations still works; they are declared here so a remote D1
-- gets them deterministically and reviewably. Additive only: no existing table
-- is touched, and nothing in the attribution audit is ever deleted.
CREATE TABLE IF NOT EXISTS `seller_confirmations` (
  `deal_id` text PRIMARY KEY NOT NULL,
  `seller_id` text NOT NULL,
  `seller_name` text,
  `confirmed_by` text NOT NULL,
  `confirmed_at` text NOT NULL,
  `prior_evidence` text,
  `bitrix_write_status` text,
  `bitrix_write_at` text,
  `bitrix_error_code` text
);
CREATE TABLE IF NOT EXISTS `seller_attribution_audit` (
  `row_key` text PRIMARY KEY NOT NULL,
  `deal_id` text NOT NULL,
  `recorded_at` text NOT NULL,
  `actor` text NOT NULL,
  `action` text NOT NULL,
  `payload` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `seller_audit_deal_idx` ON `seller_attribution_audit` (`deal_id`);
