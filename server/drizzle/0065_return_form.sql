-- The photograph that proves undelivered medication got back to a counter,
-- as a file kind of its own.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THERE WAS ALREADY A PICTURE. THERE WAS NO WAY TO ADD ONE.
--
-- A courier handing a load back photographs part 3 of the docket, and that
-- picture goes in the batch shape a collection does: `files.order_id` NULL,
-- because one sheet covers everything handed back together, with its id on
-- every order's `returned` custody event. That path works and is unchanged.
--
-- What did not exist was any way to supply the sheet AFTERWARDS. Once
-- `returned_at` is set the order leaves the "still in the van" query, which
-- is the only list the return screen is built from, so a return recorded
-- without its photograph -- the upload failed and the courier was offered
-- the choice to carry on, or it predates the photograph being asked for --
-- could never be completed by anybody. Dispatch could see that the form was
-- missing (orders.ts reports it) and could do nothing about it.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY IT IS NOT courier_form, AND NOT A SECOND `returned` EVENT.
--
-- Not courier_form: that kind is already two things at once depending on
-- which custody event names it, and pod-photos.ts had to grow two separate
-- queries to tell a collection form from a return form after the client's
-- proof of delivery spent weeks printing one under the other's caption. A
-- third meaning on the same name is how that happens again.
--
-- Not a second `returned` event: custody_events is append-only by trigger
-- and every row in it is a claim about what physically happened. A
-- photograph arriving on Thursday is not the packages crossing the counter
-- a second time, and writing one that says so to make a query find a file
-- would corrupt the one table nothing is allowed to edit. The attach path
-- records a `note` -- exactly what stop.ts does when a delivery photograph
-- is replaced -- and binds the file to the order, so it is found by the
-- order it belongs to rather than by a custody claim that did not happen.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY A WHOLE TABLE REBUILD FOR ONE WORD.
--
-- `files_kind_check` is a CHECK constraint and SQLite cannot alter one.
-- drizzle/0038 added 'courier_form' and 'patient_id' this way and
-- drizzle/0062 added 'stamped_receipt'; this follows them exactly, including
-- recreating all three indexes afterwards, because a rebuilt table keeps no
-- index of its own.
--
-- EVERY EXISTING ROW SURVIVES. The insert names each column rather than
-- using SELECT *, so a column added to the table later cannot silently
-- change what this copies.
--
-- BOTH ENDS MOVE TOGETHER. core/files/routes.ts validates the kind against
-- FILE_KINDS in db/schema/core.ts before anything is written. That import
-- exists because a local copy of the list went stale when 0038 widened it:
-- the database accepted the new kinds and the upload route refused them.

CREATE TABLE `files_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer,
	`kind` text NOT NULL,
	`s3_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`stored_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "files_kind_check" CHECK("files_new"."kind" IN ('doorstep','pod','exception','signature','courier_form','patient_id','stamped_receipt','return_form')),
	CONSTRAINT "files_status_check" CHECK("files_new"."status" IN ('pending','stored'))
);
--> statement-breakpoint
INSERT INTO `files_new` (`id`,`project_id`,`order_id`,`kind`,`s3_key`,`content_type`,`bytes`,`status`,`uploaded_by`,`created_at`,`stored_at`)
  SELECT `id`,`project_id`,`order_id`,`kind`,`s3_key`,`content_type`,`bytes`,`status`,`uploaded_by`,`created_at`,`stored_at` FROM `files`;
--> statement-breakpoint
DROP TABLE `files`;
--> statement-breakpoint
ALTER TABLE `files_new` RENAME TO `files`;
--> statement-breakpoint
CREATE INDEX `files_order_idx` ON `files` (`order_id`);
--> statement-breakpoint
CREATE INDEX `files_project_status_idx` ON `files` (`project_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_key_unique` ON `files` (`s3_key`);
