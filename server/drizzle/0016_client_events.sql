CREATE TABLE `client_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`client_event_id` text NOT NULL,
	`username` text NOT NULL,
	`method` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'in_progress' NOT NULL,
	`status` integer,
	`response` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "client_events_state_check" CHECK("client_events"."state" IN ('in_progress','done'))
);
--> statement-breakpoint
CREATE INDEX `client_events_created_idx` ON `client_events` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_events_key_unique` ON `client_events` (`project_id`,`client_event_id`);