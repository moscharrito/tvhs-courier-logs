-- 78234 was missing from the zone map, and a delivery went there.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY A ROW RATHER THAN A RATE.
--
-- A ZIP with no zone cannot be priced: modules/uh/pricing.ts bills it per
-- one-way loaded mile, and driver-pay.ts pays it the out-of-zone rate, which
-- is $28.00 -- the top band, the same as zone 5. One delivery on 5 November
-- 2026 went to 78234 and was paid that way.
--
-- 78234 is Fort Sam Houston, inside Loop 410. Both its neighbours are zone 1
-- (78233 and 78235), as is every other ZIP in that contiguous central block.
-- Its absence from Bid Table BT-89AO is a gap in the table rather than a
-- statement about the geography, so the fix is the row, not the rate: paying
-- a top-band rate for a central stop is how a data fault becomes a standing
-- cost that nobody notices because the money flows.
--
-- Confirmed as zone 1 by the owner on 7 November 2026.
--
-- ─────────────────────────────────────────────────────────────────────────
-- DATED TODAY, NOT 2026-05-18, AND THAT IS THE WHOLE CARE IN THIS FILE.
--
-- modules/uh/zones.ts resolves a ZIP by the newest `effective_from` that is
-- on or before the delivery's service date. Writing this with the original
-- table's date would rewrite history: the 5 November delivery would re-price
-- from out-of-area to zone 1, moving what a courier was paid for a day
-- already settled and what University Health were billed for it.
--
-- Nothing already paid moves. Deliveries from 7 November onward get zone 1.
--
-- Idempotent, like every batch in 0007: the unique index is
-- (project_id, zip, effective_from), and the NOT EXISTS guard means a repeat
-- run writes nothing.
INSERT INTO `zone_zips` (`project_id`, `zip`, `zone`, `place`, `effective_from`)
SELECT p.`id`, '78234', 1, 'Fort Sam Houston', '2026-11-07' FROM `projects` p
WHERE p.`code` = 'uh' AND NOT EXISTS (
	SELECT 1 FROM `zone_zips` z
	 WHERE z.`project_id` = p.`id` AND z.`zip` = '78234' AND z.`effective_from` = '2026-11-07');
