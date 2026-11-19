-- Which notifications a person wants, per contract.
--
-- Added when the bell was built, because the bell is what made the volume
-- question real. Twelve kinds existed and nothing in either app rendered one
-- of them, so nobody had yet had the experience of being told too much. Two
-- of the kinds added at the same time -- a courier arriving somewhere, and a
-- courier finishing a delivery -- happen between five hundred and fifteen
-- hundred times a day on this contract, and there are four dispatch chairs.
--
-- A ROW IS AN OVERRIDE, NOT A SETTING. The absence of a row means "whatever
-- the default for this kind is", which lives in core/notify/prefs.ts next to
-- the reason for it. That way a kind added later behaves sensibly for people
-- who signed up before it existed, and changing a default does not mean
-- rewriting everybody's rows.
CREATE TABLE IF NOT EXISTS `notification_prefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`username` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- One answer per person per kind per contract. The upsert in prefs.ts depends
-- on this: without it, switching a kind off twice makes two rows and which
-- one wins is whichever the reader happens to see first.
CREATE UNIQUE INDEX IF NOT EXISTS `notification_prefs_unique` ON `notification_prefs` (`project_id`,`username`,`kind`);
--> statement-breakpoint
-- The settings screen reads every override one person has in one go.
CREATE INDEX IF NOT EXISTS `notification_prefs_user_idx` ON `notification_prefs` (`project_id`,`username`);
--> statement-breakpoint
-- And the hot one: "has ANYBODY asked for this kind." A courier tapping
-- delivered on a phone on bad signal waits for this read, so it is an index
-- and not a scan even though the table is tiny -- it is tiny today.
CREATE INDEX IF NOT EXISTS `notification_prefs_kind_idx` ON `notification_prefs` (`project_id`,`kind`,`enabled`);
