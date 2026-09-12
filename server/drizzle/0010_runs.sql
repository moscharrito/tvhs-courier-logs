CREATE TABLE `run_stops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_stops_run_seq_idx` ON `run_stops` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_stops_order_unique` ON `run_stops` (`project_id`,`order_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`courier_username` text NOT NULL,
	`service_date` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`started_at` text,
	`completed_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_status_check" CHECK("runs"."status" IN ('planned','started','completed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `runs_project_date_idx` ON `runs` (`project_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `runs_courier_date_idx` ON `runs` (`courier_username`,`service_date`);