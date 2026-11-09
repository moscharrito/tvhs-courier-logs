-- What a courier is paid for a stop is a DISTANCE FROM THE PICKUP, and it is
-- not University Health's zone.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE FAULT THIS REPAIRS.
--
-- On 9 November a courier reported a stop fourteen road miles from the
-- pharmacy showing as zone 1 and paying 5.00. Both halves were true:
--
--   78247 IS zone 1. Bid Table BT-89AO says so, every University Health
--   invoice for that ZIP is priced on it, and Addendum 2 clause 3 forbids
--   pricing a zone 1 ZIP any other way. `orders.zone` holds that and this
--   migration does not touch it.
--
--   AND THE STOP IS ZONE 2 TO THE COURIER. The independent contractor offer
--   letter, section 3, heads its column "Distance from pickup" and bands
--   11-25 miles at 7.25.
--
-- The live rate card's figures -- 5.00, 7.25, 12.00, 22.00, 28.00 -- came
-- from that letter. The zone NUMBERS they were being applied to came from
-- UH's ZIP list. Two tables, two definitions, one word, and a courier paid
-- 5.00 for work their contract prices at 7.25.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY A TABLE OF DISTANCES AND NOT A COLUMN OF THEM.
--
-- UH's zone map is one list for the whole contract: a ZIP has a zone, full
-- stop. A distance from the pickup cannot be, because the pickup moves. The
-- same ZIP is eight miles from one counter and twenty-six from another, so
-- the unit is a PAIR -- a pharmacy and a ZIP -- and nine counters over the
-- priced ZIPs is a few hundred rows that are computed once and then read.
--
-- NOT PER DELIVERY, and not per address. Measuring to the door would mean
-- sending a patient's address to a mapping provider, which core/geo
-- refuses in code: Google Maps Platform is outside Google's BAA and ticket
-- 1.4 says so at length. The destination here is the CENTRE OF A ZIP, which
-- is public reference data, already the unit Addendum 2 prices by, and
-- already in `zip_points` for the planner. No address is read and none
-- leaves the building.
--
-- EFFECTIVE-DATED, like zone_zips and zip_points beside it, and for the
-- reason 0063 spelled out: a re-measure must be loadable without rewriting
-- what a past day was worth. Pay already settled does not move.
CREATE TABLE `site_zip_miles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`zip` text NOT NULL,
	`miles` real NOT NULL,
	-- 'road' from the mapping provider, 'straight-line' from haversine when
	-- no provider could answer. Recorded per row rather than per load: a
	-- mixed table is the normal case and a dispute about one stop needs to
	-- know which kind of mile it was paid on. mileage.ts already records
	-- that a straight line runs a fifth to a third short in this city.
	`basis` text NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`),
	CONSTRAINT "site_zip_miles_basis_check" CHECK(`basis` IN ('road', 'straight-line')),
	-- Loose, like zip_points' latitude guard, and for the same job: not a
	-- map, a trap for a transposed pair or a units mix-up. Nothing on this
	-- contract is eight hundred miles from a San Antonio counter, and a row
	-- that says so would quietly pay zone 4 forever.
	CONSTRAINT "site_zip_miles_range_check" CHECK(`miles` > 0 AND `miles` < 800)
);--> statement-breakpoint
CREATE UNIQUE INDEX `site_zip_miles_unique` ON `site_zip_miles` (`project_id`,`site_id`,`zip`,`effective_from`);--> statement-breakpoint
CREATE INDEX `site_zip_miles_lookup_idx` ON `site_zip_miles` (`project_id`,`site_id`,`zip`);--> statement-breakpoint
-- And the answer, frozen onto the order.
--
-- WHY FROZEN AND NOT LOOKED UP AT PAY TIME. The same reason `zone` is: a
-- stop's pay must not change because a table was corrected afterwards. A
-- courier who was paid zone 2 for a stop in March is owed zone 2 for it in
-- June, whatever a re-measure says. 0063 took exactly this care with the
-- zone map and it is the rule here too.
--
-- `pay_miles` is kept beside the zone because the band alone cannot be
-- argued with. A courier who thinks a stop was further than we paid for has
-- a number to point at, and so does anybody answering them.
--
-- NULL MEANS NOT MEASURED AND IT MUST NOT MEAN ZONE 1. driver-pay.ts
-- resolves a missing figure to no figure rather than to the cheapest one,
-- and `pay_zone` follows it: a stop with no distance is reported as
-- unmeasured, never paid at the bottom band by default.
ALTER TABLE `orders` ADD `pay_zone` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `pay_miles` real;--> statement-breakpoint
ALTER TABLE `orders` ADD `pay_basis` text;
-- AND NO INDEX ON pay_zone. One was written here and taken out again: on
-- (project_id, service_date, pay_zone) it became a COVERING index for
-- "a day's orders for this project", which the planner then preferred over
-- orders_project_date_idx -- changing the plan of a query the noon wave
-- leans on, to serve no query at all. Nothing filters on pay_zone: pay reads
-- it after selecting on project, date, status and courier, and the backfill
-- scans once by design. An index that moves a hot query's plan and answers
-- nothing of its own is a cost with no reader. test/query-plans.test.mjs
-- caught it.
