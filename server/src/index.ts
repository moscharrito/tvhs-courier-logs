/* Izy Ops Platform server entry point.
 *
 * Boots the legacy TVHS server (server/server.js) unchanged. Ticket 0.4 moves
 * schema setup into migrations that run here before the listener binds, and
 * later tickets mount the core and module routers around the legacy app. */

import type { Express } from 'express';
import type { Server } from 'http';
import type { Client } from '@libsql/client';

interface LegacyServer {
    app: Express;
    ready: Promise<void>;
    start: (port?: number | string) => Promise<Server>;
    db: Client;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('../server.js') as LegacyServer;

async function main(): Promise<void> {
    const port = process.env.PORT ?? '3000';
    await legacy.start(port);
}

main().catch((err: unknown) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
