CREATE TABLE `signatures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`signed_name` text NOT NULL,
	`strokes` text DEFAULT '[]' NOT NULL,
	`captured_by` text DEFAULT '' NOT NULL,
	`captured_at` text NOT NULL,
	`lat` real,
	`lng` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signatures_kind_check" CHECK("signatures"."kind" IN ('pickup','delivery'))
);
--> statement-breakpoint
CREATE INDEX `signatures_project_idx` ON `signatures` (`project_id`,`captured_at`);