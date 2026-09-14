/* Deciding whether a restored database can be trusted.
 *
 * Ticket 4.4. This is the step somebody performs at two in the morning after a
 * restore, so what matters is that it refuses loudly rather than reassures
 * quietly. Every case here is a way a restore can come back subtly wrong, and
 * the assertion is that it is caught.
 *
 * The one that motivates the whole file: a database that lost its append-only
 * triggers still answers every query correctly. Nothing in the application
 * would notice, the tests would pass, and the chain of custody Scope 1.2.7
 * turns on would be editable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { startServer, SERVER_DIR } from './helpers/server.mjs';
import { verifyDatabase, formatVerify, REQUIRED_TRIGGERS, COUNTED_TABLES } from '../src/db/verify.ts';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.ts';

let srv;
let client;
const migrationCount = fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).length;

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;
});
afterAll(async () => { await srv.stop(); });

/* A throwaway copy, so a test can break a database without breaking the one
 * every other test in this file reads. */
const copies = [];
async function brokenCopy(damage) {
    const dir = fs.mkdtempSync(path.join(SERVER_DIR, 'test', '.tmp', 'verify-'));
    const file = path.join(dir, 'copy.db');
    const c = createClient({ url: `file:${file}` });
    /* Built from the same migrations rather than copied from a live file: a
       file copy of an open SQLite database is its own source of corruption,
       and this test is about detection, not about that. */
    const { createDatabase } = await import('../src/db/client.ts');
    const { runMigrations } = await import('../src/db/migrate.ts');
    const db = createDatabase({ db: { url: `file:${file}`, authToken: undefined, kind: 'file' } });
    await runMigrations(db);
    await damage(db.client);
    copies.push({ client: c, db, dir });
    return db.client;
}
afterAll(() => {
    for (const c of copies) {
        try { c.db.client.close(); c.client.close(); } catch { /* already closed */ }
        try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch { /* Windows holds it */ }
    }
});

describe('a sound database', () => {
    it('passes, and says how far back it goes', async () => {
        const result = await verifyDatabase(client, { expectedMigrations: migrationCount });
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.integrity).toBe('ok');
        expect(result.foreignKeyViolations).toBe(0);
        expect(result.migrations).toBe(migrationCount);

        // Every table a restore should be counted on.
        expect(result.counts.map((c) => c.table)).toEqual([...COUNTED_TABLES]);
        // And the question a restore is actually asked.
        expect(result.freshness.map((f) => f.label)).toContain('newest custody event');
    });

    it('reads as something to paste into an incident note', async () => {
        const text = formatVerify(await verifyDatabase(client, { expectedMigrations: migrationCount }));
        expect(text.startsWith('SOUND')).toBe(true);
        expect(text).toMatch(/append-only triggers 4 of 4/);
        expect(text).toMatch(/how far back this goes/);
    });
});

describe('what it refuses', () => {
    it('a database whose append-only triggers did not come back', async () => {
        /* The quiet one. Every query still answers correctly; the only thing
           that changed is that the chain of custody can now be edited. */
        const c = await brokenCopy(async (db) => {
            await db.execute('DROP TRIGGER custody_events_no_delete');
        });
        const result = await verifyDatabase(c, { expectedMigrations: migrationCount });
        expect(result.ok).toBe(false);
        expect(result.problems.join(' ')).toMatch(/custody_events_no_delete/);
        expect(result.problems.join(' ')).toMatch(/chain of custody can be edited/);
    });

    it('a database missing the audit triggers, in the same way', async () => {
        const c = await brokenCopy(async (db) => {
            await db.execute('DROP TRIGGER audit_events_no_update');
        });
        const result = await verifyDatabase(c, { expectedMigrations: migrationCount });
        expect(result.ok).toBe(false);
        expect(result.problems.join(' ')).toMatch(/the audit trail can be edited/);
    });

    it('a snapshot older than the code that will run against it', async () => {
        /* The ordinary case, and the one with a fix: the restored copy is
           behind, so run the migrations against it and check again. */
        const result = await verifyDatabase(client, { expectedMigrations: migrationCount + 1 });
        expect(result.ok).toBe(false);
        expect(result.problems.join(' ')).toMatch(/this build expects/);
        expect(result.problems.join(' ')).toMatch(/db:migrate/);
    });

    it('something that is not a database this application made', async () => {
        const c = await brokenCopy(async (db) => {
            await db.execute('DELETE FROM __drizzle_migrations');
        });
        const result = await verifyDatabase(c, { expectedMigrations: migrationCount });
        expect(result.ok).toBe(false);
        expect(result.problems.join(' ')).toMatch(/not a database this application made/);
    });

    it('a restore aimed at the wrong moment, leaving a link missing', async () => {
        /* A custody event pointing at an order that is not there. This is
           exactly the shape a partial restore produces, and it is the one an
           auditor would find rather than us. */
        const c = await brokenCopy(async (db) => {
            await db.execute('PRAGMA foreign_keys = OFF');
            await db.execute(`INSERT INTO custody_events (project_id, order_id, type, at, actor, from_status, to_status)
                              VALUES (1, 999999, 'created', '2026-09-14T12:00:00Z', 'drill', '', 'ready')`);
        });
        const result = await verifyDatabase(c, { expectedMigrations: migrationCount });
        expect(result.ok).toBe(false);
        expect(result.problems.join(' ')).toMatch(/foreign key violation/);
    });

    it('names every problem at once, rather than the first', async () => {
        const c = await brokenCopy(async (db) => {
            await db.execute('DROP TRIGGER custody_events_no_delete');
            await db.execute('DROP TRIGGER audit_events_no_delete');
            await db.execute('DELETE FROM __drizzle_migrations');
        });
        const result = await verifyDatabase(c, { expectedMigrations: migrationCount });
        expect(result.problems.length).toBeGreaterThanOrEqual(3);
        const text = formatVerify(result);
        expect(text.startsWith('PROBLEMS FOUND')).toBe(true);
    });
});

describe('what it will not do', () => {
    it('repairs nothing', async () => {
        /* A check that quietly fixed what it found would hide the reason the
           restore was needed, and would make the next one harder. */
        const c = await brokenCopy(async (db) => {
            await db.execute('DROP TRIGGER custody_events_no_delete');
        });
        await verifyDatabase(c, { expectedMigrations: migrationCount });
        const after = await c.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custody_events_no_delete'");
        expect(after.rows).toHaveLength(0);
    });

    it('lists the triggers it requires, so the list is not buried in a check', () => {
        expect([...REQUIRED_TRIGGERS]).toEqual([
            'audit_events_no_delete', 'audit_events_no_update',
            'custody_events_no_delete', 'custody_events_no_update',
        ]);
    });
});
