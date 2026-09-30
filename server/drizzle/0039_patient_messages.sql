-- Texting a patient that a delivery is coming.
--
-- University Health, 29 September 2026: "Text patients in the morning that
-- package will be delivered that day."
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NOT THE notifications TABLE.
--
-- Every row in `notifications` is addressed to a `username`, because every
-- one of them goes to somebody with an account: our couriers, or pharmacy
-- staff at the client. A patient has no account and never will. Bending that
-- table to carry a phone number with no user behind it would leave a column
-- that is meaningless for nine rows in ten and a query that has to remember
-- which kind it is looking at.
--
-- So patients get their own table, and the separation is worth more than the
-- duplication costs: this is the only place in the system where a message
-- leaves for somebody who is not a user, and it should be obvious in the
-- schema that it is.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE PHONE NUMBER IS THE MOST IDENTIFYING THING HERE.
--
-- A phone number plus "a medical courier has a delivery for you" links a
-- named person to healthcare, which is what makes it PHI rather than a
-- contact detail. It is lawful to send because Twilio has executed a BAA.
-- It is not lawful to be careless with, so:
--
--   The BODY is stored as sent, and contains no pharmacy, no medication and
--   no order reference. See modules/uh/patient-sms.ts, which refuses to send
--   anything else. A neighbour reading a lock screen should learn that a
--   courier is coming and nothing more.
--
--   ONE MESSAGE PER ORDER, enforced by the unique index rather than by the
--   sender remembering. A scheduler that ticks every two minutes and a table
--   with no constraint would text somebody thirty times before breakfast.
--
-- ─────────────────────────────────────────────────────────────────────────
-- OPT-OUT IS PERMANENT AND KEYED ON THE NUMBER, NOT THE PATIENT.
--
-- A person who replies STOP has said so to us, not to one order. Carriers
-- enforce it too and Twilio rejects a send to an opted-out number outright,
-- but relying on that alone would mean discovering the decision by being
-- refused, once per order, forever. This records it the first time.

CREATE TABLE IF NOT EXISTS patient_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    -- Digits, as normalizePhone stores them everywhere else.
    phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- As sent, never re-rendered. A template run against the database a week
    -- later describes the world as it is then; what somebody was told must
    -- not change after they were told it.
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- Null until the carrier accepted it. The sweep retries what is null,
    -- which is what makes an outage a delay rather than a silence.
    sent_at TEXT,
    -- Twilio's id, so a delivery dispute has something to quote.
    provider_id TEXT NOT NULL DEFAULT '',
    -- Why it did not go, for the one person who will ever read it.
    failed_reason TEXT NOT NULL DEFAULT '',
    CONSTRAINT patient_messages_kind_check CHECK (kind IN ('delivery_today'))
);
--> statement-breakpoint
-- ONE PER ORDER PER KIND. The constraint, not the caller, is what stops a
-- two-minute sweep texting a patient all morning.
CREATE UNIQUE INDEX IF NOT EXISTS patient_messages_once
    ON patient_messages(order_id, kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patient_messages_unsent_idx
    ON patient_messages(sent_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS patient_optouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    -- 'replied_stop' when they told us, 'carrier' when Twilio refused it.
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS patient_optouts_phone_unique
    ON patient_optouts(phone);
