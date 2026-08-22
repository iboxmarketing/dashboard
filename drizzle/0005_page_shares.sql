CREATE TABLE `page_share_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_accessed_at` text,
	FOREIGN KEY (`page_id`) REFERENCES `custom_pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `page_share_widgets` (
	`share_id` text NOT NULL,
	`widget_id` text NOT NULL,
	PRIMARY KEY(`share_id`, `widget_id`),
	FOREIGN KEY (`share_id`) REFERENCES `page_share_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`widget_id`) REFERENCES `custom_page_widgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_share_tokens_hash_idx` ON `page_share_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `page_share_tokens_page_idx` ON `page_share_tokens` (`page_id`);--> statement-breakpoint
CREATE INDEX `page_share_widgets_share_idx` ON `page_share_widgets` (`share_id`);
