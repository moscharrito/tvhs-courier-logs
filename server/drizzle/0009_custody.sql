CREATE TABLE `custody_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`package_id` integer,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`actor` text DEFAULT '' NOT NULL,
	`from_status` text DEFAULT '' NOT NULL,
	`to_status` text DEFAULT '' NOT NULL,
	`signed_name` text DEFAULT '' NOT NULL,
	`signature_key` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`lat` real,
	`lng` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "custody_events_type_check" CHECK("custody_events"."type" IN ('created','released','assigned','unassigned','picked_up','arrived','delivered','attempted','returned','cancelled','note'))
);
--> statement-breakpoint
CREATE INDEX `custody_events_order_idx` ON `custody_events` (`order_id`,`at`);--> statement-breakpoint
CREATE INDEX `custody_events_project_at_idx` ON `custody_events` (`project_id`,`at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `assigned_to_username` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `assigned_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `picked_up_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `received_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `failure_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `returned_at` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`signature_required` integer DEFAULT true NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "packages_outcome_check" CHECK("__new_packages"."outcome" IN ('pending','delivered','failed'))
);
--> statement-breakpoint
-- Hand-corrected. drizzle-kit generated this SELECT reading "outcome" from
-- the old packages table, which does not have that column yet, so the
-- migration failed on any database that already held imported packages.
-- Every existing package predates the outcome column and so is 'pending'.
INSERT INTO `__new_packages`("id", "project_id", "order_id", "description", "quantity", "signature_required", "outcome", "created_at") SELECT "id", "project_id", "order_id", "description", "quantity", "signature_required", 'pending', "created_at" FROM `packages`;--> statement-breakpoint
DROP TABLE `packages`;--> statement-breakpoint
ALTER TABLE `__new_packages` RENAME TO `packages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `packages_order_idx` ON `packages` (`order_id`);
--> statement-breakpoint
-- Scope 1.2.7: the chain of custody must be secured and available for
-- regulatory audit. A custody record that can be edited after the fact is not
-- evidence, so the table is append-only in the database and not merely by
-- convention, the same way audit_events is (migration 0004).
CREATE TRIGGER custody_events_no_update BEFORE UPDATE ON custody_events
BEGIN
	SELECT RAISE(ABORT, 'custody_events is append-only');
END;--> statement-breakpoint
CREATE TRIGGER custody_events_no_delete BEFORE DELETE ON custody_events
BEGIN
	SELECT RAISE(ABORT, 'custody_events is append-only');
END;
