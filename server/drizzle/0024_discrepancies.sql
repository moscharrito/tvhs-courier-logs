CREATE TABLE `discrepancies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`service_date` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`order_id` integer,
	`expected` text NOT NULL,
	`actual` text NOT NULL,
	`reported_by` text NOT NULL,
	`reported_at` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text DEFAULT '' NOT NULL,
	`resolved_by` text DEFAULT '' NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discrepancies_project_date_idx` ON `discrepancies` (`project_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `discrepancies_status_idx` ON `discrepancies` (`project_id`,`status`);