-- Tickets 6.6 and 6.7. Where a courier was, while they were working.
--
-- A different class of data from anything before it. Until now a position was
-- one point attached to a custody event, captured because somebody arrived
-- somewhere; the board shows it with its age precisely so that nobody reads it
-- as "now". A continuous track is a minute-by-minute record of where an
-- identified employee was, and joined to orders it says which patients' homes
-- were visited and when.
--
-- shift_id is NOT NULL and references a shift, which is the first of the three
-- defences: every row belongs to a period of work with an end on it, and the
-- ingest refuses once that end exists. There is no path by which somebody's
-- evening lands in this table.
--
-- The other two are elsewhere and are named here so a reader of the schema
-- finds them: the retention period is undecided in core/retention/policy.ts
-- and the purge refuses to act until a person decides, and reading a track
-- back over a period writes an audit row while the live board does not.
CREATE TABLE `shift_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`shift_id` integer NOT NULL,
	`courier_username` text NOT NULL,
	`at` text NOT NULL,
	`received_at` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`accuracy_m` real,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shift_positions_shift_at_idx` ON `shift_positions` (`shift_id`,`at`);--> statement-breakpoint
CREATE INDEX `shift_positions_courier_at_idx` ON `shift_positions` (`project_id`,`courier_username`,`at`);
