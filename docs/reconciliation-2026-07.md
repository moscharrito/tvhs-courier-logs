# Reconciliation: 2026-07-01 to 2026-07-31

Produced by `npm run reconcile -w server` on 2026-11-17.

A simulated month was billed through the invoice pipeline, and every line was
then re-derived from the rate card by `src/modules/uh/reconcile.ts`, which
shares no code with the pricing module. This is phase 3's acceptance gate.

## Result

| | |
|---|---|
| Deliveries billed | 7772 |
| Invoice total | $185,321.50 |
| Independently checked total | $185,321.50 |
| Difference | **$0.00** |
| Lines that differ | 0 |
| Deliveries that could not be priced | 323 |

Every line matches the rate card.

## The rate card this was checked against

Transcribed from migration 0007, which was built from the bid table.
**Somebody has to compare this against the signed bid table once.** The signed
document is not in the repository, so no script can do it.

| Item | Rate |
|---|---|
| Zone 1 | $12.50 |
| Zone 2 | $14.50 |
| Zone 3 | $22.00 |
| Zone 4 | $36.00 |
| Zone 5 | $52.00 |
| STAT surcharge | $22.00 |
| After-hours surcharge | $18.00 |
| Dry run, per item | $9.00 |
| Out of area, per mile | $1.95 |
| Effective from | 2026-05-18 |

## Sampled lines

Spread through the month so they are not all one day and one pharmacy. Check
these with a calculator against the table above.

**Order 13372** (SIM-20260701-0001) = $12.50

- zone 1: $12.50
- total: $12.50

**Order 14379** (SIM-20260704-0189) = $9.00

- dry run: $9.00 x 1 item = $9.00
- dry run replaces the delivery charge, so no zone rate and no mileage
- total: $9.00

**Order 15388** (SIM-20260708-0198) = $14.50

- zone 2: $14.50
- total: $14.50

**Order 16401** (SIM-20260712-0165) = $22.00

- zone 3: $22.00
- total: $22.00

**Order 17421** (SIM-20260716-0139) = $12.50

- zone 1: $12.50
- total: $12.50

**Order 18435** (SIM-20260720-0153) = $12.50

- zone 1: $12.50
- total: $12.50

**Order 19437** (SIM-20260724-0063) = $22.00

- zone 3: $22.00
- total: $22.00

**Order 20444** (SIM-20260728-0070) = $14.50

- zone 2: $14.50
- total: $14.50

## Open questions

- A STAT delivery that failed is charged the dry-run fee AND the STAT surcharge. Addendum 1 does not say whether a surcharge survives an attempt.

## Not billable

323 deliveries could not be priced and are in neither total:

- Out of area with no University Health authorisation on record. Addendum 2 clause 9 requires one before it can be billed at the out-of-area rate. Record their approval against the order, or leave it off this invoice.

## What this does and does not prove

It proves the invoice pipeline computes what the rate card above says, for a
month of ordinary and awkward deliveries, using two independent readings of
the contract.

It does not prove the rate card matches the signed bid table: that comparison
needs a person and the signed document.

It does not prove the billing unit is right. Whether a delivery is billed per
stop or per package, and whether a surcharge survives a failed attempt, are
open items with University Health.
