/* Test harness: boots the real server.js in-process against a fresh SQLite
   file on a random port.

   server.js exports { app, ready, start } and only listens when run directly,
   so requiring it here gives us the app without a listener. Vitest runs each
   test file in its own process (pool: forks), so module state such as the
   in-memory PIN throttle and the libsql client is isolated per file. */

const path = require('path');
const fs = require('fs');
const request = require('supertest');

const SERVER_DIR = path.resolve(__dirname, '..', '..');

// Known credentials for the seeded accounts (see syncUsers in server.js).
const CREDS = {
    admin: { username: 'admin', password: 'admin-pass-1' },
    // DRIVER1 is seeded as the southbound driver (Mohamed Djemai)
    south: { username: 'south.driver', password: 'south-pass-1', route: 'southbound', name: 'Mohamed Djemai' },
    // DRIVER2 is seeded as the northbound driver (Bereket Nigusse)
    north: { username: 'north.driver', password: 'north-pass-1', route: 'northbound', name: 'Bereket Nigusse' },
};

let booted = null;

/**
 * Start an isolated server. Returns { url, agent(), login(who), stop(), creds }.
 * agent() gives a cookie-keeping supertest agent bound to the server URL.
 */
async function startServer() {
    if (booted) throw new Error('startServer() called twice in one test file; server.js holds module-level state');

    // server.js does path.join(__dirname, DB_FILE), so DB_FILE must be relative
    // to the server dir (an absolute path would be appended, not replaced).
    const tmpRoot = path.join(SERVER_DIR, 'test', '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    sweepStaleRuns(tmpRoot);
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
    const dbFile = path.relative(SERVER_DIR, path.join(dir, 'test.db'));

    // Environment must be set before server.js is required: it reads these at load.
    Object.assign(process.env, {
        DB_FILE: dbFile,
        TURSO_DATABASE_URL: '',          // force local file even if .env sets Turso
        TURSO_AUTH_TOKEN: '',
        APP_TIMEZONE: 'America/Chicago',
        SESSION_SECRET: 'test-session-secret',
        ADMIN_USER: CREDS.admin.username,
        ADMIN_PASS: CREDS.admin.password,
        DRIVER1_USER: CREDS.south.username,
        DRIVER1_PASS: CREDS.south.password,
        DRIVER2_USER: CREDS.north.username,
        DRIVER2_PASS: CREDS.north.password,
    });

    // Silence the boot log lines so test output stays readable.
    const origLog = console.log;
    console.log = () => { };
    let legacy;
    try {
        legacy = require(path.join(SERVER_DIR, 'server.js'));
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

    booted = {
        url,
        creds: CREDS,
        app: legacy.app,
        db: legacy.db,
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
            await removeDir(dir);
            booted = null;
        },
    };
    return booted;
}

// On Windows the SQLite file can stay locked for a moment after close(), so
// retry the delete a few times before giving up. Anything left behind is
// swept by the next run (test/.tmp is gitignored).
async function removeDir(dir) {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

// Only runs older than 10 minutes are swept, so a parallel test file's live
// database is never touched.
function sweepStaleRuns(tmpRoot) {
    let entries = [];
    try { entries = fs.readdirSync(tmpRoot); } catch (e) { return; }
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const name of entries) {
        if (!name.startsWith('run-')) continue;
        const full = path.join(tmpRoot, name);
        try {
            if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
        } catch (e) { /* ignore */ }
    }
}

// Collect a binary response body (xlsx) into a Buffer.
function binaryParser(res, cb) {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
}

module.exports = { startServer, binaryParser, CREDS };
