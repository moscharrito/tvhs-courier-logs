-- University Health's dispensing requirements, 29 September 2026.
--
-- Three changes to how a delivery is proved, all asked for by the client and
-- all of them narrowing what a courier may record.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1. THREE IDENTIFIERS, CHECKED AT THE DOOR.
--
-- "Courier driver to ensure correct patient and correct address by verifying
-- three identifiers: patient name, patient address, patient phone number."
--
-- So the check becomes a recorded act rather than an instruction in a
-- handbook. identity_checked_at is what a dispute is answered with: on the
-- fourteenth, at 2:22pm, this courier confirmed the three identifiers against
-- the person at the door. Without the column there is no answer.
--
-- THE PHONE NUMBER IS THE ONE THAT WILL BITE. It is already imported when a
-- pharmacy's list carries it, and the parser accepts nine spellings of the
-- header, but nothing has ever REQUIRED it. A manifest with a blank phone
-- cannot be verified against, so the courier app has to show what it has and
-- the import has to say when it is missing.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 2. THE SIGNATURE MOVES ONTO PAPER.
--
-- "Courier will need to obtain a signature on the courier form from the
-- person who is receiving the package." University Health signs their own
-- form; we photograph it.
--
-- This is a deliberate trade the owner made with the client's request in
-- front of him. The drawn signature this system captured was better evidence:
-- pen strokes at full resolution, a missing one shown as missing with its
-- reason. A photograph of a paper form is a photograph. What it buys is that
-- the pharmacy's own document is the record, which is what they asked for.
--
-- The PRINTED NAME stays. Scope 1.2.8 requires the name of the receiving
-- personnel and a photograph does not reliably yield one.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 3. ID REQUIRED.
--
-- "If the courier form has ID Required stamped, courier is to ask for an
-- ID/DL, take a picture of it and send back to pharmacy."
--
-- id_required is set from the pharmacy's list or by hand, and where it is set
-- a delivery cannot be recorded without a photograph of the identification.
--
-- A PHOTOGRAPH OF A DRIVING LICENCE IS THE MOST SENSITIVE THING THIS SYSTEM
-- HAS EVER HELD. It is a government identity document tied by name to a
-- patient receiving a prescription. It goes to the same bucket under the same
-- KMS key as everything else, it is never attached to an email, and it is
-- reachable only through the authenticated portal where every read is
-- audited. Its retention period is the open question the owner has to settle
-- with University Health alongside the proof-of-delivery period; until then
-- nothing purges it, which is the same deliberate stall as everywhere else.

ALTER TABLE orders ADD COLUMN id_required INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN identity_checked_at TEXT;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN identity_checked_by TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
-- Which of the three the courier could actually confirm. A phone number the
-- pharmacy never sent cannot be verified, and recording "all three checked"
-- when one was blank would be a lie a courier is forced into by a form.
ALTER TABLE orders ADD COLUMN identity_checked_fields TEXT NOT NULL DEFAULT '';
-- NO INDEX ON id_required, and that is a decision rather than an omission.
--
-- One was written here first, on (project_id, service_date, id_required), and
-- taken out again after the query-plan test caught what it did: SQLite began
-- choosing it as a COVERING index for "a day's orders", displacing
-- orders_project_date_idx on the hottest read in the module. It served no
-- query at all, because nothing looks orders up BY id_required; the flag is
-- read from a row somebody already has.
--
-- An index that nothing uses and that changes the plan for something that
-- matters is a net loss. If a screen ever needs "today's ID Required
-- deliveries", add it then, with that query in front of you.

--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────
-- The files table gains two kinds, and SQLite cannot alter a CHECK.
--
-- So the table is rebuilt, which is the standard twelve-step dance and is
-- safe here for a reason worth writing down rather than assuming: file
-- storage was switched on for the first time hours before this migration, so
-- the table is empty or nearly so. The copy below is correct regardless, but
-- if this is ever run against a bucket-years-old table, read it again first.
--
-- 'courier_form' is the photograph of University Health's own signed paper
-- form, which replaces the drawn signature at their request.
-- 'patient_id' is the photograph of an identity document, taken only where
-- the form is stamped ID Required, and is the most sensitive object this
-- system stores.
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
	CONSTRAINT "files_kind_check" CHECK("files_new"."kind" IN ('doorstep','pod','exception','signature','courier_form','patient_id')),
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
