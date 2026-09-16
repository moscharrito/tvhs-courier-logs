-- Ticket 6.3. On shift and off shift, as explicit rows.
--
-- Not the legacy `checkins` table, which is one timestamp per person per date
-- with no end and no second one. Three later tickets ask "is this courier on
-- shift": who may be auto-assigned an unclaimed STAT (6.5), whose phone is
-- being tracked (6.6), and who the board draws as available (6.7). All three
-- want a row with an end on it, not a check-in.
--
-- THE PARTIAL UNIQUE INDEX IS THE POINT. One open shift per courier per
-- project, enforced by the database rather than by a handler that reads and
-- then writes. Two taps on a phone with bad signal is the ordinary case here,
-- not the attack, and a SELECT-then-INSERT loses that race on any day when
-- two requests arrive together. SQLite indexes a row only when the WHERE
-- matches, so ended shifts are not in the index at all and a courier may have
-- as many of those as they work.
CREATE TABLE `shifts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`courier_username` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`ended_by` text DEFAULT '' NOT NULL,
	`ended_reason` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shifts_project_courier_idx` ON `shifts` (`project_id`,`courier_username`);--> statement-breakpoint
CREATE INDEX `shifts_started_idx` ON `shifts` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `shifts_one_open_per_courier` ON `shifts` (`project_id`,`courier_username`) WHERE `ended_at` IS NULL;
