-- Ticket 6.8. Telling somebody something happened.
--
-- An outbox, not a send call. The obvious version of this is a function that
-- talks to Firebase the moment a request is approved, and it is the wrong
-- shape: a push that was attempted and lost looks exactly like one that was
-- never attempted unless there is a row, and "did dispatch tell me?" is a
-- question a courier will ask. There is also no app and no credentials yet,
-- so a send call would have to be stubbed, and a stub is a thing that stays.
--
-- sent_at stays NULL while no channel is configured, which is the state this
-- ships in: notifications are written, and read in the app.
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`username` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`order_id` integer,
	`created_at` text NOT NULL,
	`sent_at` text,
	`read_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`project_id`,`username`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_unsent_idx` ON `notifications` (`sent_at`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`platform` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_token_unique` ON `push_devices` (`token`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`username`);
