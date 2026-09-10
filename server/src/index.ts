/* Izy Ops Platform server entry point.
 *
 * Order matters:
 *   1. Load .env (development and test only; production gets env from Render).
 *   2. Validate the environment into a typed config. Fail fast and loudly.
 *   3. Run database migrations. Refuse to start if any fail.
 *   4. Boot the legacy TVHS server with core services injected (request id
 *      and logging, sessions, audit, health, core routers, error handler).
 *   5. Bind the listener. */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, describeConfig, ConfigError, type Config } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { bootLegacy, createLogger } from './legacy';
import { errorFields } from './core/http/logger';

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
    const logger = createLogger(config);
    logger.info('config', describeConfig(config));

    const database = createDatabase(config);
    await runMigrations(database, (m) => logger.info(m));

    const { legacy } = bootLegacy(config, database, logger);
    const server = await legacy.start(config.port);
    logger.info('listening', { port: config.port });

    const shutdown = (signal: string) => {
        logger.info('shutting down', { signal });
        server.close(() => {
            try { database.client.close(); } catch { /* ignore */ }
            process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
        logger.error('unhandled rejection', errorFields(reason));
    });
}

main().catch((err: unknown) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
