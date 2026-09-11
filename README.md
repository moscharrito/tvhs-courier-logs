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

Sessions are server-side (`sessions` table). The `izy_sid` cookie carries only a random token; the row is keyed by its SHA-256, so the table cannot be replayed. Idle expiry refreshes on use (staff 30 minutes, couriers 12 hours by default), absolute expiry does not (staff 12 hours, couriers 30 days). Signing out revokes the row. `GET /api/me/sessions` lists a user's live devices; admins can list and revoke any user's devices under `/api/users/:username/sessions`. Lifetimes are set with the `SESSION_*` variables in `server/.env.example`.

## Users

Users are managed in-app by platform admins through `/api/users` (create, update name/email/role/status, reset password, set or clear PIN, add or remove project memberships with per-project settings). Platform roles are `admin`, `staff`, and `driver`; project rights come from memberships. Disabling a user or resetting a password signs them out of every device. The environment only creates the first admin on an empty database. The admin screens live in the frontend shell under Users.

## Audit trail

`audit_events` is append-only: database triggers abort any UPDATE or DELETE. Every request gets `req.audit(action, entity, entityId, detail)`, which stamps the actor, project, IP, and time. Logins (success and failure), logouts, check-ins, log saves and clears, exports, admin reads of one user's data, user management, membership changes, and session revocations are recorded. `detail` holds ids, counts, and field names only, never PHI or secrets. The one deliberate exception is `project.settings.update`, which records the new values: they are contract parameters rather than patient data, and an invoice dispute turns on who changed the after-hours window and when. Admins query it at `GET /api/audit` with `username`, `action` (prefix), `entity`, `entityId`, `projectId`, `from`, `to`, `limit`, and `before` (cursor); reading the log is itself audited.

### Daily list import

Each pharmacy compiles its own delivery list and sends it, typically between noon and 2pm (Addendum 1). Nine pharmacies means nine layouts, so the importer discovers the column mapping, has a person confirm it, then saves it against the site. A saved mapping is keyed to a fingerprint of the header row: when a pharmacy changes its export, the fingerprint stops matching and the operator is asked to confirm again rather than the importer reading the wrong columns.

`server/src/modules/uh/import-parse.ts` is pure: bytes and a mapping in, rows and issues out. It reads .xlsx through exceljs and .csv with its own RFC 4180 parser, finds the header row beneath any title and blank rows, and normalises as it goes (ZIP+4 to five digits, punctuated phones to digits, "Emergency" and "Rush" to STAT). An unrecognised service type becomes scheduled **and says so**, so nobody is silently downgraded.

Rows come back with issues at two severities. An error blocks the row (no recipient, no address, no valid ZIP, a quantity that is not a number); a warning does not (no city, no description, an unrecognised service word, a ZIP outside the published zone list). Duplicates are detected within the file and against orders already imported for that site and date, keyed on the pharmacy's reference when there is one and on the normalised recipient and address when there is not. A duplicate is held back until the operator confirms it is a genuinely separate delivery.

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
