# Izy Ops Platform

Operations platform for Izy Global Services courier contracts. One login, one user directory, a module per contract. Today it runs the TVHS RMD courier log system. The UH Pharmacy Courier dispatch module is being built on the same platform; see `docs/uh-platform-feasibility-plan.md` and `docs/build-backlog.md`.

## Layout

```
server/        Express API. server/server.js is the legacy TVHS app, booted by server/src/index.ts
web/           Frontend shell: Vite + React (login, project switcher, users, devices, audit, legacy TVHS mount)
docs/          Plans and backlog
NorthBound/    Historical TVHS driver log spreadsheets (reference for the export format)
SouthBound/    Historical TVHS driver invoice spreadsheets (reference for the export format)
render.yaml    Render blueprint
```

## Commands (run from the repo root)

```bash
npm ci                 # install every workspace from the root lockfile
npm run ci             # typecheck + tests, what GitHub Actions runs
npm run typecheck
npm test
npm run build          # compile server/src to server/dist
npm start              # run the compiled server
npm run dev            # run server/src/index.ts with tsx and file watching
npm run dev -w web     # Vite dev server on :5173, proxying /api and /legacy to :3000
```

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
