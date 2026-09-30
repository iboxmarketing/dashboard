-- Subscription occurrences: one row per (subscription, due date).
--
-- A subscription stays a template. When its due date arrives the scheduler
-- creates exactly one occurrence for that date and checks the linked account's
-- balance ONCE. The occurrence carries the draft until the owner confirms the
-- real card/bank charge, and only then is a canonical Expense posted.
--
-- The primary key IS the identity the owner named — subscription + due date — so
-- a scheduler rerun, a double-clicked Retry or a retried network request can
-- never produce a second occurrence, a second draft or a second Expense.
--
-- Additive: no existing table is touched, and no historical period is
-- backfilled. Apply once per database before deploying the build that reads it.
CREATE TABLE IF NOT EXISTS `finance_subscription_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text NOT NULL,
	`direction` text NOT NULL,
	`account_id` text NOT NULL,
	`category_id` text NOT NULL,
	`project_id` text,
	`amount_minor` integer NOT NULL,
	`currency_code` text NOT NULL,
	`available_balance_minor` integer,
	`missing_amount_minor` integer,
	`balance_checked_at` text,
	`transaction_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`subscription_id`) REFERENCES `finance_subscriptions`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `finance_categories`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `finance_projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`transaction_id`) REFERENCES `finance_transactions`(`id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `finance_occurrence_identity_idx` ON `finance_subscription_occurrences` (`subscription_id`, `due_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `finance_occurrence_status_idx` ON `finance_subscription_occurrences` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `finance_occurrence_due_idx` ON `finance_subscription_occurrences` (`due_date`);
