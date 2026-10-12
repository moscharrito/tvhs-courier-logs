# Driver rate card

What Izy pays a courier per completed delivery on the University Health
contract, agreed 12 October 2026.

This file exists because these five numbers were living in three places that
could not be compared: a PDF offer letter, a terminal command, and a row in
`project_settings`. The client rate card is seeded by SQL and is auditable;
this one was not written down anywhere.

## The rates

| Zone | Pays the driver | Set with |
|---|---|---|
| 1 | $5.00 | `--zone1 5.00` |
| 2 | $7.25 | `--zone2 7.25` |
| 3 | $12.00 | `--zone3 12.00` |
| 4 | $22.00 | `--zone4 22.00` |
| 5 | $28.00 | `--zone5 28.00` |

Zones 4 and 5 were printed in the offer letter as a single range,
"$22.00 - $28.00". They are two rates, confirmed 12 October 2026.

**A zone is the destination ZIP's band, not a measured distance.** The mile
ranges printed beside the zones in the offer letter describe them; Addendum 2
clause 2 prices by destination ZIP. A delivery twelve miles out can be zone 1,
and a driver who checks their odometer against the mile column will disagree
with their payslip. The offer letter needs one line saying so.

## Setting them

Not in Project settings, deliberately: the rest of that screen is operational
settings a dispatcher changes mid-shift, and these are what people are paid.

```
node scripts/driver-rates.mjs --show
node scripts/driver-rates.mjs --basis zone \
    --zone1 5.00 --zone2 7.25 --zone3 12.00 --zone4 22.00 --zone5 28.00
```

Add `--base https://logs.izyglobalservices.com --i-mean-production` for the
live server. It asks for the admin password with the echo off, refuses any
amount that is not a whole cent, and reads the result back.

`driverPay.basis` must be `zone` for these to be used at all. Until it is, the
project pays on `perDeliveryCents` by service level, which is the default and
is what every other project means.

## What this is not

**It is not the client rate card.** What University Health are billed is in
`price_schedules`, seeded by `drizzle/0007_pricing.sql` from Bid Table BT-89AO
and firm for the base term and both renewals. Keeping the two apart is what
makes them comparable:

| Zone | UH pays Izy | Izy pays driver | Margin | |
|---|---|---|---|---|
| 1 | $12.50 | $5.00 | $7.50 | 60% |
| 2 | $14.50 | $7.25 | $7.25 | 50% |
| 3 | $22.00 | $12.00 | $10.00 | 45% |
| 4 | $36.00 | $22.00 | $14.00 | 39% |
| 5 | $52.00 | $28.00 | $24.00 | 46% |

## Three things the driver is not paid for, and Izy is

Recorded here rather than argued about later. None of these is wrong; all
three are decisions nobody has explicitly taken, and the first is the one
drivers will raise first.

**An attempted delivery.** The contract carries a `dry_run_fee` of **$9.00**,
so a stop where nobody answers the door bills $9.00 and pays the courier
nothing. `driver-pay.ts` says so in its own header: *"a courier who drove to a
door and found nobody in has done real work"*. Failed attempts are counted and
shown beside the paid ones so the question stays visible.

**STAT urgency.** The contract adds a **$22.00** STAT surcharge. Driver pay is
by zone and does not vary by service level, so a STAT in zone 1 bills
$12.50 + $22.00 = $34.50 and pays the driver $5.00 — the same as an unhurried
scheduled stop to the same ZIP. The driver carries the one-hour-from-pickup
clock for none of the premium.

**The return leg.** Section 9 of the offer letter requires every undelivered
package to go back to the originating pharmacy the same day, and the ticket
carries a Return charge line. No driver rate covers it.

## Still open

- Whether any of the three above should attract a driver rate.
- Wait time: the delivery ticket has a Wait time charge line and
  `price_schedules` has no column for it, so it is neither billed nor paid
  through the system today.
- Out-of-area: billed at **$1.95/mile** on top of zone 4 or 5. The driver gets
  the flat zone rate however far it is.
