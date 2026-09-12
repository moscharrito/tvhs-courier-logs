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
import { createAuditMiddleware, type AuditLog } from './core/audit/audit';
import { createAuditRouter } from './core/audit/routes';
import { Logger } from './core/http/logger';
import { createRequestMiddleware } from './core/http/request';
import { createHealthRouter } from './core/http/health';
import { apiNotFound, createErrorHandler } from './core/http/errors';
import { createRequireProject } from './core/projects/middleware';
import { createProjectSettingsRouter } from './core/projects/settings-routes';
import { createSitesRouter } from './modules/uh/sites';
import { createPricingRouter } from './modules/uh/pricing-routes';
import { createImportsRouter, MAX_UPLOAD_BYTES } from './modules/uh/imports';
import { createOrdersRouter } from './modules/uh/orders';
import { createRunsRouter } from './modules/uh/runs';
import { createBoardRouter } from './modules/uh/board';

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

    // Order inside server.js: request id + log, json body, static, sessions, audit, routes.
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
    legacy.app.use(createAuditRouter({ log }));

    // Project settings are core: every contract has operating parameters.
    // UH Pharmacy Courier module below. Project scoping is enforced here
    // rather than in server.js, so a module has no dependency on the legacy app.
    const requireProject = createRequireProject(database.client);
    legacy.app.use('/api/projects/:pid/settings', requireProject, createProjectSettingsRouter({ client: database.client }));
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
    legacy.app.use('/api/projects/:pid/uh/orders', requireProject, createOrdersRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/runs', requireProject, createRunsRouter({ client: database.client }));
    legacy.app.use('/api/projects/:pid/uh/board', requireProject, createBoardRouter({ client: database.client }));

    if (config.nodeEnv === 'test') {
        // Lets the test suite exercise the error handler on a real request.
        legacy.app.get('/api/_test/error', () => { throw new Error('synthetic failure with secret detail'); });
        legacy.app.get('/api/_test/exposed', () => { throw Object.assign(new Error('You may see this'), { status: 422, expose: true }); });
    }

    mountShell(legacy.app, config.webDist);

    // Last: JSON 404 for unknown API paths, then the central error handler.
    legacy.app.use(apiNotFound);
    legacy.app.use(createErrorHandler({ logger, isProduction: config.isProduction }));

    return { legacy, sessions: store, audit: log, logger };
}

/* The built frontend shell (web/dist) is served at /. Any GET that is not an
 * API call, a legacy asset, or a real file falls back to index.html so the
 * React router can handle it. Without a build (development before
 * `npm run build -w web`, or tests) a plain-text pointer is served instead. */
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
        // Real files under the built shell were already served by express.static above.
        if (path.extname(req.path) && req.path !== '/') return next();
        if (!built) {
            res.status(200).type('text/plain').send('Izy Ops shell is not built. Run `npm run build -w web`, or use `npm run dev -w web` during development.\n');
            return;
        }
        // root + relative name: `send` rejects dot-segments in the path it is
        // given, and a test dist may live under test/.tmp.
        res.sendFile('index.html', { root: webDist, headers: { 'Cache-Control': 'no-cache' } }, (err) => { if (err) next(err); });
    });
}
