-- Business Center III is an office, not a pharmacy.
--
-- ─────────────────────────────────────────────────────────────────────────
-- OPEN ITEM 6, CLOSED.
--
-- 0006 seeded nine sites and said so in the row itself: "Listed in the bid
-- table; confirm whether it is a pickup location (open item 6)". The doubt
-- was right.
--
-- Three things settle it. The name carries no "Pharmacy" where every other
-- site's does. The address, 6200 Northwest Parkway, 78249, is the one printed
-- on the solicitation itself as University Health's own procurement address,
-- which is a back office. And when University Health's Assistant Director of
-- Pharmacy read out yesterday's volumes site by site on 30 September 2026, he
-- named eight pharmacies and this was not one of them.
--
-- ─────────────────────────────────────────────────────────────────────────
-- EIGHT, NOT SEVEN, AND THAT IS DELIBERATE.
--
-- Addendum 1 says "7 Pharmacy pick-up locations" three times. The eight that
-- remain each handled deliveries yesterday, from 504 at Robert B. Green down
-- to 14 at Vida. The RFP closed in May; the network has since grown, and
-- Addendum 1 separately describes three community hospitals that are not yet
-- operational.
--
-- So the count disagrees with the contract and the right response is not to
-- delete a pharmacy that is taking work. Exhibit E: Locations is the
-- authoritative list and is not in the documents we hold. Until somebody
-- reads it, eight real pharmacies beats seven and a guess.
--
-- ─────────────────────────────────────────────────────────────────────────
-- IT REFUSES TO DELETE A SITE WITH HISTORY.
--
-- A site is referenced by orders, by the ZIP-to-zone map and by returns. If
-- anything was ever picked up here the row stays, because deleting it would
-- orphan a custody record that is evidence. The delete is written so that it
-- simply does nothing in that case rather than failing the migration: a
-- deployment must not stop because a rehearsal once used this site.

DELETE FROM sites
 WHERE code = 'bc3'
   AND project_id IN (SELECT id FROM projects WHERE code = 'uh')
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.site_id = sites.id)
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.returned_to_site_id = sites.id);
--> statement-breakpoint
-- If it survived the delete above it is carrying history, so say why it is
-- still here rather than leaving the old note implying the question is open.
UPDATE sites
   SET notes = 'Not a pharmacy: University Health back office. Kept only because orders reference it. Do not dispatch from here.'
 WHERE code = 'bc3'
   AND project_id IN (SELECT id FROM projects WHERE code = 'uh');
