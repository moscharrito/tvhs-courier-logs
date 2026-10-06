-- A project for the app store reviewers, and for nobody else.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NOT JUST A COURIER ACCOUNT ON `uh`.
--
-- docs/app-store-submission.md requires a demo account a reviewer can sign in
-- to, with work on its board, because an app that signs in to an empty screen
-- reads as broken and is rejected. Apple reviews days after submission and a
-- TestFlight build is open for weeks, so that work has to be there whenever
-- they look, not only on the day it was seeded.
--
-- On the `uh` project that is impossible both ways round:
--
--   Dated forward, invented "Test Patient" rows appear on University Health's
--   live board, in their reports, and in an invoice draft. From 1 November
--   their staff are in that portal every day. A client finding fabricated
--   deliveries in their own system is not a bug, it is a conversation about
--   whether they can trust any of the numbers.
--
--   Dated backward, the courier app's today is empty, which is the exact
--   rejection the submission doc warns about.
--
-- So the reviewer gets their own project. It is also the cleanest possible
-- answer to the standing rule that no University Health data, real or
-- sampled, shares a table with invented data: here they do not share a
-- project either.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHAT THIS DOES AND DOES NOT TURN ON.
--
-- The scheduler loops every project, so this one is reached by the sweep, the
-- patient texts and the daily report. Its settings are written to keep all
-- three quiet rather than relying on them being unconfigured:
--
--   patientSms.paused     true, so no invented recipient is ever texted even
--                         if texting is unpaused for the real contract
--   reporting.recipients  empty, so the daily report has nobody to send to
--
-- AND `hidden`, which keeps it off the public sign-in list. Without it the
-- pre-sign-in contract picker offers "Izy Courier Demo" to every driver and
-- every member of University Health's staff. It hides the project there and
-- nowhere else: members still reach it through /api/me/projects, which asks
-- what somebody belongs to rather than what exists.
--
-- The sweep is harmless: it assigns unclaimed work to couriers on shift, and
-- the only courier here is the reviewer's own account.
--
-- EMPTY UNTIL SEEDED. This creates the project and nothing in it. The sites,
-- the account and the work come from scripts/seed-reviewer.mjs, which drives
-- the HTTP API so the rows are the same shape the application makes.

INSERT INTO `projects` (`code`, `name`, `timezone`, `settings`)
	SELECT 'demo', 'Izy Courier Demo', 'America/Chicago',
	       '{"hidden":true,"patientSms":{"paused":true},"reporting":{"recipients":[]}}'
	WHERE NOT EXISTS (SELECT 1 FROM `projects` WHERE `code` = 'demo');
--> statement-breakpoint

-- Platform admins administer every project, the same as 0005 did for uh.
-- Without this an admin cannot see the demo project to clear it up.
INSERT OR IGNORE INTO `memberships` (`user_id`, `project_id`, `role`, `settings`)
	SELECT u.`id`, p.`id`, 'admin', '{}'
	FROM `users` u, `projects` p
	WHERE u.`role` = 'admin' AND p.`code` = 'demo';
--> statement-breakpoint

-- A price list, and a zone table, for the demo project only.
--
-- WITHOUT THESE EVERY DEMO DELIVERY IS OUT OF AREA. Zones are per project and
-- migration 0007 loaded them for University Health alone, so a ZIP that is
-- zone 1 for them resolves to nothing here: the order is created, priced as
-- out of area with no mileage, and shows on a board as an exception. Found by
-- seeding this project and reading the rows back rather than trusting that a
-- San Antonio ZIP is a San Antonio ZIP.
--
-- THE RATES ARE INVENTED AND DELIBERATELY ROUND. University Health's rates
-- are commercial terms of a specific contract and have no business being
-- copied into a project whose purpose is to be shown to strangers. Ten,
-- fifteen, twenty is obviously nobody's negotiated price.
--
-- Effective from 2020 so it is always in force, whenever a reviewer looks.
INSERT INTO `price_schedules`
    (`project_id`, `effective_from`, `label`, `zone1`, `zone2`, `zone3`, `zone4`, `zone5`,
     `stat_surcharge`, `after_hours_surcharge`, `dry_run_fee`, `out_of_area_per_mile`, `notes`)
    SELECT p.`id`, '2020-01-01', 'Demo rates (invented)',
           10, 15, 20, 25, 30, 10, 10, 5, 2,
           'Invented figures for app store review. Not any client''s contract.'
      FROM `projects` p
     WHERE p.`code` = 'demo'
       AND NOT EXISTS (SELECT 1 FROM `price_schedules` s WHERE s.`project_id` = p.`id`);
--> statement-breakpoint

-- The five ZIPs scripts/seed-reviewer.mjs delivers to, and nothing else. A
-- demo project does not need a zone table; it needs the addresses it actually
-- uses to resolve.
INSERT INTO `zone_zips` (`project_id`, `zip`, `zone`, `place`, `effective_from`)
    SELECT p.`id`, z.`zip`, z.`zone`, z.`place`, '2020-01-01'
      FROM `projects` p
      JOIN (
            SELECT '78229' AS `zip`, 1 AS `zone`, 'Demo near' AS `place`
      UNION SELECT '78207', 1, 'Demo near'
      UNION SELECT '78237', 2, 'Demo middle'
      UNION SELECT '78228', 2, 'Demo middle'
      UNION SELECT '78201', 3, 'Demo far'
      ) z
     WHERE p.`code` = 'demo'
       AND NOT EXISTS (
           SELECT 1 FROM `zone_zips` e
            WHERE e.`project_id` = p.`id` AND e.`zip` = z.`zip` AND e.`effective_from` = '2020-01-01'
       );
