CREATE TABLE `retention_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ran_at` text NOT NULL,
	`started_by` text NOT NULL,
	`category` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `retention_runs_ran_at_idx` ON `retention_runs` (`ran_at`);