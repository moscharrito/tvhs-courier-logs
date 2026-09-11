-- Seed the UH Pharmacy Courier project (RFP-226-03-068-SVC). Its dispatch
-- module arrives in Phases 1 and 2; the project exists now so admins can see
-- it, be members of it, and enrol staff ahead of time. Platform admins are
-- admins of every project; existing admins are enrolled here, and the boot
-- bootstrap keeps that true for admins created later.
INSERT INTO `projects` (`code`, `name`, `timezone`, `settings`)
	SELECT 'uh', 'UH Pharmacy Courier', 'America/Chicago', '{}'
	WHERE NOT EXISTS (SELECT 1 FROM `projects` WHERE `code` = 'uh');--> statement-breakpoint
INSERT OR IGNORE INTO `memberships` (`user_id`, `project_id`, `role`, `settings`)
	SELECT u.`id`, p.`id`, 'admin', '{}'
	FROM `users` u, `projects` p
	WHERE u.`role` = 'admin' AND p.`code` = 'uh';
