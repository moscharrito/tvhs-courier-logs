# Restore drill: 2026-09-14

Produced by `npm run restore:drill -w server`.

## What this rehearsed, and what it could not

Ticket 4.4 asks for a Turso point-in-time restore exercised into staging.
**That was not done and could not be.** Point-in-time restore is a paid Turso
feature, the service is on the free plan, and there is no staging environment
until ticket 0.10. The snapshot here is a file copy.

What was rehearsed is everything after the snapshot comes back, which is where
our own mistakes live rather than the platform's: restoring into a new
database rather than over the top, migrating the restored copy up to the code
that will run against it, verifying it before trusting it, and measuring the
gap by name.

## Result

| | |
|---|---|
| Restored copy sound | **yes** |
| integrity_check | ok |
| Foreign key violations | 0 |
| Migrations in the restored copy | 22 of 22 expected |
| Append-only triggers present | 4 of 4 |
| Migrations this drill had to apply | 22 |


## The gap

The snapshot was taken at 2026-09-14T13:59:36.680Z. After it, 9 deliveries were
recorded. The restored copy is missing 9 of them.

- Order 116 (SIM-4404-0116)
- Order 98 (SIM-4404-0098)
- Order 89 (SIM-4404-0089)
- Order 67 (SIM-4404-0067)
- Order 44 (SIM-4404-0044)
- Order 40 (SIM-4404-0040)
- Order 39 (SIM-4404-0039)
- Order 26 (SIM-4404-0026)
- Order 14 (SIM-4404-0014)

**This list is the deliverable of a restore, not the database coming back.** A
restore is finished when somebody knows which deliveries are no longer
recorded and can go and find them: on the courier's phone, where the offline
queue may still hold anything unsent; in the audit trail, which records what
was done even when the row it did it to is gone; and on the paper the pharmacy
holds.

## Counts

| | before the snapshot | after the work | in the restored copy |
|---|---|---|---|
| Orders | 120 | 120 | 120 |
| Custody events | 492 | 501 | 427 |
| Audit events | 0 | 0 | 0 |

The audit counts are zero because the simulated day is written straight to the
database rather than through the API, and `req.audit` lives in the request
path. In a real restore this row is the interesting one: the audit trail
records what was done even when the row it was done to is gone, so it is where
the missing work is reconstructed from.

## What is still not covered

- **The Turso half.** Taking the snapshot, choosing the moment, and the
  restore itself. Blocked on ticket 0.10.
- **Doorstep photographs.** They will live in S3 and are not in any database
  snapshot. S3 versioning is the control and there is no bucket yet; the
  settings are written down in `docs/infra/s3-bucket.md`.
- **How long it takes.** A file copy is instant. A real restore of a real
  database is not, and the time matters because the service is down for it.
- **Somebody other than the author following the runbook.** That is the part
  of a drill that finds the ambiguous sentence, and it has not happened.
