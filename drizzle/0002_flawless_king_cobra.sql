CREATE TABLE `deal_sales_snapshots` (
	`deal_id` text PRIMARY KEY NOT NULL,
	`won_at` text NOT NULL,
	`manager_id` text,
	`manager_name` text,
	`attribution_source` text NOT NULL,
	`created_at` text NOT NULL
);
