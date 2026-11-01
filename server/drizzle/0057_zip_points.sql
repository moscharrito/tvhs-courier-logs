-- Where each ZIP is, so a driver's round stays in one part of town.
--
-- -------------------------------------------------------------------------
-- WHY THIS IS NOT THE THING core/geo/provider.ts REFUSES TO DO.
--
-- A delivery address is protected health information and nothing in this
-- system sends one anywhere. That has not changed and this table does not
-- change it. What is stored here is the CENTRE OF A POSTAL AREA: one row
-- per ZIP, identical for every delivery in it, describing a region of San
-- Antonio and not a person. It is public reference data from the US Census
-- Gazetteer, it is already the unit Addendum 2 prices by, and the ZIP is
-- already on every order.
--
-- No patient row is read to populate it and no address is geocoded.
--
-- -------------------------------------------------------------------------
-- WHAT IT IS FOR.
--
-- modules/uh/cluster.ts packs the noon wave into runs. Until now its only
-- proximity signal was `orders.zone`, the ZIP's distance BAND from the
-- pickup -- so two ZIPs in zone 3 are both that far out and may be on
-- opposite sides of the county. A run could hold 78207 and 78250 and look
-- correct to the planner while the driver crossed the city between stops.
--
-- With a centre per ZIP the planner can bound the real width of a round.
--
-- -------------------------------------------------------------------------
-- IT IS EMPTY ON PURPOSE.
--
-- No seed. The clustering falls back to the old zone rule for any ZIP it
-- has no point for, so an empty table is exactly the behaviour before this
-- migration -- which is what made it safe to add on a go-live morning.
-- Rows arrive through scripts/load-zip-points.mjs, which checks every point
-- against the pharmacies' own coordinates before accepting any of them.
--
-- Effective-dated like zone_zips, and for the same reason: ZIP boundaries
-- are redrawn, and a round planned last March should still be explicable
-- with the map that was in force that day.
CREATE TABLE `zip_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`zip` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	-- Where the figure came from, so a wrong one can be traced to a file
	-- rather than argued about.
	`source` text NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	-- San Antonio is near 29.4N, 98.5W. The bounds are deliberately loose:
	-- they are not a map, they are a guard against a transposed pair or a
	-- missing minus sign, both of which put a ZIP in the Indian Ocean and
	-- neither of which any later check would notice.
	CONSTRAINT "zip_points_lat_check" CHECK("zip_points"."lat" BETWEEN 25 AND 37),
	CONSTRAINT "zip_points_lng_check" CHECK("zip_points"."lng" BETWEEN -107 AND -93)
);
--> statement-breakpoint
CREATE INDEX `zip_points_project_zip_idx` ON `zip_points` (`project_id`,`zip`);--> statement-breakpoint
CREATE UNIQUE INDEX `zip_points_project_zip_from_unique` ON `zip_points` (`project_id`,`zip`,`effective_from`);
