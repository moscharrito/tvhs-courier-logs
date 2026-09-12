PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_signatures` (
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
	CONSTRAINT "signatures_kind_check" CHECK("__new_signatures"."kind" IN ('pickup','delivery','return'))
);
--> statement-breakpoint
INSERT INTO `__new_signatures`("id", "project_id", "kind", "signed_name", "strokes", "captured_by", "captured_at", "lat", "lng", "created_at") SELECT "id", "project_id", "kind", "signed_name", "strokes", "captured_by", "captured_at", "lat", "lng", "created_at" FROM `signatures`;--> statement-breakpoint
DROP TABLE `signatures`;--> statement-breakpoint
ALTER TABLE `__new_signatures` RENAME TO `signatures`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `signatures_project_idx` ON `signatures` (`project_id`,`captured_at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `returned_to_site_id` integer REFERENCES sites(id);--> statement-breakpoint
ALTER TABLE `orders` ADD `returned_by` text DEFAULT '' NOT NULL;