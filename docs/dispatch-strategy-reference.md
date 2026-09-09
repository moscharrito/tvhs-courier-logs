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
| 4. Two-hour window per package | due_at computed per order from service type and the project's clock-start rule | 1.3, 1.6 | Planned |
| 5. Grouping into dense loops | Runs and stops; dispatch board with nearest-neighbor sequencing from the origin site; full optimization deferred past go-live | 2.1, 2.2 | Planned, optimization deferred |
| 6. County-wide and street-level live view | Dispatch board with courier lanes and minutes-to-due; live status feed on each courier event; map link per stop | 2.2, 2.8 | Planned. The board is list-first; a map layer is an addition to 2.2 |
| 7. Timestamp and signature, chain of custody | Arrive timestamp separate from outcome; receiver name and signature; custody events per package; POD PDF | 2.4, 2.5, 3.2 | Planned |
| 8. Zone-based invoices from daily logs | Zone by ZIP table, price table, invoice generation with a line per order | 1.2, 3.4 | Planned |
| 9. Dashboards by day, week, month | Completion and on-time reports by day, week, quarter, exportable to the UH Quality Services layout | 3.3 | Planned |
| Foundation for all of it | One login, projects and memberships, server-side sessions, users managed in-app | 0.5, 0.6, 0.7 | Done or in progress |

## Two places the video overstates what the plan supports

**Ten drivers, noon release, two-hour window.** The video's numbers describe the scenario where the two-hour clock starts when the list is received. The staffing model in the Implementation Plan shows that scenario needs about 18 couriers on the road, not 10. Ten works only if the clock starts at physical pickup or the pharmacies release lists in tranches. That is open item 1 with University Health. Until it is answered, do not present the ten-driver figure to UH as the operating plan.

**"Instantly groups into dense loops" and "delivered perfectly on time."** Go-live sequencing is nearest-neighbor from the origin pharmacy, which is good batching but not optimal routing. True optimization is deferred past go-live. The completion target is 85 percent by contract and 95 percent as the internal goal, not 100 percent. Use those numbers in anything UH will read.

## Design decisions the video confirms

- The dispatch board must be built around the noon wave, not around individual orders. Bulk import and bulk assignment come before any per-order screen polish.
- Arrival time is its own event, captured before the outcome, because UH counts an on-time arrival as a success even when nobody answers the door.
- Proof of delivery is the custody record, not a separate feature. One event log serves the driver app, the POD PDF, the invoice, and the audit.
- A map view for dispatchers is worth adding to ticket 2.2 as a second tab beside the lane view. Mapbox GL JS or Google Maps JavaScript API, address-only, per the privacy program.
