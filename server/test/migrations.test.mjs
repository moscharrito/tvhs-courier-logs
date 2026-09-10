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
const MIGRATION_TAGS = ['0000_baseline', '0001_projects', '0002_sessions', '0003_users', '0004_audit'];
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
            expect(await columnNames(database.client, 'memberships')).toEqual(['id', 'user_id', 'project_id', 'role', 'created_at', 'settings']);
            expect(await columnNames(database.client, 'sessions')).toEqual(['id', 'user_id', 'device', 'ip', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'revoked_at']);
            expect(await columnNames(database.client, 'audit_events')).toEqual(['id', 'at', 'project_id', 'user_id', 'username', 'action', 'entity', 'entity_id', 'ip', 'detail']);

            // Legacy inline UNIQUE constraints stay autoindexes; only the named indexes from later migrations exist.
            const idx = await database.client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name");
            expect(idx.rows.map((r) => r.name)).toEqual([
                'audit_events_at_idx', 'audit_events_entity_idx', 'audit_events_project_id_idx', 'audit_events_user_id_idx',
                'checkins_project_id_idx', 'logs_project_id_idx', 'memberships_project_id_idx', 'memberships_user_project_unique', 'projects_code_unique', 'sessions_user_id_idx',
            ]);
            const triggers = await database.client.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name");
            expect(triggers.rows.map((r) => r.name)).toEqual(['audit_events_no_delete', 'audit_events_no_update']);
            expect(await migrationRows(database.client)).toBe(MIGRATION_COUNT);

            // tvhs is seeded as project 1 so the project_id default points at it.
            const projects = (await database.client.execute('SELECT id, code, name, timezone, settings FROM projects')).rows.map((r) => ({ ...r }));
            expect(projects).toEqual([{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', settings: '{}' }]);
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
            expect(await count(database.client, 'projects')).toBe(1);
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
