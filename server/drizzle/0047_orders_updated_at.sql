-- When this order last changed, as a fact rather than as a convention.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE COLUMN ALREADY EXISTED AND COULD NOT BE TRUSTED.
--
-- orders.updated_at has been there since the baseline, defaulted to
-- CURRENT_TIMESTAMP, and maintained by whichever writer remembered. Two of
-- them do: order-events.ts on every custody transition, and the out-of-area
-- authorisation. Three do not:
--
--   stop.ts        the patient identity check
--   stop.ts        a handover recorded without a signature, and its reason
--   mileage.ts     the out-of-area mileage backfill
--
-- That is survivable for a column nobody reads. It is not survivable for the
-- dispatch board polling "what changed since", which is what this is for: a
-- courier records an identity check, the row changes, updated_at does not,
-- and the board never shows it. A dispatcher would be looking at a card that
-- is quietly out of date with no indication, which is worse than the 361 KB
-- poll it replaced.
--
-- ─────────────────────────────────────────────────────────────────────────
-- A TRIGGER, NOT FIVE CALL SITES.
--
-- Patching the three writers would work today and break the next time
-- somebody adds a fourth, and the symptom would be a stale card on one
-- screen rather than a test failure. The whole point of putting this in the
-- database is that it cannot be forgotten: the same reasoning as the
-- append-only triggers on custody_events, which exist so that no future
-- writer can quietly rewrite a chain of custody.
--
-- So the two call sites that set it by hand are being stripped of that in the
-- same commit, and the trigger becomes the only thing that writes it. One
-- writer, enforced where the data lives.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ISO WITH MILLISECONDS, BECAUSE IT IS COMPARED AGAINST A BROWSER'S CLOCK.
--
-- CURRENT_TIMESTAMP renders '2026-10-04 20:38:15': a space, no zone, one
-- second of resolution. The board hands its cursor back as the ISO string it
-- was given, and '2026-10-04 20:38:15' sorts BEFORE '2026-10-04T...' because
-- a space is less than a T. Every comparison would have been wrong, in the
-- direction that resends everything forever, which is the failure that looks
-- like it is working.
--
-- strftime with %f gives '2026-10-04T20:38:15.123Z', which is exactly what
-- Date.prototype.toISOString produces and sorts against it correctly.
-- Milliseconds rather than seconds so that two changes inside one second are
-- still ordered, and a cursor landing between them cannot swallow the second.

-- Normalise what is already there. Rows written by the two conscientious
-- writers are in CURRENT_TIMESTAMP's format; rows that never updated carry
-- the column default, same shape. Anything already ISO is left alone.
UPDATE orders
   SET updated_at = CASE
        WHEN updated_at IS NULL
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(received_at, created_at, 'now'))
        WHEN updated_at LIKE '%T%'
            THEN updated_at
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
   END;
--> statement-breakpoint

-- WHEN NEW.updated_at IS OLD.updated_at does two jobs. It leaves alone any
-- statement that set the column deliberately, and it terminates the
-- recursion: after the inner UPDATE the values differ, so a second firing
-- cannot pass the guard. SQLite has recursive_triggers off by default and
-- this does not depend on that staying true.
CREATE TRIGGER IF NOT EXISTS `orders_touch_updated_at`
AFTER UPDATE ON `orders`
FOR EACH ROW
WHEN NEW.`updated_at` IS OLD.`updated_at`
BEGIN
    UPDATE `orders`
       SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint

-- ALTER TABLE cannot carry a non-constant default, so the column's own
-- default is still CURRENT_TIMESTAMP and a new row would arrive in the wrong
-- format. Caught on insert instead. The LIKE test means a row inserted with
-- an explicit ISO value is left as the caller wrote it.
CREATE TRIGGER IF NOT EXISTS `orders_stamp_updated_at`
AFTER INSERT ON `orders`
FOR EACH ROW
WHEN NEW.`updated_at` IS NULL OR NEW.`updated_at` NOT LIKE '%T%'
BEGIN
    UPDATE `orders`
       SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- (project_id, updated_at), AND THE COLUMN ORDER IS THE WHOLE POINT.
--
-- The obvious index for "this day, changed since" is
-- (project_id, service_date, updated_at). I wrote that first and
-- test/query-plans.test.mjs failed on the next run:
--
--   SEARCH orders USING COVERING INDEX orders_project_date_updated_idx
--
-- It is a superset of orders_project_date_idx, so SQLite preferred it for the
-- board's own whole-day query and stopped using the index that exists for
-- that. This codebase has made that exact mistake twice before, once with
-- id_required and once with delivery_kind, and both times the answer was to
-- delete the index. The third time is this comment.
--
-- Putting updated_at second instead fixes it and is the better index anyway.
-- service_date is no longer in the key, so nothing can cover a query that
-- filters on it, and the delta query seeks straight to a range fifteen
-- seconds wide rather than to a whole day and then filtering. A Tuesday has
-- 1,417 rows in it and perhaps a dozen that moved since the last poll; this
-- reads the dozen.
CREATE INDEX IF NOT EXISTS `orders_project_updated_idx`
    ON `orders` (`project_id`, `updated_at`);
