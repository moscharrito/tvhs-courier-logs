-- Tickets 6.4 and 6.5. A courier asking for work.
--
-- A request is an expression of interest. It moves no package and assigns
-- nothing: approval does that, and approval goes through the same custody
-- transition as every other assignment, so there is still no way to put work
-- in a van without a recorded event.
--
-- THE PARTIAL UNIQUE INDEX stops one courier holding two live requests for the
-- same stop, which is what a double tap on a phone produces. It does NOT stop
-- two different couriers asking for the same stop: that is the ordinary case,
-- because the first two people to open the app both see it. Approving one
-- marks the others superseded, which reads differently to the person who asked
-- than being denied does.
CREATE TABLE `delivery_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`courier_username` text NOT NULL,
	`requested_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`decided_by` text DEFAULT '' NOT NULL,
	`decision_reason` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_requests_status_check" CHECK("delivery_requests"."status" IN ('pending','approved','denied','withdrawn','superseded'))
);
--> statement-breakpoint
CREATE INDEX `delivery_requests_project_status_idx` ON `delivery_requests` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `delivery_requests_order_idx` ON `delivery_requests` (`order_id`);--> statement-breakpoint
CREATE INDEX `delivery_requests_courier_idx` ON `delivery_requests` (`courier_username`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_requests_one_pending_per_courier` ON `delivery_requests` (`order_id`,`courier_username`) WHERE `status` = 'pending';
