-- Keep the spreadsheet the pharmacy sent, column for column.
--
-- WHAT WENT WRONG. A pharmacy asked where the patient's telephone number
-- had gone. It was in the file they uploaded; it was not in the list they
-- got back. The importer reads eighteen fields and the comment above them
-- said the quiet part out loud -- "Everything else in the sheet is dropped"
-- -- so a column we had never thought of was not merely unused, it ceased
-- to exist the moment the upload finished. Nothing kept the file either:
-- daily_lists holds its name and a SHA-256 and nothing else, on purpose,
-- so there was no copy to go back to.
--
-- That is the wrong default for somebody else's record. Nine pharmacies
-- export from systems we do not control and none of their layouts is a
-- specification; the set of columns we model is a guess that was always
-- going to be short. The guess should decide what we ACT on, not what we
-- KEEP.
--
-- EVERY ROW, NOT EVERY IMPORTED ROW. daily_list_rows holds one row per row
-- of the sheet, including the ones that were blocked, skipped as duplicates
-- or folded into a box series. Hanging the cells off `orders` instead would
-- have lost exactly the rows somebody asks about afterwards -- "we sent you
-- 142 and you show 139" is a question about the three that did not become
-- deliveries, and under the old shape those three were unanswerable.
-- order_id says which delivery a row became, or NULL when it became none,
-- and `outcome` says why in one word.
--
-- THE CELLS ARE STORED AS A JSON ARRAY aligned to daily_lists.source_headers
-- rather than as an object per row. A three hundred row list repeats its
-- headers three hundred times as an object and not at all as an array, and
-- the alignment is what preserves column ORDER -- which matters, because
-- this is read beside the pharmacy's own copy of the file.
--
-- IT IS PHI, ALL OF IT. The mapped columns were already: names, home
-- addresses, free-text notes. What changes is that the unmapped ones now
-- persist too, and those may carry a drug name, a date of birth or an MRN.
-- Three consequences, all of them handled where they belong rather than
-- here:
--
--   The retention sweep purges these rows with the orders of the same
--   service date, so the unmapped columns cannot outlive the mapped ones.
--   A copy of the file that survived its own deliveries would be the worst
--   possible version of this feature.
--
--   Scoping is the list's scoping. A pharmacy reads its own uploads and
--   nobody else's, by the same rule the portal already applies.
--
--   It does not reach a courier's phone. A driver needs an address and a
--   name; a driver does not need whatever else the dispenser printed.
--
-- NO BACKFILL IS POSSIBLE. Every list imported before this migration kept
-- nothing to recover, and the rows below start empty for them. source_headers
-- defaults to an empty array so an old list reads as "no columns recorded"
-- rather than as a list whose file had no columns.
ALTER TABLE `daily_lists` ADD COLUMN `source_headers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TABLE `daily_list_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`daily_list_id` integer NOT NULL,
	`row_number` integer NOT NULL,
	`cells` text DEFAULT '[]' NOT NULL,
	`order_id` integer,
	`outcome` text DEFAULT 'imported' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`daily_list_id`) REFERENCES `daily_lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `daily_list_rows_outcome_check` CHECK(`outcome` IN ('imported','merged','skipped'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_list_rows_list_row_unique` ON `daily_list_rows` (`daily_list_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `daily_list_rows_order_idx` ON `daily_list_rows` (`order_id`);
