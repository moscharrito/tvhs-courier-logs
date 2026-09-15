-- Ticket 5.12. Five project roles become three.
--
--   admin, ops_manager, dispatcher  ->  admin
--   courier                         ->  courier
--   client_viewer                   ->  pharmacy
--
-- Three is how many kinds of person actually exist on this contract: whoever
-- runs the operation, whoever drives, and whoever the pharmacy sends to look
-- at their own deliveries. The boundary between an ops manager and a
-- dispatcher was never one anybody could state out loud, and in a company
-- this size it mostly meant somebody waiting on an administrator to do a
-- five-second job.
--
-- THE MERGE WIDENS WHAT A DISPATCHER CAN DO. They could not edit the price
-- schedule or issue an invoice before; as admins they can. That is the cost
-- of the consolidation and it was a deliberate decision, recorded in
-- docs/build-backlog.md rather than discovered later from this file.
--
-- A CHECK constraint cannot be altered in SQLite, so the table is rebuilt.
-- That is the shape of migration that lost every packages row in 0009, so the
-- roles are mapped in the SELECT and server/test/migrations.test.mjs runs this
-- against a table holding one row of every old role and checks all five land.
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
	CONSTRAINT "memberships_role_check" CHECK("__new_memberships"."role" IN ('admin','courier','pharmacy'))
);
--> statement-breakpoint
INSERT INTO `__new_memberships`("id", "user_id", "project_id", "role", "settings", "created_at")
SELECT "id", "user_id", "project_id",
       CASE "role"
           WHEN 'ops_manager' THEN 'admin'
           WHEN 'dispatcher' THEN 'admin'
           WHEN 'client_viewer' THEN 'pharmacy'
           ELSE "role"
       END,
       "settings", "created_at"
FROM `memberships`;--> statement-breakpoint
DROP TABLE `memberships`;--> statement-breakpoint
ALTER TABLE `__new_memberships` RENAME TO `memberships`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `memberships_project_id_idx` ON `memberships` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_project_unique` ON `memberships` (`user_id`,`project_id`);
