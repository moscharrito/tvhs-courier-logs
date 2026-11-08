-- A pharmacy hands us a file. Nothing happens to it until somebody decides.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NOT AN IMPORT.
--
-- `POST /imports` reads a sheet, maps its columns and creates deliveries, and
-- that is the right shape when a list is ready to work. It is the wrong shape
-- for the thing nine pharmacies actually do, which is email us a spreadsheet
-- and let dispatch sort it out. A file that cannot be parsed cannot be
-- imported, so under the import route it also cannot be HANDED OVER -- and
-- the layouts are not ours: BC3 has no ZIP column at all, TDI arrives with no
-- header row, and none of the nine is a specification.
--
-- So this table is a drop box. It keeps the bytes and says who sent them, for
-- which counter and which day. It creates no orders, touches no board and
-- starts no SLA clock. Dispatch downloads the file and imports it the normal
-- way, which is the step where a layout has to make sense.
--
-- THE BYTES ARE THE POINT. daily_lists keeps a filename and a SHA-256 and
-- deliberately not the file (drizzle/0060 says why it was wrong to keep
-- nothing, and daily_list_rows now keeps every cell). This keeps the object
-- itself in the same bucket as the delivery photographs, because "send me
-- back exactly what we sent you" is a question a reconstruction answers
-- almost right, and almost right is worse than not at all when somebody is
-- reconciling a day.
--
-- HANDLED IS A PERSON PRESSING A BUTTON, not an inference. Dispatch edits a
-- sheet before importing it more often than not, so matching the import back
-- to the drop by hash would miss most of the time and quietly leave work
-- looking outstanding. A button somebody forgets is a visible failure; a
-- match that silently misses is not.
CREATE TABLE `list_drops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL REFERENCES `projects`(`id`),
	`site_id` integer NOT NULL REFERENCES `sites`(`id`),
	-- The day the deliveries are for, as the pharmacy says. Not a clock:
	-- nothing here starts an SLA, and dispatch may import it for another day.
	`service_date` text NOT NULL,
	-- As it was named on their machine, so an operator recognises it. Never
	-- a path: the key below is ours and is not derived from this.
	`original_filename` text DEFAULT '' NOT NULL,
	`content_type` text DEFAULT '' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	-- Catches the same file sent twice, and lets dispatch see at a glance
	-- that two counters sent the identical sheet.
	`sha256` text DEFAULT '' NOT NULL,
	-- Where the object lives. Ours, opaque, never shown to a browser: the
	-- download is a presigned URL that expires.
	`s3_key` text NOT NULL,
	-- Anything the pharmacy wants to say. "Two STATs at the top", usually.
	`note` text DEFAULT '' NOT NULL,
	`uploaded_by` text DEFAULT '' NOT NULL,
	`uploaded_at` text NOT NULL,
	-- NULL until dispatch presses Done. Both or neither.
	`handled_at` text,
	`handled_by` text
);
--> statement-breakpoint
-- The page opens on one counter and a date range, and defaults to what is
-- still outstanding, which is the query this serves.
CREATE INDEX `list_drops_project_date_idx` ON `list_drops` (`project_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `list_drops_site_date_idx` ON `list_drops` (`site_id`,`service_date`);--> statement-breakpoint
CREATE INDEX `list_drops_project_handled_idx` ON `list_drops` (`project_id`,`handled_at`);
