-- A text at each stage of a delivery, not only in the morning.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG.
--
-- 0039 wrote CHECK (kind IN ('delivery_today')), which was exactly right when
-- the morning notice was the only message there was. University Health then
-- asked for the other stages, and the code gained five more kinds while the
-- table still accepted one.
--
-- Nothing failed loudly. queueStageNotice catches everything and returns
-- false, deliberately, because a delivery that happened must not be undone by
-- a text that was not queued. So every "delivered" and every "could not
-- deliver" message was refused by the constraint, swallowed, and counted as
-- "no row written" -- indistinguishable from a stage being switched off.
--
-- It would have reached production as a feature that was on, configured,
-- previewed, and silent. An integration test that completed a delivery
-- through the real endpoints and looked for the row is what caught it.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY A REBUILD.
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so changing a CHECK means
-- building the table again and copying the rows. Columns are listed
-- explicitly rather than INSERT INTO ... SELECT *, so that a column added
-- between writing this and running it fails here rather than silently
-- shifting every value one place to the left.
--
-- The kinds are the stage names in core/notify/sms-template.ts. A test
-- asserts the two lists match, because a constraint that disagrees with the
-- code is what this migration exists to fix and is not worth doing twice.

CREATE TABLE patient_messages_rebuild (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    provider_id TEXT NOT NULL DEFAULT '',
    failed_reason TEXT NOT NULL DEFAULT '',
    CONSTRAINT patient_messages_kind_check CHECK (kind IN (
        'delivery_today', 'picked_up', 'arrived', 'delivered', 'attempted', 'returned'
    ))
);
--> statement-breakpoint
INSERT INTO patient_messages_rebuild
    (id, project_id, order_id, phone, kind, body, created_at, sent_at, provider_id, failed_reason)
SELECT id, project_id, order_id, phone, kind, body, created_at, sent_at, provider_id, failed_reason
FROM patient_messages;
--> statement-breakpoint
DROP TABLE patient_messages;
--> statement-breakpoint
ALTER TABLE patient_messages_rebuild RENAME TO patient_messages;
--> statement-breakpoint
-- ONE PER ORDER PER KIND, as before. Dropping the table took the indexes with
-- it, and this is the one that stops a sweep texting somebody all morning, so
-- it is recreated rather than left to be noticed.
CREATE UNIQUE INDEX IF NOT EXISTS patient_messages_once
    ON patient_messages(order_id, kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patient_messages_unsent_idx
    ON patient_messages(sent_at);
