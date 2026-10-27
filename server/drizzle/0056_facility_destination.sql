-- Where a facility transfer actually goes, and when it is there to collect.
--
-- ─────────────────────────────────────────────────────────────────────────
-- MIGRATION 0043 GAVE THESE ROWS A NAME AND STOPPED THERE.
--
-- `delivery_kind = 'facility'` already does the things that matter at the
-- door: no identification is asked for, because nobody at a goods-in desk
-- carries any; the signature rule drops to 'anyone'; and the morning text
-- is not sent, because a loading bay does not want to know a courier is
-- coming. That was the point of it and it works.
--
-- What it never did was say WHERE. A transfer's destination is typed into
-- recipient_name and address_line like a patient's, so "Business Center
-- III" and "BC3" and "Business Centre 3" are three different places as far
-- as this database is concerned, and the only way to ask how much went
-- there last month is to guess at the spellings somebody used.
--
-- Which matters now because the leg has become a named piece of the
-- operation rather than thirteen rows in nine hundred: Pavilion dispenses
-- University Health's own employees' prescriptions and they are carried to
-- BC3 for collection (Izy Business, 26 October 2026).
--
-- BC3 IS ALREADY A ROW IN `sites`, code 'bc3', with its address on it. It
-- has been since the nine locations were seeded. So the destination can be
-- a reference to a place this database already knows rather than a string
-- somebody retypes, and then counting the leg is a join instead of a LIKE.
--
-- NULL FOR EVERY EXISTING ROW, and null for every patient delivery for
-- ever: a patient's address is not a site and never will be. This column
-- answers "which of our own buildings" and is empty when the question does
-- not apply.
--
-- ─────────────────────────────────────────────────────────────────────────
-- AND `ready_at`, WHICH IS NOT A DEADLINE.
--
-- Every other time on this table is something that must happen BY a moment:
-- due_at, pickup_due_at. This is the opposite -- the earliest moment the
-- medication exists to be collected. "Employee prescription, pickup ready
-- 11AM" is a fact about the pharmacy's morning, and without somewhere to
-- put it a courier can be sequenced to Pavilion at a quarter past ten and
-- arrive to be told to come back.
--
-- Deliberately a timestamp and not a rule about BC3. A pharmacy that starts
-- compounding late on a Friday has the same problem and no reason to be a
-- special case in code.
--
-- NOT ENFORCED AT THE DOOR. Recording a pickup before ready_at is allowed,
-- because if the pharmacy hands the bag over early then that is what
-- happened, and a courier standing at a counter holding medication is in no
-- position to argue with a timestamp. It informs dispatch and the run
-- screen; it does not refuse reality.
--
-- No index on either. A facility transfer is thirteen rows in nine hundred
-- and ready_at is read with the order, never searched on -- the same
-- reasoning that kept an index off delivery_kind in 0043, and off
-- id_required before that.

--
-- ─────────────────────────────────────────────────────────────────────────
-- AND BC3 HAS TO EXIST AGAIN, WHICH IS A REVERSAL OF 0041.
--
-- 0041 deleted Business Center III, and its reasoning was sound: the name
-- carries no "Pharmacy" where every other site's does, the address is
-- University Health's own procurement back office, and when their Assistant
-- Director of Pharmacy read out yesterday's volumes site by site he named
-- eight pharmacies and this was not one. It is not a place we collect from.
--
-- That was right about what BC3 is NOT and is now wrong about whether it
-- should be a row. It is a place we DELIVER TO: Pavilion dispenses
-- University Health's own employees' prescriptions and they are carried to
-- BC3 for collection (Izy Business, 26 October 2026).
--
-- 0041 only managed to delete it where it had no history -- it refuses to
-- orphan a custody record -- so production still has the row and a fresh
-- database does not. Both end up with one row and the same code after this,
-- which is what makes the leg work the same way everywhere.
--
-- type 'other', NOT 'pharmacy'. That is the distinction 0041 was drawing and
-- it still holds: releases_list is false, nobody picks up here, and it must
-- never appear in a list of counters that send work.
--
-- INSERT ... SELECT WHERE NOT EXISTS so production, where the row survived,
-- is untouched. Idempotent by construction rather than by a flag.

INSERT INTO `sites` (`project_id`, `code`, `name`, `type`, `address_line`, `city`, `state`, `zip`, `releases_list`, `status`, `notes`)
SELECT p.`id`, 'bc3', 'Business Center III', 'other', '6200 Northwest Parkway', 'San Antonio', 'TX', '78249', 0, 'active',
       'Employee prescriptions from Pavilion are delivered here for collection. Not a pickup location: see drizzle/0041 and 0056.'
  FROM `projects` p
 WHERE p.`code` = 'uh'
   AND NOT EXISTS (SELECT 1 FROM `sites` s WHERE s.`project_id` = p.`id` AND s.`code` = 'bc3');
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `destination_site_id` integer REFERENCES `sites`(`id`);
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `ready_at` text;
