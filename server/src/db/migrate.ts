/* Migration runner.
 *
 * Runs on boot before the listener binds (src/index.ts) and from the CLI
 * (src/db/cli.ts). Two steps:
 *
 *   1. Pre-baseline: databases created by the legacy server before the pin,
 *      leg_from, and leg_to columns existed get those columns added, exactly
 *      as the legacy migrate() did. New databases skip this.
 *   2. Drizzle migrator: applies every SQL file in server/drizzle in journal
 *      order, recording each in __drizzle_migrations. The baseline uses
 *      CREATE TABLE IF NOT EXISTS, so a database that already has the legacy
 *      tables adopts the baseline without touching them.
 *
 * Any failure rejects, and the caller refuses to start. */

import path from 'node:path';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from './client';

// src/db and dist/db are both one level below server/, so this resolves to
// server/drizzle from either.
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', '..', 'drizzle');

interface ColumnInfo { name: string }

async function tableExists(client: Database['client'], table: string): Promise<boolean> {
    const rs = await client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
    return rs.rows.length > 0;
}

async function columns(client: Database['client'], table: string): Promise<Set<string>> {
    const rs = await client.execute(`PRAGMA table_info(${table})`);
    return new Set((rs.rows as unknown as ColumnInfo[]).map((r) => r.name));
}

/** Ported from the legacy migrate(): add columns older databases lack. */
export async function applyPreBaseline(client: Database['client'], log: (msg: string) => void = () => {}): Promise<string[]> {
    const applied: string[] = [];

    if (await tableExists(client, 'users')) {
        const cols = await columns(client, 'users');
        if (!cols.has('pin')) {
            await client.execute('ALTER TABLE users ADD COLUMN pin TEXT');
            applied.push('users.pin');
        }
    }

    if (await tableExists(client, 'logs')) {
        const cols = await columns(client, 'logs');
        for (const col of ['leg_from', 'leg_to'] as const) {
            if (!cols.has(col)) {
                await client.execute(`ALTER TABLE logs ADD COLUMN ${col} TEXT DEFAULT ''`);
                applied.push(`logs.${col}`);
            }
        }
    }

    for (const a of applied) log(`Pre-baseline: added ${a}`);
    return applied;
}

export interface MigrateResult {
    preBaseline: string[];
    /** Number of rows in __drizzle_migrations after the run. */
    appliedCount: number;
}

export async function runMigrations(database: Database, log: (msg: string) => void = () => {}): Promise<MigrateResult> {
    const preBaseline = await applyPreBaseline(database.client, log);

    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rs = await database.client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations');
    const appliedCount = Number((rs.rows[0] as unknown as { n: number }).n);
    log(`Migrations: ${appliedCount} applied (folder ${MIGRATIONS_FOLDER})`);
    return { preBaseline, appliedCount };
}
