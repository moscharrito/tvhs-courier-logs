-- A third photograph on a controlled delivery: the stamped receipt.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHAT THE DRIVERS ASKED FOR, AND WHY IT IS NOT courier_form.
--
-- Reported 4 November 2026: "There's only 1 spot to upload a picture.
-- Please add a 2nd spot to add ID & receipt." Asked whether the receipt is
-- the signed pharmacy form the app already collects, the answer was no --
-- it is a separate document, stamped, that travels with a controlled item.
--
-- So it is its own kind. Folding it into `courier_form` would put two
-- different documents behind one name, and the one question anybody asks of
-- a controlled delivery months later is "show me what came with it": a
-- single kind holding sometimes one document and sometimes two cannot
-- answer that, and nothing would say which it held.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY A WHOLE TABLE REBUILD FOR ONE WORD.
--
-- `files_kind_check` is a CHECK constraint and SQLite cannot alter one. The
-- same thing happened at drizzle/0038, which added 'courier_form' and
-- 'patient_id' the same way; this follows that migration exactly, including
-- recreating all three indexes afterwards, because a rebuilt table keeps no
-- index of its own.
--
-- EVERY EXISTING ROW SURVIVES. The insert names each column rather than
-- using SELECT *, so a column added to the table later cannot silently
-- change what this copies.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE CONSTRAINT IS THE LAST LINE OF DEFENCE, NOT THE FIRST.
--
-- core/files/routes.ts validates the kind against FILE_KINDS in
-- db/schema/core.ts before anything is written, and that import exists
-- because a local copy of this list went stale when 0038 widened it: the
-- database accepted the new kinds, the courier app sent them, and the
-- upload route refused them. Both ends move together here.

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
	CONSTRAINT "files_kind_check" CHECK("files_new"."kind" IN ('doorstep','pod','exception','signature','courier_form','patient_id','stamped_receipt')),
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
