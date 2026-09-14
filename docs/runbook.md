# Runbook

Ticket 4.5. What to do when something needs doing, written to be read at
three in the morning by somebody who did not write the code.

Every procedure here is a real command against real endpoints. Where something
cannot be done yet, it says so and says what it is waiting on, rather than
describing a procedure that would fail halfway.

---

## Before anything else

```bash
curl -s https://<service>.onrender.com/health
```

```json
{"status":"ok","db":"ok","migrations":20,"uptimeSeconds":1174,"version":"1.0.0"}
```

| Field | What it tells you |
|---|---|
| `status` | `degraded` means the database query failed. The platform health check fails with it, so Render will not route to a broken instance. |
| `db` | `error` means Turso is unreachable or the token is wrong. Nothing else on this page will work. |
| `migrations` | Should match the number of files in `server/drizzle`. Fewer means a deploy is part-way or a rollback left the code behind the schema. |
| `version` | From `server/package.json`. Confirms which build is actually serving. |

It is public and holds nothing sensitive, so it can be checked from anywhere,
including from a phone.

**Logs.** Render dashboard, service, Logs. Every line is JSON with a
`requestId`; an error a user reports can be found by that id if they can read
it off the screen. `LOG_LEVEL=debug` in the environment turns up the volume
without a redeploy (it is read at boot, so it needs a restart).

---

## Deploy

**Today, deploying would ship the wrong code.** Render's `autoDeploy` follows
the repository's default branch, which is `master`. All of the platform work
lives on `0/1-characterization-tests`, which is 39 commits ahead and has never
been pushed. Merging that branch is a decision, not a deploy step, and it has
not been made. Until it is, the blueprint would deploy the old TVHS courier
log app.

Once the branch question is settled, the deploy itself is:

1. `npm run ci` locally. It must be green: typecheck and 1,078 tests.
2. `npm run audit`. Production dependencies, high and above. Must exit zero.
3. Push to the default branch. Render builds `npm ci && npm run build` and
   starts `npm start -w server`.
4. Watch `/health` until `status` is `ok` and `migrations` matches the number
   of files in `server/drizzle`.
5. Sign in and load the dispatch board. The health check proves the process is
   up and the database answers; it does not prove the shell was built.

**Migrations run themselves, on boot, before the listener binds**
(`server/src/index.ts`). A failed migration means the process refuses to
start, which means the health check fails, which means Render keeps the
previous instance serving. That is the intended behaviour: a half-migrated
database serving traffic is worse than a deploy that did not happen.

To watch a migration separately from a deploy, run it first against the same
database:

```bash
NODE_ENV=production TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:migrate -w server
```

**The first deploy onto an empty database** has a sequence that cannot be
reordered, because two-factor authentication is enforced (ticket 4.3):

1. `ADMIN_USER` / `ADMIN_PASS` create the first administrator on boot. They
   are ignored on every later boot.
2. Sign in as that administrator. The only thing the account can reach is the
   two-factor setup screen.
3. Enrol: scan the QR, type the code, **write down the ten recovery codes**.
4. Now create everybody else, and grant project memberships.

Step 3 is not optional and cannot be skipped from the outside. An
administrator who abandons it has an account that can do nothing.

---

## Rollback

Render: service, Deploys, find the last good one, Rollback. It restarts on the
previous image; no build runs.

**Check the migrations first.** Migrations are forward-only: a rollback moves
the code back and leaves the schema where it is. That is safe when the new
migration only added things, which every migration in this repository so far
does (new tables, new columns with defaults, new indexes). It is not safe if a
migration ever drops or renames a column the older code reads.

So, before rolling back across a migration:

```bash
# What the schema has now
curl -s https://<service>.onrender.com/health     # note "migrations"
# What the old build expects
git show <old-commit>:server/drizzle/meta/_journal.json | grep -c '"tag"'
```

If the numbers differ, look at the SQL files in between. If they only add,
roll back and carry on. If any of them removes or renames, **do not roll
back**: fix forward instead, because the older code will be reading columns
that are no longer there and the failure will be a 500 per request rather than
anything as clean as a refusal to start.

**A rollback does not undo data.** Orders created, deliveries recorded and
invoices issued by the newer build are still there. If the problem was bad
data rather than bad code, rolling back does nothing for it: see Restore.

---

## Rotate a secret

All of these live in the Render service's Environment tab. Changing one
restarts the service.

### SESSION_SECRET

**Everybody is signed out**, immediately and everywhere. Couriers mid-round
will be asked to sign in again, and anything in a phone's offline queue stays
queued until they do (it is bound to the courier who created it, ticket 2.7,
so it is not lost).

Do it when a secret may have been exposed, and prefer doing it outside a wave.
Render can generate the replacement; it must be at least 32 characters, which
the config enforces in production.

### TURSO_AUTH_TOKEN

1. Mint a new token in Turso for the same database.
2. Paste it into Render. The service restarts.
3. Watch `/health` until `db` is `ok`.
4. Revoke the old token in Turso, **after** step 3 and not before.

Doing step 4 first takes the application down until the restart completes.

### ADMIN_USER / ADMIN_PASS

These matter only on an empty database. Changing them on a live system does
nothing at all: it does not change the administrator's password. To change a
real password, use the users API (`POST /api/users/:username/password`) or ask
that person to change their own.

### S3 keys

Not applicable yet: `FILES_ENABLED` is `false` and there is no bucket. When
there is (ticket 0.10), rotation is the same shape as the Turso token: add the
new key, restart, confirm, then deactivate the old one.

---

## Revoke a device, or a person

Three different things, and the difference matters.

### A courier lost their phone

The phone holds an enrolled device cookie, and a PIN signs in from it. Revoke
the enrolment, which takes its live sessions with it:

```
GET    /api/users/<username>/devices      (admin, to find the id)
DELETE /api/devices/<id>                  (admin, or the owner)
```

The row is kept and marked revoked, so the history stays readable. If anything
was queued offline on that phone it is gone with it, which is the correct
trade: a phone in somebody else's hands must not be able to send.

### A staff member lost their phone (two-factor)

They sign in with a recovery code, in the same box as the six-digit code.

If they have no recovery codes left:

```
POST /api/users/<username>/mfa/reset      (admin)
```

This clears their enrolment **and revokes every live session they have**,
because the lost phone may be holding one. They sign in with their password
and are put straight back on the setup screen.

**If the last administrator loses both their phone and their recovery codes,
the application has no way back in.** Nobody can reset the last
administrator, by design. The way back is a direct database change:

```sql
DELETE FROM mfa_recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = '<admin>');
DELETE FROM mfa_enrolments     WHERE user_id = (SELECT id FROM users WHERE username = '<admin>');
```

Run it from the Turso shell, then sign in and enrol again immediately. **Write
it in the audit trail by hand afterwards** (a note to the security program),
because a change made outside the application does not appear in it: the audit
table is append-only to the app, not to somebody with the database token.
Prevention is cheaper: a second administrator account, enrolled, with its
recovery codes somewhere separate.

### Somebody has left

```
PATCH /api/users/<username>   { "status": "disabled" }
```

A disabled account loses every session on its next request, not on the next
sweep: the session middleware checks the account's status on every resolve.
The account is kept rather than deleted, so the custody events and signatures
that carry their name still make sense a year later.

Revoke their sessions too if you want them out this second rather than on
their next request:

```
DELETE /api/users/<username>/sessions     (admin)
```

### Reading back what somebody did

```
GET /api/audit?username=<username>&limit=200
GET /api/audit?action=auth.login_failed&from=2026-09-01T00:00:00Z
GET /api/audit?action=mfa&limit=100          (prefix match: mfa.enrolled, mfa.reset, ...)
```

Platform administrators only, and reading it is itself audited. `detail` never
contains PHI: ids, counts and field names only.

---

## Restore

**Half of this has been rehearsed and half has not, and the line between them
matters.** Steps 3, 5 and 6 below were exercised by ticket 4.4 and there is a
dated report: `docs/restore-drill-2026-09-14.md`. Steps 1, 2 and 4 involve
Turso's point-in-time restore, which is a paid feature on a service still on
the free plan, so **taking and restoring a real snapshot has never been done**.
That waits on ticket 0.10.

1. **Stop writing.** In Render, scale the service to zero, or suspend it. A
   restore while couriers are still recording deliveries produces a database
   that disagrees with the phones in their pockets. *(Not rehearsed.)*
2. Restore in Turso to a timestamp **before** the damage, into a **new
   database**. Never over the top of the live one: the broken state is
   evidence, and the restore might be to the wrong moment. *(Not rehearsed.)*
3. **Migrate the restored copy, then check it before trusting it.**
   ```bash
   ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=<restored> TURSO_AUTH_TOKEN=... \
     npm run db:migrate -w server
   ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=<restored> TURSO_AUTH_TOKEN=... \
     npm run restore:check -w server
   ```
   `restore:check` reads and never writes, and exits non-zero if the database
   is not sound. It reports integrity, foreign key violations, the migrations
   applied against the number this build ships, **whether the append-only
   triggers came back**, the row counts, and the newest row of each kind.

   The trigger check is the one worth understanding. A database that lost
   `custody_events_no_delete` answers every query correctly and passes every
   other check; the only thing that changed is that the chain of custody Scope
   1.2.7 turns on can now be edited. Nothing else would notice.

   "How far back this goes" is how you size step 5 before promising anybody
   anything.
4. Repoint `TURSO_DATABASE_URL` at the restored database and restart. *(Not
   rehearsed.)*
5. **Work out what was lost, by name.** Anything recorded between the restore
   point and the stop is gone from the database but may not be gone from the
   world:
   - **The courier's phone.** The offline queue holds anything unsent and will
     replay it when they next sign in. Do not tell anybody to sign out.
   - **The audit trail**, which records what was done even when the row it was
     done to is gone. `GET /api/audit?from=<restore point>` is the list.
   - **The pharmacy's paper.**

   The drill produces exactly this list for a simulated loss, which is what it
   is for: a restore is not finished when the database answers again, it is
   finished when somebody knows which deliveries are no longer recorded.
6. Tell University Health. A delivery record that vanished is a records
   problem under the contract, whatever caused it.

### Rehearsing it

```bash
npm run restore:drill -w server
```

Seeds a day, snapshots it, records more work, loses the database, restores the
snapshot into a new file, migrates and verifies it, and reports the gap by
name. It writes `docs/restore-drill-<date>.md` and exits non-zero if the
restored copy is not sound. The snapshot is a file copy, so **it rehearses our
handling and not Turso's feature.**

### What is still not covered

- **Taking and restoring a real snapshot**, and how long that takes while the
  service is down. Blocked on ticket 0.10.
- **Doorstep photographs.** They live in S3 and are in no database snapshot.
  The control is bucket versioning, specified in `docs/infra/s3-bucket.md` and
  not enabled, because there is no bucket.
- **Somebody other than the author following this page.** That is the part of
  a drill that finds the ambiguous sentence, and it has not happened.

---

## On-call

**To be filled in before go-live. This is the section a runbook is useless
without, and it cannot be written from the code.**

| Role | Who | Reach them on |
|---|---|---|
| Platform on-call | | |
| Operations lead | | |
| University Health contact | Karthik Munnam (procurement) | see the contract file |
| Turso support | | plan-dependent; free plan has no support channel |
| Render support | | plan-dependent |

Decide and write down:

- Who is called when the dispatch board is down during a wave, and after how
  many minutes.
- Who decides to fall back to telephone dispatch, and what the couriers are
  told to do.
- Who tells University Health, and at what threshold. The contract's own
  standard is the delivery window, so an outage that does not miss one is a
  different conversation from an outage that does.
- Where the paper fallback lives. Scope 1.2.8 wants a signature per delivery;
  a system outage does not suspend that.

---

## Known failure modes

Written from what has actually gone wrong in development and in the load test,
not from imagination. Each one says what it looks like from outside.

### The application refuses to start

**Looks like:** Render shows the deploy failing, the health check never
passes, the previous instance keeps serving.

This is usually the configuration guard doing its job. The logs name every
problem at once, in plain English. The most likely ones:

- `TURSO_DATABASE_URL is set but NODE_ENV is "development"`. The deploy lost
  `NODE_ENV=production`. Without it: cookies are not Secure, HSTS is not sent,
  staff are not made to hold a second factor, and the proxy hop is not
  trusted. It refuses on purpose (ticket 4.5).
- `SESSION_SECRET must be at least 32 characters in production`.
- `TURSO_DATABASE_URL is required in production`. A local file would be lost
  on the next redeploy.
- A migration failed. The log names the file. Fix forward.

### Everything is slow at the start of a wave

**Looks like:** the first minute of the morning is sluggish, then fine.

Known and measured (ticket 4.1). Every slow request in the load test is in the
first five seconds, when every courier opens the app at once against a server
that has answered nothing yet. The worst is the pickup manifest,
`GET /runs/:id/pickup`. It is ticket 4.8 and it is not fixed. If it is worse
in production than the report suggests, that is the staging measurement nobody
has done yet, not a new fault.

### Board reads are queueing behind courier writes

**Looks like:** the board takes seconds to refresh while couriers are
delivering; everything recovers when the wave ends.

On a local file database this was write-ahead logging being off, and it is now
on (`src/db/client.ts`). On Turso this pragma does nothing, because Turso is a
server with its own concurrency. If it happens in production the cause is
somewhere else, and the place to look is the Turso dashboard's query latency
rather than this application.

### A courier says "it says that order is not mine"

**Working as intended, almost always.** A dispatcher moved the order to
another courier while this one was halfway down their list. The load test
produces exactly this and the courier app sets such refusals aside for a
person rather than retrying them (ticket 2.7). Look at the board: the order
will be on somebody else's lane.

### A courier's deliveries are not appearing

**Looks like:** the courier says they delivered; the board says they did not.

Their phone is queueing. The app shows a sync indicator. Anything queued sends
when signal returns, in the order it was recorded, and a delivery cannot
arrive before its own arrival because the queue is strictly ordered. Nothing
needs doing unless it persists after the phone is demonstrably back online,
which would be a bug worth capturing before clearing anything.

**Do not tell them to sign out.** Signing out empties the queue, by design:
it holds patient names and addresses on a phone that may be personal. Anything
unsent would be lost.

### Somebody is locked out

**Looks like:** 429, "Too many attempts. Wait N minutes."

The auth throttle (ticket 4.2). Ten password attempts per account and fifty
per address in fifteen minutes; five PIN attempts per account. It clears
itself when the window passes; there is no unlock button, and a restart clears
it too, because the counters are in this process's memory.

**That last point is also a limitation to know about:** with more than one
Render instance, an attacker gets each limit once per instance. Moving the
counters into the database is the fix and it is deliberately deferred, because
a write per failed attempt against a network database is a lever handed to the
attacker. Revisit it when there is a second instance.

Check whether it is one person fumbling or something worse:

```
GET /api/audit?action=auth.throttled&limit=50
```

Many different usernames from one address is a spray, not a forgotten
password.

### A staff account cannot reach anything, and says "Set up two-factor authentication"

Working as intended (ticket 4.3). They have not enrolled. They can reach the
setup screen and nothing else. If they cannot enrol because they have no
phone, that is a real problem with no good answer inside the application: an
administrator can create them a fresh account, but the policy applies to that
one too.

### An import is refused

**Looks like:** the pharmacy's list will not upload.

The import refuses rather than guessing, and says which row and which column.
The usual causes are a changed column heading and a new pharmacy that has no
mapping yet. Neither is an incident; both are a person looking at the preview
screen, which shows what would be created before anything is.

### Deliveries cannot be invoiced

**Looks like:** the invoice draft lists exceptions and the total looks low.

Out-of-area deliveries with no mileage recorded cannot be priced, because
there is no distance to price them on. That needs ticket 1.4 (geocoding and a
distance matrix), and it is not a defect in the invoice. In the simulated
month it was 323 deliveries out of 7,772. Issuing an invoice past an exception
is deliberate and explicit: `excludeUnpriceable: true`.

### A doorstep delivery is refused

Working as intended until ticket 0.10. Doorstep delivery needs a photograph,
the photograph needs a bucket covered by a BAA, and there is no bucket. The
stop screen refuses clearly and names the ticket, rather than recording a
delivery with no evidence behind it.

### `npm run db:generate` stops working

**Looks like:** "Please install latest version of drizzle-orm".

drizzle-kit resolving drizzle-orm from the wrong place in the workspace. It
happened once, silently, when drizzle-orm was upgraded in ticket 4.2, and was
only noticed one ticket later. `drizzle-orm` is now a root devDependency so it
stays hoisted where drizzle-kit can find it. If it recurs, check where npm
actually put it:

```bash
ls node_modules/drizzle-orm server/node_modules/drizzle-orm
```

Migrations can always be written by hand: the runner only reads the SQL files
and `meta/_journal.json`.

---

## Before go-live

```bash
curl -s https://<service>.onrender.com/api/projects/uh/uh/go-live
```

Thirteen checks against the database and the configuration. It never answers
"ready": it answers "nothing automatic is in the way", and lists seven things a
person has to confirm because no program can. Run it before the decision, not
after.

---

## During the shadow week

`docs/shadow-week.md` is the plan. The log is at **Discrepancies** on the
project, and the rule is that every item is resolved or accepted before the
next morning, with anything `critical` dealt with that night. The Friday
question is `GET /api/projects/uh/uh/discrepancies/summary`, which answers in
numbers and does not make the decision.

---

## Answering "do you have a control for that?"

`docs/privacy-controls.md` is the inventory: each safeguard, the file that
implements it, and the test that proves it, under the headings a privacy and
security program uses. It also lists what is missing, which is the part worth
reading first.

The short version of what is missing, at the time of writing: no BAAs with
Render, Turso or AWS (ticket 0.10), no breach notification procedure, no
backup that has been restored, no second enrolled administrator, and no
written program for any of it to be checked against.

---

## Retention and purging

A sweep runs at boot and once a day after that. It **counts** what is past its
retention period and writes a row saying so; it never deletes anything. The
row is written whether or not it found something, because "nothing was past
retention on 3 November" is what an auditor asks for and what nobody can prove
after the fact.

```
GET  /api/retention          the policy, the last sweep, the last 20 runs
POST /api/retention/sweep    count now rather than waiting for the timer
```

Platform administrators only.

**Most categories cannot be purged yet, and that is deliberate.** Nobody has
decided how long a delivery record, a signature or a proof-of-delivery
photograph is kept. The policy carries a seven-year placeholder so the sweep
has something to count against, marked `decided: false`, and the purge refuses
any category in that state with the reason printed. A retention period a
developer picked is not a retention period; it is a number that turns up in an
audit years later attached to deleted evidence.

**The decision is one decision in two places.** `docs/infra/s3-bucket.md` has
a bucket lifecycle rule disabled for the same reason. Decide the number with
University Health and Izy's compliance counsel, write it into the privacy and
security program, then change both.

### Purging, when there is a period

```
POST /api/retention/purge
{ "category": "client_events", "expected": 412, "reason": "past the seven day window" }
```

`expected` is the exact count the approver read off the screen. If it has
moved, the purge refuses with a 409 and the real number. That is the manual
approval, in a form that survives being pasted into a terminal at the wrong
moment: a checkbox would not.

What it refuses, and why:

| Code | Means |
|---|---|
| `retention.undecided` | Nobody has decided a period for this category. |
| `retention.not_purgeable` | The audit trail, and issued invoices. Never removed by this job. |
| `retention.count_moved` | The number changed since you looked. Look again. |
| `retention.files_unavailable` | No bucket, so the photographs cannot actually be deleted. Removing the rows would leave them in S3 with nothing pointing at them. Needs ticket 0.10. |

The audit trail is never purged. It holds no PHI, and it is the only record
that can answer a question about a deletion; purging it to satisfy a retention
policy would destroy the proof that the policy was followed.

**Deleting a delivery record means deleting its custody events**, and
`custody_events` is append-only in the database, enforced by a trigger, because
Scope 1.2.7 wants a chain of custody that is evidence rather than a table
somebody can tidy. The purge drops and recreates that trigger around its own
delete, deliberately and visibly, the way the simulator's cleanup does. It is
never relaxed for the application. If a purge is ever interrupted, check the
trigger is back before anything else:

```sql
SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custody_events_no_delete';
```

If it is missing, recreate it from `server/drizzle/0009_custody.sql` before
letting anybody near the application, because until then the chain of custody
is editable and the tests that prove it is not are the only thing that would
notice.

### What a purge leaves behind

The audit trail records the request before the delete and the result after it,
so an interrupted purge still says what was meant. `retention_runs` holds the
counts, table by table. Neither is enough to undo one: see Restore.

---

## Routine checks

| How often | What | Command |
|---|---|---|
| Every deploy | Tests and types | `npm run ci` |
| Every deploy | Production dependency advisories | `npm run audit` |
| Monthly | Invoice arithmetic against the rate card | `npm run reconcile -w server` |
| Before go-live, then quarterly | Load and concurrency | `npm run loadtest -w server` |
| Quarterly | Who can reach what | `npx vitest run test/access-matrix.test.mjs --root server` |
| Automatic, daily | What is past retention | `GET /api/retention` to read the result |
| Quarterly, and after any schema change | The restore procedure | `npm run restore:drill -w server` |

The reconciliation and the load test both write dated reports into `docs/`,
which is the point: they are things somebody signs, not things that scroll
past in a terminal.
