# Izy Ops Platform

Operations platform for Izy Global Services courier contracts. One login, one user directory, a module per contract. Today it runs the TVHS RMD courier log system. The UH Pharmacy Courier dispatch module is being built on the same platform; see `docs/uh-platform-feasibility-plan.md` and `docs/build-backlog.md`.

## Layout

```
server/        Express API. server/server.js is the legacy TVHS app, booted by server/src/index.ts
web/           Frontend workspace (placeholder until ticket 0.9)
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

A project is one courier contract. Users belong to projects through memberships with a per-project role (`admin`, `ops_manager`, `dispatcher`, `courier`, `client_viewer`). Project-scoped APIs live under `/api/projects/:pid/<module>/...`, where `:pid` is the project code (`tvhs`) or id, and require membership. `GET /api/me/projects` lists the caller's projects. The pre-project TVHS paths (`/api/routes`, `/api/checkin*`, `/api/logs*`, `/api/admin/*`) answer 308 redirects to the `tvhs` project for one release.

## Sessions

Sessions are server-side (`sessions` table). The `izy_sid` cookie carries only a random token; the row is keyed by its SHA-256, so the table cannot be replayed. Idle expiry refreshes on use (staff 30 minutes, couriers 12 hours by default), absolute expiry does not (staff 12 hours, couriers 30 days). Signing out revokes the row. `GET /api/me/sessions` lists a user's live devices; admins can list and revoke any user's devices under `/api/users/:username/sessions`. Lifetimes are set with the `SESSION_*` variables in `server/.env.example`.

## Users

Users are managed in-app by platform admins through `/api/users` (create, update name/email/role/status, reset password, set or clear PIN, add or remove project memberships with per-project settings). Platform roles are `admin`, `staff`, and `driver`; project rights come from memberships. Disabling a user or resetting a password signs them out of every device. The environment only creates the first admin on an empty database. The admin screen for these endpoints ships with the frontend shell in ticket 0.9.

## Audit trail

`audit_events` is append-only: database triggers abort any UPDATE or DELETE. Every request gets `req.audit(action, entity, entityId, detail)`, which stamps the actor, project, IP, and time. Logins (success and failure), logouts, check-ins, log saves and clears, exports, admin reads of one user's data, user management, membership changes, and session revocations are recorded. `detail` holds ids, counts, and field names only, never PHI or secrets. Admins query it at `GET /api/audit` with `username`, `action` (prefix), `entity`, `entityId`, `projectId`, `from`, `to`, `limit`, and `before` (cursor); reading the log is itself audited.
