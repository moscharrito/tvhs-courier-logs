# Izy Ops Platform

Operations platform for Izy Global Services courier contracts. One login, one user directory, a module per contract. Today it runs the TVHS RMD courier log system. The UH Pharmacy Courier dispatch module is being built on the same platform; see `docs/uh-platform-feasibility-plan.md` and `docs/build-backlog.md`.

## Layout

```
server/        Express API. server/server.js is the legacy TVHS app, booted by server/src/index.ts
web/           Frontend shell: Vite + React (login, project switcher, users, devices, audit, legacy TVHS mount)
docs/          Plans, backlog, runbook, and the dated reports somebody signs
NorthBound/    Historical TVHS driver log spreadsheets (reference for the export format)
SouthBound/    Historical TVHS driver invoice spreadsheets (reference for the export format)
render.yaml    Render blueprint
```

## Commands (run from the repo root)

```bash
npm ci                 # install every workspace from the root lockfile
npm run ci             # typecheck + tests, what GitHub Actions runs
npm run audit          # production dependency advisories, high and above
npm run typecheck
npm test
npm run build          # compile server/src to server/dist
npm start              # run the compiled server
npm run dev            # run server/src/index.ts with tsx and file watching
npm run dev -w web     # Vite dev server on :5173, proxying /api and /legacy to :3000
```

## Running it in production

**`docs/runbook.md`** is the operational document: deploy, rollback, rotating a
secret, revoking a lost phone, restoring from a backup, and the failure modes
that have actually happened, with what each one looks like from outside. It is
written to be read by somebody who did not write the code, at three in the
morning.

**`docs/training/`** is what the people using it are given: a one-page courier
quick card, a dispatcher guide, and a one-pager for pharmacy staff. They quote
the application's own button text, because training material that paraphrases
the interface makes somebody translate it at the worst possible moment.

Writing them against the screens rather than from memory found a real gap: the
device enrolment and PIN sign-in built in ticket 2.3 existed as a tested API
that **nothing in the frontend called**, for three phases, so no courier could
reach a PIN and the device-bound second factor was unreachable in practice.
Ticket 5.4 closed it: the sign-in page opens on a PIN and the courier's own
name when the phone is enrolled, the run screen offers setup once so the
feature is discoverable at all, and the devices page now separates **This
phone**, **Your phones** and **Signed in** instead of listing sessions under a
heading that promised devices.

**`docs/privacy-controls.md`** is the control inventory: every safeguard this
application and its hosting actually implement, with the file that implements
it and the test that proves it, arranged under the headings a privacy and
security program uses. It exists because ticket 4.7 asked to check the program
against the app and **there is no written program yet**, so the useful half is
the inverse: write down what is true, and what is missing, so the program can
be checked against reality in one pass when it is written.

A document like that rots the first time somebody renames a module, so
`server/test/privacy-controls.test.mjs` reads it: every file it cites must
exist, and the numbers a program would quote back at us (session timeouts,
lockout limits, code lifetimes, retention periods) are asserted against the
constants they describe. A session timeout cannot be changed in one place and
left true in the other.

Two things in it are worth knowing before you need it.

**The first deploy onto an empty database has an order that cannot be
changed.** Two-factor authentication is enforced in production, so the
bootstrap administrator signs in, can reach nothing but the setup screen,
enrols, writes down the recovery codes, and only then creates anybody else.

**The server refuses to start against a real database without
`NODE_ENV=production`.** Half of the security posture hangs off that variable:
Secure cookies, HSTS, whether staff are made to hold a second factor, and how
many proxy hops are trusted. A deploy that lost it would serve PHI with every
one of those quietly relaxed and a health check still saying `ok`, so the
configuration check treats a Turso URL outside production as a fatal
misconfiguration rather than a preference. `ALLOW_TURSO_OUTSIDE_PRODUCTION=true`
is the deliberate exception, for inspecting or restoring a database from a
laptop.

## Local configuration

Copy `server/.env.example` to `server/.env` (gitignored) and fill in the values. The entry point loads `.env` outside production, then validates the environment (`server/src/config.ts`) and refuses to start with a message naming every missing or invalid variable. With no `TURSO_DATABASE_URL` the server uses a local SQLite file at `server/courier_logs.db`.

## Tests

`server/test` holds characterization tests for the TVHS API. Each test file boots the real server in-process against a throwaway SQLite file on a random port. Vitest runs files in separate processes, so in-memory state (such as the PIN throttle) does not leak between files.

## Database and migrations

The schema lives in `server/src/db/schema` (Drizzle). Versioned SQL migrations live in `server/drizzle` and are applied automatically on boot, before the listener binds; a failed migration stops the start. To run them by hand (for example against Turso before a deploy):

```bash
npm run db:migrate -w server
```

After changing the schema, generate the next migration and commit the SQL and the `meta/` snapshot together:

```bash
npm run db:generate -w server -- --name <short-description>
```

Databases created by the original TVHS server adopt the baseline migration without change; those older than the `pin`, `leg_from`, and `leg_to` columns get them added first.

## Projects

A project is one courier contract. Two are seeded: `tvhs` (TVHS RMD Courier) and `uh` (UH Pharmacy Courier, RFP-226-03-068-SVC, dispatch module in progress). Platform admins are admins of every project. Users belong to projects through memberships with a per-project role (`admin`, `ops_manager`, `dispatcher`, `courier`, `client_viewer`). Project-scoped APIs live under `/api/projects/:pid/<module>/...`, where `:pid` is the project code (`tvhs`) or id, and require membership. `GET /api/me/projects` lists the caller's projects. The pre-project TVHS paths (`/api/routes`, `/api/checkin*`, `/api/logs*`, `/api/admin/*`) answer 308 redirects to the `tvhs` project for one release.

## Sessions

Sessions are server-side (`sessions` table). The `izy_sid` cookie carries only a random token; the row is keyed by its SHA-256, so the table cannot be replayed. Idle expiry refreshes on use (staff 30 minutes, couriers 12 hours by default), absolute expiry does not (staff 12 hours, couriers 30 days). Signing out revokes the row. `GET /api/me/sessions` lists a user's live devices; admins can list and revoke any user's devices under `/api/users/:username/sessions`. Lifetimes are set with the `SESSION_*` variables in `server/.env.example`. A session started from a registered courier phone records which one, so revoking the phone revokes the session with it (see Registered devices below).

## Users

Users are managed in-app by platform admins through `/api/users` (create, update name/email/role/status, reset password, set or clear PIN, add or remove project memberships with per-project settings). Platform roles are `admin`, `staff`, and `driver`; project rights come from memberships. Disabling a user or resetting a password signs them out of every device. The environment only creates the first admin on an empty database. The admin screens live in the frontend shell under Users.

## Audit trail

`audit_events` is append-only: database triggers abort any UPDATE or DELETE. Every request gets `req.audit(action, entity, entityId, detail)`, which stamps the actor, project, IP, and time. Logins (success and failure), logouts, check-ins, log saves and clears, exports, admin reads of one user's data, user management, membership changes, and session revocations are recorded. `detail` holds ids, counts, and field names only, never PHI or secrets. The one deliberate exception is `project.settings.update`, which records the new values: they are contract parameters rather than patient data, and an invoice dispute turns on who changed the after-hours window and when. Admins query it at `GET /api/audit` with `username`, `action` (prefix), `entity`, `entityId`, `projectId`, `from`, `to`, `limit`, and `before` (cursor); reading the log is itself audited.

### Daily list import

Each pharmacy compiles its own delivery list and sends it, typically between noon and 2pm (Addendum 1). Nine pharmacies means nine layouts, so the importer discovers the column mapping, has a person confirm it, then saves it against the site. A saved mapping is keyed to a fingerprint of the header row: when a pharmacy changes its export, the fingerprint stops matching and the operator is asked to confirm again rather than the importer reading the wrong columns.

`server/src/modules/uh/import-parse.ts` is pure: bytes and a mapping in, rows and issues out. It reads .xlsx through exceljs and .csv with its own RFC 4180 parser, finds the header row beneath any title and blank rows, and normalises as it goes (ZIP+4 to five digits, punctuated phones to digits, "Emergency" and "Rush" to STAT). An unrecognised service type becomes scheduled **and says so**, so nobody is silently downgraded.

Rows come back with issues at two severities. An error blocks the row (no recipient, no address, no valid ZIP, a quantity that is not a number); a warning does not (no city, no description, an unrecognised service word, a ZIP outside the published zone list). Duplicates are detected within the file and against orders already imported for that site and date, keyed on the pharmacy's reference when there is one and on the normalised recipient and address when there is not. A duplicate is held back until the operator confirms it is a genuinely separate delivery.

Imported orders are created **ready** for dispatch rather than pending: the operator has already reviewed every row in the preview, the list itself is recorded as released, and a second release gate would only burn minutes off a two-hour clock that started when the pharmacy sent the list. Each one gets a `created` custody event naming the list and the row it came from, so the chain of custody starts where the order entered the system rather than at assignment.

Zones are resolved from the ZIP map at import, so a list is priceable before ticket 1.4 supplies coordinates; a ZIP outside the list is flagged as needing a distance. `due_at` is stamped with `dueTimesFor`, which means the SLA clock starts when the list was received, and `receivedAt` can be set explicitly so a list imported twenty minutes after it arrived does not quietly gain twenty minutes.

`POST .../uh/imports/preview` and `POST .../uh/imports` take the same bytes as the raw request body, with the filename in `X-Upload-Filename` and the options as a JSON query parameter. Preview changes nothing. Both need project `admin`, `ops_manager` or `dispatcher`.

#### PHI

This is the first module that stores patient data, and the rules are load-bearing rather than aspirational:

- **The uploaded file is never written to disk.** It is parsed in memory and discarded. There is no staging table and no temp file, so an operator who previews a list and closes the tab leaves nothing behind. That is why preview and commit each take the bytes, rather than the server holding them between the two.
- **An issue never contains a value copied from a row.** It carries a row number, a field name and a code. The operator sees the offending data in the preview table, which is authorised and transient; the issue list stays safe to log and count. A test asserts that no fixture name, street or phone number appears in any issue message.
- **Audit rows carry counts and ids only.** A test asserts the same of the whole audit trail after an import.
- **Only what a delivery needs is stored.** A pharmacy list usually carries more (date of birth, account number, drug name); the importer maps the fields it needs and drops the rest.
- `orders.dedupe_key` is a hash, so neither the column nor its index reads as a list of who is receiving medication.

Reading a list (`GET .../uh/imports/:id`) is itself audited, the way an admin reading one user's record is.

### Orders and the chain of custody

An order's status only ever moves through `POST /api/projects/:pid/uh/orders/:id/events`. There is deliberately no endpoint that sets a status directly: a status you can PATCH drifts away from the custody record that is supposed to explain it. `server/src/modules/uh/lifecycle.ts` holds the whole transition table, what each event means, which project roles may record it, and which fields it is meaningless without. An illegal event answers 409 with the current status and the list of events that would be legal instead.

Three rules in that table come straight from the contract and are easy to get wrong:

- **Arrival is a timestamp, not an outcome.** Addendum 1 counts an on-time arrival as a success even when nobody answers the door, so `arrived` records a time and leaves the status alone. The first arrival wins, so a courier tapping twice cannot reset the stamp that decides whether the delivery was on time.
- **A return is custody, not an outcome.** Scope 1.2.9 sends undelivered packages back to the pharmacy of origin, or to the Discharge Pharmacy after hours. That does not undo the failure: a dry run stays `failed` and bills as one. "Still in a van" is `status = 'failed' AND returned_at IS NULL`.
- **Once a courier has custody the order cannot be cancelled.** Something physical is in a vehicle; it has to be delivered, failed, or returned.

Proof of delivery needs the printed name and signature of the authorised **sending and receiving** personnel (Scope 1.2.8), so a signature is captured at pickup as well as at the door. STAT's second deadline, one hour from pickup, is stamped when the pickup happens, because that is the first moment it is knowable.

A timestamp more than five minutes in the future is refused. A device's clock can drift a little; beyond that, a future `received_at` would push the SLA deadline out and a future delivery time would make an on-time calculation say yes when the answer is no.

`POST /api/projects/:pid/uh/orders` creates a STAT or ad hoc order by hand, with `requestedAt` defaulting to now. Scheduled orders cannot be created this way: they come in on a daily list, where they are checked for duplicates first.

Couriers see and act on only the orders assigned to them, which is both the minimum-necessary rule for PHI and the obvious operational one.

`custody_events` is append-only in the database, the way `audit_events` is: migration 0009 adds triggers that abort any UPDATE or DELETE, because Scope 1.2.7 requires the chain of custody to be available for regulatory audit and a record that can be edited afterwards is not evidence. **It is not the audit trail.** `audit_events` records who touched the system and carries no PHI; `custody_events` records what happened to a patient's medication and deliberately carries the signatures the contract requires. Treat it like `orders`, not like a log.

### Order search and detail

`/projects/:code/orders` is the staff screen. Filters are the first thing on the page and the time remaining is the first thing on a row, because a dispatcher's questions are "what is late", "what has this pharmacy sent today", and "where is the order this caller is asking about". Filters live in the URL, so a view can be sent to a colleague.

Filter by service date or a date range, site, status, service type, courier (a username, or `unassigned`), zone (a number, or `out_of_area`), pharmacy reference, and `overdue=true`. **Searching by patient name is deliberately not offered.** It would put a name in a URL, and URLs reach browser history, proxies and referrer headers. The pharmacy reference is what a caller reads out anyway.

`GET .../uh/orders/summary` counts the same filtered set the list returns, so the screen's header cannot disagree with its own table. It reports the count by status, how many are overdue, and the on-time rate.

**On time is measured at arrival, not at delivery.** `evaluateSla` in `lifecycle.ts` is the single place that decides: Addendum 1 counts an on-time arrival as a success even when the recipient is unavailable, so a courier who reached the door at 19:58 and handed over at 20:05 was on time. Measuring at delivery would under-report our own performance against the figure University Health holds us to. The delivery time is a fallback only for records with no arrival captured. A cancelled order, or one with no deadline, is scored as `not_applicable` rather than guessed at. This is not the 85 percent completion rate, which is a different figure, and whose formula in Scope 1.2.5 reads inverted ("number of attempts divided by successful deliveries" is never 85 percent); reporting is ticket 3.3.

The detail page shows the packages, the full price breakdown, and the chain of custody with the signatures Scope 1.2.8 requires, rather than summarising them away. It is read-only: events are recorded by the dispatch board and the courier app, and the custody rows cannot be edited at all.

The breakdown is computed rather than stored, so it follows the settings and the effective schedule. Three inputs are not simply read off the row:

- **After hours** is measured at the delivery when there is one, else the pickup, else the request. Addendum 1 defines the service as one "requested and performed outside of normal business hours", and performed is what a courier can be held to. The response says which instant was used, because on a borderline order an $18 surcharge turns on it.
- **A dry run** bills per item, counting the quantities of the packages that actually failed rather than the whole order, since an order can be part delivered.
- **Mileage** for an out-of-area order is still unknown until ticket 1.4. `priceFor` says so in its notes rather than quietly billing zero as though the question were settled.

A price is marked provisional while the order can still change what it bills at.

### Runs and stops

A run is one courier's batch of stops for part of a day: the "dense loop" the dispatch strategy describes. A courier can have more than one in a day, because lists arrive between noon and 2pm and after-hours work happens too, so runs carry a label rather than being one per courier per date.

**Adding a stop is what assigns an order, and removing one is what unassigns it.** Both go through the transition table, so there is no path that puts work in a courier's hands without the custody event that says who did it and when. `server/src/modules/uh/runs.ts` never writes `orders.status` itself: `recordOrderEvent` in `order-events.ts` is the only code in the system that does, for every caller.

Three rules the endpoint enforces:

- **The event is recorded before the stop is inserted.** If the transition is refused the stop is never created, so a run can never hold an order that the order itself does not believe is assigned.
- **An order is on at most one run**, enforced by a unique index rather than only by a handler. Two couriers each believing a package is theirs is the failure that prevents.
- **A reorder must list exactly the orders already on the run**, each once. A short list would silently drop stops; a long one would add an order without ever recording the assignment.

Removing a stop is refused once the courier has picked the package up, because taking a stop off the board does not take it out of the van. It has to be delivered, failed, or returned.

`POST .../uh/runs` creates a run and optionally fills it in one call, reporting which orders it could not take and why. `POST .../runs/:id/stops` adds (optionally at a position), `DELETE .../runs/:id/stops/:orderId` removes, and `PUT .../runs/:id/sequence` reorders. Couriers see and open only their own runs. The dispatch board and nearest-neighbour sequencing are ticket 2.2, which needs the coordinates ticket 1.4 will supply.

### The dispatch board

`/projects/:code/board` is the screen a dispatcher watches during the noon wave: the unassigned pool on the left grouped by pharmacy, one lane per courier on the right, and the time remaining on every card.

`GET .../uh/board` returns the pool, the lanes, the couriers and the counts **in one request**. Fetching them separately would show an order in the pool and on a lane at the same time, which is the confusion the board exists to remove. Filters apply to both sides together so the header cannot disagree with what is on screen. Staff only: the board is every patient address for the day, and no courier needs that.

Two decisions in the screen worth knowing:

- **Dragging is an enhancement, not the mechanism.** Every assignment is also reachable through a select and a button. A drag-only board cannot be used with a keyboard, and a dispatcher on a headset during a 273-stop wave is not always holding a mouse. The select is the accessible path and the one the tests drive; drag calls the same function.
- **Polling pauses while the tab is hidden**, and catches up the moment it is shown again. A board left open overnight would otherwise pull every patient address for the day four times a minute into an empty room.

Dragging an order between lanes is one request (`allowMove`), not a delete followed by an add: it keeps the two custody events together and cannot leave an order unassigned because the second call never arrived. Moving is refused once the courier has the package.

**Courier presence** comes from when they last used the app (the sessions table), not from location tracking. The platform does not track a courier continuously; a position is known from the events they send, and only then. Someone who has never signed in is shown as such rather than being called present on the strength of nothing.

### Auto-sequencing a run

`POST .../uh/runs/:id/sequence/auto` proposes an order for the stops and applies it unless `preview` is set. Two strategies:

- **`nearest`** is nearest-neighbour from the pickup pharmacy, which is what the dispatch strategy describes. It needs coordinates on the site and on every stop, and **ticket 1.4 has not supplied them**. Asked for today it refuses with `sequencing.noOrigin` or `sequencing.missingCoordinates` and points at the strategy that does work. It never sequences part of a run geographically and leaves the rest: a silently partial route is worse than none, because the dispatcher would believe the whole run was measured.
- **`due`** is strictly by deadline. It needs nothing and is available now, but it takes no account of geography and will cross the county between stops.

Neither is optimal routing, and the plan says full optimisation is deferred past go-live. Plain nearest-neighbour also **ignores deadlines** entirely and can put a STAT with twenty minutes left at the end of a loop; the result says so in its notes, and the board shows the minutes-to-due badges afterwards so it is visible rather than silent.

`haversineMiles` is straight-line distance, for ordering stops relative to each other. It must never reach an invoice: the contract bills one-way **loaded** miles, which is a road distance, and that comes from the Distance Matrix call in ticket 1.4.

### What the board says is happening now

The board polls every fifteen seconds, so a poll has to be worth reading. Counts alone change without saying who did what, so the board carries a feed of courier events: collected, arrived, delivered, could not deliver, returned.

**The dispatcher's own actions are left out.** Echoing back `created` and `assigned` would bury the courier events, which are the only ones a dispatcher cannot already see.

**Ordered by when it happened, not by when the row was written.** The order detail page deliberately reads the chain of custody by id, because that is the append order. The feed answers a different question, against ages shown in minutes, and since ticket 2.7 a queued phone routinely delivers an hour-old event a moment ago. Sorting by arrival would headline it.

**A dry run shows the courier's own words.** The custody row carries the reason code, because that is what the invoice line rests on; the words the courier typed are on the package, because the contract bills a dry run per item. The feed carries both.

**Position comes from events, and never from tracking.** Each courier's last known position is their most recent event that carried coordinates, within the last twelve hours. The age travels with it and is shown, and anything older than fifteen minutes is marked old. A stale position presented as a live one is worse than none, because a dispatcher would route around a courier who is no longer there. The map link carries coordinates only, never an address.

**A board that has stopped updating says so.** If a poll fails the header changes from "updated 14:32" to "not updating"; during a wave that is the difference between a late delivery and a missed one.

### A simulated day

`npm run sim -w server` generates a whole day of the contract: 273 stops on a weekday, 227 at a weekend (UH's own figures from Addendum 1 and the bid table), spread across the nine pharmacies, carried by twelve test couriers, and driven from released to delivered or failed and carried back.

```
npm run sim -w server                          273 stops, 12 couriers, today
npm run sim -w server -- --orders 50           a smaller day
npm run sim -w server -- --stop-after assigned a board full of work to dispatch
npm run sim -w server -- --seed 7              a different but repeatable day
npm run sim -w server -- --reset               remove a simulated day again
```

**Nothing writes a status directly.** Every state change goes through `recordOrderEvent`, the same path the courier app uses, so a simulated day cannot contain an order in a state the application could not have produced. A generator that took the shortcut would produce data that hides lifecycle bugs rather than exposing them.

**What is real and what is assumed.** The daily totals are UH's. The split between pharmacies, the mix of service types and the failure rate are assumptions made in `simulate.ts` and labelled there as assumptions: UH gave a total, not a distribution, and the redacted sample list the addendum referenced was never supplied to us. When it arrives, those constants are what changes.

**Deterministic.** The same seed gives the same day, so a load test repeats and a bug found in a simulated wave can be reproduced.

**It only ever touches its own rows.** Everything it creates carries a `SIM-` reference, `--reset` removes only those, and the end-of-day return sweep picks up only failures it created itself. `--reset` has to drop the append-only trigger on `custody_events` to delete their events, so it refuses unless the caller confirms this is a local file database, puts the trigger back in a `finally`, and then checks that it is really there.

A full weekday takes about 25 seconds to generate (1113 lifecycle events) and the board renders it in about 65 ms. That is a generator figure, not a load test: ticket 4.1 is twelve couriers posting concurrently over HTTP, which is a different question.

### Demo data

`npm run seed:demo -w server` creates a courier called Mohammed (`demo-pass-2026`, PIN 4417) and a day of stops in the UH project: delivered, arrived, in transit, a dry run with a reason, two still assigned and two left in the pool. Every name and address is invented. It refuses to run against a Turso database, because demo patients in a production table are indistinguishable from real ones a week later and somebody would eventually invoice them. Each state is reached through the same transition table the application uses, so the seeded data cannot be in a state the app could not have produced itself.

### The courier app

`/projects/:code/my-run` is today's run on a phone: the next stop large and first, the rest in sequence, and one tap each for directions and dispatch. A courier who opens a project goes straight here; the rest of the project page is sites, pricing, settings and the whole day's addresses, none of which is theirs to see. `GET .../uh/runs/mine` returns the runs, the stops in sequence and the dispatch number in one request, because a phone on cellular should not make three round trips to show one screen.

**The map link carries the address only, never the patient's name.** That URL leaves this application: it reaches a third party's servers, a URL bar and the phone's own history. The address is what the courier needs to drive there; the name adds nothing to the navigation and everything to the disclosure.

The dispatch number is `dispatch.phone` in the project settings. There is no default, and the button is hidden until someone sets one: a courier standing at a door with a problem would dial whatever is there, so a placeholder is worse than nothing.

### Taking custody at the pharmacy

`POST .../uh/runs/:id/pickup` collects a batch. **One signature, many packages.** A technician handing over forty packages signs once; making a courier collect forty signatures at a counter would guarantee the feature goes unused and the record ends up blank, which is worse than one honest signature covering the batch. The custody events for every order in the batch point at the same signature row, and each still says individually that this courier took this order at this time.

Grouped by pharmacy, because that is where the courier is standing: a run can collect from more than one, and they are done a counter at a time.

**The package count is confirmed, not assumed.** The screen does not pre-fill the expected number, because that would turn "confirm the count" into "tap continue". A mismatch is allowed through with a reason and flagged in the response and the custody record; it is not blocked, because blocking it would only teach couriers to type whatever number makes the screen continue. A short handover nobody explained is unexplained missing medication, so the reason is required.

Signatures are stored as the **strokes** the finger drew, not as a rendered image: points in a 0..1 space, so the capture does not depend on the size of the phone and renders crisply at any size on a proof of delivery. A few hundred points is a kilobyte or two, it keeps the platform out of storing binary blobs before ticket 1.8's file service exists, and the stroke order and timing are part of the evidence. The key on the custody event reads `local:signature:<id>` so it says plainly where the bytes are today.

A pickup without a position is recorded and says so, rather than being refused: a courier inside a building often has no fix, and Scope 1.2.7 is better served by a custody record with a gap that is visible than by no record at all.

### The stop

`/projects/:code/orders/:id/stop` is the screen a courier works from at the door, and `POST .../uh/orders/:id/{arrive,deliver,doorstep,attempt}` are what it calls. `server/src/modules/uh/stop.ts` holds the rules; it writes no status itself, going through `recordOrderEvent` like every other caller.

**Arriving is its own tap, because arrival is the thing that is measured.** Addendum 1 counts an on-time arrival as the success, so folding it into the outcome would lose the time on every stop where the courier is quick. When an outcome does arrive without one, the arrival is inferred from it and the custody row says so in as many words rather than leaving a delivery with no arrival at all. The first arrival wins: a courier tapping twice cannot reset the stamp the deadline is judged against.

Then exactly one of three endings:

- **Handed over.** Printed name and signature, both required (Scope 1.2.8). The signature is captured as strokes, the same way the pharmacy handover is.
- **Left at the door.** A stored photo and a written reason, both required. It is **refused outright when any package on the order needs a signature**, not offered with a warning: Scope 1.2.3 allows a doorstep drop only "depending on the medication type", and a control a courier can see is a control a courier will try. The screen hides the button entirely and says why.
- **Could not deliver, a dry run.** A reason code **per package**, from Addendum 1's own list (`incorrect_address`, `recipient_not_located`, `no_access`, `incomplete_shipment`, `refused`, `other`), with a note required for `other`. Per package because the contract bills a dry run per item, so the reason is what the invoice line rests on, and because half a shipment arriving is a real outcome.

**The photo is written with the custody row, not attached afterwards.** `custody_events` is append-only by trigger, so there is no afterwards: an earlier version recorded the delivery and then tried to `UPDATE` the row with the file id, which the trigger rejected, leaving a courier looking at an error on a delivery that had in fact succeeded. `EventInput` carries `fileId` and the row is written once, complete. A photo that was never confirmed as stored, or that belongs to a different order, is refused before anything is recorded.

Until the S3 environment in ticket 0.10 exists, the doorstep endpoint answers 503 `files.notConfigured` and the screen says so plainly instead of offering a button that cannot work.

A position is sent when the phone offers one and the event is recorded without it otherwise, for the same reason as a pickup: a courier in a stairwell has no fix, and a record with a visible gap beats no record.

### Taking undelivered medication back

`/projects/:code/returns` and `GET`/`POST .../uh/returns`. Scope 1.2.9 sends an undelivered package back to the pharmacy of origin, or to the Discharge Pharmacy after hours.

**A return is not an outcome.** It records a time, a place and a name, and never touches the status: a dry run bills as a dry run whether or not the package has made it back yet. So the query that matters, and the reason the feature exists, is `status = 'failed' AND returned_at IS NULL`. At the end of a shift somebody has to be able to ask what medication is unaccounted for, and get a straight answer.

**Keyed on the courier, not the run.** Pickup is per run because a run is a batch collected at one counter. What is in the van at 8pm is whatever failed across every run of the day, and asking a courier to hand it back run by run would leave packages behind for no reason a courier could see.

**The destination is proposed, not enforced.** The rule picks the origin while that pharmacy is open and the after-hours pharmacy once it has shut, shows the courier which and why, and then records where the packages actually went. A pharmacy that shut early is a real event; a record claiming medication is somewhere it is not would be worse than one that admits the deviation, so an off-rule return needs a reason and is then allowed through. Same reasoning as the pickup count.

**Open or shut is the working day, not the billing window.** `businessHours` (08:00 to 20:00 by default), not the 20:00 to 07:00 after-hours window that carries the surcharge. They disagree between 7am and 8am, which is the Addendum 1 versus Scope 1.2.3 ambiguity noted under pricing. What matters here is whether anyone is behind the counter to take the packages, so sending a courier to a shut pharmacy to save an hour of bookkeeping would be the wrong trade.

The after-hours pharmacy is `returns.afterHoursSiteCode` in the project settings, defaulting to `discharge`: a site code rather than an id so it survives a reseed, and a setting rather than a constant so ops can repoint it without a deploy. A code matching no site falls back to the origin and says so on the screen, because silently routing medication to whatever site sorts first would be worse than a courier reading an explanation.

One signature covers the batch, the same as a pickup and for the same reason, stored as strokes under its own kind (`return`). Adding that kind meant rebuilding the `signatures` table, which is the shape of migration that lost rows in 0009; a migrations test captures a real signature before 0015 and proves it survives.

### Working with no signal

San Antonio has basements, lift shafts, loading docks and long stretches of the far zones with nothing. A courier standing in one of them has still made the delivery. So every write a courier makes goes through an outbox in IndexedDB (`web/src/lib/outbox.ts`) rather than straight at `fetch`, and the queue drains when it can.

**The phone generates the event id.** A server-generated id cannot help here: the phone would have to receive it first, which is exactly the round trip that failed. Each entry carries a `clientEventId` sent with the first attempt and with every retry, and `core/http/idempotency.ts` answers a repeat with the stored first reply instead of entering the handler again. Without that, the dangerous case is not the request that never arrives, it is the one that arrives and whose reply does not: the phone retries and the order is delivered twice.

**In order, one at a time.** A delivery recorded before its own arrival is a chain of custody that reads backwards. The queue stops at the first entry it cannot send rather than skipping ahead, and entries carry a `sequence` allocated one higher than anything already queued, not a timestamp: `Date.now()` has millisecond resolution, and two events recorded in the same millisecond would come back in whatever order their random ids happened to sort in.

**A refusal is not a retry.** A 4xx means the server understood and said no; sending it again in thirty seconds produces the same no for ever, with every later event stuck behind it. Those are moved aside and shown to the courier, who is the only one who can say what really happened. Network failures and 5xx are retried, and a 5xx also releases the claimed id on the server so a transient database error cannot make an id permanently unusable.

**A queued photo reaches the bucket before the event that depends on it.** A doorstep drop is queued as the blob plus the event; the queue asks for the upload URL, PUTs the bytes, confirms the object, and only then sends the delivery carrying the resulting file id. So a doorstep delivery is never claimed without the photo behind it, on a signal or off one.

**The queue is PHI.** It holds names, addresses and signatures in IndexedDB on a phone that may be personal. Entries are deleted the moment they are accepted, refusals expire after a day, and signing out empties it along with the service worker cache. On the server, stored replies are swept after `CLIENT_EVENT_RETENTION_DAYS` (7): a replay cache is useful for hours, not years, and an unbounded copy of every delivery response is a liability with no reader.

**A queued entry belongs to the courier who made it.** The queue lives on the phone, not on the person, and a phone is handed over, borrowed and signed into by the next shift. An entry is only sent while its own courier is signed in; otherwise it is set aside for a person, because the server records the actor from the session and sending it would name the wrong courier on an append-only custody row with somebody else's signature attached. This was found by watching it happen during verification, not by reasoning about it.

**The courier can always see the difference between "recorded" and "sent".** `SyncStatus` sits in the frame above every screen, says nothing when there is nothing to say, and becomes loud only for a refusal. A courier who cannot tell those apart will assume sent, and a delivery nobody knows about is the failure the whole feature exists to prevent.

A browser with no usable IndexedDB (a private window, site data switched off) falls back to sending directly and surfacing real errors, rather than pretending to queue and dropping the event.

### What University Health sees

`/projects/:code/deliveries`, behind `GET .../uh/client/...` and the `client_viewer` role. Scope 1.2.6 asks for a tracking method giving the time, the location, the description and the quantity. This is that, and deliberately nothing more.

**Scoped to pharmacies, not to the project.** A client viewer is a pharmacist at one counter. Their membership names the sites they may see (`settings.siteIds`, set from the admin screen), and an account with no sites named sees nothing and is told why. Defaulting an unscoped viewer to "everything" would mean one mistake in a settings form silently hands one pharmacy the other eight pharmacies' patients.

**No courier personal data beyond a first name.** A courier appears as "Ada"; our office appears as "Dispatch". No surnames, no usernames, no positions. UH needs to know a person carried it and who to ask; a courier is entitled to work without their employer's client being handed their movements.

**No money.** What a delivery cost belongs in an invoice somebody has checked (Scope 1.2.11, ticket 3.4), not in a tracking screen where a number can be quoted back at us that we never meant as a bill.

**A delivery at another pharmacy is 404, not 403.** A refusal would confirm it exists, which is itself something that viewer is not entitled to know.

**Searchable by the pharmacy's own reference, never by patient name**, for the reason the staff search made the same choice: a name typed into a search box reaches browser history, proxies and server logs. The screen says so rather than silently returning nothing.

Staff can open the same portal, so the people answering the phone can see exactly what the caller is looking at.

### Performance against the contract

`/projects/:code/reports`, behind `GET .../uh/reports/sla` and `.../sla.xlsx`. Staff only: the client gets their numbers from us in a workbook somebody has looked at, not from a live endpoint that could disagree with an invoice.

**The definitions are the feature.** Every rate carries its numerator, its denominator and what was excluded, on the screen and on a Definitions sheet of the workbook. A performance figure nobody can reproduce is worse than none, because the argument about it then happens in a contract meeting rather than here. Cancelled deliveries and still-open ones are excluded from every rate and counted separately; attempts that cannot be timed are counted and shown, so the on-time denominator can be checked against the attempt count.

**Scope 1.2.5's formula reads inverted.** It defines the completion rate as "the number of attempts divided by the number of successful deliveries" and in the same clause requires 85 per cent. That ratio is at or above 1 and can never be a percentage. The report uses the sensible reading as the headline and shows the literal ratio beside it, labelled, rather than resolving the ambiguity quietly in our own favour. It is an open item for the clarification email, and the screen says so.

**On time is measured at arrival**, through the same `evaluateSla` the board and the order detail use, so the figure on this screen cannot drift from the figure on those.

Ranges group by day, week, month or quarter. Weeks start on Monday and are labelled "week of 2026-09-14" rather than "2026-W38", which is a number people have to look up.

The Excel export has a Summary sheet, one sheet per breakdown, and the definitions. Rates are written as numbers with a percentage format rather than as text, so they can be charted. **The layout is provisional and says so on its own sheet:** it has not been agreed with University Health Quality Services, and the ticket expected that alignment to happen after the first draft rather than before.

### Invoicing

`/projects/:code/invoices`, behind `/uh/invoices`. Admins and ops managers bill; a dispatcher can read one; couriers and the client cannot reach it at all.

**A draft recomputes, an issued invoice does not.** Opening a draft re-prices every delivery in the period, because a late courier event or a corrected zone should change what we bill. Issuing writes every line down as billed and never recomputes it: you cannot send a finance team a number and then show them a different one. That is why `invoice_lines` exists rather than the invoice being a query, and the screen says on every draft that its numbers will move.

**One pricing function.** Lines are priced by `order-pricing.ts`, the same code the order detail screen quotes from. It was extracted from `orders.ts` in this ticket precisely so there is no second implementation to drift; a disagreement between a quote and a charge surfaces as a dispute over a number the client has already been shown.

**Nothing is billed at zero.** A delivery that cannot be priced, which today means out of area with no mileage until ticket 1.4 supplies distances, becomes an exception, is excluded from the total, and is listed above the total rather than below it. Issuing an invoice that leaves deliveries off requires saying so explicitly, and the count and the reason are written onto the invoice and printed on the document.

**Money is integer cents** everywhere, converted to dollars only for display. A dollar is not representable in binary floating point, and an invoice is the one place where a hundredth of a cent becomes a letter from somebody's accounts department.

**Corrections carry a reason** and cannot be removed once the invoice is issued: an issued document that quietly changes is not a document. An invoice is voided with a reason, never deleted, so the number stays used and the question "what happened to 0004" has an answer a year later.

**No patient names on an invoice.** It goes to a finance team who need the date, the pharmacy, the reference and the charge. The delivery ZIP is carried because it justifies the zone, and a ZIP with no name and no street is not a patient.

Both documents come from the writers already in the tree: the Excel export from exceljs, the PDF from `core/pdf`, paginated with a continuation header and a page count.

### Reconciling an invoice by hand

`npm run reconcile -w server` simulates a month, bills it through the invoice pipeline, and then re-derives every line from the rate card using arithmetic in `src/modules/uh/reconcile.ts` that shares no code with `pricing.ts`. It reports every difference with the working spelled out, writes `docs/reconciliation-<month>.md` for somebody to sign, and exits non-zero if anything disagrees. The same check runs in CI over three days, so the two readings cannot drift apart between now and go-live.

**A reconciliation that called `priceFor` would prove only that `priceFor` equals itself.** The point is two independent readings of the same contract, and finding where they differ before University Health does.

**What it proves and what it does not.** It proves the invoice pipeline computes what the rate card says, across ordinary and awkward deliveries. It does not prove the rate card matches the signed bid table: that document is not in this repository, so the report prints the rate card in full for a person to check once, by eye, against the signed copy. And it does not settle the billing unit, which is an open question with UH.

Two things came out of running it:

- **The wave simulation never produced an after-hours delivery.** Every simulated delivery happened in the afternoon, so the $18 after-hours surcharge had only ever been unit-tested and never appeared on a generated invoice. The simulator now runs a small evening batch with its own pickup, which is what an after-hours request actually looks like.
- **A failed STAT delivery is charged the dry-run fee *and* the STAT surcharge.** The dry-run fee replaces the delivery charge, but the surcharges survive. Addendum 1 calls the dry run "a predetermined flat fee ... to cover the attempted service for each item" and says nothing about whether a surcharge survives an attempt. The reconciliation raises it as a question rather than agreeing with the code, and it belongs in the clarification email with a dollar figure attached.

### The proof of delivery document

`GET .../uh/orders/:id/pod.pdf` for our own people, `GET .../uh/client/orders/:id/pod.pdf` for the pharmacy. One page, laid out around the five things Scope 1.2.8 names: the date and time, the pickup location, the delivery location, the description and quantity, and the printed name and signature of the sending and receiving personnel.

**Written by hand, not by a library.** `server/src/core/pdf/writer.ts` is a few hundred lines: Helvetica text, rules, boxes and polylines, uncompressed, with a plain cross-reference table. This document carries patient names, addresses and signatures, so everything in its path has to be reviewed, kept patched and covered by the security program we owe University Health, and the whole need is text in one standard font and some straight lines. The same reasoning as the SigV4 signer: small specified things are worth writing, large unspecified ones are not.

**The signatures are drawn, not described.** They were captured as strokes in a 0..1 space (ticket 2.4), so the document renders the actual movement of the pen at any size. They are fitted with a single scale factor for both axes, because stretching a signature to fill a wide box produces something the person did not draw, which is exactly what a disputed proof of delivery must not contain.

**A missing signature is shown as missing**, with the reason under it, never as a blank space that could be mistaken for a printing fault. A proof of delivery that hides its own gaps is not proof of anything.

**Our copy and the client's copy differ in one way:** ours names couriers in full, because it is our record of who handled a controlled substance; theirs names a first name, for the reasons in the portal section above.

**Not cached.** The ticket asks for the document to be cached in S3. A copy takes about ten milliseconds to build, and a cached one is a second copy of PHI with its own lifetime and its own deletion problem. The generation time is asserted in a test so that if it ever stops being true, the decision gets revisited rather than quietly remaining wrong.

Text that a base-14 font cannot draw is transliterated and the rest dropped, so an accented name prints plainly rather than breaking the file. The separators the application writes are mapped rather than dropped, which was found by rendering a page and reading it: "stat - Delivered" had been printing as "stat Delivered".

### The access matrix, and the holes it found

Building the portal meant creating the first real `client_viewer`, and that exposed something that had been true since ticket 1.5: the staff order search, the run list, the import list and the rate card had **no role gate at all**. Any member of the project passed. Couriers were narrowed to their own work by a filter inside the handler, but a client viewer would have read every patient address in the contract, and our price schedule with it.

Ticket 4.2 turned that one-off discovery into a standing check. `server/test/access-matrix.test.mjs` is a table of **every endpoint the application mounts against every kind of caller**, and it is both the specification and the proof: 109 cases, covering anonymous, a signed-in person who is not a member of the project, each of the five project roles, and the platform administrator. The non-member is the seeded TVHS driver, so every University Health row is a cross-project check as well.

Two rules make it worth having.

**Authorization is asserted and nothing else.** The ids in the table are nonexistent and the bodies are empty on purpose, so an allowed caller usually gets a 400 or a 404, and that counts as a pass. What is under test is the gate, not the handler behind it.

**A route must decide who is asking before it decides what exists.** A handler that answers 404 to a caller who should have been refused has told them the id is free. That is how the third defect below was found.

It found three more holes of the same shape as the first: routes written before `client_viewer` existed, which had simply never been asked the question.

- **Every University Health site was readable by a client viewer**: address, contact, the lot. Now staff and couriers, because a courier needs the pickup address and a pharmacy contact does not need the list of every location in the contract.
- **So were the project's operating parameters**, including the internal SLA goal we hold ourselves to above the 85% University Health measures. A client reading our own target is not a breach, but it is not theirs to read.
- **The manual event endpoint loaded the order before checking the role**, so a client viewer walking the id space learned which orders exist, one 404 at a time. It now refuses first and looks second.

The test ends with a coverage guard that compares the table against the routes the application actually mounts. A new endpoint fails the suite until somebody writes down who may call it, which is the only way a table like this stays true.

`docs/security-review-2026-09-13.md` is the written review: what was examined, what was found, what was changed, and what is still open.

### Guessing a credential

`POST /api/login` had no rate limit at all. The only thing slowing a guesser down was bcrypt, which is a cost to us as much as to them: answering ten thousand guesses with a deliberately slow hash is its own denial of service. `POST /api/login/pin/setup` takes a driver's password and had no counter either. Two doors, one credential, a counter on neither. The PIN picker and the enrolled-device endpoint each had one, and they were two copies of the same code.

`server/src/core/auth/throttle.ts` is now the only implementation, shared by all four, so a guesser cannot get a fresh allowance by moving between them.

**Two keys, not one.** By username alone, an attacker sprays one guess at a thousand accounts and is never counted. By address alone, an attacker with a thousand addresses is never counted, and a pharmacy behind one NAT locks itself out. Passwords get ten per account and fifty per address in fifteen minutes; PINs get five per account and thirty per address in ten. Five, because a PIN is four digits and five guesses is the most that can be allowed while leaving ten thousand possibilities genuinely out of reach.

A refused caller gets a 429, a `Retry-After`, and a message that reads the same whether or not the account exists. A correct credential clears that account's counter but not the address's: one person signing in correctly must not erase the evidence of a spray coming from the same place. Every lockout writes `auth.throttled` to the audit trail, which is what turns a blocked attack into a visible one.

**The counters live in this process's memory.** On one Render instance that is the whole picture; on two, an attacker gets each limit once per instance. Moving them into the database is the fix, and it is deliberately not done yet: a write per failed attempt against a network database hands the attacker a lever.

### Headers, and a script that came from somebody else

There were no security headers of any kind until ticket 4.2. `server/src/core/http/security.ts` sets them, written by hand rather than taken from helmet, for the same reason as the PDF writer and the SigV4 signer: the requirement is a fixed set of values this application has to decide anyway, and a dependency in the path of every response is one more thing to patch, audit and explain to University Health.

The policy is `default-src 'self'` with `script-src 'self'`, no CDN and no inline script, plus `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `base-uri 'none'`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that asks for the camera and position and nothing else, and HSTS for two years in production only. Sending HSTS from a development server would pin localhost to HTTPS in a developer's browser for a year.

**`script-src 'self'` immediately broke something, which is the point.** The legacy TVHS page was loading flatpickr from cdnjs at runtime, with no subresource integrity, on a page carrying a signed-in session and showing driver logs. A CDN compromise would have been our breach to report. The file is now served from `server/public/vendor/flatpickr`, byte-identical to cdnjs flatpickr 4.6.13, with the hashes recorded in the security review. A content security policy is a tripwire as much as a defence.

`style-src` keeps `'unsafe-inline'` and it is the one relaxed directive: React components set style attributes in about fifty places, and `index.html` carries the boot styles that paint the loading state before the bundle arrives. Style injection cannot execute code, and the price of removing it is a nonce threaded through the whole render path.

**`trust proxy` was not set**, which would have put Render's address in every audit row instead of the courier's, and made the new per-address throttle count the whole internet as one caller. It is now a hop count from the environment, one in production and none elsewhere. Not `true`, which trusts an `X-Forwarded-For` header from anyone and so lets a caller choose the address that lands in the audit trail.

### Dependencies

`npm run audit` checks production dependencies at the high threshold. It is not part of `npm run ci`, which has to run offline.

The review found one high advisory, `drizzle-orm` below 0.45.2, and upgraded it. Exposure was nil either way, because drizzle is used for schema definitions and migrations and every runtime query goes through `client.execute({ sql, args })` with bound parameters, but a high advisory in a production dependency is not something to argue with.

Four moderate advisories were traced to the calling code rather than accepted or dismissed by their labels: the `uuid` bug needs a `buf` argument that `exceljs` never passes, and the react-router open redirect needs a user-controlled navigation target, of which this application has none. Both "fixes" are major-version changes. The reasoning is written down in the security review so the next person does not have to redo it.

### A second factor for staff

`POST /api/login` stops being the whole of signing in for anybody who runs the contract. Project roles admin, ops manager and dispatcher, plus any platform administrator, hold a TOTP factor; the password step answers with a short-lived challenge instead of a session, and `POST /api/login/mfa` finishes it.

**Couriers are deliberately outside the policy.** Their second factor is the enrolled phone: a PIN works only from a device registered with the full password (ticket 2.3), which is something-you-have plus something-you-know already. Asking a courier to read a rotating code off a second device at a pharmacy counter, in the rain, is a control people find a way around, and a control that gets worked around is worse than none because it still looks like one. Client viewers are outside it for a different reason: they are outside contacts we cannot support through a lost-phone call, and they see only their own pharmacy's deliveries.

**The TOTP is written here** (`server/src/core/auth/totp.ts`), on the same reasoning as the PDF writer and the SigV4 signer: the whole of RFC 6238 is an HMAC, a truncation and a base32 alphabet, and this code sits in the authentication path of every administrator. It is checked against the RFC's own test vectors rather than against itself, including the counter above 2^32 that is otherwise invisible until the year 6053.

SHA-1 is correct here and not an oversight. The RFC allows SHA-256, essentially no authenticator app implements it, and a secret issued that way produces codes Google Authenticator will not match. The construction is HMAC, where SHA-1's collision weakness does not apply.

**A code cannot be used twice.** The window is one step either side, which covers a phone whose clock is half a minute out, and the last accepted step is stored, so a code read over a shoulder or out of a screen share is dead the moment it is used rather than good for another ninety seconds.

**Recovery codes are ten, single-use, and shown exactly once**, because the database holds only their SHA-256. Not bcrypt: these carry about 48 bits of entropy rather than being chosen by a person, so there is no dictionary to slow down, and ten bcrypt comparisons per sign-in attempt would be a second of server time per guess. The alphabet leaves out 0/O, 1/I/L and 5/S, because these get printed, photographed and read down a phone line. A recovery code goes in the same box as a real one at sign-in: somebody whose phone is in a taxi should not have to find a different form, and the server can tell the two apart without being told.

**The challenge between the two steps is server-side**, like sessions. A signed token the client carries could not be revoked, could not count its own attempts, and would let one intercepted password be replayed against the code prompt for as long as it lived. It expires in five minutes, counts wrong codes, and tears itself up after five.

**"Enforced in production" means the API refuses.** `src/core/auth/mfa.ts` holds a middleware that runs before every route in both halves of the application: a staff session that owes a factor may reach the enrolment endpoints, its own session, and nothing else. The first version of it was mounted after the user and audit routers, which left the platform administrator able to read the whole user directory, and the enforcement test caught that. Enforcement that lives only in the frontend is advice; the API is where the PHI is, and a stolen password reaches it without ever loading a page.

That includes the first administrator on a fresh deployment: they sign in, they enrol, and only then can they create anybody. The test harness does exactly that sequence, because with enforcement on there is no other order that works.

**A lost phone** is a recovery code, or `POST /api/users/:username/mfa/reset` from an administrator, which clears the enrolment and revokes every live session the person has, since the lost phone may be holding one. If the last administrator loses both their phone and their codes, the way back is the runbook (ticket 4.5) and not the application.

**Turning it off is not an option for anybody the policy covers.** Removing the policy is a change to the policy, not a change to an account.

**The QR code is drawn in the browser** from the `otpauth://` URI, as an inline SVG, by `qrcode-generator`: one dependency with no transitive tree of its own. Nothing is fetched to render it, which keeps `img-src` closed and means the secret never travels to anybody's QR service.

**What the browser found that the tests did not.** Confirming an enrolment used to refresh the session, which lifted the setup gate, which swapped the screen for the project list, which threw away ten recovery codes that are shown exactly once. Every unit test passed, because they render that screen on its own. The session is now re-read when the codes are acknowledged and not before, and there is a test that pins it.

### Keeping things, and stopping keeping them

A sweep runs at boot and daily after that. It counts what is past its
retention period and writes down that it ran; it deletes nothing. `GET
/api/retention` shows the policy, the last sweep and the last twenty runs, to
platform administrators only.

**Almost nothing can be purged yet, on purpose.** `server/src/core/retention/policy.ts`
carries a period and a basis for each category, and the four that matter most
are marked `decided: false` with a seven-year placeholder so the sweep has
something to count against. A retention period a developer picked is not a
retention period. It is a number that turns up in an audit years later,
attached to deleted evidence. The purge refuses an undecided category and
prints the reason, which names who has to decide.

The same decision is waiting in `docs/infra/s3-bucket.md`, where the bucket
lifecycle rule is disabled for the same reason. One decision, two places.

**The approval is a number, not a checkbox.** `POST /api/retention/purge`
takes the exact count the approver read off the screen; if it has moved, the
purge refuses with a conflict and the real figure. A count survives being
pasted into a terminal at the wrong moment in a way that a confirmation
dialog does not.

**The audit trail is never purged.** It holds no PHI by construction, and it
is the only record that can answer a question about a deletion. Purging it to
satisfy a retention policy would destroy the proof that the policy was
followed.

**Retention and evidence pull against each other, and the resolution is
written down rather than discovered.** Deleting a delivery record means
deleting its custody events, and `custody_events` is append-only in the
database, enforced by a trigger, because Scope 1.2.7 wants a chain of custody
that is evidence and not a table somebody can tidy. The purge drops and
recreates the trigger around its own delete, visibly, the way the simulator's
cleanup does; a test asserts the trigger is back afterwards and that it still
fires. A purge that silently could not remove half of what it claimed to
remove would be worse than one that refuses.

**Photographs are refused while there is no bucket.** Deleting the rows
without deleting the objects would leave the images in S3 with nothing
pointing at them: unreachable, undeletable, and still PHI. That waits for
ticket 0.10.

### Registered devices and PIN sign-in

A four-digit PIN is not an authentication factor on its own. Ten thousand possibilities is a number a person can work through, and an app that accepted a PIN from anywhere would be one stolen PIN away from a stranger reading a day of patient addresses. So a PIN only works from a **registered device**: the phone is enrolled once with the courier's full password (`POST /api/devices/enrol`, which also sets the PIN), and after that `POST /api/login/device` needs only the PIN. That is something-you-have plus something-you-know, which is the only reason four digits is acceptable on a screen showing PHI.

The `izy_did` cookie holds a random token; the row id is its SHA-256, the same shape as sessions, so a copy of the table cannot be replayed as a phone. PIN attempts are throttled per device, not per user: an attacker without the phone has nothing to try against, and a courier fumbling their own PIN cannot lock out a colleague.

Revoking a device revokes its live sessions with it (`DELETE /api/devices/:id`, by the owner or an admin). A lost phone that stays signed in is the entire risk, and revoking the enrolment while leaving the session alive would look like it had been handled when it had not. The row is kept, marked revoked, so the history stays readable. `GET /api/devices` is the caller's own list; admins read anyone's at `GET /api/users/:username/devices`.

### The installable shell, and what it must never cache

`web/public/manifest.webmanifest` and `sw.js` make the app installable on a phone. The service worker exists under one rule:

**Nothing from `/api` is ever cached.**

A service worker is a cache that outlives the session, the sign-out and often the employment. One that cached API responses would leave a day of patient names and addresses in Cache Storage on a personal phone, readable by anyone who picks it up, long after the session cookie expired and the account was disabled. That is a reportable breach caused by a performance optimisation.

So the cache holds the application shell only: the HTML, the hashed build assets, the icon, the manifest. `/api`, `/legacy` and `/health` return before any cache is opened or matched. Signing out tells the worker to drop its caches as well.

The tests for this run the real worker in a sandbox and hand it requests, rather than asserting on the file's text, because a text assertion passes happily while the code does the opposite of what it says. Offline queueing of a courier's own events is ticket 2.7, and it will use IndexedDB with an explicit lifetime, not this cache.

### Dates

Every date stored here is a **service date**: the day a list belongs to, the day a run is driven, the day that decides which effective-dated price schedule applies. Those are questions about San Antonio, not about UTC, so they go through `dateIn` and `todayIn` in `server/src/core/dates.ts`. `new Date().toISOString().slice(0, 10)` is the tempting one-liner and it is wrong for five hours of every day: between 7pm and midnight in Chicago it returns tomorrow, which would file an evening STAT call under the next day, drop it off today's board, and price it against a schedule that had not taken effect yet.

### Under load

`npm run loadtest -w server` spawns a real server process against an isolated database on port 3210, seeds a day of the contract, and then runs 12 couriers working their stops, 3 dispatchers watching the board and moving orders between lanes, and a 300-row import, all at once. Real HTTP, real sessions, the real idempotency path: anything that short-circuited those would measure something other than what a courier's phone meets at noon. It writes `docs/load-test-<date>.md` and exits non-zero if it misses the bar.

**The first run failed badly**, and the cause was worth the exercise on its own: 8,957 ms to import 300 rows, and a board read at 1,414 ms. The database was in SQLite's default rollback-journal mode, where a write locks the whole file, so every dispatcher's board read waited behind a courier's delivery. Write-ahead logging, `synchronous = NORMAL` and a 5-second busy timeout for file databases (`src/db/client.ts`) took the import to 541 ms and the board to 259 ms.

**The target is measured after the first five seconds, and the reason is written into the report.** The opening seconds are every courier opening the app at the same instant next to a 300-row import. As one figure that burst moved the p95 between 86 ms and 741 ms across runs of identical code, which is a number that decides nothing. Split, both halves say something.

**Ticket 4.8 chased the slow opening down, and the answer was not the one this README first gave.** It is not a cold cache and it is not the query: the manifest read and the import take the same time, to within a few milliseconds, in every run, because one process holds one connection and the import is roughly nine hundred statements that the reads are interleaved with. The manifest is not slow, it is waiting. Measured away from the import, the first manifest read a booted process serves takes about 18 ms, so the warm-up the ticket proposed would have bought 18 milliseconds once and was not written.

What the investigation did find was a latent defect worth fixing: with no statistics SQLite chose the unique index on `(project_id, order_id)` for that query, used only its leading column, and walked every stop in the **project** to return one courier's twenty. An index on `(project_id, run_id, sequence)` removes the choice, and `server/test/query-plans.test.mjs` asserts the plan, because a missing index does not fail a test, it makes one slower. The remaining lever is the import itself, which is ticket 4.9.

**These numbers are a floor, not a forecast.** A local libSQL file is not Turso over the network, where every query carries a round trip. The run that decides anything is the one against staging, once ticket 0.10 exists.

**Speed is measured; correctness is asserted.** `server/test/concurrency.test.mjs` holds the half that a timing threshold cannot check, because a threshold in CI fails on a busy machine and teaches people to ignore it. A retry that overlaps its own first attempt writes one custody row, not two. Two couriers delivering the same order produce one winner and one refusal. Two dispatchers moving an order at the same moment leave it on exactly one run, enforced by a unique index rather than by a handler that looks first. Twelve couriers posting together lose no events and no audit rows. A board read taken mid-write never shows an order in the pool and on a lane at the same time.

**A 4xx under load is not a failure.** The report separates them: **failed** means the server broke, **refused** means it worked and the application declined. Every refusal in the run is a dispatcher moving an order while its courier is halfway down the list, which is a real thing that happens at noon, and the courier app sets such refusals aside for a person rather than retrying them.

## Files: proof of delivery storage

Bytes never pass through this server. The browser is handed a **signed PUT** and uploads straight to S3; reading is a **signed GET that expires in five minutes**. That is not only a bandwidth decision: a photo of a patient's front door that never touches the application server cannot end up in a request log, a heap dump or a crash report.

Three steps, because the server never sees the bytes: `POST .../uh/files` records what is about to exist and returns the signed URL, the browser PUTs to S3, then `POST .../uh/files/:id/stored` confirms. A row left pending is an upload that never completed.

- **SSE-KMS is part of the signature.** The encryption headers are signed, so a PUT that omits them does not match and S3 rejects it. With the bucket policy in [docs/infra/s3-bucket.md](docs/infra/s3-bucket.md) there is no way to write an unencrypted object, and the guarantee does not rest on the application alone.
- **The key is built by the server**: `project/date/order-<id>/kind/<uuid>.<ext>`. A client cannot propose one, which keeps a patient's name out of an object key by way of a helpfully named photo and stops a caller reaching outside their project. It is never returned to a client either: a list of keys is a list of which orders have a photo of a door.
- **A courier can only touch files on an order assigned to them**, and cannot enumerate the day's photos at all.
- Files are filed under the **order's service date**, not the day the photo was taken.

### Signing

`server/src/core/files/sigv4.ts` signs the URLs itself rather than pulling in the AWS SDK. Presigning is the only AWS operation this platform performs, and the SDK plus presigner is tens of megabytes of transitive dependencies to reach it; on a system holding PHI, dependency surface is a security property.

The obvious risk in hand-writing a signature is being subtly wrong in a way that only appears against real AWS. That is answered by AWS's own published worked example: the tests reproduce the canonical request, the string to sign and the final signature from the "Authenticating Requests: Using Query Parameters" documentation **byte for byte**, including the documented `aeeed9bb…` signature. If those match, the canonical form and the key derivation match AWS.

Not supported, because nothing needs it: temporary STS credentials (`x-amz-security-token`), path-style addressing, and keys outside the character set the key builder produces. Moving the deployment to an IAM role would need the first of those.

### Until the bucket exists

There is no AWS account yet: **ticket 0.10** sets it up, under a signed AWS Business Associate Addendum. Until `FILES_ENABLED` and the `S3_*` values are set, every file endpoint answers 503 naming that ticket, and no row is created. An upload that silently goes nowhere is worse than one that fails loudly at the counter. `GET .../uh/files/status/check` reports whether uploads are possible, so a screen can say so before a courier takes a photo.

## Project settings

Each project is one contract, and a contract's operating parameters are configuration rather than code. They live in the `projects.settings` JSON column, with their shape, defaults and validation in `server/src/core/projects/settings.ts`. Nothing is stored until someone changes a value, so the defaults are always what the contract says.

The defaults are the University Health answers, quoted from Addendum 1 in that file:

| Setting | Default | Source |
|---|---|---|
| `sla.clockStart` | `receipt` | "delivered to the designated location within two (2) hours of the courier receiving the delivery request" |
| `sla.scheduledMinutes` | 120 | the 2-hour delivery window |
| `sla.statMinutes` | 120 | "the maximum overall delivery time for this service type" |
| `sla.statFromPickupMinutes` | 60 | "completed within one (1) hour of pickup" |
| `sla.adhocMinutes` | 240 | Scope 1.2.5 |
| `businessHours` | 08:00 to 20:00, every day | Scope 1.2.3; UH runs weekends |
| `listRelease` | 12:00 to 14:00 | "typically provided between 12:00-2:00pm" |
| `pricing` | 20:00 to 07:00, dry run replaces | Addendum 1 |

`dueTimesFor` turns those into a due time and is the only place that arithmetic lives; ticket 1.6 calls it to stamp `due_at` on an order. Only scheduled deliveries honour `clockStart`: STAT and ad hoc are written as running from the request, so a pickup rule must not loosen them. STAT carries both of its deadlines, since a late pickup can satisfy one and breach the other.

`GET /api/projects/:pid/settings` is readable by any member and returns the resolved settings, the contract defaults, the list of leaves someone has overridden, and worked examples for an order received now. `PATCH` is a section-by-section merge, restricted to project `admin` and `ops_manager`; unknown keys are rejected rather than stored, because a silently ignored setting looks applied and is not. Changes are audited with their new values, a deliberate exception to the "field names only" rule below: these are contract parameters, not PHI, and an invoice dispute turns on who changed the after-hours window and when.

## Frontend shell

`web/` is a Vite + React app served by the server at `/` from `web/dist` (any non-API, non-file GET falls back to `index.html` for the client router). It is branded TAG. Sign-in asks which project first (`GET /api/login/projects`, public, names only), then shows that project's couriers (`GET /api/drivers/list?project=<code>`) for PIN entry or first-time setup; staff sign in with username and password from any step. After sign-in everyone lands on a project picker, and the platform screens for admins (Users, Audit log) and everyone (My devices). The original TVHS courier log app is served under `/legacy` and mounted inside the shell without an iframe: the shell injects its markup, loads its script once, and re-enters it through its global `checkSession()`; sign-out is routed through the shell. Drivers pick their project like everyone else. A project page carries its sites, its contract pricing and its operating settings; the settings card shows each value beside the contract default, marks anything a person changed, and restates the current rules as real due times, but only an admin or ops manager sees an Edit button. During development run `npm run dev -w server` and `npm run dev -w web` side by side.

## Health, logs, and errors

`GET /health` is public and runs a real query; it answers 200 `{ status: "ok", db: "ok", migrations, uptimeSeconds, version }` or 503 `degraded` when the database is unreachable. Render's health check points at it. Every request gets an id (a sane client `X-Request-Id` is honoured, otherwise a UUID) that is echoed on the response, and one structured log line on finish with method, path, status, duration, actor, and ip; the query string is never logged. Logs are JSON lines (pretty in development; `LOG_LEVEL`, `LOG_FORMAT`). Unknown `/api` paths answer JSON 404. The central error handler logs the full error with the request id and answers JSON with a generic message for 5xx (never a stack; the message appears as `detail` only outside production) and the message for exposable 4xx errors such as malformed JSON.

## UH Pharmacy Courier module

Sites are the pickup and delivery locations a run starts or ends at. The nine UH pharmacies from Bid Table BT-89AO are seeded by migration `0006_sites`. Coordinates are deliberately left unset (`geocode_status` of `pending`) until address lookup is switched on; nothing invents them, and changing a site's address clears any coordinates so a stale point cannot price a zone. `GET` and `POST /api/projects/:pid/uh/sites`, and `GET`, `PATCH` and `DELETE /api/projects/:pid/uh/sites/:id`, are readable by any project member and writable by project `admin` or `ops_manager`. Every query is scoped by project, so sites cannot be read or written across projects.

### Zones and pricing

Migration `0007_pricing` loads the zone ZIP map and the Izy BAFO price schedule from the Pricing sheet of Bid Table BT-89AO. The seed SQL is generated from the spreadsheet rather than typed, because a wrong ZIP would misprice every delivery to it; a test diffs the seeded map against the workbook. Both tables are effective-dated, so a later revision never rewrites the mapping that priced past invoices.

`priceFor` in `server/src/modules/uh/pricing.ts` is pure and returns the full breakdown: zone base, STAT and after-hours surcharges, dry-run fee, out-of-area mileage, and a total, with money held in cents so repeated addition cannot drift. Two contract ambiguities are settings rather than assumptions:

- **After-hours window.** Addendum 1 defines it outright as 8 pm to 7 am; Scope 1.2.3's 8 am is superseded under the precedence clause. `pricing.afterHoursEnd` in the project settings changes it if UH ever says otherwise.
- **Dry run.** Addendum 1 calls it a flat rate for the attempted service, per item, but does not say whether it replaces the delivery charge or is added to it. The default is replace, the reading that cannot over-bill University Health; `pricing.dryRunReplacesBase` flips it. Still open with UH.

Read the schedule at `GET /api/projects/:pid/uh/pricing`, the ZIP map at `.../pricing/zones` (add `?zip=` for one lookup), and price a delivery at `POST .../pricing/quote`. All are readable by any project member.
