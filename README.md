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
npm run dev            # run server/src/index.ts directly with file watching (Node 20+)
```

## Local configuration

Copy `server/.env.example` to `server/.env` (gitignored) and fill in the values. With no `TURSO_DATABASE_URL` the server uses a local SQLite file at `server/courier_logs.db`.

## Tests

`server/test` holds characterization tests for the TVHS API. Each test file boots the real server in-process against a throwaway SQLite file on a random port. Vitest runs files in separate processes, so in-memory state (such as the PIN throttle) does not leak between files.
