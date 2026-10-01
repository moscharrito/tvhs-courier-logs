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
import { startScheduler, type Scheduler } from './core/scheduler';
import { createMailer } from './core/notify/ses';
import { createTexter } from './core/notify/twilio';
import { createSesWebhookRouter } from './core/notify/suppressions';
import { startOptimize } from './db/optimize';
import { createGoogleProvider } from './core/geo/google';
import { scopedTo, unavailableProvider, type GeoScope } from './core/geo/provider';
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
import { createReattemptRouter } from './modules/uh/reattempt';
import { createStopRouter } from './modules/uh/stop';
import { createRunsRouter } from './modules/uh/runs';
import { createPickupRouter } from './modules/uh/pickup';
import { createReturnsRouter } from './modules/uh/returns';
import { createFilesRouter } from './core/files/routes';
import { createApplicationsRouter, createPublicApplicationsRouter } from './core/onboarding/routes';
import { createShiftsRouter } from './modules/uh/shifts';
import { createRequestsRouter } from './modules/uh/requests';
import { createTrackingRouter } from './modules/uh/tracking';
import { createNotificationsRouter, createPushDevicesRouter } from './core/notify/routes';
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
    /** The unclaimed sweep and the mail queue. Exposed so a test can stop the
     *  timer it started: an interval left running keeps a process that should
     *  have exited alive. */
    scheduler: Scheduler;
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

    /* Built here rather than beside the scheduler below, because /health
       reports whether email is configured and is mounted first. One
       mailer, so what the health endpoint says and what actually sends
       cannot drift apart. */
    const mailer = createMailer(config);
    const texter = createTexter(config);
    /* Hoisted for the same reason as the mailer: /health reports whether
       file storage is usable, and the blueprint no longer records it. One
       instance, so what /health says and what the stop screen does cannot
       disagree. */
    const fileStorage = createFileStorage(config);

    /* Bounces and complaints from SES. Public by necessity and verified in
       code: see core/notify/sns.ts. Mounted beside health, before any
       session middleware, because SNS carries no session. */
    /* SNS POSTS AS text/plain, AND express.json() SKIPS IT.
     *
     * Amazon sends bounce notifications with Content-Type
     * "text/plain; charset=UTF-8" and the message type in an x-amz-sns-*
     * header. server.js installs express.json() with default options, which
     * parses application/json and nothing else, so req.body arrived empty,
     * the handler answered 400 "Not an SNS message", and the subscription
     * could never confirm. Every test passed, because supertest sends JSON.
     *
     * Found by subscribing a real topic and watching it sit at "pending
     * confirmation".
     *
     * Scoped to this one path rather than widening the global parser: making
     * every route accept JSON under any content type is a much larger change
     * than this needs, and body-parser leaves the stream alone when the type
     * does not match, so a second parser here still reads it. */
    legacy.app.use('/api/webhooks/ses', express.json({ type: () => true, limit: '256kb' }));
    legacy.app.use(createSesWebhookRouter({
        client: database.client,
        logger,
        topicArn: config.mail.snsTopicArn,
    }));

    legacy.app.use(createHealthRouter({
        client: database.client,
        version: VERSION,
        sweepIntervalSeconds: config.sweepIntervalSeconds,
        mailConfigured: mailer.available,
        filesConfigured: fileStorage.available,
        smsConfigured: texter.available,
    }));
    legacy.app.use(createCoreAuthRouter({ client: database.client, store }));
    legacy.app.use(createUsersRouter({ client: database.client, store }));
    legacy.app.use(createDevicesRouter({ client: database.client, config, throttles }));
    legacy.app.use(createAuditRouter({ log }));

    // Project settings are core: every contract has operating parameters.
    // UH Pharmacy Courier module below. Project scoping is enforced here
    // rather than in server.js, so a module has no dependency on the legacy app.
    const requireProject = createRequireProject(database.client);
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

    /* The unclaimed sweep and the mail queue.
     *
     * THIS CALL DID NOT EXIST. startScheduler was written, tested and never
     * wired into a running server, so SWEEP_INTERVAL_SECONDS switched on
     * nothing and the promise that an unclaimed STAT is never nobody's
     * problem was held up entirely by somebody remembering to call the
     * endpoint. A rule enforced by a person remembering is not enforced, and
     * a scheduler with no caller is worse than none, because the environment
     * variable and the tests both suggest it is running.
     *
     * Still off unless SWEEP_INTERVAL_SECONDS is set, which is deliberate:
     * a timer that hands deliveries to couriers should be switched on in an
     * environment somebody chose. But it is now a switch that does something. */
    const scheduler = startScheduler({
        client: database.client,
        logger,
        intervalSeconds: config.sweepIntervalSeconds,
        mailer,
        texter,
        portalUrl: config.mail.portalUrl,
    });
    logger.info('scheduler', {
        sweep: config.sweepIntervalSeconds === undefined ? 'off' : `every ${config.sweepIntervalSeconds}s`,
        mail: mailer.available ? 'on' : (mailer.reason ?? 'off'),
        sms: texter.available ? 'on' : (texter.reason ?? 'off'),
    });
    /* Query planner statistics, refreshed at boot and daily (ticket 4.8).
     * Without them the pickup manifest walks every stop in the project. */
    startOptimize(database.client);

    legacy.app.use('/api/projects/:pid/settings', requireProject, createProjectSettingsRouter({ client: database.client }));
    /* Address lookup (ticket 1.4). Wrapped in scopedTo so that the provider
     * can only ever be asked about site addresses: a patient's address is PHI
     * and Google Maps is not covered by a BAA. The refusal is code rather
     * than a comment because a comment does not stop a loop.
     *
     * DELIVERY ADDRESSES ARE ADDED ONLY BY A PERMISSION THAT EXPIRES.
     * UH_PATIENT_GEOCODE_UNTIL grants it for a test phase in which every
     * address in the system is invented, so nothing disclosed is PHI. It is a
     * date, capped at ninety days, and when it lapses this list goes back to
     * sites alone with no deploy and nobody remembering. See config.ts.
     *
     * If this is ever live while real University Health data is loaded, that
     * is a disclosure to a processor with no agreement covering it. The
     * go-live check reports it as a blocker for exactly that reason. */
    const geoScopes: GeoScope[] = config.geo.patientGeocodeAllowed ? ['site', 'patient'] : ['site'];
    const geoProvider = config.geo.googleApiKey
        ? scopedTo(createGoogleProvider({ apiKey: config.geo.googleApiKey }), geoScopes)
        : unavailableProvider('No address lookup is configured. Set GOOGLE_MAPS_API_KEY (ticket 1.4).');

    if (config.geo.patientGeocodeAllowed) {
        /* At warn, not info. This is a deliberate, temporary relaxation of the
           control this system is most careful about, and it should be visible
           in a log somebody skims. */
        logger.warn('geo.patient_addresses_permitted', {
            until: config.geo.patientGeocodeUntil,
            why: 'Test phase: every address in this system is invented. Must not be renewed once real University Health data is loaded.',
        });
    } else if (config.geo.patientGeocodeUntil) {
        logger.info('geo.patient_addresses_refused', {
            lapsed: config.geo.patientGeocodeUntil,
            note: 'The grant in UH_PATIENT_GEOCODE_UNTIL has expired. Delivery addresses are refused again, which is the intended end state.',
        });
    }
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
            patientGeocodeAllowed: config.geo.patientGeocodeAllowed,
            patientGeocodeUntil: config.geo.patientGeocodeUntil,
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
    /* Before the general orders router, which owns /:id/events and would
       otherwise answer /:id/reattempt with a 404 from its own 404 handler. */
    legacy.app.use('/api/projects/:pid/uh/orders', requireProject, idempotent, createReattemptRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/orders', requireProject, createOrdersRouter({ client: database.client, storage: fileStorage }));
    // Pickup first: its /:id/pickup must be matched before the runs
    // router's /:id, which would otherwise swallow it.
    legacy.app.use('/api/projects/:pid/uh/runs', requireProject, idempotent, createPickupRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/runs', requireProject, createRunsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/returns', requireProject, idempotent, createReturnsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/board', requireProject, createBoardRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/client', requireProject, createClientPortalRouter({ client: database.client, storage: fileStorage }));
    legacy.app.use('/api/projects/:pid/uh/reports', requireProject, createReportsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/invoices', requireProject, createInvoicesRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/files', requireProject, idempotent, createFilesRouter({ client: database.client, storage: fileStorage }));
    legacy.app.use('/api/projects/:pid/uh/shifts', requireProject, createShiftsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/requests', requireProject, createRequestsRouter({ client: database.client, config }));
    legacy.app.use('/api/projects/:pid/uh/tracking', requireProject, createTrackingRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/notifications', requireProject, createNotificationsRouter({ client: database.client }));
    legacy.app.use(createPushDevicesRouter({ client: database.client }));

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

    /* `scheduler` goes out with the rest so a test can stop the timer it
       started. Without it a suite that builds an app leaves an interval
       behind, and the process that should have exited hangs. */
    return { legacy, sessions: store, audit: log, logger, throttles, scheduler };
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
