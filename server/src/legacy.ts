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
}

export function bootLegacy(config: Config, database: Database): BootedLegacy {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require('../legacy-bridge.js') as Bridge;

    const { middleware, store } = createSessionMiddleware({ client: database.client, config });
    bridge.set('sessionMiddleware', middleware);
    const { middleware: auditMiddleware, log } = createAuditMiddleware({ client: database.client });
    bridge.set('auditMiddleware', auditMiddleware);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const legacy = require('../server.js') as LegacyServer;

    legacy.app.use(createCoreAuthRouter({ client: database.client, store }));
    legacy.app.use(createUsersRouter({ client: database.client, store }));
    legacy.app.use(createAuditRouter({ log }));

    mountShell(legacy.app, config.webDist);

    return { legacy, sessions: store, audit: log };
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
