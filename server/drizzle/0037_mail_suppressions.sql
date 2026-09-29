-- Addresses we must stop sending to, and why.
--
-- A hard bounce means the address does not exist. A complaint means somebody
-- pressed "this is spam". Continuing to send to either is how a sending
-- domain's reputation is destroyed, and the damage is not confined to the
-- address that bounced: it degrades delivery for every pharmacist on the
-- contract, including the ones who need the message.
--
-- ONE ROW PER ADDRESS, not per event. The question this table answers is
-- "may we send to this address", which is a state and not a log. The event
-- history lives in audit_events, which is append-only and is the right place
-- for "when did this start happening".
--
-- ADDRESSES ARE STORED LOWERCASE. The local part is case-sensitive in the
-- RFC and case-insensitive at every mail provider anybody actually uses, and
-- a suppression that misses because somebody typed a capital letter is worse
-- than useless: it reads as working.
--
-- SOFT BOUNCES ARE NOT RECORDED HERE. A full mailbox or a server having a bad
-- afternoon is temporary, and suppressing on one would permanently silence a
-- pharmacist over a transient fault. Only hard bounces and complaints.
--
-- REVERSIBLE ON PURPOSE. A person whose mailbox was closed and reopened, or
-- who pressed the spam button by accident, must be able to receive again, so
-- rows can be deleted. That is a deliberate act by an administrator and is
-- audited; it is not something the mail path does on its own.

CREATE TABLE IF NOT EXISTS mail_suppressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    -- 'bounce' or 'complaint'. Checked rather than free text: this drives
    -- whether a hospital stops being told about their deliveries.
    reason TEXT NOT NULL,
    -- What AWS called it, kept verbatim for a person diagnosing later.
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    CONSTRAINT mail_suppressions_reason_check CHECK (reason IN ('bounce', 'complaint'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mail_suppressions_address_unique ON mail_suppressions(address);
