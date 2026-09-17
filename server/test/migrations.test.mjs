import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { createDatabase } from '../src/db/client.ts';
import { runMigrations, applyPreBaseline, MIGRATIONS_FOLDER } from '../src/db/migrate.ts';
import { tempDb, removeDir, SERVER_DIR } from './helpers/server.mjs';

// The legacy CREATE TABLE text from server.js, which the baseline must reproduce.
const LEGACY_SQL = {
    users: `CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        pin TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('driver','admin')),
        route TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    logs: `CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        date TEXT NOT NULL,
        leg_index INTEGER NOT NULL,
        leg_from TEXT DEFAULT '',
        leg_to TEXT DEFAULT '',
        start_time TEXT DEFAULT '',
        end_time TEXT DEFAULT '',
        sterile INTEGER DEFAULT 0,
        soiled INTEGER DEFAULT 0,
        miles REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(username, date, leg_index),
        FOREIGN KEY(username) REFERENCES users(username)
    )`,
    checkins: `CREATE TABLE checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        date TEXT NOT NULL,
        checkin_at DATETIME NOT NULL,
        UNIQUE(username, date),
        FOREIGN KEY(username) REFERENCES users(username)
    )`,
};

// The shape the very first legacy release created, before pin / leg_from / leg_to.
const OLD_SCHEMA = `
    CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('driver','admin')),
        route TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        date TEXT NOT NULL,
        leg_index INTEGER NOT NULL,
        start_time TEXT DEFAULT '',
        end_time TEXT DEFAULT '',
        sterile INTEGER DEFAULT 0,
        soiled INTEGER DEFAULT 0,
        miles REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(username, date, leg_index),
        FOREIGN KEY(username) REFERENCES users(username)
    );
    CREATE TABLE checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        date TEXT NOT NULL,
        checkin_at DATETIME NOT NULL,
        UNIQUE(username, date),
        FOREIGN KEY(username) REFERENCES users(username)
    );
`;

// Keep in step with drizzle/meta/_journal.json.
const MIGRATION_TAGS = ['0000_baseline', '0001_projects', '0002_sessions', '0003_users', '0004_audit', '0005_uh_project', '0006_sites', '0007_pricing', '0008_daily_lists', '0009_custody', '0010_runs', '0011_devices', '0012_signatures', '0013_files', '0014_stop_flow', '0015_return_flow', '0016_client_events', '0017_invoices', '0018_invoice_performed_at', '0019_mfa', '0020_retention', '0021_run_stops_project_run_idx', '0022_geocodes', '0023_out_of_area_basis', '0024_discrepancies', '0025_report_sends', '0026_device_pin', '0027_drop_mfa', '0028_three_roles', '0029_driver_applications', '0030_shifts', '0031_delivery_requests', '0032_shift_positions', '0033_notifications'];
const MIGRATION_COUNT = MIGRATION_TAGS.length;

// users after 0003 (rebuilt in place; SQLite quotes the name after RENAME).
const USERS_SQL_AFTER_0003 = `CREATE TABLE "users" (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT UNIQUE NOT NULL,
	password TEXT NOT NULL,
	pin TEXT,
	name TEXT NOT NULL,
	email TEXT,
	role TEXT NOT NULL CHECK(role IN ('admin','staff','driver')),
	status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
	route TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;
const USERS_COLS_AFTER_0003 = ['id', 'username', 'password', 'pin', 'name', 'email', 'role', 'status', 'route', 'created_at'];

const norm = (s) => String(s).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

// What SQLite stores after `ALTER TABLE ADD COLUMN`: the new column definition
// is spliced in after the last column, before the table constraints.
const PROJECT_ID_COL = '`project_id` integer DEFAULT 1 NOT NULL';
function withProjectId(sql) {
    return String(sql)
        .replace('updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,', `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, ${PROJECT_ID_COL},`)
        .replace('checkin_at DATETIME NOT NULL,', `checkin_at DATETIME NOT NULL, ${PROJECT_ID_COL},`);
}

const dirs = [];
function freshDb() {
    const t = tempDb('mig-');
    dirs.push(t.dir);
    return t;
}
afterEach(async () => {
    while (dirs.length) await removeDir(dirs.pop());
});

async function tableSql(client, name) {
    const rs = await client.execute({ sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", args: [name] });
    return rs.rows[0]?.sql;
}
async function columnNames(client, table) {
    return (await client.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name);
}
async function count(client, table) {
    return Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
}
async function migrationRows(client) {
    return count(client, '__drizzle_migrations');
}

describe('migrations folder', () => {
    it('resolves to server/drizzle and has the baseline in the journal', () => {
        expect(MIGRATIONS_FOLDER).toBe(path.join(SERVER_DIR, 'drizzle'));
        const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
        expect(journal.entries.map((e) => e.tag)).toEqual(MIGRATION_TAGS);
        for (const tag of journal.entries.map((e) => e.tag)) {
            expect(fs.existsSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`))).toBe(true);
        }
    });
});

describe('fresh database', () => {
    it('creates the legacy tables exactly (plus project_id), the core tables, and records both migrations', async () => {
        const { absolute } = freshDb();
        const database = createDatabase({ db: { url: `file:${absolute}`, authToken: undefined, kind: 'file' } });
        try {
            const result = await runMigrations(database);
            expect(result.preBaseline).toEqual([]);
            expect(result.appliedCount).toBe(MIGRATION_COUNT);

            // users is rebuilt by 0003; logs and checkins get project_id appended by 0001.
            expect(norm(await tableSql(database.client, 'users'))).toBe(norm(USERS_SQL_AFTER_0003));
            expect(await columnNames(database.client, 'users')).toEqual(USERS_COLS_AFTER_0003);
            for (const t of ['logs', 'checkins']) {
                expect(norm(await tableSql(database.client, t))).toBe(norm(withProjectId(LEGACY_SQL[t])));
                const pid = (await database.client.execute(`PRAGMA table_info(${t})`)).rows.find((r) => r.name === 'project_id');
                expect(pid).toMatchObject({ notnull: 1, dflt_value: '1' });
            }
            expect(await columnNames(database.client, 'projects')).toEqual(['id', 'code', 'name', 'timezone', 'settings', 'created_at']);
            /* settings used to come last, because it arrived by ALTER TABLE
               after the others. Migration 0028 rebuilt this table to change
               the role CHECK, and a rebuild writes the columns in schema
               order. Nothing was lost; the order simply stopped recording the
               history of how the table was built. */
            expect(await columnNames(database.client, 'memberships')).toEqual(['id', 'user_id', 'project_id', 'role', 'settings', 'created_at']);
            expect(await columnNames(database.client, 'sessions')).toEqual(['id', 'user_id', 'device', 'ip', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'revoked_at', 'device_id']);
            expect(await columnNames(database.client, 'audit_events')).toEqual(['id', 'at', 'project_id', 'user_id', 'username', 'action', 'entity', 'entity_id', 'ip', 'detail']);

            // Legacy inline UNIQUE constraints stay autoindexes; only the named indexes from later migrations exist.
            const idx = await database.client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name");
            expect(idx.rows.map((r) => r.name)).toEqual([
                'audit_events_at_idx', 'audit_events_entity_idx', 'audit_events_project_id_idx', 'audit_events_user_id_idx',
                'checkins_project_id_idx', 'client_events_created_idx', 'client_events_key_unique', 'custody_events_order_idx',
                'custody_events_project_at_idx', 'daily_lists_project_date_idx', 'daily_lists_site_date_idx', 'delivery_requests_courier_idx',
                'delivery_requests_one_pending_per_courier', 'delivery_requests_order_idx', 'delivery_requests_project_status_idx', 'devices_user_id_idx',
                'discrepancies_project_date_idx', 'discrepancies_status_idx', 'driver_applications_project_idx', 'driver_applications_status_idx',
                'files_key_unique', 'files_order_idx', 'files_project_status_idx', 'geo_usage_day_idx',
                'geocodes_key_unique', 'import_mappings_site_unique', 'invoice_adjustments_invoice_idx', 'invoice_lines_invoice_idx',
                'invoice_lines_invoice_order_unique', 'invoices_project_number_unique', 'invoices_project_period_idx', 'logs_project_id_idx',
                'memberships_project_id_idx', 'memberships_user_project_unique', 'notifications_unsent_idx', 'notifications_user_idx',
                'onboarding_checks_application_idx', 'onboarding_checks_application_kind_unique', 'orders_dedupe_idx', 'orders_list_idx',
                'orders_project_date_idx', 'orders_site_date_idx', 'orders_status_idx', 'packages_order_idx',
                'price_schedules_project_from_unique', 'projects_code_unique', 'push_devices_token_unique', 'push_devices_user_idx',
                'report_sends_day_unique', 'retention_runs_ran_at_idx', 'run_stops_order_unique', 'run_stops_project_run_idx',
                'run_stops_run_seq_idx', 'runs_courier_date_idx', 'runs_project_date_idx', 'sessions_user_id_idx',
                'shift_positions_courier_at_idx', 'shift_positions_shift_at_idx', 'shifts_one_open_per_courier', 'shifts_project_courier_idx',
                'shifts_started_idx', 'signatures_project_idx', 'sites_project_code_unique', 'sites_project_id_idx',
                'zone_zips_project_zip_from_unique', 'zone_zips_project_zip_idx',
            ]);
            const triggers = await database.client.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name");
            expect(triggers.rows.map((r) => r.name)).toEqual([
                'audit_events_no_delete', 'audit_events_no_update',
                'custody_events_no_delete', 'custody_events_no_update',
            ]);
            expect(await migrationRows(database.client)).toBe(MIGRATION_COUNT);

            // tvhs is seeded as project 1 so the project_id default points at it; uh follows.
            const projects = (await database.client.execute('SELECT id, code, name, timezone, settings FROM projects ORDER BY id')).rows.map((r) => ({ ...r }));
            expect(projects).toEqual([
                { id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', settings: '{}' },
                { id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', settings: '{}' },
            ]);
        } finally {
            database.client.close();
        }
    });

    it('is idempotent: a second run applies nothing new', async () => {
        const { absolute } = freshDb();
        const database = createDatabase({ db: { url: `file:${absolute}`, authToken: undefined, kind: 'file' } });
        try {
            await runMigrations(database);
            const again = await runMigrations(database);
            expect(again.appliedCount).toBe(MIGRATION_COUNT);
            expect(await migrationRows(database.client)).toBe(MIGRATION_COUNT);
            expect(await count(database.client, 'projects')).toBe(2);
        } finally {
            database.client.close();
        }
    });
});

describe('database created by the legacy server', () => {
    it('adopts the baseline without altering tables or data (current legacy shape)', async () => {
        const { absolute } = freshDb();
        const raw = createClient({ url: `file:${absolute}` });
        // Reproduce what the legacy SCHEMA string created, then add data.
        await raw.executeMultiple(Object.values(LEGACY_SQL).join(';') + ';');
        await raw.execute("INSERT INTO users (username, password, name, role, route) VALUES ('d1','x','Driver One','driver','southbound')");
        await raw.execute("INSERT INTO logs (username, date, leg_index, miles) VALUES ('d1','2026-01-05',0,122.6)");
        await raw.execute("INSERT INTO checkins (username, date, checkin_at) VALUES ('d1','2026-01-05','2026-01-05T11:00:00.000Z')");
        const before = { users: await tableSql(raw, 'users'), logs: await tableSql(raw, 'logs'), checkins: await tableSql(raw, 'checkins') };
        raw.close();

        const database = createDatabase({ db: { url: `file:${absolute}`, authToken: undefined, kind: 'file' } });
        try {
            const result = await runMigrations(database);
            expect(result.preBaseline).toEqual([]);
            expect(result.appliedCount).toBe(MIGRATION_COUNT);
            // users is rebuilt with the same rows and ids; logs/checkins only gain project_id.
            expect(norm(await tableSql(database.client, 'users'))).toBe(norm(USERS_SQL_AFTER_0003));
            for (const t of ['logs', 'checkins']) {
                expect(norm(await tableSql(database.client, t))).toBe(norm(withProjectId(before[t])));
            }
            expect(await count(database.client, 'users')).toBe(1);
            expect(await count(database.client, 'logs')).toBe(1);
            expect(await count(database.client, 'checkins')).toBe(1);
            const user = (await database.client.execute('SELECT id, username, name, role, status, email, route FROM users')).rows[0];
            expect({ ...user }).toEqual({ id: 1, username: 'd1', name: 'Driver One', role: 'driver', status: 'active', email: null, route: 'southbound' });
            const log = (await database.client.execute('SELECT * FROM logs')).rows[0];
            expect(log.miles).toBe(122.6);
            expect(log.project_id).toBe(1);
            expect((await database.client.execute('SELECT project_id FROM checkins')).rows[0].project_id).toBe(1);

            // The existing driver is enrolled in tvhs as a courier with its route in settings.
            const members = (await database.client.execute('SELECT user_id, project_id, role, settings FROM memberships')).rows.map((r) => ({ ...r }));
            expect(members).toEqual([{ user_id: 1, project_id: 1, role: 'courier', settings: '{"route":"southbound"}' }]);
        } finally {
            database.client.close();
        }
    });

    it('upgrades the oldest legacy shape by adding pin, leg_from, leg_to with data intact', async () => {
        const { absolute } = freshDb();
        const raw = createClient({ url: `file:${absolute}` });
        await raw.executeMultiple(OLD_SCHEMA);
        await raw.execute("INSERT INTO users (username, password, name, role, route) VALUES ('d2','x','Driver Two','driver','northbound')");
        await raw.execute("INSERT INTO logs (username, date, leg_index, start_time, end_time, sterile, soiled, miles) VALUES ('d2','2026-01-06',0,'05:00','06:30',4,0,80)");
        raw.close();

        const database = createDatabase({ db: { url: `file:${absolute}`, authToken: undefined, kind: 'file' } });
        try {
            const result = await runMigrations(database);
            expect(result.preBaseline).toEqual(['users.pin', 'logs.leg_from', 'logs.leg_to']);
            expect(result.appliedCount).toBe(MIGRATION_COUNT);

            expect(await columnNames(database.client, 'users')).toContain('pin');
            const logCols = await columnNames(database.client, 'logs');
            expect(logCols).toContain('leg_from');
            expect(logCols).toContain('leg_to');
            expect(logCols).toContain('project_id');

            const log = (await database.client.execute('SELECT * FROM logs')).rows[0];
            expect(log).toMatchObject({ username: 'd2', date: '2026-01-06', start_time: '05:00', end_time: '06:30', sterile: 4, miles: 80, leg_from: '', leg_to: '', project_id: 1 });

            // Second run: nothing more to add.
            const again = await runMigrations(database);
            expect(again.preBaseline).toEqual([]);
        } finally {
            database.client.close();
        }
    });

    it('pre-baseline is a no-op on an empty database', async () => {
        const { absolute } = freshDb();
        const raw = createClient({ url: `file:${absolute}` });
        try {
            expect(await applyPreBaseline(raw)).toEqual([]);
        } finally {
            raw.close();
        }
    });
});

describe('the real local development database', () => {
    const real = path.join(SERVER_DIR, 'courier_logs.db');
    const present = fs.existsSync(real);

    it.skipIf(!present)('migrates a copy in place with every row and column intact', async () => {
        const { dir, absolute } = freshDb();
        fs.copyFileSync(real, absolute);
        // Copy the WAL too if the dev server left one open.
        for (const ext of ['-wal', '-shm']) {
            if (fs.existsSync(real + ext)) fs.copyFileSync(real + ext, absolute + ext);
        }
        expect(fs.existsSync(path.join(dir, 'test.db'))).toBe(true);

        const raw = createClient({ url: `file:${absolute}` });
        const before = {};
        for (const t of ['users', 'logs', 'checkins']) {
            before[t] = { rows: await count(raw, t), cols: await columnNames(raw, t), sql: await tableSql(raw, t) };
        }
        const usersBefore = (await raw.execute('SELECT username, name, role, route, pin FROM users ORDER BY id')).rows;
        raw.close();

        const database = createDatabase({ db: { url: `file:${absolute}`, authToken: undefined, kind: 'file' } });
        try {
            const result = await runMigrations(database);
            expect(result.appliedCount).toBe(MIGRATION_COUNT);
            for (const t of ['users', 'logs', 'checkins']) {
                expect(await count(database.client, t)).toBe(before[t].rows);
            }
            // The real file may be legacy-shaped or already migrated by a local
            // dev server; either way it must end in the canonical shape with
            // every row intact.
            expect(await columnNames(database.client, 'users')).toEqual(USERS_COLS_AFTER_0003);
            expect(norm(await tableSql(database.client, 'users'))).toBe(norm(USERS_SQL_AFTER_0003));
            for (const t of ['logs', 'checkins']) {
                const cols = await columnNames(database.client, t);
                const legacyCols = before[t].cols.filter((c) => c !== 'project_id');
                expect(cols).toEqual([...legacyCols, 'project_id']);
            }
            const usersAfter = (await database.client.execute('SELECT username, name, role, route, pin FROM users ORDER BY id')).rows;
            expect(usersAfter).toEqual(usersBefore);
            // Every admin and driver is a tvhs member (staff users may have none).
            const eligible = Number((await database.client.execute("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','driver')")).rows[0].n);
            expect(await count(database.client, 'memberships')).toBeGreaterThanOrEqual(eligible);
        } finally {
            database.client.close();
        }
    });
});

describe('0009 rebuilds packages without losing rows', () => {
    /* drizzle-kit generated this migration's INSERT reading "outcome" from the
       old packages table, which does not have that column yet. It was
       hand-corrected. The bug only shows on a database that already holds
       imported packages, so run 0000 through 0008, put a package in, and then
       apply 0009 on top. */
    it('carries existing packages across the table rebuild and defaults them to pending', async () => {
        const { dir, absolute } = tempDb('rebuild-');
        const client = createClient({ url: `file:${absolute}` });
        try {
            const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
            const runFile = async (tag) => {
                const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
                for (const stmt of sql.split('--> statement-breakpoint')) {
                    const trimmed = stmt.trim();
                    if (trimmed) await client.execute(trimmed);
                }
            };
            const tags = journal.entries.map((e) => e.tag);
            for (const tag of tags.filter((t) => t < '0009')) await runFile(tag);

            const site = await client.execute("SELECT id FROM sites WHERE code = 'discharge'");
            const siteId = Number(site.rows[0].id);
            await client.execute({
                sql: `INSERT INTO daily_lists (project_id, site_id, service_date, received_at) VALUES (2, ?, '2026-09-14', '2026-09-14T17:00:00Z')`,
                args: [siteId],
            });
            await client.execute({
                sql: `INSERT INTO orders (project_id, site_id, daily_list_id, service_date, recipient_name, address_line, zip, received_at)
                      VALUES (2, ?, 1, '2026-09-14', 'Test Person', '1 Somewhere', '78229', '2026-09-14T17:00:00Z')`,
                args: [siteId],
            });
            await client.execute(`INSERT INTO packages (project_id, order_id, description, quantity) VALUES (2, 1, 'Cold pack', 3)`);

            // The column does not exist yet: this is the pre-0009 shape.
            const before = await client.execute('PRAGMA table_info(packages)');
            expect(before.rows.map((r) => r.name)).not.toContain('outcome');

            await runFile('0009_custody');

            const after = await client.execute('SELECT id, description, quantity, outcome FROM packages');
            expect(after.rows).toHaveLength(1);
            expect({ ...after.rows[0] }).toMatchObject({ id: 1, description: 'Cold pack', quantity: 3, outcome: 'pending' });

            // And the constraint the rebuild existed to add is really there.
            await expect(client.execute("UPDATE packages SET outcome = 'nonsense' WHERE id = 1")).rejects.toThrow();
        } finally {
            client.close();
            await removeDir(dir);
        }
    });
});

describe('0015 rebuilds signatures without losing rows', () => {
    /* Adding 'return' to the kind CHECK means a full table rebuild in SQLite,
       which is the shape of migration that lost data in 0009. Signatures are
       proof of delivery under Scope 1.2.8: losing one is losing the evidence
       that a controlled substance changed hands. So this runs 0000 through
       0014, captures a real pickup signature, and applies 0015 on top. */
    it('carries captured signatures across the rebuild and then accepts a return', async () => {
        const { dir, absolute } = tempDb('sig-rebuild-');
        const client = createClient({ url: `file:${absolute}` });
        try {
            const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
            const runFile = async (tag) => {
                const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
                for (const stmt of sql.split('--> statement-breakpoint')) {
                    const trimmed = stmt.trim();
                    if (trimmed) await client.execute(trimmed);
                }
            };
            const tags = journal.entries.map((e) => e.tag);
            for (const tag of tags.filter((t) => t < '0015')) await runFile(tag);

            const strokes = JSON.stringify([[{ x: 0.1, y: 0.2, t: 0 }, { x: 0.4, y: 0.5, t: 40 }]]);
            await client.execute({
                sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, captured_by, captured_at, lat, lng)
                      VALUES (2, 'pickup', 'Pharmacy Tech', ?, 'ada.courier', '2026-09-14T17:05:00.000Z', 29.42, -98.49)`,
                args: [strokes],
            });
            // The kind under test is refused before 0015, which is why it exists.
            await expect(client.execute(
                `INSERT INTO signatures (project_id, kind, signed_name, captured_at) VALUES (2, 'return', 'Night Pharmacist', '2026-09-14T21:00:00.000Z')`,
            )).rejects.toThrow();

            await runFile('0015_return_flow');

            const after = await client.execute('SELECT * FROM signatures');
            expect(after.rows).toHaveLength(1);
            expect({ ...after.rows[0] }).toMatchObject({
                id: 1, kind: 'pickup', signed_name: 'Pharmacy Tech', strokes,
                captured_by: 'ada.courier', captured_at: '2026-09-14T17:05:00.000Z', lat: 29.42, lng: -98.49,
            });

            // The kind the rebuild existed to allow, and nothing beyond it.
            await client.execute(
                `INSERT INTO signatures (project_id, kind, signed_name, captured_at) VALUES (2, 'return', 'Night Pharmacist', '2026-09-14T21:00:00.000Z')`,
            );
            await expect(client.execute(
                `INSERT INTO signatures (project_id, kind, signed_name, captured_at) VALUES (2, 'nonsense', 'X', '2026-09-14T21:00:00.000Z')`,
            )).rejects.toThrow();

            // The index the rebuild dropped and recreated is back.
            const indexes = await client.execute('PRAGMA index_list(signatures)');
            expect(indexes.rows.map((r) => r.name)).toContain('signatures_project_idx');

            // And the id sequence continues rather than restarting at 1.
            const ids = await client.execute('SELECT id FROM signatures ORDER BY id');
            expect(ids.rows.map((r) => Number(r.id))).toEqual([1, 2]);
        } finally {
            client.close();
            await removeDir(dir);
        }
    });
});

describe('0028 collapses five project roles into three', () => {
    /* A CHECK constraint cannot be altered in SQLite, so this rebuilds the
       memberships table. That is the shape of migration that lost every
       packages row in 0009, and a lost membership is somebody who can no
       longer sign into their own project. */
    it('maps every old role onto a new one and keeps every row', async () => {
        const { dir, absolute } = tempDb('roles-');
        const client = createClient({ url: `file:${absolute}` });
        try {
            const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
            const runFile = async (tag) => {
                const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
                for (const stmt of sql.split('--> statement-breakpoint')) {
                    const trimmed = stmt.trim();
                    if (trimmed) await client.execute(trimmed);
                }
            };
            for (const tag of journal.entries.map((e) => e.tag).filter((t) => t < '0028')) await runFile(tag);

            await client.execute(
                `INSERT INTO users (username, password, name, role)
                 VALUES ('a','x','A','admin'), ('b','x','B','staff'), ('c','x','C','staff'),
                        ('d','x','D','driver'), ('e','x','E','staff')`,
            );
            // One membership of every role the old model had.
            await client.execute(
                `INSERT INTO memberships (user_id, project_id, role, settings)
                 VALUES (1, 2, 'admin', '{}'), (2, 2, 'ops_manager', '{}'), (3, 2, 'dispatcher', '{}'),
                        (4, 2, 'courier', '{"route":"north"}'), (5, 2, 'client_viewer', '{"siteIds":[2]}')`,
            );

            await runFile('0028_three_roles');

            const rows = (await client.execute('SELECT user_id, role, settings FROM memberships ORDER BY user_id')).rows;
            expect(rows).toHaveLength(5);
            expect(rows.map((r) => String(r.role))).toEqual(['admin', 'admin', 'admin', 'courier', 'pharmacy']);
            // Per-membership settings ride across the rebuild untouched.
            expect(String(rows[3].settings)).toBe('{"route":"north"}');
            expect(String(rows[4].settings)).toBe('{"siteIds":[2]}');

            // And the old values are refused from here on.
            await expect(client.execute(
                `INSERT INTO memberships (user_id, project_id, role) VALUES (1, 1, 'dispatcher')`,
            )).rejects.toThrow();
        } finally {
            client.close();
            await removeDir(dir);
        }
    });
});

describe('0026 moves a phone PIN off the user without locking the phone out', () => {
    /* Ticket 5.8. Until this migration the only copy of a phone's PIN was
       users.pin, shared with the legacy route PIN. Two things have to be true
       afterwards: a phone enrolled before it still signs in, and the copy
       that authenticated from any device is gone for anybody who has no route
       to authenticate on. */
    it('carries the PIN onto live devices and clears it from routeless users', async () => {
        const { dir, absolute } = tempDb('pin-split-');
        const client = createClient({ url: `file:${absolute}` });
        try {
            const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
            const runFile = async (tag) => {
                const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
                for (const stmt of sql.split('--> statement-breakpoint')) {
                    const trimmed = stmt.trim();
                    if (trimmed) await client.execute(trimmed);
                }
            };
            const tags = journal.entries.map((e) => e.tag);
            for (const tag of tags.filter((t) => t < '0026')) await runFile(tag);

            // The pre-5.8 world: the PIN on the user, and nowhere else.
            await client.execute(
                `INSERT INTO users (username, password, pin, name, role, route)
                 VALUES ('ada.courier', 'pw-hash', 'pin-hash-ada', 'Ada', 'driver', NULL),
                        ('north.driver', 'pw-hash', 'pin-hash-north', 'North', 'driver', 'northbound')`,
            );
            await client.execute(
                `INSERT INTO devices (id, user_id, label, user_agent, created_at, last_seen_at, revoked_at)
                 VALUES ('aaa', 1, 'her phone', '', '2026-01-01', '2026-01-01', NULL),
                        ('bbb', 2, 'the van', '', '2026-01-01', '2026-01-01', NULL),
                        ('ccc', 1, 'old phone', '', '2026-01-01', '2026-01-01', '2026-02-01')`,
            );
            expect(await columnNames(client, 'devices')).not.toContain('pin');

            await runFile('0026_device_pin');

            const devices = await client.execute('SELECT id, pin FROM devices ORDER BY id');
            const byId = Object.fromEntries(devices.rows.map((r) => [String(r.id), r.pin]));
            // Live phones keep the PIN they were enrolled with.
            expect(byId.aaa).toBe('pin-hash-ada');
            expect(byId.bbb).toBe('pin-hash-north');
            // A revoked phone is history and is not signing in again.
            expect(byId.ccc).toBeNull();

            const users = await client.execute('SELECT username, pin FROM users ORDER BY username');
            const byName = Object.fromEntries(users.rows.map((r) => [String(r.username), r.pin]));
            // No route, so users.pin could authenticate nothing: it is cleared.
            expect(byName['ada.courier']).toBeNull();
            // A route PIN is still a route PIN, and this is the only column for it.
            expect(byName['north.driver']).toBe('pin-hash-north');
        } finally {
            client.close();
            await removeDir(dir);
        }
    });
});
