-- A fourth role: the site lead.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THE THREE WERE NOT ENOUGH.
--
-- 0028 collapsed five roles into three on the grounds that ops_manager and
-- dispatcher were the same person as admin. That was right then. The
-- operating model University Health were shown on 30 September 2026 adds
-- somebody who genuinely is not any of the three:
--
--   A site lead stands at one pharmacy for the wave. They verify the list
--   against what is on the counter, sort it by zone, hand batches to drivers,
--   take the pickup signature, and move an order to a different driver when
--   somebody is late or a batch is too big. They take returns back in.
--
-- They are not a courier: a courier sees their own assigned work and nothing
-- else, and a lead has to see every package at their site and every driver on
-- shift there. They are not an admin either, and that is the whole point of
-- this migration: an admin sees all eight pharmacies, the contract's pricing,
-- the invoice drafts and every patient address in the project. A lead at
-- Wheatley has no business reading Robert B. Green's day, and giving them an
-- admin account because there was no better role would be the largest
-- over-grant in the system.
--
-- SCOPED BY settings.siteIds, exactly like a pharmacy membership already is.
-- The mechanism exists and is tested; this role reuses it rather than
-- inventing a second way to say "these sites and no others".
--
-- ─────────────────────────────────────────────────────────────────────────
-- A REBUILD, BECAUSE SQLITE CANNOT ALTER A CHECK.
--
-- Same shape as 0028, which is the shape that lost every packages row in
-- 0009. So the columns are named in both the DDL and the INSERT rather than
-- SELECT *, and no role is rewritten on the way through: this migration adds
-- a permitted value and must not move anybody into it.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`role` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memberships_role_check" CHECK("__new_memberships"."role" IN ('admin','lead','courier','pharmacy'))
);
--> statement-breakpoint
INSERT INTO `__new_memberships`("id", "user_id", "project_id", "role", "settings", "created_at")
SELECT "id", "user_id", "project_id", "role", "settings", "created_at"
FROM `memberships`;--> statement-breakpoint
DROP TABLE `memberships`;--> statement-breakpoint
ALTER TABLE `__new_memberships` RENAME TO `memberships`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `memberships_project_id_idx` ON `memberships` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_project_unique` ON `memberships` (`user_id`,`project_id`);
