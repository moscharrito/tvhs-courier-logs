/* Izy Ops Platform server entry point.
 *
 * Order matters:
 *   1. Load .env (development and test only; production gets env from Render).
 *   2. Validate the environment into a typed config. Fail fast and loudly.
 *   3. Run database migrations. Refuse to start if any fail.
 *   4. Boot the legacy TVHS server with core services injected (sessions,
 *      core routers). It reads process.env at load and reconciles the
 *      bootstrap users against the migrated schema.
 *   5. Bind the listener. */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, describeConfig, ConfigError, type Config } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { bootLegacy } from './legacy';

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

    // The core keeps this client (sessions, core routers); the legacy server
    // still opens its own for its handlers until they move into modules.
    const { legacy } = bootLegacy(config, database);
    await legacy.start(config.port);
}

main().catch((err: unknown) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
