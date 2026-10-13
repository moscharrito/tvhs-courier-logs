-- Ticket 7.12. A conversation attached to the delivery it is about.
--
-- WHY THE ORDER IS THE THREAD.
--
-- The incumbent's sites and drivers "traded personal cell phones". That is
-- protected health information on uncovered devices, with no agreement, no
-- retention, no audit, and no way to take it back when a driver leaves: they
-- keep the number and the history. Replacing it is a control, not a feature.
--
-- A chat room would have been the obvious shape and is the wrong one. The
-- conversation about one delivery belongs ON that delivery, beside its
-- custody events and its proof, where it is still findable in March. In a
-- room it is forty messages up, and a pasted reference is a reference that
-- scrolls away. modules/uh/discrepancies.ts was written against exactly this
-- failure: "a pile of messages in a group chat that nobody can count on the
-- Friday".
--
-- It also means the scope is the order's scope. A pharmacy already sees only
-- its own orders, so it can only read and write its own threads, and there is
-- no second permission model to get wrong three weeks before go-live.
--
-- APPEND-ONLY, like custody_events. No edit, no delete. A thread somebody can
-- revise after the fact is not evidence of what was said at the time, and
-- these threads will be read when a delivery is disputed.
CREATE TABLE `order_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`author_username` text NOT NULL,
	`body` text NOT NULL,
	-- Usernames, comma separated, resolved and checked when the message was
	-- written rather than parsed out of the body on every read. A mention of
	-- somebody who cannot see the order is dropped at write time, so this
	-- column never names a person the thread was not visible to.
	`mentions` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
-- The only read there is: one order's thread, oldest first.
CREATE INDEX `order_messages_order_idx` ON `order_messages` (`project_id`,`order_id`,`id`);--> statement-breakpoint
-- Append-only in the database as well as in the code, the same way
-- custody_events is. A bug that deletes a message is then a failed statement
-- rather than a quiet gap in a record somebody is relying on.
CREATE TRIGGER `order_messages_no_update`
BEFORE UPDATE ON `order_messages`
BEGIN
	SELECT RAISE(ABORT, 'order_messages is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `order_messages_no_delete`
BEFORE DELETE ON `order_messages`
BEGIN
	SELECT RAISE(ABORT, 'order_messages is append-only');
END;
