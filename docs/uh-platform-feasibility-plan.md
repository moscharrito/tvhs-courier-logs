# Izy Ops Platform: Feasibility and Plan for the UH Pharmacy Courier Module

Prepared September 5, 2026. Internal engineering plan. Companion to the UH Implementation Plan in the Contracts folder.

## 0. Decisions taken September 5, 2026

| Decision | Choice | Consequence |
|---|---|---|
| Build versus buy | Option A, build in-house | No vendor fallback at go-live. Schedule in Section 8 has no slack, so Phase 0 starts the week of September 8 |
| Hosting | Render, paid organization plan with BAA | Confirm the BAA is signed and filed before any UH data is loaded. Move TVHS first as the rehearsal |
| Database | Turso, paid plan with BAA | Stay on libSQL. Drop the Postgres and PostGIS recommendation. Spatial work is done through Google APIs and stored lat/lng. Zone by ZIP table |
| File storage | Not covered by Render or Turso. Use AWS S3 with a BAA (AWS Artifact) | One extra provider. Signatures and photos never enter the database |
| Team | In-house senior developer, with Claude as pair | Backlog in docs/build-backlog.md is written as tickets with acceptance criteria |
| Language | TypeScript for all new code. Existing TVHS JavaScript stays until its module is migrated | Drizzle ORM with the libsql driver gives typed queries and versioned migrations on Turso |

Open verification before Phase 1 loads real data: written BAA from Render, written BAA from Turso, AWS BAA accepted in AWS Artifact, and a documented position on address-only geocoding calls to Google.

## 1. Decision summary

Build the UH system on top of the existing TVHS codebase: yes for the platform shell, no for the data model. The TVHS app gives us a working login, session handling, a database layer, Excel export, and a Render deploy pipeline. None of its tables, routes, or screens fit UH. The right move is to promote the TVHS app into a multi-project platform (one entry point, one user directory, project-scoped modules) and build the UH dispatch module as new code inside that platform.

The hard constraint is time. UH go-live is Day 60 from Notice to Proceed, and dispatch dry runs start Day 25. A HIPAA-grade dispatch and driver application is a 10 to 12 week build for a small team. That fits only if development starts before contract execution, during the Board approval window. Section 8 lays out the schedule and the fallback (buy a dispatch tool for go-live, build behind it).

## 2. What exists today

| Layer | Current state | Reusable for UH? |
|---|---|---|
| Runtime | Node 18+, Express 5, CommonJS, single 977-line server.js | Yes, as the platform host |
| Database | libSQL via @libsql/client. Turso in prod, SQLite file locally. Schema created by executeMultiple on boot, migrations by hand-written ALTER TABLE checks | Not for UH. See Section 4 |
| Auth | cookie-session (signed cookie, 60-day life), bcrypt passwords, driver PIN quick login with in-memory throttle. Users seeded from env vars (ADMIN, DRIVER1, DRIVER2) | Partly. Login flow yes. User provisioning and session policy no |
| Domain model | users (role admin or driver, one route each), logs (driver, date, leg_index, times, sterile, soiled, miles), checkins | TVHS only |
| Routes | ROUTES constant hard-coded in server.js (northbound, southbound) | TVHS only |
| Frontend | Vanilla JS single-page app: index.html 680 lines, app.js 1,475 lines, style.css 1,830 lines. Sidebar dashboard, driver and admin views, screen switching by id | Shell and styling yes. Screens no |
| Export | ExcelJS weekly driver log and invoice, format matches the NorthBound and SouthBound xlsx files | Pattern yes, template no |
| Hosting | Render free plan, autoDeploy on push, health check on /api/config | Not for PHI. See Section 5 |
| Tests | None | Must add |

Scale today: 2 drivers, 2 fixed routes, roughly 10 rows per driver per day, weekly export. The code is clean for what it does. It is not built for concurrency, many users, dynamic work, or audit.

## 3. What UH requires of the software

Derived from the Scope of Services (Q-27KX), Addendum 1, and the Implementation Plan.

| Requirement | Source | Software implication |
|---|---|---|
| About 273 stops per weekday, 227 per weekend day, from 9 pharmacies, lists arriving 12:00 to 2:00 pm | Addendum 1, bid table | Daily list import (spreadsheet or manual), 95,000 delivery rows per year, multi-user concurrent dispatch |
| Batching multiple stops per courier | Addendum 1 | Route or run entity holding ordered stops per courier per day |
| Zone pricing by one-way loaded miles from origin pharmacy | Addendum 1, bid table | Geocoding, distance calculation, ZIP-to-zone table, per-delivery price |
| Scheduled 2-hour window, STAT 1 hour from pickup and 2 total, ad hoc 4 hours | Scope 1.2.5 | Per-order due_at computed from service type and clock-start rule; SLA timers visible to dispatch |
| 85% completion rate, on-time arrival counts even if recipient unavailable | Addendum 1 | Arrival timestamp captured separately from delivery outcome |
| Tracking method for UH: time, location, description, quantity | Scope 1.2.6 | Read-only client portal for UH pharmacy staff |
| Proof of delivery: date and time, pickup location, delivery location, description and quantity, printed name and signature of sender and receiver | Scope 1.2.8 | Signature capture at pickup and at delivery, photo, printed name fields, PDF on demand |
| Doorstep delivery allowed by medication type | Scope 1.2.3 | Signature-required flag per package, forced exception record when no signature |
| Dry run billed per item | Addendum 1 | Package-level outcome, not just stop-level |
| Returns to origin or Discharge Pharmacy after hours | Scope 1.2.9 | Return leg and custody event |
| Chain of custody secured and available for audit | Scope 1.2.7 | Immutable event log per package with actor, timestamp, GPS |
| Detailed records including distance per request | Scope 1.2.10 | Distance stored on every order |
| Invoices with detailed breakdown | Scope 1.2.11 | Invoice generation by zone, service type, surcharge, dry run; export to Excel and PDF |
| Business Associate Agreement, HITECH safeguards, written privacy and security program | Master Solicitation 3.9, Scope 1.2.13 | Encryption, access control, audit log, session policy, hosting with a BAA |
| Badged couriers, 20 field staff, 3 dispatchers, ops manager | Staffing Plan | Roles: admin, ops manager, dispatcher, courier, client viewer. Self-service user management, not env vars |

Patient name plus address plus the fact of a pharmacy delivery is protected health information. Every design choice below follows from that.

## 4. Gap analysis: existing system versus UH needs

| Area | Gap | Severity |
|---|---|---|
| Data model | Nothing in TVHS models an order, a package, a stop, a run, a site, a zone, an event, or an invoice | Rebuild |
| Users | Two drivers seeded from env vars, identified by route. UH needs 25 or more accounts managed in-app with per-project roles | Rebuild |
| Multi-project | No project concept. TVHS assumptions (route on the user row, ROUTES constant) are global | Refactor |
| Sessions | 60-day signed cookie, no server-side revocation, no MFA, no idle timeout | Replace for PHI |
| Audit | No audit log. Updates overwrite rows in place | Add |
| Migrations | Ad hoc ALTER TABLE on boot. Fine for 3 tables, not for 15 | Replace with a migration tool |
| Concurrency | libSQL over HTTP to Turso is fine for 2 drivers. Three dispatchers and 20 couriers writing status events during the 2 pm wave is a different load profile | Move to Postgres |
| Geospatial | None | Add geocoding and distance services |
| Mobile | Driver screens are responsive web. UH couriers need camera, signature pad, GPS, and tolerance for dead zones | Build a PWA |
| Client access | No external user role | Add client viewer role and portal |
| Reporting | Stats endpoint with 4 numbers | Build SLA and invoice reporting |
| Tests | None | Add before refactor |
| Hosting | Render free, Turso free, no BAA | Replace |

## 5. Compliance constraints that shape the architecture

1. Hosting must come with a Business Associate Agreement. Confirm in writing before choosing. Render, Turso, and the free tiers of most providers do not sign one. AWS, Google Cloud, and Azure do. Some managed Postgres providers sign one on paid team plans. Do not deploy PHI to a provider without a signed BAA.
2. Geocoding and distance APIs receive street addresses. Google Maps Platform and Mapbox generally do not sign BAAs. Mitigation used widely in healthcare logistics: send only the address string, never a name, medication, or order reference, and document this in the privacy and security program. Get a legal read before go-live.
3. Encryption in transit (TLS everywhere, including database connections) and at rest (provider-managed disk encryption plus application-level encryption for signature images and photos).
4. Access control by role and by project. A UH client viewer must never see TVHS data or another courier's runs. A courier sees only stops assigned to them for the current day.
5. Audit log of every read and write of PHI: who, what record, when, from where. Append-only table. This is also the chain of custody record UH can audit.
6. Session policy: idle timeout of 15 to 30 minutes for dispatch and admin, MFA for admin and dispatcher, PIN plus device registration for couriers, server-side session store so a lost phone can be revoked.
7. Retention: keep delivery records and custody events for the contract term plus whatever Exhibit A requires. Purge signature images and photos on a schedule once retention passes.

## 6. Target architecture

### 6.1 Shape

One deployable application, one login, one user directory. A project is a first-class record. Each user has memberships in one or more projects with a role per project. After login the user lands on a project switcher, or straight into their only project. Every API route under a project is scoped by project id and checked against membership.

```
/api/auth/*                         login, logout, session, MFA
/api/me                             profile, memberships
/api/admin/users, /api/admin/projects
/api/projects/:pid/tvhs/*           existing TVHS endpoints, moved, unchanged behavior
/api/projects/:pid/uh/*             new UH dispatch module
```

Modules are folders, each with its own routes, schema migrations, and screens. The core owns auth, users, projects, audit, exports, and configuration.

### 6.2 Stack

| Layer | Recommendation | Why |
|---|---|---|
| Runtime | Node 20 LTS, Express 5, keep CommonJS or move to ESM in the refactor | Team already works here |
| Language | JavaScript with JSDoc types, or TypeScript if the team is comfortable | Type checking pays off once the model has 15 tables. Not a blocker either way |
| Database | Turso (libSQL), paid plan with BAA. Single database, project_id on every table, scoping enforced in middleware. Per-project databases are a later hardening option Turso makes cheap | Decided September 5. Write volume at the 2 pm wave is a few hundred rows per hour, well inside libSQL limits. Encryption at rest on the paid plan |
| Migrations | Drizzle ORM with drizzle-kit, libsql driver | Typed schema, versioned SQL migrations, works against Turso and the local SQLite file |
| Sessions | Server-side sessions table in Turso, cookie carries only the session id | Revocation, idle timeout, device listing |
| Frontend, staff | Vite plus React (or Preact) single-page app served by Express | The dispatch board is a stateful interactive screen. Vanilla JS at 1,500 lines is already at its limit |
| Frontend, couriers | Same codebase as a PWA route: installable, service worker, offline queue for status events and POD | Camera, signature, GPS through browser APIs; no app store |
| Maps | Google Maps Platform: Geocoding, Distance Matrix, Route Optimization API | One vendor, good coverage of Bexar County. Address-only calls per Section 5 |
| Files | AWS S3 with BAA, private bucket, SSE-KMS, signed URLs with short expiry, lifecycle rule for retention | Never store binaries in the database. Render and Turso do not provide object storage |
| Excel and PDF | ExcelJS (already used), PDFKit or Playwright for POD and invoice PDFs | Continuity |
| Hosting | Render, paid organization plan with signed BAA. Web service runs the Express app and serves the built frontend. Separate Render services for staging and production | Decided September 5. TVHS moves first as the rehearsal |
| Monitoring | Structured logs, uptime check on /health, error tracking | Required to defend an SLA |

### 6.3 Core data model (UH module)

```
projects            id, code (tvhs, uh), name, timezone, settings json
users               id, email, name, password_hash, mfa_secret, pin_hash, status
memberships         user_id, project_id, role (admin, ops_manager, dispatcher, courier, client_viewer)
sessions            id, user_id, device, created_at, last_seen_at, revoked_at
audit_events        id, project_id, user_id, action, entity, entity_id, at, ip, detail json

sites               id, project_id, name, address, lat, lng, type (pharmacy, hospital, other)
zone_zips           project_id, zip, zone, effective_from
price_table         project_id, zone, service_type, price, surcharge_stat, surcharge_after_hours, dry_run_fee, oo_area_per_mile, effective_from

daily_lists         id, project_id, site_id, service_date, received_at, source (upload, manual), row_count, uploaded_by
orders              id, project_id, site_id, daily_list_id, service_type (scheduled, stat, adhoc),
                    requested_at, received_at, pickup_at, due_at,
                    recipient_name, address_line, city, zip, lat, lng, geocode_status,
                    distance_miles, zone, price, after_hours, out_of_area_miles,
                    signature_required, cold_chain, notes,
                    status (received, assigned, picked_up, en_route, arrived, delivered, dry_run, returned, cancelled),
                    run_id, courier_id, arrived_at, completed_at
packages            id, order_id, description, quantity, outcome (delivered, dry_run, returned), dry_run_reason
runs                id, project_id, courier_id, service_date, status, started_at, ended_at
run_stops           run_id, order_id, sequence
custody_events      id, order_id, package_id, event (picked_up, arrived, delivered, dry_run, returned, handoff),
                    at, lat, lng, actor_user_id, note
pod                 order_id, sender_name, sender_signature_key, receiver_name, receiver_signature_key,
                    photo_key, no_signature_reason, captured_at
invoices            id, project_id, period_start, period_end, status, total, generated_at
invoice_lines       invoice_id, order_id, description, zone, service_type, amount
```

The TVHS tables keep their shape and gain a project_id. The TVHS ROUTES constant moves into a project settings record.

### 6.4 Order lifecycle and the SLA clock

Every order carries received_at (when the list or request reached dispatch), pickup_at (courier scanned at pharmacy), and due_at. The clock-start rule is a project setting (receipt or pickup) so the open question with UH can be answered without a code change. Dispatch sees minutes-to-due on every stop. arrived_at is captured on its own because UH counts arrival as success regardless of outcome.

### 6.5 Screens

Staff web app
- Project switcher
- Dispatch board: today's orders by site, unassigned pool, courier lanes, drag to assign, auto-sequence by proximity, minutes-to-due coloring, live courier status
- List intake: upload spreadsheet per pharmacy, map columns once, review geocode failures, release to board
- Orders: search, detail with custody timeline and POD
- Couriers: roster, badge and credential expiry, today's runs
- Reports: completion rate by day and week, on-time by service type, dry runs, volume by site and zone
- Invoicing: generate period, review lines, export Excel and PDF
- Admin: users, memberships, sites, zone table, price table, project settings, audit log

Courier PWA
- PIN login on a registered device
- Today's run in sequence, with map link per stop
- Pickup: sender printed name and signature, package count confirmation
- Stop: arrive button (timestamp and GPS), then deliver with receiver name and signature, or doorstep with photo, or dry run with reason
- Return leg
- Offline queue: events stored locally and synced when back in coverage

Client viewer (UH pharmacy staff)
- Today's deliveries from their site with status and timestamps
- POD download per order
- Weekly completion summary

## 7. Build versus buy

| Option | What it means | Pros | Cons |
|---|---|---|---|
| A. Build the full stack | Everything in Section 6, in-house | Own the data, the invoicing logic, and the UH relationship. No per-driver SaaS fees at 20 couriers. Extends to every future contract | 10 to 12 weeks of focused work before it is trustworthy. Route optimization, offline sync, and signature capture each hide edge cases |
| B. Buy dispatch, build the platform around it | Use a medical courier dispatch SaaS for routing, driver app, and POD. Build the Izy platform for users, projects, invoicing, reporting, and TVHS. Pull deliveries from the SaaS API | Go-live in weeks. Vendor carries the driver app and offline logic. Several vendors sign BAAs | Monthly per-driver cost, roughly $20 to $60 per driver, so $5k to $15k per year. Data lives in two places. Custom POD fields may not map cleanly to Scope 1.2.8 |
| C. Hybrid | Buy for go-live (Option B). Build the UH module (Option A) in parallel and migrate once it passes a shadow run | Removes go-live risk. Keeps the long-term platform goal | Pay twice for a period. Migration work |

Recommendation: Option C unless a developer can start Option A within two weeks and work on it full time. The Implementation Plan already sets a Day 10 decision point for the dispatch platform. Put this choice in front of that decision.

Vendor shortlist to evaluate for Option B or C, all claiming healthcare or pharmacy courier use: Onfleet, Tookan, Dispatch Science, eLogii, Routific, Bringg. Screening criteria: BAA signed, POD fields configurable to match Scope 1.2.8, export API for invoicing, per-driver pricing, offline driver app.

## 8. Schedule for Option A (or the build half of Option C)

Assumes one senior full-stack developer plus part-time help on the courier PWA and testing. Weeks are calendar weeks from start.

| Phase | Weeks | Scope | Exit criterion |
|---|---|---|---|
| 0. Platform refactor | 1 to 2 | Postgres, migration tool, projects and memberships, session store, audit log, TVHS module moved under /api/projects/:pid/tvhs with its data migrated, tests for TVHS endpoints | TVHS drivers use the new build with no change to their workflow |
| 1. UH foundations | 3 to 4 | Sites, zone and price tables loaded from the bid table, list import with column mapping, geocoding and distance, order and package model, order search | A daily list uploads and every row gets a zone and a due time |
| 2. Dispatch and courier | 5 to 7 | Dispatch board, runs and stops, courier PWA with pickup, arrive, deliver, dry run, return, signatures and photos, offline queue | Simulated wave: 273 orders, 12 couriers, all statuses flow end to end on phones |
| 3. Client, reporting, invoicing | 8 to 9 | Client viewer portal, completion and on-time reports, POD PDF, invoice generation and export | Sample month invoiced and reconciled to the price table by hand |
| 4. Hardening | 10 to 11 | Load test the 2 pm wave, security review, penetration test of auth and access control, backup and restore drill, runbook | Go or no-go review passed |
| 5. Shadow run and cutover | 12 | Parallel with the vendor tool or the manual process for one week | Zero SLA misses attributed to software |

Route optimization beyond proximity sequencing, SMS notifications to patients, and inter-campus community hospital flows are deferred past go-live.

If Notice to Proceed lands in early October, Day 25 dry runs fall in late October and Day 60 go-live in early December. A build started by September 15 reaches Phase 2 exit around mid-November and Phase 5 in early December. That is a working schedule with no slack, which is why Option C is recommended.

## 9. Refactor plan for the existing code

Ordered so TVHS keeps working at every step.

1. Add tests around the current TVHS API (login, PIN, checkin, logs save and load, export). These protect the refactor.
2. Introduce a config module and a database module. Replace the boot-time schema string with migrations. First migration recreates the current three tables.
3. Add projects, memberships, sessions, audit_events. Seed a tvhs project. Add project_id to logs and checkins, backfilled to tvhs.
4. Replace env-var user seeding with an admin user management screen. Keep a one-time bootstrap admin from env.
5. Move the TVHS handlers into modules/tvhs/routes.js mounted at /api/projects/:pid/tvhs. Move ROUTES into project settings. Keep the old paths as redirects for one release.
6. Replace cookie-session with a server-side session store. Add idle timeout and MFA for admin.
7. Split the frontend: a shell (login, project switcher, navigation) and per-module screens. Wrap the existing TVHS screens as the first module without rewriting them. New UH screens are built in the framework chosen in Section 6.2.
8. Move hosting to a BAA-eligible provider with managed Postgres and object storage. Cut TVHS over first, since it carries no PHI and is a safe rehearsal.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Building during Board approval before the contract is signed | Phase 0 is valuable regardless of UH (better TVHS platform). Delay Phase 1 spend until intent to award is confirmed as firm, which it now is |
| No BAA from current hosting | Decide the provider in week 1. Do not put a single UH address into Turso or Render free |
| Courier phones without coverage in parts of the service area | Offline queue in the PWA from Phase 2, not deferred |
| Signature and photo storage growing fast | Object storage with lifecycle rules, not the database |
| One developer is a single point of failure during mobilization | Option C keeps a vendor tool as the fallback through Day 60 |
| Scope creep from UH requests once they see the client portal | Change control: features outside Scope 1.2.x are priced |
| Address quality on daily lists | Geocode review queue before release to the board; dispatchers fix, system remembers corrections |

## 11. Immediate next steps

1. Choose Option A, B, or C. Recommendation is C.
2. Confirm which hosting and database provider will sign a BAA. One day of calls.
3. Name the developer or team and confirm availability for 12 weeks.
4. Start Phase 0 on the TVHS repo. It is safe, testable, and needed either way.
5. Request demos from two dispatch vendors in parallel, with the Scope 1.2.8 POD fields and the BAA question as the first filters.
