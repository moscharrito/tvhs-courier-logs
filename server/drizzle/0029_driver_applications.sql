-- Tickets 6.1 and 6.2. The courier network starts here.
--
-- Two tables, and the important thing about them is what is NOT in either.
--
-- driver_applications has a nullable user_id. That null is ticket 6.1: a
-- person who fills in the signup form has an application with a status and no
-- account, no session, no membership and no way to read anything. Only
-- approval creates the account, and approval is refused unless every check on
-- the application is verified and current.
--
-- onboarding_checks records that a named person saw a document, when, what it
-- was called and when it expires. The document itself is never here. A
-- background check report sitting in a courier database is a second breach
-- waiting for the first one, and nothing in this system needs the report: it
-- needs to know somebody read it.
--
-- Both are additive. Nothing existing is rebuilt, so this cannot lose a row
-- the way 0009 did.
CREATE TABLE `driver_applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`claims` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`submitted_at` text DEFAULT CURRENT_TIMESTAMP,
	`decided_at` text,
	`decided_by` text DEFAULT '' NOT NULL,
	`decision_reason` text DEFAULT '' NOT NULL,
	`user_id` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "driver_applications_status_check" CHECK("driver_applications"."status" IN ('submitted','in_review','approved','rejected','withdrawn'))
);
--> statement-breakpoint
CREATE INDEX `driver_applications_project_idx` ON `driver_applications` (`project_id`);--> statement-breakpoint
CREATE INDEX `driver_applications_status_idx` ON `driver_applications` (`status`);--> statement-breakpoint
CREATE TABLE `onboarding_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verified_by` text DEFAULT '' NOT NULL,
	`verified_at` text,
	`reference` text DEFAULT '' NOT NULL,
	`expires_at` text,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `driver_applications`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "onboarding_checks_status_check" CHECK("onboarding_checks"."status" IN ('pending','verified','failed')),
	CONSTRAINT "onboarding_checks_kind_check" CHECK("onboarding_checks"."kind" IN ('hipaa_training','confidentiality','background_check','drivers_licence','insurance'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_checks_application_kind_unique` ON `onboarding_checks` (`application_id`,`kind`);--> statement-breakpoint
CREATE INDEX `onboarding_checks_application_idx` ON `onboarding_checks` (`application_id`);
