-- A rate for one ZIP, where the contract allows one.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ADDENDUM 2 CLAUSE 3 SPLITS THE PRICING IN TWO.
--
--   "Respondents shall provide one fully loaded flat rate per completed
--    delivery for each of Zones 1, 2, and 3. The proposed rate for each
--    respective zone shall apply uniformly to all ZIP codes assigned to that
--    zone. ZIP-specific pricing will not be accepted within Zones 1 through
--    3. For Zones 4 and 5, Respondents may provide separate fully loaded flat
--    rates by individual ZIP code, community, or other University
--    Health-designated service area."
--
-- price_schedules carries one rate per zone, which is the whole of what zones
-- 1 to 3 may be. Zones 4 and 5 may be finer, and there was nowhere to put it.
--
-- ─────────────────────────────────────────────────────────────────────────
-- TIED TO A SCHEDULE, NOT TO ITS OWN DATE.
--
-- A contract price schedule changes as a whole: that is why price_schedules
-- is one row for the entire list rather than a row per rate. A ZIP rate is
-- part of that list, so it belongs to a schedule and changes with it. Giving
-- it an independent effective_from would allow a half-escalated price list,
-- which is the thing that shape was chosen to prevent.
--
-- EMPTY ON PURPOSE. The Pricing Schedule naming the zone 4 and 5 ZIPs and
-- their rates is not among the documents we hold. The capability exists; the
-- numbers are a commercial decision and nobody should invent them here. Until
-- a row is added, every ZIP prices at its zone rate exactly as before.
--
-- The ZIP is five digits, matched the way resolveZone matches: a ZIP+4 on an
-- order is priced by its prefix.

CREATE TABLE IF NOT EXISTS `zip_prices` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `project_id` integer NOT NULL REFERENCES projects(id),
    `schedule_id` integer NOT NULL REFERENCES price_schedules(id),
    `zip` text NOT NULL,
    `price` real NOT NULL,
    /* What University Health call this area, where the rate is for a named
     * community rather than a bare ZIP. Clause 3 allows either. */
    `label` text DEFAULT '' NOT NULL,
    `note` text DEFAULT '' NOT NULL,
    `created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
-- One rate per ZIP per schedule. Two rows for the same ZIP would make the
-- price depend on which one a query happened to read first, which is the kind
-- of ambiguity that only shows up in a disputed invoice.
CREATE UNIQUE INDEX IF NOT EXISTS `zip_prices_schedule_zip_unique`
    ON `zip_prices` (`schedule_id`, `zip`);
