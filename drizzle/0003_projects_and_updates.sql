CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`deadline` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `project_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`deadline` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_status_idx` ON `projects` (`status`);--> statement-breakpoint
CREATE INDEX `projects_deadline_idx` ON `projects` (`deadline`);--> statement-breakpoint
CREATE INDEX `projects_created_idx` ON `projects` (`created_at`);--> statement-breakpoint
CREATE INDEX `projects_updated_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE INDEX `project_updates_project_idx` ON `project_updates` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_updates_status_idx` ON `project_updates` (`status`);--> statement-breakpoint
CREATE INDEX `project_updates_deadline_idx` ON `project_updates` (`deadline`);--> statement-breakpoint
CREATE INDEX `project_updates_created_idx` ON `project_updates` (`created_at`);--> statement-breakpoint
CREATE INDEX `project_updates_updated_idx` ON `project_updates` (`updated_at`);
