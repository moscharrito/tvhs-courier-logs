/* Test harness: boots the real server.js in-process against a fresh SQLite
   file on a random port.

   Sequence mirrors src/index.ts: set the environment, run migrations through
   src/db/migrate.ts, then require server.js (which exports { app, ready, start }
   and only listens when run directly). Vitest runs each test file in its own
   process (pool: forks), so module state such as the in-memory PIN throttle
   and the libsql client is isolated per file. */

import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';
import { loadConfig } from '../../src/config.ts';
import { createDatabase } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { bootLegacy } from '../../src/legacy.ts';

export const SERVER_DIR = path.resolve(import.meta.dirname, '..', '..');

// Known credentials for the seeded accounts (see syncUsers in server.js).
export const CREDS = {
    admin: { username: 'admin', password: 'admin-pass-1' },
    // DRIVER1 is seeded as the southbound driver (Mohamed Djemai)
    south: { username: 'south.driver', password: 'south-pass-1', route: 'southbound', name: 'Mohamed Djemai' },
    // DRIVER2 is seeded as the northbound driver (Bereket Nigusse)
    north: { username: 'north.driver', password: 'north-pass-1', route: 'northbound', name: 'Bereket Nigusse' },
};

/** A fresh directory under test/.tmp and a DB_FILE value relative to server/. */
export function tempDb(prefix = 'run-') {
    // server.js does path.join(__dirname, DB_FILE), so DB_FILE must be relative
    // to the server dir (an absolute path would be appended, not replaced).
    const tmpRoot = path.join(SERVER_DIR, 'test', '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, prefix));
    const absolute = path.join(dir, 'test.db');
    return { dir, absolute, dbFile: path.relative(SERVER_DIR, absolute) };
}

let booted = null;

/**
 * Start an isolated server. Returns { url, agent(), login(who), stop(), creds }.
 * agent() gives a cookie-keeping supertest agent bound to the server URL.
 */
export async function startServer() {
    if (booted) throw new Error('startServer() called twice in one test file; server.js holds module-level state');

    const { dir, dbFile } = tempDb();

    // Environment must be set before server.js is required: it reads these at load.
    // Only the bootstrap admin comes from the environment; the drivers are
    // created through the users API below, the way an admin would.
    Object.assign(process.env, {
        DB_FILE: dbFile,
        TURSO_DATABASE_URL: '',          // force local file even if .env sets Turso
        TURSO_AUTH_TOKEN: '',
        APP_TIMEZONE: 'America/Chicago',
        SESSION_SECRET: 'test-session-secret',
        ADMIN_USER: CREDS.admin.username,
        ADMIN_PASS: CREDS.admin.password,
    });

    // Migrate, then boot the legacy app through the same wrapper as the entry
    // point (session middleware injected, core routers mounted). The core keeps
    // this database client for the life of the test file.
    const config = loadConfig();
    const database = createDatabase(config);
    await runMigrations(database);

    // Silence the boot log lines so test output stays readable.
    const origLog = console.log;
    console.log = () => { };
    let legacy, sessions;
    try {
        ({ legacy, sessions } = bootLegacy(config, database));
        await legacy.ready;
    } finally {
        console.log = origLog;
    }

    const httpServer = await new Promise((resolve, reject) => {
        const s = legacy.app.listen(0, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
    });
    const { port } = httpServer.address();
    const url = `http://127.0.0.1:${port}`;

    // Provision the two TVHS drivers as an admin would: create the user, then
    // give it a tvhs courier membership carrying its route.
    const admin = request.agent(url);
    const adminLogin = await admin.post('/api/login').send({ username: CREDS.admin.username, password: CREDS.admin.password });
    if (adminLogin.status !== 200) throw new Error(`bootstrap admin login failed: ${adminLogin.status} ${adminLogin.text}`);
    for (const who of ['south', 'north']) {
        const c = CREDS[who];
        const created = await admin.post('/api/users').send({ username: c.username, name: c.name, password: c.password, role: 'driver' });
        if (created.status !== 201) throw new Error(`creating ${who} failed: ${created.status} ${created.text}`);
        const member = await admin.put(`/api/users/${c.username}/memberships/tvhs`).send({ role: 'courier', settings: { route: c.route } });
        if (member.status !== 200) throw new Error(`membership for ${who} failed: ${member.status} ${member.text}`);
    }
    await admin.post('/api/logout');

    booted = {
        url,
        creds: CREDS,
        config,
        app: legacy.app,
        db: legacy.db,
        core: database,
        sessions,
        agent: () => request.agent(url),
        async login(who) {
            const a = request.agent(url);
            const res = await a.post('/api/login').send({ username: CREDS[who].username, password: CREDS[who].password });
            if (res.status !== 200) throw new Error(`login as ${who} failed: ${res.status} ${res.text}`);
            return a;
        },
        async stop() {
            await new Promise((resolve) => httpServer.close(resolve));
            try { legacy.db.close(); } catch (e) { /* ignore */ }
            try { database.client.close(); } catch (e) { /* ignore */ }
            await removeDir(dir);
            booted = null;
        },
    };
    return booted;
}

// On Windows the SQLite file can stay locked for a moment after close(), so
// retry the delete a few times. Whatever is left is removed by the global
// teardown (test/helpers/global-setup.mjs) once every worker has exited.
export async function removeDir(dir) {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

// Collect a binary response body (xlsx) into a Buffer.
export function binaryParser(res, cb) {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
}
