/* Test harness: boots the real server.js as a child process against a fresh
   SQLite file on a free port. server.js is not modified for these tests; the
   process boundary is what isolates state (DB file, in-memory PIN throttle).
   Ticket 0.2 will switch this to an in-process app import. */

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const request = require('supertest');

const APP_DIR = path.resolve(__dirname, '..', '..');

// Known credentials for the seeded accounts (see syncUsers in server.js).
const CREDS = {
    admin: { username: 'admin', password: 'admin-pass-1' },
    // DRIVER1 is seeded as the southbound driver (Mohamed Djemai)
    south: { username: 'south.driver', password: 'south-pass-1', route: 'southbound', name: 'Mohamed Djemai' },
    // DRIVER2 is seeded as the northbound driver (Bereket Nigusse)
    north: { username: 'north.driver', password: 'north-pass-1', route: 'northbound', name: 'Bereket Nigusse' },
};

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

function waitFor(url, timeoutMs, child) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = async () => {
            if (child.exitCode !== null) return reject(new Error(`server exited early (code ${child.exitCode})\n${child.stderrText}`));
            try {
                const res = await fetch(url);
                if (res.ok) return resolve();
            } catch (e) { /* not up yet */ }
            if (Date.now() - started > timeoutMs) return reject(new Error(`server did not start within ${timeoutMs}ms\n${child.stderrText}`));
            setTimeout(tick, 100);
        };
        tick();
    });
}

/**
 * Start an isolated server. Returns { url, agent(), stop(), creds }.
 * agent() gives a cookie-keeping supertest agent bound to the server URL.
 */
async function startServer() {
    const port = await freePort();
    // server.js does path.join(__dirname, DB_FILE), so DB_FILE must be relative
    // to the app dir (an absolute path would be appended, not replaced).
    const tmpRoot = path.join(APP_DIR, 'test', '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
    const dbFile = path.relative(APP_DIR, path.join(dir, 'test.db'));

    const env = {
        ...process.env,
        PORT: String(port),
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
    };

    const child = spawn(process.execPath, ['server.js'], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderrText = '';
    child.stdout.on('data', () => { });
    child.stderr.on('data', (d) => { child.stderrText += d.toString(); });

    const url = `http://127.0.0.1:${port}`;
    await waitFor(`${url}/api/config`, 20000, child);

    return {
        url,
        creds: CREDS,
        agent: () => request.agent(url),
        async login(who) {
            const a = request.agent(url);
            const res = await a.post('/api/login').send({ username: CREDS[who].username, password: CREDS[who].password });
            if (res.status !== 200) throw new Error(`login as ${who} failed: ${res.status} ${res.text}`);
            return a;
        },
        async stop() {
            await new Promise((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once('exit', resolve);
                child.kill();
            });
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        },
    };
}

// Collect a binary response body (xlsx) into a Buffer.
function binaryParser(res, cb) {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
}

module.exports = { startServer, binaryParser, CREDS };
