CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer,
	`kind` text NOT NULL,
	`s3_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`stored_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "files_kind_check" CHECK("files"."kind" IN ('doorstep','pod','exception','signature')),
	CONSTRAINT "files_status_check" CHECK("files"."status" IN ('pending','stored'))
);
--> statement-breakpoint
CREATE INDEX `files_order_idx` ON `files` (`order_id`);--> statement-breakpoint
CREATE INDEX `files_project_status_idx` ON `files` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_key_unique` ON `files` (`s3_key`);