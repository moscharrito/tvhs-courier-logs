CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'pharmacy' NOT NULL,
	`address_line` text NOT NULL,
	`city` text DEFAULT 'San Antonio' NOT NULL,
	`state` text DEFAULT 'TX' NOT NULL,
	`zip` text NOT NULL,
	`lat` real,
	`lng` real,
	`geocode_status` text DEFAULT 'pending' NOT NULL,
	`geocoded_at` text,
	`releases_list` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sites_type_check" CHECK("sites"."type" IN ('pharmacy','hospital','other')),
	CONSTRAINT "sites_status_check" CHECK("sites"."status" IN ('active','inactive')),
	CONSTRAINT "sites_geocode_status_check" CHECK("sites"."geocode_status" IN ('pending','ok','failed','manual'))
);
--> statement-breakpoint
CREATE INDEX `sites_project_id_idx` ON `sites` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_project_code_unique` ON `sites` (`project_id`,`code`);--> statement-breakpoint
-- The nine UH pickup locations, transcribed from the Pharmacy Locations sheet
-- of Bid Table BT-89AO. lat/lng stay NULL until ticket 1.4 geocodes them; no
-- coordinates are invented here. Business Center III is included because the
-- bid table lists it, though the Scope of Services says seven locations: that
-- discrepancy is open item 6 with University Health.
-- The pharmacies, in two statements rather than one nine-term UNION.
--
-- Split for the same reason as the ZIP map in 0007: Turso enforces a lower
-- SQLITE_MAX_COMPOUND_SELECT than a local SQLite build, so a seed like this
-- can pass every local test and still be impossible to apply in production.
--
-- Every chunk repeats the column aliases. In a UNION only the first SELECT
-- names the derived table's columns, so a chunk starting from a row that had
-- none fails with "no such column: v.code".
INSERT INTO `sites` (`project_id`, `code`, `name`, `type`, `address_line`, `city`, `state`, `zip`, `notes`)
SELECT p.`id`, v.`code`, v.`name`, 'pharmacy', v.`address_line`, 'San Antonio', 'TX', v.`zip`, v.`notes`
FROM `projects` p, (
	SELECT 'pavilion' AS `code`, 'University Health Medical Center Pavilion Pharmacy' AS `name`, '4647 Medical Drive' AS `address_line`, '78229' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'green' AS `code`, 'University Health Robert B. Green Pharmacy' AS `name`, '903 W. Martin Street' AS `address_line`, '78207' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'southeast' AS `code`, 'University Health Southeast Pharmacy' AS `name`, '1055 Ada Street' AS `address_line`, '78223' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'southwest' AS `code`, 'University Health Southwest Pharmacy' AS `name`, '2121 SW. 36th Street' AS `address_line`, '78237' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'tdi' AS `code`, 'University Health Texas Diabetes Institute Pharmacy' AS `name`, '701 S. Zarzamora Street' AS `address_line`, '78207' AS `zip`, '' AS `notes`
) v
WHERE p.`code` = 'uh' AND NOT EXISTS (SELECT 1 FROM `sites` s WHERE s.`project_id` = p.`id` AND s.`code` = v.`code`);
--> statement-breakpoint
INSERT INTO `sites` (`project_id`, `code`, `name`, `type`, `address_line`, `city`, `state`, `zip`, `notes`)
SELECT p.`id`, v.`code`, v.`name`, 'pharmacy', v.`address_line`, 'San Antonio', 'TX', v.`zip`, v.`notes`
FROM `projects` p, (
	SELECT 'discharge' AS `code`, 'University Hospital Discharge Pharmacy' AS `name`, '4502 Medical Drive' AS `address_line`, '78229' AS `zip`, 'Highest volume; after-hours returns come here (Scope 1.2.9)' AS `notes`
	UNION ALL SELECT 'vida' AS `code`, 'University Health Vida Pharmacy' AS `name`, '3611 Jaguar Parkway' AS `address_line`, '78224' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'wheatley' AS `code`, 'University Health Wheatley Pharmacy' AS `name`, '3860 Interstate Highway 10 East' AS `address_line`, '78220' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'bc3' AS `code`, 'University Health Business Center III' AS `name`, '6200 Northwest Parkway' AS `address_line`, '78249' AS `zip`, 'Listed in the bid table; confirm whether it is a pickup location (open item 6)' AS `notes`
) v
WHERE p.`code` = 'uh' AND NOT EXISTS (SELECT 1 FROM `sites` s WHERE s.`project_id` = p.`id` AND s.`code` = v.`code`);
