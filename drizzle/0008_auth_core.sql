CREATE TABLE `app_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`must_change_password` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_login_at` text,
	CONSTRAINT `app_users_role_check` CHECK (`role` IN ('ADMIN', 'MEMBER')),
	CONSTRAINT `app_users_must_change_check` CHECK (`must_change_password` IN (0, 1)),
	CONSTRAINT `app_users_active_check` CHECK (`active` IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_email_idx` ON `app_users` (`email` COLLATE NOCASE);
--> statement-breakpoint
CREATE TABLE `app_user_permissions` (
	`user_id` text NOT NULL,
	`permission_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT `app_user_permissions_key_check` CHECK (`permission_key` IN ('dashboard','managers','leadFlow','quality','stages','deals','finance','projects','pages','diagnostics','settings','users'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_permissions_user_key_idx` ON `app_user_permissions` (`user_id`, `permission_key`);
--> statement-breakpoint
CREATE INDEX `app_user_permissions_user_idx` ON `app_user_permissions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_sessions_token_hash_idx` ON `app_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `app_sessions_user_idx` ON `app_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `app_sessions_expiry_idx` ON `app_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `app_login_attempts` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`failure_count` integer NOT NULL,
	`window_started_at` text NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `app_login_attempts_count_check` CHECK (`failure_count` >= 0 AND `failure_count` <= 100)
);
