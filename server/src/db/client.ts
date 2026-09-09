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
    const db = drizzle(client, { schema });
    return { client, db };
}
