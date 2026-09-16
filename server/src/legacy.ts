/* Boots the legacy TVHS server (server/server.js) with core services injected.
 *
 * Shared by src/index.ts and the test harness so both wire the legacy app the
 * same way:
 *   1. register the session middleware on the legacy bridge,
 *   2. require server.js (which pulls the middleware from the bridge at load
 *      and kicks off its bootstrap-user sync),
 *   3. mount the core routers on the legacy app.
 *
 * Migrations must already have run against `database`. */

import path from 'node:path';
import fs from 'node:fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'http';
import type { Client } from '@libsql/client';
import type { Config } from './config';
import type { Database } from './db/client';
import { createSessionMiddleware, type SessionStore } from './core/auth/sessions';
import { createCoreAuthRouter } from './core/auth/routes';
import { createUsersRouter } from './core/users/routes';
import { createDevicesRouter } from './core/auth/devices';
import { createAuditMiddleware, type AuditLog } from './core/audit/audit';
import { createAuditRouter } from './core/audit/routes';
import { Logger } from './core/http/logger';
import { createRequestMiddleware } from './core/http/request';
import { errorFields } from './core/http/logger';
import { securityHeadersFor } from './core/http/security';
import { createAuthThrottles, tooManyAttempts } from './core/auth/throttle';
import { createRetentionRouter } from './core/retention/routes';
import { startRetentionSweep } from './core/retention/sweep';
import { startOptimize } from './db/optimize';
import { createGoogleProvider } from './core/geo/google';
import { scopedTo, unavailableProvider } from './core/geo/provider';
import { createGeoLookup } from './core/geo/lookup';
import { createGeocodeRouter } from './modules/uh/geocode';
import { createDiscrepancyRouter } from './modules/uh/discrepancies';
import { createGoLiveRouter } from './modules/uh/go-live';
import { MIGRATIONS_FOLDER } from './db/migrate';
import { todayIn } from './core/dates';
import { createHealthRouter } from './core/http/health';
import { apiNotFound, createErrorHandler } from './core/http/errors';
import { createRequireProject } from './core/projects/middleware';
import { createProjectSettingsRouter } from './core/projects/settings-routes';
import { createSitesRouter } from './modules/uh/sites';
import { createPricingRouter } from './modules/uh/pricing-routes';
import { createImportsRouter, MAX_UPLOAD_BYTES } from './modules/uh/imports';
import { createOrdersRouter } from './modules/uh/orders';
import { createStopRouter } from './modules/uh/stop';
import { createRunsRouter } from './modules/uh/runs';
import { createPickupRouter } from './modules/uh/pickup';
import { createReturnsRouter } from './modules/uh/returns';
import { createFilesRouter } from './core/files/routes';
import { createApplicationsRouter, createPublicApplicationsRouter } from './core/onboarding/routes';
import { createShiftsRouter } from './modules/uh/shifts';
import { createIdempotency } from './core/http/idempotency';
import { createFileStorage } from './core/files/storage';
import { createBoardRouter } from './modules/uh/board';
import { createClientPortalRouter } from './modules/uh/client-portal';
import { createReportsRouter } from './modules/uh/reports';
import { createInvoicesRouter } from './modules/uh/invoices';

export interface LegacyServer {
    app: Express;
    ready: Promise<void>;
    start: (port?: number | string) => Promise<Server>;
    db: Client;
}

interface Bridge {
    set(name: string, value: unknown): void;
    get<T>(name: string): T;
    has(name: string): boolean;
}

export interface BootedLegacy {
    legacy: LegacyServer;
    sessions: SessionStore;
    /** Exposed so tests can start each case from a clean slate. */
    throttles: ReturnType<typeof createAuthThrottles>;
    audit: AuditLog;
    logger: Logger;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION: string = (require('../package.json') as { version: string }).version;

export function createLogger(config: Config): Logger {
    return new Logger({ level: config.log.level, format: config.log.format }, { app: 'izy-ops', env: config.nodeEnv });
}

export function bootLegacy(config: Config, database: Database, logger: Logger = createLogger(config)): BootedLegacy {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require('../legacy-bridge.js') as Bridge;

    // Order inside server.js: security headers, request id + log, json body,
    // static, sessions, audit, routes.
    bridge.set('securityHeaders', securityHeadersFor(config));
    /* One set of counters for the process, shared by the legacy password and
     * PIN endpoints and by the enrolled-device ones in core/auth/devices. */
    const throttles = createAuthThrottles();
    bridge.set('authThrottles', throttles);
    bridge.set('tooManyAttempts', tooManyAttempts);
    bridge.set('trustProxy', config.trustProxy);
    bridge.set('requestMiddleware', createRequestMiddleware(logger));
    const { middleware, store } = createSessionMiddleware({ client: database.client, config });
    bridge.set('sessionMiddleware', middleware);
    const { middleware: auditMiddleware, log } = createAuditMiddleware({ client: database.client });
    bridge.set('auditMiddleware', auditMiddleware);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const legacy = require('../server.js') as LegacyServer;

    legacy.app.use(createHealthRouter({ client: database.client, version: VERSION }));
    legacy.app.use(createCoreAuthRouter({ client: database.client, store }));
    legacy.app.use(createUsersRouter({ client: database.client, store }));
    legacy.app.use(createDevicesRouter({ client: database.client, config, throttles }));
    legacy.app.use(createAuditRouter({ log }));

    // Project settings are core: every contract has operating parameters.
    // UH Pharmacy Courier module below. Project scoping is enforced here
    // rather than in server.js, so a module has no dependency on the legacy app.
    const requireProject = createRequireProject(database.client);
    const fileStorage = createFileStorage(config);
    /* Every route a courier's phone writes to goes through this. A phone that
       loses signal mid-request retries with the same id, and the retry is
       answered rather than applied a second time (ticket 2.7). Read-only
       routes and the staff screens do not need it: nobody replays a GET, and
       a dispatcher watching a reply arrive is not an unreliable network. */
    const idempotent = createIdempotency({ client: database.client });
    /* Retention (ticket 4.6): counts what is past its period on a schedule
     * and never deletes without an approval that names an exact number. */
    legacy.app.use(createRetentionRouter({ client: database.client, storage: fileStorage }));
    startRetentionSweep(database.client, (err) => logger.error('retention sweep failed', errorFields(err)));
    /* Query planner statistics, refreshed at boot and daily (ticket 4.8).
     * Without them the pickup manifest walks every stop in the project. */
    startOptimize(database.client);

    legacy.app.use('/api/projects/:pid/settings', requireProject, createProjectSettingsRouter({ client: database.client }));
    /* Address lookup (ticket 1.4). Wrapped in scopedTo so that the provider
     * can only ever be asked about site addresses: a patient's address is PHI
     * and Google Maps is not covered by a BAA. The refusal is code rather
     * than a comment because a comment does not stop a loop. */
    const geoProvider = config.geo.googleApiKey
        ? scopedTo(createGoogleProvider({ apiKey: config.geo.googleApiKey }), ['site'])
        : unavailableProvider('No address lookup is configured. Set GOOGLE_MAPS_API_KEY (ticket 1.4).');
    const geoLookup = createGeoLookup({
        client: database.client,
        provider: geoProvider,
        today: () => todayIn(config.timezone),
        ceiling: config.geo.dailyCeiling,
    });
    legacy.app.use('/api/projects/:pid/uh/geocode', requireProject, createGeocodeRouter({
        client: database.client,
        lookup: geoLookup,
        providerName: geoProvider.name,
        providerReason: geoProvider.reason,
    }));

    /* The shadow week's log of what did not match (ticket 5.2). */
    legacy.app.use('/api/projects/:pid/uh/discrepancies', requireProject, createDiscrepancyRouter({ client: database.client }));

    /* Go-live readiness, and the daily report as a recorded send (5.3). */
    legacy.app.use('/api/projects/:pid/uh/go-live', requireProject, createGoLiveRouter({
        client: database.client,
        deployment: {
            databaseKind: config.db.kind,
            filesEnabled: config.files.enabled,
            geocoderConfigured: config.geo.googleApiKey !== undefined,
            trustProxy: config.trustProxy,
            isProduction: config.isProduction,
        },
        expectedMigrations: fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).length,
    }));

    legacy.app.use('/api/projects/:pid/uh/sites', requireProject, createSitesRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/pricing', requireProject, createPricingRouter({ client: database.client }));
    // The daily list upload is the raw file body. express.json() in server.js
    // ignores these content types, so the raw parser below is what reads them.
    legacy.app.use(
        '/api/projects/:pid/uh/imports',
        express.raw({
            type: [
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-excel',
                'application/octet-stream',
                'text/csv',
                'text/plain',
            ],
            limit: MAX_UPLOAD_BYTES,
        }),
        requireProject,
        createImportsRouter({ client: database.client }),
    );
    // Stop flow first: its /:id/arrive and friends must be matched before
    // the orders router's /:id, which would otherwise swallow them.
    legacy.app.use('/api/projects/:pid/uh/orders', requireProject, idempotent, createStopRouter({ client: database.client, storage: fileStorage }));
    legacy.app.use('/api/projects/:pid/uh/orders', requireProject, createOrdersRouter({ client: database.client }));
    // Pickup first: its /:id/pickup must be matched before the runs
    // router's /:id, which would otherwise swallow it.
    legacy.app.use('/api/projects/:pid/uh/runs', requireProject, idempotent, createPickupRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/runs', requireProject, createRunsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/returns', requireProject, idempotent, createReturnsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/board', requireProject, createBoardRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/client', requireProject, createClientPortalRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/reports', requireProject, createReportsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/invoices', requireProject, createInvoicesRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/files', requireProject, idempotent, createFilesRouter({ client: database.client, storage: fileStorage }));
    legacy.app.use('/api/projects/:pid/uh/shifts', requireProject, createShiftsRouter({ client: database.client }));

    /* Driver applications (tickets 6.1 and 6.2). Two mount points, and the
       split is the security property: the public one takes a form from a
       stranger and can only write an application, and the admin one lives
       behind requireProject like everything else. */
    legacy.app.use(createPublicApplicationsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/driver-applications', requireProject, createApplicationsRouter({ client: database.client }));

    if (config.nodeEnv === 'test') {
        // Lets the test suite exercise the error handler on a real request.
        legacy.app.get('/api/_test/error', () => { throw new Error('synthetic failure with secret detail'); });
        legacy.app.get('/api/_test/exposed', () => { throw Object.assign(new Error('You may see this'), { status: 422, expose: true }); });
    }

    mountShell(legacy.app, config.webDist);

    // Last: JSON 404 for unknown API paths, then the central error handler.
    legacy.app.use(apiNotFound);
    legacy.app.use(createErrorHandler({ logger, isProduction: config.isProduction }));

    return { legacy, sessions: store, audit: log, logger, throttles };
}

/* The built frontend shell (web/dist) is served at /. Any GET that is not an
 * API call, a legacy asset, or a real file falls back to index.html so the
 * React router can handle it. Without a build (development before
 * `npm run build -w web`, or tests) a plain-text pointer is served instead. */
/* Extensions a browser asks for as a SUBRESOURCE. A request for one of these
 * that got past express.static is a missing file and deserves a 404: serving
 * index.html instead would hand the browser HTML where it expected a script,
 * and the error it prints then describes the MIME type rather than the
 * missing file.
 *
 * This used to be `path.extname(req.path)`, which is not the same question.
 * Every username in this application is first.last, so path.extname of
 * "/users/pat.pharmacy" is ".pharmacy" and the user detail page 404ed on a
 * refresh or a pasted link. It only worked at all because clicking through
 * from the directory is client-side routing and never asks the server.
 * Found by walking docs/day-rehearsal.md. */
const ASSET_EXTENSIONS = new Set([
    '.js', '.mjs', '.css', '.map', '.json', '.webmanifest', '.txt', '.xml',
    '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp4', '.webm', '.mp3', '.wav', '.pdf', '.wasm',
]);

function mountShell(app: Express, webDist: string): void {
    const indexFile = path.join(webDist, 'index.html');
    const built = fs.existsSync(indexFile);

    if (built) {
        app.use(express.static(webDist, { index: false, maxAge: '1h', setHeaders: (res, filePath) => {
            // Hashed assets are immutable; index.html must always be revalidated.
            if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        } }));
    }

    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (req.path.startsWith('/api/') || req.path.startsWith('/legacy/')) return next();
        // Real files under the built shell were already served by express.static
        // above, so anything still here is missing. Only 404 it when it looks
        // like a subresource; every other path belongs to the React router.
        if (ASSET_EXTENSIONS.has(path.extname(req.path).toLowerCase())) return next();
        if (!built) {
            res.status(200).type('text/plain').send('Izy Ops shell is not built. Run `npm run build -w web`, or use `npm run dev -w web` during development.\n');
            return;
        }
        // root + relative name: `send` rejects dot-segments in the path it is
        // given, and a test dist may live under test/.tmp.
        res.sendFile('index.html', { root: webDist, headers: { 'Cache-Control': 'no-cache' } }, (err) => { if (err) next(err); });
    });
}
