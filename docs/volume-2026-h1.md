# What University Health's own six months say

Source: `Courier Volume Zip Codes included Jan -June 2026.xlsx`, sent by Rebeca
to Jason Wong, 2 October 2026. 169,602 delivery rows, January to June 2026,
each carrying the dispensing pharmacy and the patient's destination ZIP.

Reproduce with `npx tsx server/scripts/analyse-volume.mjs "<path>"`. Read-only,
touches no database.

## The headline

**937 deliveries a day across 181 calendar days. On a weekday, 1,240. On a
Tuesday, 1,417. The busiest single day was 1,875.**

The RFP says "approximately 7,900 monthly deliveries", which is about 263 a
working day. The bid was priced against that figure.

| Source | Deliveries a day |
|---|---|
| RFP, Addendum 1 | ~263 |
| University Health's covering email | 796 |
| **This file, all days** | **937** |
| **This file, weekdays only** | **1,240** |
| This file, Tuesdays | 1,417 |
| This file, busiest day | 1,875 |

The RFP understates a weekday by about **4.7 times**.

The covering email's 796 understates the file it is attached to by 18 per
cent: 169,602 divided by 796 is 213 days, and January to June is 181. Their
per-pharmacy figures are each about 85 per cent of what the rows add up to.
Worth raising, politely, because it is their number and it is the one in
everybody's head.

## By pharmacy

Deliveries a day, averaged over all 181 days.

| Pharmacy | Six-month total | Per day |
|---|---|---|
| Robert B. Green | 43,598 | 241 |
| Discharge | 28,090 | 155 |
| Southeast | 26,587 | 147 |
| Southwest | 24,322 | 134 |
| Texas Diabetes Institute | 23,183 | 128 |
| Pavilion | 20,569 | 114 |
| Wheatley | 1,995 | 11 |
| Vida | 1,258 | 7 |

**The main campus pairing is wrong.** Discharge and Pavilion were put under one
lead on the strength of "about 160 between them". They are **269 a day
together**, which is more than Robert B. Green. That is the largest single load
in the contract and it currently has one lead on it.

Wheatley and Vida at 18 between them are confirmed as one lead who also drives.

## The week is not flat

| Day | Deliveries a day |
|---|---|
| Tuesday | 1,417 |
| Wednesday | 1,343 |
| Thursday | 1,273 |
| Friday | 1,179 |
| Monday | 995 |
| Sunday | 261 |
| Saturday | 106 |

Deliveries happen on **all 181 days**, so this is a seven-day operation with no
exceptions, including 1 January.

Two consequences. Staffing cannot be built on 937: a Tuesday is half as much
again, and the peak day was double. And a Saturday at 106 across eight
pharmacies does not need eight leads or anything like forty drivers, so the
weekend is where the model saves money rather than where it strains.

## Destination ZIPs, which is how it is priced

Addendum 2 clause 2 prices every delivery by its destination ZIP. Clause 3 puts
one flat rate on each of zones 1 to 3 and allows per-ZIP or per-community rates
in zones 4 and 5.

**185 distinct destination ZIPs.** The concentration is the useful part:

| Share of deliveries | ZIPs needed |
|---|---|
| 50% | 13 |
| 80% | 29 |
| 90% | 37 |
| 95% | 44 |
| 99% | 64 |

The ten busiest: 78207 (55/day), 78228 (52), 78237 (52), 78223 (49), 78227
(38), 78245 (36), 78221 (34), 78210 (33), 78201 (32), 78211 (28).

The tail is **118 ZIPs averaging under half a delivery a day, 0.8 per cent of
volume between them**. That is the shape zones 4 and 5 were written for, and it
means per-ZIP pricing there is a short exercise rather than a project.

78207 being the densest destination is worth noticing: Robert B. Green and the
Texas Diabetes Institute both sit in it, so a large share of the heaviest ZIP
is a short hop from its own pharmacy.

## BC3 is a destination, not a pharmacy

The file carries a delivery method column with two values:

| Method | Deliveries | Share |
|---|---|---|
| Courier | 167,290 | 98.6% |
| Courier to BC3 (6200 NW Pkwy) | 2,312 | 1.4% |

About **13 a day**, sent from Discharge and Pavilion only. This settles open
item 6 from the other direction: Business Center III is somewhere deliveries
**go**, not somewhere they are collected from. Removing it as a pickup location
was right.

It is also a gap. These are inter-facility transfers with no patient on the
other end, and the system assumes every order has one: a recipient name, a
patient address, an identity check where the form demands it, and a text
message. Sending a patient notification for a transfer between two University
Health buildings would be wrong, and nothing currently stops it.

## What this changes

1. **Pricing.** The bid was built on roughly a fifth of the real weekday
   volume. This is a commercial conversation, not a software one, and it should
   happen in writing before 1 November.
2. **Staffing.** Discharge and Pavilion need more than one lead between them.
   Tuesday is the day to size against, not the average.
3. **Weekend cover** can be a fraction of the weekday roster.
4. **Zone pricing** can now be quoted against a real distribution: 29 ZIPs
   carry 80 per cent of the work.
5. **Inter-facility transfers** need a delivery type that is not a patient
   delivery.
