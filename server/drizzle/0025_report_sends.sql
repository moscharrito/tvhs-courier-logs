CREATE TABLE `report_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`service_date` text NOT NULL,
	`figures` text NOT NULL,
	`recipient` text NOT NULL,
	`channel` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`sent_by` text NOT NULL,
	`sent_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_sends_day_unique` ON `report_sends` (`project_id`,`service_date`);