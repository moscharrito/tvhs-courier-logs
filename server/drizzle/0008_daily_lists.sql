CREATE TABLE `daily_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`service_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`received_at` text NOT NULL,
	`source_filename` text DEFAULT '' NOT NULL,
	`source_sha256` text DEFAULT '' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`imported_by` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "daily_lists_status_check" CHECK("daily_lists"."status" IN ('draft','released','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `daily_lists_project_date_idx` ON `daily_lists` (`project_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `daily_lists_site_date_idx` ON `daily_lists` (`site_id`,`service_date`);--> statement-breakpoint
CREATE TABLE `import_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`mapping` text DEFAULT '{}' NOT NULL,
	`header_fingerprint` text DEFAULT '' NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_mappings_site_unique` ON `import_mappings` (`project_id`,`site_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`daily_list_id` integer,
	`external_ref` text DEFAULT '' NOT NULL,
	`service_type` text DEFAULT 'scheduled' NOT NULL,
	`service_date` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_phone` text DEFAULT '' NOT NULL,
	`address_line` text NOT NULL,
	`address_line2` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'TX' NOT NULL,
	`zip` text NOT NULL,
	`delivery_notes` text DEFAULT '' NOT NULL,
	`lat` real,
	`lng` real,
	`geocode_status` text DEFAULT 'pending' NOT NULL,
	`zone` integer,
	`out_of_area_miles` real,
	`signature_required` integer DEFAULT true NOT NULL,
	`received_at` text NOT NULL,
	`due_at` text,
	`pickup_due_at` text,
	`pickup_at` text,
	`arrived_at` text,
	`delivered_at` text,
	`dedupe_key` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`daily_list_id`) REFERENCES `daily_lists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_service_type_check" CHECK("orders"."service_type" IN ('scheduled','stat','adhoc')),
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('pending','ready','assigned','picked_up','delivered','failed','cancelled')),
	CONSTRAINT "orders_zone_check" CHECK("orders"."zone" IS NULL OR "orders"."zone" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `orders_project_date_idx` ON `orders` (`project_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `orders_list_idx` ON `orders` (`daily_list_id`);--> statement-breakpoint
CREATE INDEX `orders_site_date_idx` ON `orders` (`site_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_dedupe_idx` ON `orders` (`site_id`,`service_date`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`signature_required` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `packages_order_idx` ON `packages` (`order_id`);