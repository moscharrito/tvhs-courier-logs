CREATE TABLE `invoice_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_adjustments_invoice_idx` ON `invoice_adjustments` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`service_date` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`pharmacy` text DEFAULT '' NOT NULL,
	`delivery_zip` text DEFAULT '' NOT NULL,
	`zone` integer,
	`service_type` text NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`items` integer DEFAULT 1 NOT NULL,
	`base_cents` integer DEFAULT 0 NOT NULL,
	`stat_cents` integer DEFAULT 0 NOT NULL,
	`after_hours_cents` integer DEFAULT 0 NOT NULL,
	`dry_run_cents` integer DEFAULT 0 NOT NULL,
	`out_of_area_miles` real,
	`out_of_area_cents` integer DEFAULT 0 NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_lines_invoice_order_unique` ON `invoice_lines` (`invoice_id`,`order_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`number` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`site_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`adjustments_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`line_count` integer DEFAULT 0 NOT NULL,
	`excluded_count` integer DEFAULT 0 NOT NULL,
	`excluded_note` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`issued_at` text,
	`issued_by` text DEFAULT '' NOT NULL,
	`paid_at` text,
	`voided_at` text,
	`void_reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_status_check" CHECK("invoices"."status" IN ('draft','issued','paid','void'))
);
--> statement-breakpoint
CREATE INDEX `invoices_project_period_idx` ON `invoices` (`project_id`,`period_from`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_project_number_unique` ON `invoices` (`project_id`,`number`);