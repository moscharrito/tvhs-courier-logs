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

const norm = (s) => String(s).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

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
        expect(journal.entries.map((e) => e.tag)).toEqual(['0000_baseline']);
        expect(fs.existsSync(path.join(MIGRATIONS_FOLDER, '0000_baseline.sql'))).toBe(true);
    });
});

describe('fresh database', () => {
    it('creates the three legacy tables exactly and records the baseline', async () => {
        const { absolute } = freshDb();
        const database = createDatabase({ db: { url: `file:${absolute}`, authToken: undefined, kind: 'file' } });
        try {
            const result = await runMigrations(database);
            expect(result.preBaseline).toEqual([]);
            expect(result.appliedCount).toBe(1);

            for (const t of ['users', 'logs', 'checkins']) {
                expect(norm(await tableSql(database.client, t))).toBe(norm(LEGACY_SQL[t]));
            }
            // Inline UNIQUE constraints become autoindexes; no extra named indexes.
            const idx = await database.client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'");
            expect(idx.rows).toHaveLength(0);
            expect(await migrationRows(database.client)).toBe(1);
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
            expect(again.appliedCount).toBe(1);
            expect(await migrationRows(database.client)).toBe(1);
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
            expect(result.appliedCount).toBe(1);
            for (const t of ['users', 'logs', 'checkins']) {
                expect(await tableSql(database.client, t)).toBe(before[t]);
            }
            expect(await count(database.client, 'users')).toBe(1);
            expect(await count(database.client, 'logs')).toBe(1);
            expect(await count(database.client, 'checkins')).toBe(1);
            const log = (await database.client.execute('SELECT * FROM logs')).rows[0];
            expect(log.miles).toBe(122.6);
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
            expect(result.appliedCount).toBe(1);

            expect(await columnNames(database.client, 'users')).toContain('pin');
            const logCols = await columnNames(database.client, 'logs');
            expect(logCols).toContain('leg_from');
            expect(logCols).toContain('leg_to');

            const log = (await database.client.execute('SELECT * FROM logs')).rows[0];
            expect(log).toMatchObject({ username: 'd2', date: '2026-01-06', start_time: '05:00', end_time: '06:30', sterile: 4, miles: 80, leg_from: '', leg_to: '' });

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
            expect(result.appliedCount).toBe(1);
            for (const t of ['users', 'logs', 'checkins']) {
                expect(await count(database.client, t)).toBe(before[t].rows);
                expect(await columnNames(database.client, t)).toEqual(before[t].cols);
                expect(await tableSql(database.client, t)).toBe(before[t].sql);
            }
            const usersAfter = (await database.client.execute('SELECT username, name, role, route, pin FROM users ORDER BY id')).rows;
            expect(usersAfter).toEqual(usersBefore);
        } finally {
            database.client.close();
        }
    });
});
