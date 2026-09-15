-- Ticket 5.10. Two-factor authentication for staff, added in 4.3, removed on
-- the owner's decision: judged more friction than the size of this operation
-- warrants. Staff sign in with a username and a password.
--
-- Couriers are unaffected. Their PIN is bound to an enrolled phone
-- (ticket 2.3, and 5.8 gave it its own column on `devices`), and it never
-- involved TOTP or any of these tables.
--
-- This drops three tables and the secrets in them, which is the point rather
-- than a side effect: a TOTP secret is as sensitive as a password, and
-- leaving a table of them behind for a feature nothing reads would be keeping
-- live credentials for a door that no longer exists. There is no going back
-- from this without everybody enrolling again, which is the honest cost and
-- is on the record in docs/build-backlog.md.
--
-- The audit trail is untouched. Rows saying somebody enrolled, was challenged
-- or spent a recovery code in September are history, and history does not
-- stop being true because the feature went.
DROP TABLE `mfa_challenges`;--> statement-breakpoint
DROP TABLE `mfa_enrolments`;--> statement-breakpoint
DROP TABLE `mfa_recovery_codes`;
