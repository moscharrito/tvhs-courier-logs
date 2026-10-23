-- A password a user can reset themselves, with a code sent to their email.
--
-- WHY THIS EXISTS. Until now a forgotten password was a phone call: an
-- administrator set a new one and read it out. That works for two TVHS
-- drivers and does not work for eight pharmacy counters and eighteen
-- couriers, where the person who can reset it is also the person trying to
-- dispatch a wave. University Health staff asked for it specifically.
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT.
--
-- The code is stored as a bcrypt hash, exactly like a password, because a
-- six-digit code that opens any account is a credential for as long as it
-- lives. Somebody with read access to this table must not be able to walk
-- into an account with it.
--
-- `email` is stored as it was typed, lowercased, rather than a user id. The
-- request route must behave identically whether or not an account exists --
-- otherwise it answers "does this person work here", which is a question a
-- public endpoint should not answer -- so a row is written for an unknown
-- address too. `user_id` is null in that case and the confirm route finds
-- nothing to reset. The row costs a few bytes and buys the silence.
--
-- NO TOKEN IN A URL. A link in an email lands in a browser's history, in a
-- corporate mail scanner's fetch log, and in whatever "link preview" the
-- recipient's mail client runs. A code the person types goes none of those
-- places, and on a phone it is also less work than following a link into a
-- browser and back out again.
--
-- SINGLE USE AND SHORT LIVED. used_at is set the moment a code is accepted,
-- so a code read off a shoulder or left in an inbox cannot be replayed. A new
-- request supersedes whatever was outstanding, which is what somebody who
-- clicks twice expects.
--
-- requested_ip is kept for the same reason the audit trail is kept: a burst
-- of resets against one account is the shape of an attack, and nobody can see
-- that shape afterwards without it.
CREATE TABLE `password_resets` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `email` text NOT NULL,
    `user_id` integer,
    `code_hash` text NOT NULL,
    `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
    `expires_at` text NOT NULL,
    `used_at` text,
    `requested_ip` text DEFAULT '' NOT NULL,
    `attempts` integer DEFAULT 0 NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
-- The confirm route's only lookup: the newest live code for an address.
CREATE INDEX `password_resets_email_idx` ON `password_resets` (`email`, `created_at`);
--> statement-breakpoint
-- The sweep's lookup, so expired rows can be cleared without a table scan.
CREATE INDEX `password_resets_expires_idx` ON `password_resets` (`expires_at`);
