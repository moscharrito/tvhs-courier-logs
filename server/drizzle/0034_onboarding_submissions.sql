-- Ticket 7.2. What the applicant says, kept apart from what staff verified.
--
-- An applicant on a phone can now supply their training certificate number,
-- their licence number and their insurance policy number without waiting to
-- be asked for them. That is the whole of it, and the important thing is what
-- it does NOT do: submitting a reference does not verify a gate.
--
-- Hence separate columns rather than writing into `reference`. `reference` is
-- what a named member of staff wrote down having seen the thing; these are
-- what somebody typed about themselves. Collapsing the two would make an
-- unverified claim indistinguishable from a verification, which is the one
-- distinction the table exists to hold, and it is the distinction University
-- Health will ask about.
--
-- Additive. Nothing is rebuilt.
ALTER TABLE `onboarding_checks` ADD `submitted_reference` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `onboarding_checks` ADD `submitted_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `onboarding_checks` ADD `submitted_at` text;
