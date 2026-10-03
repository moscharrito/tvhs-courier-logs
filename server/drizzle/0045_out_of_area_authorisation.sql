-- Who at University Health said yes to a delivery outside every zone.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ADDENDUM 2 CLAUSE 9 MAKES IT A PRECONDITION, NOT A BILLING NOTE.
--
--   "Delivery destinations outside all established delivery zones require
--    prior University Health authorization. Approved Out-of-Area deliveries
--    shall be billed only in accordance with the contracted Out-of-Area
--    rate."
--
-- Prior. The approval has to exist before somebody drives forty miles, which
-- makes this an operational flag first and an invoicing one second. Today an
-- out-of-area order is detected by its ZIP matching no zone, priced by the
-- mile, and billed, with nothing anywhere recording that anybody agreed to
-- it. The first time that is noticed is a disputed invoice line, after the
-- fuel.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THREE COLUMNS, AND THE REFERENCE IS THE IMPORTANT ONE.
--
-- Their reference, not ours: an email, a ticket, whatever the person who
-- approved it can be asked about months later. A boolean would say an
-- authorisation existed without saying how to find it, which is the half of
-- the record that matters when somebody disputes the line.
--
-- Nullable timestamp rather than a default, because "never authorised" and
-- "authorised at the epoch" must not be the same row.

ALTER TABLE `orders` ADD `out_of_area_authorised_by` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `out_of_area_authorised_at` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `out_of_area_reference` text DEFAULT '' NOT NULL;
