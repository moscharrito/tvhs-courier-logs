/* Izy Ops Platform server entry point.
 *
 * Order matters:
 *   1. Load .env (development and test only; production gets env from Render).
 *   2. Validate the environment into a typed config. Fail fast and loudly.
 *   3. Require the legacy TVHS server, which reads process.env at load.
 *   4. Bind the listener.
 *
 * Ticket 0.4 moves schema setup into migrations that run between 3 and 4. */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, describeConfig, ConfigError, type Config } from './config';

import type { Express } from 'express';
import type { Server } from 'http';
import type { Client } from '@libsql/client';

interface LegacyServer {
    app: Express;
    ready: Promise<void>;
    start: (port?: number | string) => Promise<Server>;
    db: Client;
}

if (process.env.NODE_ENV !== 'production') {
    // server/.env, whether running from src (tsx) or dist (compiled)
    dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
}

function configOrExit(): Config {
    try {
        return loadConfig();
    } catch (err) {
        if (err instanceof ConfigError) {
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    }
}
const config = configOrExit();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('../server.js') as LegacyServer;

async function main(): Promise<void> {
    console.log('Config:', JSON.stringify(describeConfig(config)));
    await legacy.start(config.port);
}

main().catch((err: unknown) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
