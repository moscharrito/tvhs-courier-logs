# Izy Ops Platform: Build Backlog

Companion to docs/uh-platform-feasibility-plan.md. Decisions of September 5, 2026 apply: Option A (build), Render paid with BAA, Turso paid with BAA, AWS S3 for files, TypeScript for new code, one senior developer paired with Claude.

Tickets are numbered by phase. Each has acceptance criteria. Estimates are developer days and assume Claude drafts scaffolding, migrations, tests, and first-pass UI so the developer reviews and integrates.

## Calendar

| Phase | Dates | Goal |
|---|---|---|
| 0. Platform refactor | Sep 8 to Sep 19 | TVHS running on the new platform in staging on Render paid, Turso paid |
| 1. UH foundations | Sep 22 to Oct 3 | A real daily list uploads, geocodes, zones, and prices |
| 2. Dispatch and courier | Oct 6 to Oct 24 | Simulated wave end to end on phones |
| 3. Client, reporting, invoicing | Oct 27 to Nov 7 | Sample month invoiced and reconciled by hand |
| 4. Hardening | Nov 10 to Nov 21 | Load test, security review, backup drill, runbook |
| 5. Shadow run and cutover | Nov 24 to Dec 5 | One week parallel run, go-live |

Thanksgiving falls in Phase 5. Plan the shadow run around it.

## Target repository layout

```
tvhs-courier-logs/                (rename to izy-ops when convenient)
  package.json                    workspaces: server, web
  render.yaml
  drizzle.config.ts
  server/
    src/
      index.ts                    boot: migrations, then listen
      config.ts                   env parsing, fails fast on missing keys
      db/
        client.ts                 libsql client (Turso or local file)
        schema/                   drizzle schema per domain
          core.ts                 users, projects, memberships, sessions, audit_events
          tvhs.ts                 logs, checkins (+ project_id)
          uh.ts                   sites, zone_zips, price_table, daily_lists, orders, packages, runs, run_stops, custody_events, pod, invoices, invoice_lines
        migrations/               generated SQL, committed
      core/
        auth/                     login, pin, mfa, sessions, middleware
        users/                    admin user management
        projects/                 project CRUD, membership, scoping middleware
        audit/                    append-only writer, query endpoint
        files/                    S3 signed upload and download
      modules/
        tvhs/                     routes.ts, export.ts (existing logic moved)
        uh/
          sites.ts, pricing.ts, lists.ts, geocode.ts, orders.ts,
          dispatch.ts, courier.ts, pod.ts, reports.ts, invoices.ts, client.ts
      lib/                        dates, tz, validation (zod), errors
    test/                         vitest, supertest, local sqlite file per test run
  web/
    src/
      app/                        router, shell, project switcher, auth guard
      modules/
        tvhs/                     existing screens wrapped, migrated later
        uh/
          dispatch/               board
          intake/                 list upload and geocode review
          orders/                 search and detail
          courier/                PWA screens
          client/                 UH viewer
          reports/, invoices/, admin/
      lib/                        api client, offline queue, signature pad, camera
    public/manifest.webmanifest, sw.ts
  docs/
```

## Phase 0: Platform refactor (Sep 8 to Sep 19)

Goal: TVHS keeps working at every step. Nothing UH-specific yet. This phase carries no PHI, so it is the rehearsal for Render paid and Turso paid.

| # | Ticket | Days | Acceptance criteria |
|---|---|---|---|
| 0.1 | Characterization tests for the current TVHS API | 1.5 | vitest plus supertest against a temp SQLite file. Covers login, PIN setup and login, throttle, checkin idempotency, logs save with extra legs and deletion, admin filters, both Excel exports produce a workbook with expected cells. All green on the untouched code |
| 0.2 | Monorepo and TypeScript setup | 1 | npm workspaces server and web. tsconfig strict. Existing server.js runs unchanged under the new layout via a thin index.ts wrapper. CI script runs typecheck and tests |
| 0.3 | Config module | 0.5 | Single typed config object from env. Startup fails with a clear message on missing SESSION_SECRET, TURSO_DATABASE_URL in production, S3 keys when files enabled. Removes the hand-rolled .env loader in favor of dotenv in development only |
| 0.4 | Drizzle schema and migration runner | 1.5 | drizzle schema for core and tvhs. Migration 0001 reproduces the existing three tables exactly. Migrations run on boot before listen and refuse to start on failure. Works on Turso and on the local file. Existing local courier_logs.db migrates in place with data intact |
| 0.5 | Projects and memberships | 1.5 | Tables projects, memberships. Seed project tvhs. logs and checkins gain project_id backfilled to tvhs. Middleware loads req.project from :pid and rejects non-members with 403. All TVHS routes mounted at /api/projects/:pid/tvhs. Old paths return 308 to the new ones for one release |
| 0.6 | Server-side sessions | 1 | sessions table with user_id, device label, created_at, last_seen_at, idle_expires_at, revoked_at. Cookie holds session id only, httpOnly, secure in production, sameSite lax. Idle timeout configurable per role (couriers 12 hours, staff 30 minutes). Admin can list and revoke a user's sessions |
| 0.7 | User management | 1.5 | API in 0.7; admin screen delivered with the 0.9 shell. Create user, set role per project, reset password, set or clear PIN, deactivate. Env-var seeding reduced to a one-time bootstrap admin. TVHS driver rows migrate to memberships with role courier and a settings blob carrying their route |
| 0.8 | Audit log | 1 | audit_events append-only. Helper audit(req, action, entity, id, detail). Every write endpoint and every read of a single user's data is audited. Admin query endpoint with filters. No update or delete path exists for this table |
| 0.9 | Frontend shell | 2 | Vite plus React app: login, project switcher, sidebar navigation driven by memberships. Existing TVHS screens wrapped as-is inside the shell (iframe-free: mount the existing DOM and app.js under a TVHS route) so drivers see no change. Build output served by Express |
| 0.10 | Render and Turso paid environments | 1 | Staging and production services on the Render organization plan. Turso paid databases for each. render.yaml updated. BAA documents filed in the compliance folder. TVHS production cut over after one week on staging |
| 0.11 | Health, logging, errors | 0.5 | /health checks DB. Structured JSON logs with request id. Central error handler never leaks stack traces in production |

Phase 0 total: about 13 developer days across 10 working days. Tight. Claude drafts 0.1, 0.4, 0.8, and the first pass of 0.9.

## Phase 1: UH foundations (Sep 22 to Oct 3)

| # | Ticket | Days | Acceptance criteria |
|---|---|---|---|
| 1.1 | UH project and sites | 0.5 | Done. Project uh seeded (0005). sites table + the 9 pharmacies from the bid table (0006), admin CRUD and a Sites screen. lat/lng deliberately left null pending 1.4: no coordinates are invented |
| 1.2 | Zone and price tables | 1 | Done. zone_zips (72 ZIPs) and price_schedules seeded from the bid table by generated SQL, effective-dated; priceFor returns zone, base, surcharges, dry run and out-of-area mileage. 27 tests. Note: the real after-hours ambiguity is the morning end (7 am in Addendum 1 versus 8 am in Scope 1.2.3), not 7 pm versus 8 pm as this row originally said; both readings are tested and the window is a project setting |
| 1.3 | Project settings | 0.5 | Done. Typed settings on projects.settings with contract defaults, GET/PATCH scoped to admin and ops_manager, audited with values, and a settings card per project. dueTimesFor is the single place the clock rule becomes a due time. 30 tests. Addendum 1 turned out to answer the clock-start question outright: receipt, not pickup, which closes open item 1 against the 10-driver model. See docs/dispatch-strategy-reference.md |
| 1.4 | Google Maps integration | 1 | Geocoding and Distance Matrix wrappers. Address-only requests, never a name or note. Results cached by normalized address. Daily quota guard. Distance is one-way loaded miles from the origin site |
| 1.5 | Daily list import | 2.5 | Done. xlsx and csv upload per site, mapping auto-detected then saved per site behind a header fingerprint, preview with per-row errors and warnings, duplicate detection in the file and against the day, zones resolved at import and due_at stamped from the clock rule. daily_lists, orders and packages tables (0008). 56 tests. Two deviations: the redacted Discharge Pharmacy sample UH referenced in Addendum 1 was never supplied to us, so the fixtures are synthetic and clearly labelled; and the geocode review queue waits on 1.4, with out-of-area rows flagged now from the ZIP map |
| 1.6 | Order model and lifecycle | 1.5 | orders, packages, custody_events. Status transitions enforced in one place. due_at computed from service type and the clock rule. Manual order creation for STAT and ad hoc with requested_at defaulting to now |
| 1.7 | Order search and detail | 1 | Staff screen: filter by date, site, status, courier, service type. Detail shows packages, custody timeline, pricing breakdown |
| 1.8 | S3 file service | 1 | Signed PUT for uploads from the browser, signed GET with 5-minute expiry, SSE-KMS, key layout project/date/order/kind. Lifecycle rule stub. No public access |

Phase 1 total: about 9 days.

## Phase 2: Dispatch and courier (Oct 6 to Oct 24)

| # | Ticket | Days | Acceptance criteria |
|---|---|---|---|
| 2.1 | Runs and stops | 1 | runs and run_stops. Create run for courier and date, add or remove stops, reorder. Order status moves to assigned |
| 2.2 | Dispatch board | 4 | Today view: unassigned pool grouped by site, one lane per on-duty courier, drag to assign, minutes-to-due badge with color thresholds, courier last-seen and current stop, filters. Auto-sequence a run by nearest-neighbor from the origin site. Polling every 15 seconds; upgrade to server-sent events if needed |
| 2.3 | Courier PWA shell | 1.5 | Installable manifest, service worker, PIN login bound to a registered device (device id stored in session). Today's run list in sequence, map link per stop, call dispatch button |
| 2.4 | Pickup flow | 1 | At origin site: confirm package count, sender printed name and signature, timestamp, GPS. Custody event picked_up. Order status picked_up |
| 2.5 | Stop flow | 2 | Arrive button writes arrived_at, GPS, custody event. Then one of: deliver (receiver printed name, signature), doorstep (photo required, no_signature_reason), dry run (reason code per package). Signature-required flag enforced. Order status set accordingly |
| 2.6 | Return flow | 0.5 | Undelivered packages carried to origin or Discharge Pharmacy, custody event returned with receiver name |
| 2.7 | Offline queue | 2 | Events and files queued in IndexedDB when offline, replayed in order on reconnect, idempotent on the server by client event id. Visible sync status. Tested with airplane mode |
| 2.8 | Live status feed | 1 | Board reflects courier events within one polling interval. Courier location updated on each event, not continuous tracking |
| 2.9 | Wave simulation | 1 | Script generates 273 orders across 9 sites from the sample distribution, 12 test courier accounts, and drives the full lifecycle. Used for demos and load tests |

Phase 2 total: about 14 days across 15 working days.

## Phase 3: Client, reporting, invoicing (Oct 27 to Nov 7)

| # | Ticket | Days | Acceptance criteria |
|---|---|---|---|
| 3.1 | Client viewer portal | 2 | Role client_viewer scoped to one or more sites. Today and history list with status and timestamps. POD download. No courier personal data beyond first name |
| 3.2 | POD document | 1 | PDF per order with the five Scope 1.2.8 fields, both signatures, photo if any, custody timeline. Generated on demand, cached in S3 |
| 3.3 | SLA reports | 2 | Completion rate (on-time arrivals over attempts), on-time by service type, dry-run rate, volume by site, zone, and day type. Daily, weekly, quarterly ranges. Export to Excel in a layout to be aligned with UH Quality Services |
| 3.4 | Invoice generation | 2 | Period invoice from completed orders: one line per order with zone, service type, surcharges, dry runs per item, out-of-area miles. Adjustments with reason. Status draft, issued, paid. Excel and PDF export |
| 3.5 | Reconciliation test | 1 | Simulated month invoiced and checked by hand against the price table. Differences resolved before go-live |

Phase 3 total: about 8 days.

## Phase 4: Hardening (Nov 10 to Nov 21)

| # | Ticket | Days | Acceptance criteria |
|---|---|---|---|
| 4.1 | Load test | 1 | 12 couriers posting events while 3 dispatchers reassign, 300 orders imported in 10 minutes. p95 API under 500 ms |
| 4.2 | Security review | 2 | Access control matrix tested per role and project. Authorization tests for every endpoint. Rate limits on auth. Dependency audit clean. Secrets only in Render environment. Headers and CSP set |
| 4.3 | MFA for staff | 1 | TOTP for admin, ops manager, dispatcher. Recovery codes. Enforced in production |
| 4.4 | Backup and restore drill | 0.5 | Turso point-in-time restore exercised into staging. S3 versioning on. Documented |
| 4.5 | Runbook | 1 | Deploy, rollback, rotate secrets, revoke a device, restore, on-call contacts, known failure modes |
| 4.6 | Retention and purge | 0.5 | Scheduled job flags records past retention. Purge of files behind a manual approval |
| 4.7 | Privacy program alignment | 0.5 | Confirm every control named in the written privacy and security program exists in the app and hosting |

Phase 4 total: about 6.5 days.

## Phase 5: Shadow run and cutover (Nov 24 to Dec 5)

| # | Ticket | Days | Acceptance criteria |
|---|---|---|---|
| 5.1 | Training material | 1 | Courier quick card, dispatcher guide, client viewer one-pager |
| 5.2 | Shadow week | 5 | Real lists, real couriers, system alongside the manual process. Every discrepancy logged and fixed |
| 5.3 | Go-live | 1 | Manual process retired. First daily SLA report sent |

## Deferred past go-live

Route optimization beyond nearest-neighbor, patient SMS notifications, inter-campus community hospital flows, per-project Turso databases, continuous GPS tracking, TVHS screens rewritten in React.

## Working agreement with Claude

- Claude drafts: schema and migrations, tests, API handlers, first-pass React screens, scripts, docs. The developer reviews, integrates, and owns merges.
- Every ticket starts on a branch named phase/ticket, for example 0/4-drizzle-migrations. PR per ticket. Tests must pass before merge.
- No UH data, real or sample with real names, enters any environment until the BAAs are filed and Phase 0.10 is complete. The redacted UH sample is the only fixture.
- Definition of done for any ticket touching PHI: authorization test exists, audit event written, no PHI in logs.
