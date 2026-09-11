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
INSERT INTO `sites` (`project_id`, `code`, `name`, `type`, `address_line`, `city`, `state`, `zip`, `notes`)
SELECT p.`id`, v.`code`, v.`name`, 'pharmacy', v.`address_line`, 'San Antonio', 'TX', v.`zip`, v.`notes`
FROM `projects` p, (
	SELECT 'pavilion' AS `code`, 'University Health Medical Center Pavilion Pharmacy' AS `name`, '4647 Medical Drive' AS `address_line`, '78229' AS `zip`, '' AS `notes`
	UNION ALL SELECT 'green', 'University Health Robert B. Green Pharmacy', '903 W. Martin Street', '78207', ''
	UNION ALL SELECT 'southeast', 'University Health Southeast Pharmacy', '1055 Ada Street', '78223', ''
	UNION ALL SELECT 'southwest', 'University Health Southwest Pharmacy', '2121 SW. 36th Street', '78237', ''
	UNION ALL SELECT 'tdi', 'University Health Texas Diabetes Institute Pharmacy', '701 S. Zarzamora Street', '78207', ''
	UNION ALL SELECT 'discharge', 'University Hospital Discharge Pharmacy', '4502 Medical Drive', '78229', 'Highest volume; after-hours returns come here (Scope 1.2.9)'
	UNION ALL SELECT 'vida', 'University Health Vida Pharmacy', '3611 Jaguar Parkway', '78224', ''
	UNION ALL SELECT 'wheatley', 'University Health Wheatley Pharmacy', '3860 Interstate Highway 10 East', '78220', ''
	UNION ALL SELECT 'bc3', 'University Health Business Center III', '6200 Northwest Parkway', '78249', 'Listed in the bid table; confirm whether it is a pickup location (open item 6)'
) v
WHERE p.`code` = 'uh' AND NOT EXISTS (SELECT 1 FROM `sites` s WHERE s.`project_id` = p.`id` AND s.`code` = v.`code`);
