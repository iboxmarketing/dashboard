CREATE TABLE `analytics_records` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`assigned_manager_id` text NOT NULL,
	`category_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`source_id` text NOT NULL,
	`creation_period` text NOT NULL,
	`processing_source` text NOT NULL,
	`processing_minutes` integer,
	`sla_status` text NOT NULL,
	`call_outcome` text NOT NULL,
	`stage_before_call` integer NOT NULL,
	`payload` text NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_diagnostics` (
	`provider_key` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider_type_id` text NOT NULL,
	`type_id` text NOT NULL,
	`direction` text NOT NULL,
	`count` integer NOT NULL,
	`sample_subject` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_rules` (
	`provider_key` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`last_sync_at` text,
	`last_from` text,
	`counts` text NOT NULL,
	`permissions` text NOT NULL,
	`safe_error` text,
	`updated_at` text NOT NULL
);
