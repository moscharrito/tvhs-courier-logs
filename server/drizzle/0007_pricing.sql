CREATE TABLE `price_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`effective_from` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`zone1` real NOT NULL,
	`zone2` real NOT NULL,
	`zone3` real NOT NULL,
	`zone4` real NOT NULL,
	`zone5` real NOT NULL,
	`stat_surcharge` real NOT NULL,
	`after_hours_surcharge` real NOT NULL,
	`dry_run_fee` real NOT NULL,
	`out_of_area_per_mile` real NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_schedules_project_from_unique` ON `price_schedules` (`project_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `zone_zips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`zip` text NOT NULL,
	`zone` integer NOT NULL,
	`place` text,
	`effective_from` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "zone_zips_zone_check" CHECK("zone_zips"."zone" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `zone_zips_project_zip_idx` ON `zone_zips` (`project_id`,`zip`);--> statement-breakpoint
CREATE UNIQUE INDEX `zone_zips_project_zip_from_unique` ON `zone_zips` (`project_id`,`zip`,`effective_from`);--> statement-breakpoint
-- Zone ZIPs and the BAFO price schedule, generated from the Pricing sheet of
-- Bid Table BT-89AO (see scratch gen_pricing_seed.py). Not hand-typed: a wrong
-- ZIP here would misprice every delivery to it.
INSERT INTO `price_schedules` (`project_id`, `effective_from`, `label`, `zone1`, `zone2`, `zone3`, `zone4`, `zone5`, `stat_surcharge`, `after_hours_surcharge`, `dry_run_fee`, `out_of_area_per_mile`, `notes`)
SELECT p.`id`, '2026-05-18', 'Izy BAFO (RFP-226-03-068-SVC)', 12.50, 14.50, 22.00, 36.00, 52.00, 22.00, 18.00, 9.00, 1.95, 'Firm for the base term and both renewals; changes only by mutual written agreement (Addendum 1)'
FROM `projects` p WHERE p.`code` = 'uh'
  AND NOT EXISTS (SELECT 1 FROM `price_schedules` s WHERE s.`project_id` = p.`id` AND s.`effective_from` = '2026-05-18');
--> statement-breakpoint
INSERT INTO `zone_zips` (`project_id`, `zip`, `zone`, `place`, `effective_from`)
SELECT p.`id`, v.`zip`, v.`zone`, v.`place`, '2026-05-18' FROM `projects` p, (
	SELECT '78201' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78202' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78203' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78204' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78205' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78207' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78208' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78209' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78210' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78211' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78212' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78213' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78215' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78216' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78217' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78218' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78219' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78225' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78226' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78227' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78228' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78229' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78230' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78231' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78232' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78233' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78235' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78237' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78238' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78239' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78240' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78242' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78244' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78247' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78248' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78249' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78250' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78251' AS `zip`, 1 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78214' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78220' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78221' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78222' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78223' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78224' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78245' AS `zip`, 2 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78252' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78253' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78254' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78255' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78256' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78257' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78258' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78259' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78260' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78261' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78263' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78264' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78266' AS `zip`, 3 AS `zone`, NULL AS `place`
	UNION ALL SELECT '78002' AS `zip`, 4 AS `zone`, 'Atascosa' AS `place`
	UNION ALL SELECT '78023' AS `zip`, 4 AS `zone`, 'Helotes' AS `place`
	UNION ALL SELECT '78069' AS `zip`, 4 AS `zone`, 'Somerset' AS `place`
	UNION ALL SELECT '78073' AS `zip`, 4 AS `zone`, 'Von Ormy' AS `place`
	UNION ALL SELECT '78101' AS `zip`, 4 AS `zone`, 'Adkins' AS `place`
	UNION ALL SELECT '78108' AS `zip`, 4 AS `zone`, 'Cibolo' AS `place`
	UNION ALL SELECT '78109' AS `zip`, 4 AS `zone`, 'Converse' AS `place`
	UNION ALL SELECT '78112' AS `zip`, 4 AS `zone`, 'Elmendorf' AS `place`
	UNION ALL SELECT '78148' AS `zip`, 4 AS `zone`, 'Universal City' AS `place`
	UNION ALL SELECT '78152' AS `zip`, 4 AS `zone`, 'St. Hedwig' AS `place`
	UNION ALL SELECT '78154' AS `zip`, 4 AS `zone`, 'Shertz' AS `place`
	UNION ALL SELECT '78015' AS `zip`, 5 AS `zone`, 'Boerne' AS `place`
	UNION ALL SELECT '78114' AS `zip`, 5 AS `zone`, 'Floresville' AS `place`
	UNION ALL SELECT '78163' AS `zip`, 5 AS `zone`, 'Bulverde' AS `place`
) v
WHERE p.`code` = 'uh' AND NOT EXISTS (
	SELECT 1 FROM `zone_zips` z WHERE z.`project_id` = p.`id` AND z.`zip` = v.`zip` AND z.`effective_from` = '2026-05-18');
