ALTER TABLE `custody_events` ADD `file_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `no_signature_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `packages` ADD `failure_reason_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `packages` ADD `failure_note` text DEFAULT '' NOT NULL;