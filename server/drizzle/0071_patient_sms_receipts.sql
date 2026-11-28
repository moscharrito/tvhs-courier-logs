-- What the carrier did with the text, and what the patient said back.
--
-- ─────────────────────────────────────────────────────────────────────────
-- `sent_at` HAS NEVER MEANT WHAT IT LOOKS LIKE IT MEANS.
--
-- It is set the moment Twilio's API accepts the message, which is Twilio
-- agreeing to try. Whether it reached a handset is decided seconds to
-- minutes later and reported to a status callback -- and until this
-- migration there was no callback, so the answer was never collected.
--
-- 112 messages have gone to real patients under that column. A disconnected
-- number, a landline that cannot receive SMS, and a text read on a kitchen
-- table are all `sent_at = <a timestamp>` and nothing else. The one case
-- that matters operationally -- the patient never heard from us, so somebody
-- should ring ahead -- is the one the schema could not express.
--
-- So: `delivered_at` for the carrier's confirmation, and `provider_status`
-- for its own word, kept verbatim rather than mapped onto our vocabulary.
-- A dispute is argued with the carrier's term, not our paraphrase of it.
--
-- NOTHING IS BACKFILLED. The 112 are genuinely unknown and will stay unknown
-- -- Twilio only calls back for messages that asked it to, and these did
-- not. A backfill guessing `delivered` from `sent_at` would convert "we have
-- no idea" into "we have a record", which is worse than the gap.

ALTER TABLE patient_messages ADD COLUMN delivered_at TEXT;
--> statement-breakpoint
-- Twilio's own word: queued, sending, sent, delivered, undelivered, failed.
-- Empty until a callback says otherwise, which is also the honest state for
-- every row written before today.
ALTER TABLE patient_messages ADD COLUMN provider_status TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
-- Their numeric error, where they gave one. 30003 is an unreachable handset,
-- 30005 an unknown number, 21610 an opt-out. Kept apart from failed_reason,
-- which is OUR sentence about OUR send attempt; this is theirs about the
-- carrier leg, and the two fail at different moments for different reasons.
ALTER TABLE patient_messages ADD COLUMN provider_error TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
-- The callback arrives keyed on Twilio's sid and nothing else, so the lookup
-- it performs has to be indexed or every receipt is a table scan. Not UNIQUE:
-- the column defaults to '' for the hundred-odd rows that never had one, and
-- a unique index would refuse the second of them.
CREATE INDEX IF NOT EXISTS patient_messages_provider_idx
    ON patient_messages(provider_id);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- AND WHAT THEY SAID BACK, WHICH HAS BEEN GOING NOWHERE AT ALL.
--
-- Our templates do not invite a reply -- the "text STOP to opt out" line was
-- removed deliberately, because Twilio enforces STOP at their end and the
-- sentence was unremovable clutter in every message. People reply anyway.
-- "not home till 6", "wrong address", "who is this". With no inbound URL
-- configured, Twilio has been answering those with its default empty
-- response and discarding them.
--
-- THE BODY IS STORED, AND THAT IS A DELIBERATE DECISION ABOUT PHI RATHER
-- THAN AN OVERSIGHT. A patient's own words about their delivery can contain
-- anything they choose to put in them, including their condition. Storing it
-- is still right: a reply nobody can read is an instruction from a patient
-- that we accepted and ignored, and that is the worse failure. It lives
-- under the same retention sweep as everything else here, and dispatch is
-- the only role that can read it.
CREATE TABLE IF NOT EXISTS patient_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Twilio's id for the inbound message. UNIQUE because carriers retry a
    -- webhook that did not answer quickly enough, and a retried "not home"
    -- must not become two of them on a dispatcher's screen.
    provider_id TEXT NOT NULL,
    -- Digits, as normalizePhone stores a number everywhere else in this
    -- system. Not E.164: the join below is against patient_messages.phone.
    phone TEXT NOT NULL,
    body TEXT NOT NULL,
    -- The open order this number has today, where there is exactly one.
    -- Null is common and fine: a reply hours after a completed delivery, a
    -- household with two, or a number we never texted.
    order_id INTEGER REFERENCES orders(id),
    -- Null when the number matched no order at all, so a reply is never
    -- hidden from dispatch merely because it could not be filed.
    project_id INTEGER REFERENCES projects(id),
    -- 'stop' and 'start' are the carrier keywords we act on; 'message' is
    -- everything a person actually wrote, which is the column dispatch
    -- reads.
    kind TEXT NOT NULL,
    received_at TEXT NOT NULL,
    -- Set when a dispatcher has seen it. The point of keeping replies is
    -- that somebody acts on them, and a list with no read state is a list
    -- that is scrolled past.
    handled_at TEXT,
    handled_by TEXT NOT NULL DEFAULT '',
    CONSTRAINT patient_replies_kind_check CHECK (kind IN ('message', 'stop', 'start'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS patient_replies_provider_unique
    ON patient_replies(provider_id);
--> statement-breakpoint
-- The dispatcher's query: today's unhandled replies, newest first.
CREATE INDEX IF NOT EXISTS patient_replies_unhandled_idx
    ON patient_replies(handled_at, received_at);
