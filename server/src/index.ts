/* Izy Ops Platform server entry point.
 *
 * Order matters:
 *   1. Load .env (development and test only; production gets env from Render).
 *   2. Validate the environment into a typed config. Fail fast and loudly.
 *   3. Run database migrations. Refuse to start if any fail.
 *   4. Require the legacy TVHS server, which reads process.env at load and
 *      reconciles the bootstrap users against the migrated schema.
 *   5. Bind the listener. */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, describeConfig, ConfigError, type Config } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';

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

async function main(): Promise<void> {
    const config = configOrExit();
    console.log('Config:', JSON.stringify(describeConfig(config)));

    const database = createDatabase(config);
    await runMigrations(database, (m) => console.log(m));
    // The legacy server opens its own client for now (ticket 0.5 hands it this one).
    database.client.close();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const legacy = require('../server.js') as LegacyServer;
    await legacy.start(config.port);
}

main().catch((err: unknown) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
