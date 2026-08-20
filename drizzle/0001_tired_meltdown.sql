CREATE TABLE `crm_dictionaries` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_activities` (
	`row_key` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_call_stats` (
	`row_key` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`payload` text NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_deals` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_stage_history` (
	`row_key` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
