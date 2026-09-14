-- Ticket 5.8. The PIN a phone signs in with moves off users.pin, which from
-- here on is the legacy TVHS route PIN and nothing else.
--
-- Sharing one column meant a device PIN was also a route PIN, and the route
-- PIN is accepted from any device. A four-digit secret whose entire
-- justification is that it only works on the phone it was set on therefore
-- worked from anywhere, for any driver holding a route. It also meant a
-- second phone silently changed the first one's PIN, that resetting a route
-- PIN changed what an enrolled phone expected, and that an administrator
-- setting somebody's PIN set what their phone would accept.
ALTER TABLE `devices` ADD `pin` text;--> statement-breakpoint

-- Phones enrolled before this keep working. Until now users.pin was the only
-- place their PIN was ever written, so it is the value they were set up with.
-- Revoked rows are left null: they are history, and a revoked phone is not
-- signing in again.
UPDATE `devices`
   SET `pin` = (SELECT `pin` FROM `users` WHERE `users`.`id` = `devices`.`user_id`)
 WHERE `pin` IS NULL AND `revoked_at` IS NULL;--> statement-breakpoint

-- A user with no route has no route to sign in on, so the hash on their row
-- can authenticate nothing. It is a stored credential with no remaining
-- meaning, and the copy that matters now sits on their device rows.
UPDATE `users` SET `pin` = NULL WHERE `route` IS NULL;
