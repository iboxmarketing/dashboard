CREATE TABLE `custom_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`audience` text,
	`default_range` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `custom_page_widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`widget_type` text NOT NULL,
	`title` text,
	`position` integer NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `custom_pages_updated_idx` ON `custom_pages` (`updated_at`);--> statement-breakpoint
CREATE INDEX `custom_page_widgets_page_idx` ON `custom_page_widgets` (`page_id`);--> statement-breakpoint
CREATE INDEX `custom_page_widgets_position_idx` ON `custom_page_widgets` (`page_id`,`position`);
