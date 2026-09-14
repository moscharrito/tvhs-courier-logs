CREATE TABLE `geo_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`day` text NOT NULL,
	`lookups` integer DEFAULT 0 NOT NULL,
	`refused` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `geo_usage_day_idx` ON `geo_usage` (`day`);--> statement-breakpoint
CREATE TABLE `geocodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address_key` text NOT NULL,
	`scope` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`quality` text NOT NULL,
	`formatted` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`looked_up_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geocodes_key_unique` ON `geocodes` (`address_key`);