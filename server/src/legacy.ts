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

import type { Express } from 'express';
import type { Server } from 'http';
import type { Client } from '@libsql/client';
import type { Config } from './config';
import type { Database } from './db/client';
import { createSessionMiddleware, type SessionStore } from './core/auth/sessions';
import { createCoreAuthRouter } from './core/auth/routes';

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
}

export function bootLegacy(config: Config, database: Database): BootedLegacy {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require('../legacy-bridge.js') as Bridge;

    const { middleware, store } = createSessionMiddleware({ client: database.client, config });
    bridge.set('sessionMiddleware', middleware);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const legacy = require('../server.js') as LegacyServer;

    legacy.app.use(createCoreAuthRouter({ client: database.client, store }));

    return { legacy, sessions: store };
}
