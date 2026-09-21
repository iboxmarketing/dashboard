CREATE TABLE `finance_currencies` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`minor_unit` integer NOT NULL,
	`symbol` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	CHECK (`minor_unit` >= 0 AND `minor_unit` <= 6),
	CHECK (`archived` IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `finance_currencies` (`code`, `name`, `minor_unit`, `symbol`, `archived`) VALUES
	('UZS', 'Uzbekistani som', 2, 'so‘m', 0),
	('USD', 'US dollar', 2, '$', 0),
	('EUR', 'Euro', 2, '€', 0),
	('KZT', 'Kazakhstani tenge', 2, '₸', 0);
--> statement-breakpoint
CREATE TABLE `finance_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency_code` text NOT NULL,
	`opening_balance_minor` integer NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`currency_code`) REFERENCES `finance_currencies`(`code`) ON UPDATE restrict ON DELETE restrict,
	CHECK (`type` IN ('CASH', 'BANK', 'CARD', 'OTHER')),
	CHECK (`archived` IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `finance_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `finance_categories`(`id`) ON UPDATE restrict ON DELETE restrict,
	CHECK (`kind` IN ('INCOME', 'EXPENSE')),
	CHECK (`archived` IN (0, 1)),
	CHECK (`sort_order` >= 0),
	CHECK (`parent_id` IS NULL OR `parent_id` <> `id`)
);
--> statement-breakpoint
CREATE TABLE `finance_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`archived` IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `finance_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`project_id` text,
	`account_id` text,
	`amount_minor` integer,
	`currency_code` text,
	`category_id` text,
	`from_account_id` text,
	`to_account_id` text,
	`source_amount_minor` integer,
	`source_currency_code` text,
	`destination_amount_minor` integer,
	`destination_currency_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `finance_projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `finance_categories`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`from_account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`to_account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `finance_currencies`(`code`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`source_currency_code`) REFERENCES `finance_currencies`(`code`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`destination_currency_code`) REFERENCES `finance_currencies`(`code`) ON UPDATE restrict ON DELETE restrict,
	CHECK (`type` IN ('INCOME', 'EXPENSE', 'TRANSFER')),
	CHECK (
		(`type` IN ('INCOME', 'EXPENSE') AND `account_id` IS NOT NULL AND `amount_minor` > 0 AND `currency_code` IS NOT NULL AND `category_id` IS NOT NULL
			AND `from_account_id` IS NULL AND `to_account_id` IS NULL AND `source_amount_minor` IS NULL AND `source_currency_code` IS NULL
			AND `destination_amount_minor` IS NULL AND `destination_currency_code` IS NULL)
		OR
		(`type` = 'TRANSFER' AND `account_id` IS NULL AND `amount_minor` IS NULL AND `currency_code` IS NULL AND `category_id` IS NULL
			AND `from_account_id` IS NOT NULL AND `to_account_id` IS NOT NULL AND `from_account_id` <> `to_account_id`
			AND `source_amount_minor` > 0 AND `source_currency_code` IS NOT NULL
			AND `destination_amount_minor` > 0 AND `destination_currency_code` IS NOT NULL)
	),
	CHECK (`type` <> 'TRANSFER' OR `source_currency_code` <> `destination_currency_code` OR `source_amount_minor` = `destination_amount_minor`)
);
--> statement-breakpoint
CREATE TABLE `finance_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`account_id` text NOT NULL,
	`category_id` text NOT NULL,
	`project_id` text,
	`amount_minor` integer NOT NULL,
	`currency_code` text NOT NULL,
	`cadence` text NOT NULL,
	`interval_months` integer,
	`next_due_date` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `finance_categories`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `finance_projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `finance_currencies`(`code`) ON UPDATE restrict ON DELETE restrict,
	CHECK (`direction` IN ('INCOME', 'EXPENSE')),
	CHECK (`amount_minor` > 0),
	CHECK (`cadence` IN ('MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM_MONTHS')),
	CHECK ((`cadence` = 'CUSTOM_MONTHS' AND `interval_months` BETWEEN 1 AND 120) OR (`cadence` <> 'CUSTOM_MONTHS' AND `interval_months` IS NULL)),
	CHECK (`end_date` IS NULL OR `end_date` >= `start_date`),
	CHECK (`next_due_date` >= `start_date` AND (`end_date` IS NULL OR `next_due_date` <= `end_date`)),
	CHECK (`archived` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `finance_transactions_date_idx` ON `finance_transactions` (`date`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_account_idx` ON `finance_transactions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_from_account_idx` ON `finance_transactions` (`from_account_id`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_to_account_idx` ON `finance_transactions` (`to_account_id`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_category_idx` ON `finance_transactions` (`category_id`);
--> statement-breakpoint
CREATE INDEX `finance_transactions_project_idx` ON `finance_transactions` (`project_id`);
--> statement-breakpoint
CREATE INDEX `finance_categories_parent_idx` ON `finance_categories` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `finance_categories_kind_idx` ON `finance_categories` (`kind`);
--> statement-breakpoint
CREATE INDEX `finance_subscriptions_next_due_idx` ON `finance_subscriptions` (`next_due_date`);
--> statement-breakpoint
CREATE INDEX `finance_subscriptions_account_idx` ON `finance_subscriptions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `finance_subscriptions_category_idx` ON `finance_subscriptions` (`category_id`);
--> statement-breakpoint
CREATE INDEX `finance_subscriptions_project_idx` ON `finance_subscriptions` (`project_id`);
--> statement-breakpoint
CREATE TRIGGER `finance_accounts_currency_lock`
BEFORE UPDATE OF `currency_code` ON `finance_accounts`
WHEN OLD.`currency_code` <> NEW.`currency_code` AND EXISTS (
	SELECT 1 FROM `finance_transactions`
	WHERE `account_id` = OLD.`id` OR `from_account_id` = OLD.`id` OR `to_account_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'finance account currency is locked after use');
END;
--> statement-breakpoint
CREATE TRIGGER `finance_categories_insert_hierarchy`
BEFORE INSERT ON `finance_categories`
WHEN NEW.`parent_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `finance_categories` parent
	WHERE parent.`id` = NEW.`parent_id` AND parent.`parent_id` IS NULL AND parent.`kind` = NEW.`kind`
)
BEGIN
	SELECT RAISE(ABORT, 'finance category parent must be a same-kind root');
END;
--> statement-breakpoint
CREATE TRIGGER `finance_categories_update_hierarchy`
BEFORE UPDATE OF `parent_id`, `kind` ON `finance_categories`
WHEN (NEW.`parent_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `finance_categories` parent
	WHERE parent.`id` = NEW.`parent_id` AND parent.`parent_id` IS NULL AND parent.`kind` = NEW.`kind`
)) OR EXISTS (
	SELECT 1 FROM `finance_categories` child
	WHERE child.`parent_id` = OLD.`id` AND (NEW.`parent_id` IS NOT NULL OR child.`kind` <> NEW.`kind`)
)
BEGIN
	SELECT RAISE(ABORT, 'finance category hierarchy would become invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `finance_transactions_reference_guard_insert`
BEFORE INSERT ON `finance_transactions`
WHEN
	(NEW.`project_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `finance_projects` WHERE `id` = NEW.`project_id` AND `archived` = 0))
	OR (NEW.`type` IN ('INCOME', 'EXPENSE') AND NOT EXISTS (
		SELECT 1 FROM `finance_accounts` account JOIN `finance_categories` category
		WHERE account.`id` = NEW.`account_id` AND account.`archived` = 0 AND account.`currency_code` = NEW.`currency_code`
			AND category.`id` = NEW.`category_id` AND category.`archived` = 0 AND category.`kind` = NEW.`type`
	))
	OR (NEW.`type` = 'TRANSFER' AND (
		NOT EXISTS (SELECT 1 FROM `finance_accounts` WHERE `id` = NEW.`from_account_id` AND `archived` = 0 AND `currency_code` = NEW.`source_currency_code`)
		OR NOT EXISTS (SELECT 1 FROM `finance_accounts` WHERE `id` = NEW.`to_account_id` AND `archived` = 0 AND `currency_code` = NEW.`destination_currency_code`)
	))
BEGIN
	SELECT RAISE(ABORT, 'finance transaction references are invalid or archived');
END;
--> statement-breakpoint
CREATE TRIGGER `finance_transactions_reference_guard_update`
BEFORE UPDATE ON `finance_transactions`
WHEN
	(NEW.`project_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `finance_projects` WHERE `id` = NEW.`project_id` AND `archived` = 0))
	OR (NEW.`type` IN ('INCOME', 'EXPENSE') AND NOT EXISTS (
		SELECT 1 FROM `finance_accounts` account JOIN `finance_categories` category
		WHERE account.`id` = NEW.`account_id` AND account.`archived` = 0 AND account.`currency_code` = NEW.`currency_code`
			AND category.`id` = NEW.`category_id` AND category.`archived` = 0 AND category.`kind` = NEW.`type`
	))
	OR (NEW.`type` = 'TRANSFER' AND (
		NOT EXISTS (SELECT 1 FROM `finance_accounts` WHERE `id` = NEW.`from_account_id` AND `archived` = 0 AND `currency_code` = NEW.`source_currency_code`)
		OR NOT EXISTS (SELECT 1 FROM `finance_accounts` WHERE `id` = NEW.`to_account_id` AND `archived` = 0 AND `currency_code` = NEW.`destination_currency_code`)
	))
BEGIN
	SELECT RAISE(ABORT, 'finance transaction references are invalid or archived');
END;
--> statement-breakpoint
CREATE TRIGGER `finance_subscriptions_reference_guard_insert`
BEFORE INSERT ON `finance_subscriptions`
WHEN NOT EXISTS (
	SELECT 1 FROM `finance_accounts` account JOIN `finance_categories` category
	WHERE account.`id` = NEW.`account_id` AND account.`archived` = 0 AND account.`currency_code` = NEW.`currency_code`
		AND category.`id` = NEW.`category_id` AND category.`archived` = 0 AND category.`kind` = NEW.`direction`
) OR (NEW.`project_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `finance_projects` WHERE `id` = NEW.`project_id` AND `archived` = 0))
BEGIN
	SELECT RAISE(ABORT, 'finance subscription references are invalid or archived');
END;
--> statement-breakpoint
CREATE TRIGGER `finance_subscriptions_reference_guard_update`
BEFORE UPDATE ON `finance_subscriptions`
WHEN NOT EXISTS (
	SELECT 1 FROM `finance_accounts` account JOIN `finance_categories` category
	WHERE account.`id` = NEW.`account_id` AND account.`archived` = 0 AND account.`currency_code` = NEW.`currency_code`
		AND category.`id` = NEW.`category_id` AND category.`archived` = 0 AND category.`kind` = NEW.`direction`
) OR (NEW.`project_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `finance_projects` WHERE `id` = NEW.`project_id` AND `archived` = 0))
BEGIN
	SELECT RAISE(ABORT, 'finance subscription references are invalid or archived');
END;
