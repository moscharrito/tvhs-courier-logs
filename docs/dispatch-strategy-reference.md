# Dispatch Strategy Reference

Source: "How Medical Couriers Dispatch Route Spikes" (82-second explainer, Contracts folder, September 8, 2026). Transcribed September 9, 2026. This page maps each claim in the video to the part of the platform that delivers it, so the build stays aligned with the story being told to University Health and to the team.

## The strategy, as stated

1. Point-to-point dispatch fails when hundreds of orders arrive at once. The answer is dynamic route batching.
2. Nine San Antonio pharmacies release about 260 orders into the system at noon.
3. The system plots every delivery coordinate across Bexar County at once.
4. Every package must reach the patient within a two-hour window, with ten active drivers.
5. Overlapping coordinates are grouped into dense geographic loops, turning the map into ten continuous routes.
6. Dispatchers watch live progress on a county-wide map and a street-level view so no route falls behind.
7. At every stop the driver captures a timestamp and the patient's signature, which updates the chain of custody. This is proof of delivery.
8. Completed daily logs generate zone-based invoices automatically.
9. The same logs feed dashboards of success rates by day, week, and month.

## Where each claim lives in the build

| Claim | Platform feature | Ticket | Status |
|---|---|---|---|
| 2. Nine pharmacies release lists at noon | Sites table, daily list import per site with saved column mapping | 1.1, 1.5 | Planned |
| 3. Every coordinate plotted at once | Geocoding on import, review queue for failures, order model with lat/lng | 1.4, 1.6 | Planned |
| 4. Two-hour window per package | due_at computed per order from service type and the project's clock-start rule | 1.3, 1.6 | 1.3 done: the rule, the service levels and dueTimesFor ship as project settings. 1.6 stamps them onto orders |
| 5. Grouping into dense loops | Runs and stops; dispatch board with nearest-neighbor sequencing from the origin site; full optimization deferred past go-live | 2.1, 2.2 | Planned, optimization deferred |
| 6. County-wide and street-level live view | Dispatch board with courier lanes and minutes-to-due; live status feed on each courier event; map link per stop | 2.2, 2.8 | Planned. The board is list-first; a map layer is an addition to 2.2 |
| 7. Timestamp and signature, chain of custody | Arrive timestamp separate from outcome; receiver name and signature; custody events per package; POD PDF | 2.4, 2.5, 3.2 | Planned |
| 8. Zone-based invoices from daily logs | Zone by ZIP table, price table, invoice generation with a line per order | 1.2, 3.4 | Planned |
| 9. Dashboards by day, week, month | Completion and on-time reports by day, week, quarter, exportable to the UH Quality Services layout | 3.3 | Planned |
| Foundation for all of it | One login, projects and memberships, server-side sessions, users managed in-app | 0.5, 0.6, 0.7 | Done or in progress |

## Two places the video overstates what the plan supports

**Ten drivers, noon release, two-hour window. Settled against us, September 11, 2026.** Addendum 1 answers the clock-start question directly, and twice:

> "The item must be delivered to the designated location within two (2) hours of the courier receiving the delivery request."

> "Correct, for the 2-hour response request, item(s) must be delivered to the designated location within two (2) hours of the courier receiving the delivery request."

The clock starts at receipt of the request, not at physical pickup. That is the reading the Implementation Plan staffing model costs at about 18 couriers on the road, not 10. Open item 1 is therefore closed as a contract question: the answer is receipt.

Two things follow.

1. **Do not use the ten-driver figure anywhere University Health will see it.** It is not a negotiating position; it is a service level we would miss. The video should be re-cut or captioned before it is shown to UH.
2. **The remaining lever is the release schedule, not the clock.** Addendum 1 says the lists are "typically provided between 12:00-2:00pm", and "typically" is the only slack in the sentence. Staggering releases across that window, agreed with the pharmacies in writing, is what makes a smaller fleet defensible. Ask for it as an operational agreement during mobilization; do not assume it.

`sla.clockStart` remains a project setting so a later tranched agreement can be reflected without a code change, but it defaults to `receipt` and should not be moved off it without something in writing from UH.

**"Instantly groups into dense loops" and "delivered perfectly on time."** Go-live sequencing is nearest-neighbor from the origin pharmacy, which is good batching but not optimal routing. True optimization is deferred past go-live. The completion target is 85 percent by contract and 95 percent as the internal goal, not 100 percent. Use those numbers in anything UH will read.

## Design decisions the video confirms

- The dispatch board must be built around the noon wave, not around individual orders. Bulk import and bulk assignment come before any per-order screen polish.
- Arrival time is its own event, captured before the outcome, because UH counts an on-time arrival as a success even when nobody answers the door.
- Proof of delivery is the custody record, not a separate feature. One event log serves the driver app, the POD PDF, the invoice, and the audit.
- The due-time rule belongs in one function, not in the board, the invoice and the report separately. `dueTimesFor` in `server/src/core/projects/settings.ts` is that function; ticket 1.6 calls it to stamp `due_at`.
- STAT carries two deadlines, not one: two hours from the request overall, and one hour from pickup inside that. Both are modelled, because a courier who picks up late can satisfy one and breach the other.
- A map view for dispatchers is worth adding to ticket 2.2 as a second tab beside the lane view. Mapbox GL JS or Google Maps JavaScript API, address-only, per the privacy program.
