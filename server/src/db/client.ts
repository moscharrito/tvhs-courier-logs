/* Database client factory.
 *
 * One libsql client (Turso in production, a local SQLite file otherwise) and
 * a Drizzle instance over it. Built from the validated config so the URL and
 * token can never be half-set. */

import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema';
import type { Config } from '../config';

export type Db = LibSQLDatabase<typeof schema>;

export interface Database {
    client: Client;
    db: Db;
}

export function createDatabase(config: Pick<Config, 'db'>): Database {
    const client = createClient({
        url: config.db.url,
        // Only set when present: libsql's Config marks it optional without undefined.
        ...(config.db.authToken !== undefined ? { authToken: config.db.authToken } : {}),
        intMode: 'number', // ids and counts as JS numbers (JSON-safe), same as the legacy server
    });

    /* A local file database gets write-ahead logging.
     *
     * Without it SQLite takes an exclusive lock for the whole of every write
     * transaction, so a dispatcher's board read waits behind a courier's
     * delivery. With twelve couriers posting at once, the load test (ticket
     * 4.1) measured reads queueing behind writes for seconds at a time.
     *
     * Turso does not take this path: it is a server with its own concurrency,
     * and the pragma would be meaningless there. So this only affects
     * development, the test suite and any file-backed deployment, and it is
     * fire-and-forget: if it fails the database still works, only slower.
     */
    if (config.db.url.startsWith('file:')) {
        void client.execute('PRAGMA journal_mode = WAL').catch(() => { /* keep the default journal */ });
        /* NORMAL rather than FULL: with WAL this still survives a process
         * crash, and only risks the last transactions if the machine itself
         * loses power. The alternative is an fsync per write. */
        void client.execute('PRAGMA synchronous = NORMAL').catch(() => { /* keep the default */ });
        // Wait for a writer rather than failing instantly with SQLITE_BUSY.
        void client.execute('PRAGMA busy_timeout = 5000').catch(() => { /* keep the default */ });
    }

    const db = drizzle(client, { schema });
    return { client, db };
}
