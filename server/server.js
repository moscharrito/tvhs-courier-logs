/* ============================================
   TVHS RMD Courier Log System — Backend Server
   Express + libSQL (Turso / SQLite) + Session Auth
   ============================================ */

const express = require('express');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const path = require('path');
const bridge = require('./legacy-bridge');

// Environment loading and validation live in src/index.ts (dotenv outside
// production, then loadConfig()). This file expects process.env to be ready.

const app = express();
const PORT = process.env.PORT || 3000;

/* Do not advertise the framework. It tells an attacker which CVE list to read
 * and tells a legitimate caller nothing at all. */
app.disable('x-powered-by');

/* Behind Render's proxy, exactly one hop. Without this every audit row records
 * the proxy's address instead of the courier's, and every per-address throttle
 * counts the whole internet as one caller. `true` is not the safe default here:
 * it would trust an X-Forwarded-For header sent by anyone, so a number is used
 * and it is set from the environment (src/core/http/security.ts explains the
 * rest of the hardening). */
const trustProxy = bridge.has('trustProxy') ? bridge.get('trustProxy') : 0;
if (trustProxy) app.set('trust proxy', trustProxy);

// Response headers (src/core/http/security.ts): CSP, HSTS, nosniff and the
// rest. First, so they are on every response including static files and 404s.
app.use(bridge.get('securityHeaders'));

// ---- Database (libSQL) ----
// In production set TURSO_DATABASE_URL (libsql://...) + TURSO_AUTH_TOKEN so data
// persists in Turso — required on hosts with an ephemeral disk (e.g. Render free).
// With no URL set, it falls back to a local SQLite file for development.
const dbUrl = process.env.TURSO_DATABASE_URL
    || `file:${path.join(__dirname, process.env.DB_FILE || 'courier_logs.db')}`;
const db = createClient({
    url: dbUrl,
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: 'number' // ids/counts as JS numbers (JSON-safe)
});

// Small async query helpers returning plain objects (safe for res.json + field access)
async function dbAll(sql, args = []) {
    const rs = await db.execute({ sql, args });
    return rs.rows.map(row => {
        const o = {};
        for (const c of rs.columns) o[c] = row[c];
        return o;
    });
}
async function dbGet(sql, args = []) {
    return (await dbAll(sql, args))[0];
}
async function dbRun(sql, args = []) {
    return db.execute({ sql, args });
}

// Schema is owned by versioned migrations (server/drizzle, applied by
// src/db/migrate.ts before this file is required). See src/db/schema/tvhs.ts.

// ---- Bootstrap admin ----
// Users are managed in-app (src/core/users/routes.ts). The environment only
// matters on a database with no admin yet: ADMIN_USER / ADMIN_PASS create the
// first one. After that, env changes do nothing; use the users API. Drivers
// are no longer seeded or renamed from the environment.
async function bootstrapAdmin() {
    const adminRow = await dbGet("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!adminRow) {
        const username = String(process.env.ADMIN_USER || 'admin').toLowerCase().trim();
        const password = process.env.ADMIN_PASS;
        if (!password) throw new Error('No admin user exists and ADMIN_PASS is not set. Set ADMIN_USER and ADMIN_PASS for the first boot.');
        await dbRun("INSERT INTO users (username, password, name, role, status) VALUES (?, ?, 'Administrator', 'admin', 'active')",
            [username, bcrypt.hashSync(password, 10)]);
        console.log(`Bootstrap admin created: ${username}`);
    }

    // Platform admins are admins of every project; legacy driver rows are
    // tvhs couriers. Idempotent (unique user + project). Other users get
    // memberships via the users API.
    await dbRun(`
        INSERT OR IGNORE INTO memberships (user_id, project_id, role, settings)
        SELECT u.id, p.id, 'admin', '{}'
        FROM users u, projects p
        WHERE u.role = 'admin'
    `);
    await dbRun(`
        INSERT OR IGNORE INTO memberships (user_id, project_id, role, settings)
        SELECT u.id, p.id, 'courier',
               CASE WHEN u.route IS NOT NULL THEN json_object('route', u.route) ELSE '{}' END
        FROM users u, projects p
        WHERE p.code = ? AND u.role = 'driver'
    `, [TVHS_PROJECT_CODE]);
}

// ---- Middleware ----
// Request id + structured request log (src/core/http/request.ts). First, so
// every later line and error carries the id.
app.use(bridge.get('requestMiddleware'));
app.use(express.json());
// The legacy TVHS frontend now lives under /legacy; the platform shell
// (web/dist, mounted by src/legacy.ts) owns /. The shell loads these files
// into its TVHS screen, so drivers still see the same app.
app.use('/legacy', express.static(path.join(__dirname, 'public')));
// Server-side sessions (src/core/auth/sessions.ts), injected by src/legacy.ts.
// The middleware sets req.session = { id, user } from the izy_sid cookie and
// req.sessions = { create(user), destroy() } for login and logout. Sessions
// survive restarts and deploys because they live in the database, and an
// admin can revoke any device.
app.use(bridge.get('sessionMiddleware'));
// Audit trail (src/core/audit/audit.ts): req.audit(action, entity, id, detail)
// records who did what, stamped with actor, project and IP. Append-only.
app.use(bridge.get('auditMiddleware'));
/* Two-factor enforcement (src/core/auth/mfa.ts, ticket 4.3). Here, before any
 * route in either half of the application: a staff session that owes a second
 * factor may reach the enrolment endpoints and nothing else. Enforcement that
 * covered only the routes mounted after it would be a gate with a path round
 * the side, and the first version of this was exactly that. */
app.use(bridge.get('mfaEnforcement'));

// Operating timezone — pinned in config so check-in dates don't depend on the host clock.
// Override with APP_TIMEZONE (e.g. "America/New_York") in the environment / .env if needed.
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Chicago';

// Calendar date (YYYY-MM-DD) in the app's timezone — en-CA formats as YYYY-MM-DD.
function localDate(d = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(d);
    } catch (e) {
        // Fallback to host-local date if the timezone id is invalid
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
}

// Auth middleware
function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ---- Projects ----
// Every project-scoped route lives under /api/projects/:pid/... where :pid is
// the project code (tvhs) or numeric id. The caller must be a member of that
// project; the project and membership are attached to the request.
const TVHS_PROJECT_CODE = 'tvhs';

async function findProject(pid) {
    const byId = /^\d+$/.test(String(pid));
    return dbGet(
        `SELECT id, code, name, timezone, settings FROM projects WHERE ${byId ? 'id = ?' : 'code = ?'}`,
        [byId ? Number(pid) : String(pid).toLowerCase()]
    );
}

async function requireProject(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

    const project = await findProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const membership = await dbGet(`
        SELECT m.role FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE u.username = ? AND m.project_id = ?
    `, [req.session.user.username, project.id]);
    if (!membership) return res.status(403).json({ error: 'Not a member of this project' });

    let settings = {};
    try { settings = JSON.parse(project.settings || '{}'); } catch (e) { /* keep {} */ }
    req.project = { id: project.id, code: project.code, name: project.name, timezone: project.timezone, settings };
    req.membership = { role: membership.role };
    next();
}

// Projects the caller belongs to, with their role in each. Drives the
// project switcher in the frontend shell.
app.get('/api/me/projects', requireAuth, async (req, res) => {
    const rows = await dbAll(`
        SELECT p.id, p.code, p.name, p.timezone, m.role
        FROM memberships m
        JOIN users u ON u.id = m.user_id
        JOIN projects p ON p.id = m.project_id
        WHERE u.username = ?
        ORDER BY p.name
    `, [req.session.user.username]);
    res.json(rows);
});

// One project, for members only.
app.get('/api/projects/:pid', requireProject, (req, res) => {
    res.json({ ...req.project, role: req.membership.role });
});

// The TVHS module router. Handlers below register on it with paths relative
// to /api/projects/:pid/tvhs; mergeParams exposes :pid to them.
const tvhs = express.Router({ mergeParams: true });
app.use('/api/projects/:pid/tvhs', requireProject, tvhs);

// Old un-scoped paths redirect to the tvhs project for one release. 308 keeps
// the method and body, so POST/DELETE callers land on the new path intact.
app.use(/^\/api\/(routes|checkin|checkins|logs|admin)(\/.*)?$/, (req, res) => {
    const target = `/api/projects/${TVHS_PROJECT_CODE}/tvhs${req.originalUrl.slice('/api'.length)}`;
    res.redirect(308, target);
});

// ---- Route Definitions ----
const ROUTES = {
    northbound: {
        label: 'NorthBound',
        legs: [
            { from: 'Murfreesboro', to: 'Clarksville', defaultMiles: 80 },
            { from: 'Clarksville', to: 'Fort Campbell', defaultMiles: 15 },
            { from: 'Fort Campbell', to: 'Clarksville', defaultMiles: 15 },
            { from: 'Clarksville', to: 'Murfreesboro', defaultMiles: 80 },
            { from: 'Nashville', to: 'Murfreesboro', defaultMiles: 35 },
            { from: 'Murfreesboro', to: 'Nashville', defaultMiles: 35 },
        ]
    },
    southbound: {
        label: 'SouthBound',
        legs: [
            { from: 'Murfreesboro', to: 'Chattanooga', defaultMiles: 122.6 },
            { from: 'Chattanooga', to: 'Murfreesboro', defaultMiles: 123.0 },
            { from: 'Murfreesboro', to: 'Chattanooga', defaultMiles: 122.6 },
            { from: 'Chattanooga', to: 'Murfreesboro', defaultMiles: 123.0 },
        ]
    }
};

// A day's rows for a driver: the route's standard legs (in schedule order),
// followed by any extra legs the driver added for that day. Extra legs are
// stored at leg_index >= legs.length and carry their own from/to labels.
function dayRows(routeDef, dayLogs) {
    const values = (log) => ({
        startTime: log ? (log.start_time || '') : '',
        endTime: log ? (log.end_time || '') : '',
        sterile: log ? (log.sterile || 0) : 0,
        soiled: log ? (log.soiled || 0) : 0,
        miles: log ? (log.miles || 0) : 0
    });

    const rows = routeDef.legs.map((leg, i) => ({
        label: `${leg.from} to ${leg.to}`,
        ...values(dayLogs.find(l => l.leg_index === i))
    }));

    dayLogs
        .filter(l => l.leg_index >= routeDef.legs.length)
        .sort((a, b) => a.leg_index - b.leg_index)
        .forEach(l => rows.push({
            label: `${l.leg_from || '—'} to ${l.leg_to || '—'} (Extra)`,
            ...values(l)
        }));

    return rows;
}

// ---- API Routes ----

// Open a server-side session for the authenticated user (sets the cookie) and
// return the public profile.
async function loginSession(req, user) {
    await req.sessions.create({ id: user.id, username: user.username, name: user.name, role: user.role, route: user.route });
    const method = req.path === '/api/login' ? 'password'
        : req.path === '/api/login/mfa' ? 'password_and_code'
            : req.path === '/api/login/pin' ? 'pin' : 'pin_setup';
    await req.audit('auth.login', 'user', user.username, { method, role: user.role });
    return req.session.user;
}

/* Failed-attempt throttling (src/core/auth/throttle.ts), shared with the
 * enrolled-device endpoints so a guesser cannot get a fresh allowance by
 * moving between them. This file used to keep its own copy for PIN attempts
 * and none at all for passwords. */
const throttles = bridge.get('authThrottles');
const tooManyAttempts = bridge.get('tooManyAttempts');
/* The second factor (src/core/auth/mfa.ts, ticket 4.3). The password step
 * lives in this file, so this is where a challenge is opened. */
const mfaChallenges = bridge.get('mfaChallenges');
const mfaFactsFor = bridge.get('mfaFactsFor');
const mfaEnforced = bridge.get('mfaEnforced');

/** Refuse a caller who has spent their attempts. Returns true when handled. */
async function throttled(req, res, guard, identity, alternative, detail) {
    const wait = guard.check(req.ip, identity);
    if (!wait) return false;
    await req.audit('auth.throttled', 'user', String(identity).slice(0, 120), detail);
    res.set('Retry-After', String(wait.retryAfterSeconds));
    res.status(429).json(tooManyAttempts(wait.retryAfterSeconds, alternative));
    return true;
}

// Auth — username + password (admin, and a fallback for drivers)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const name = String(username).toLowerCase().trim();

    /* Checked before the password is, so a throttled caller costs one map
       lookup rather than a bcrypt comparison. bcrypt is deliberately slow;
       answering unlimited guesses with it is its own denial of service. */
    if (await throttled(req, res, throttles.password, name, 'ask an administrator to reset your password', { method: 'password' })) return;

    const user = await dbGet('SELECT * FROM users WHERE username = ?', [name]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        throttles.password.fail(req.ip, name);
        await req.audit('auth.login_failed', 'user', name.slice(0, 120), { method: 'password', reason: user ? 'bad_password' : 'no_such_user' });
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.status !== 'active') {
        await req.audit('auth.login_failed', 'user', user.username, { method: 'password', reason: 'disabled' });
        return res.status(403).json({ error: 'Account disabled' });
    }

    throttles.password.reset(req.ip, name);

    /* A password alone is not a session for anybody who holds a second
       factor. The reply carries a challenge token instead: short-lived,
       server-side, and useless without the code (ticket 4.3). */
    const facts = await mfaFactsFor(user.id, user.role);
    if (facts.confirmed) {
        const challenge = await mfaChallenges.open(user.id);
        await req.audit('auth.mfa_challenged', 'user', user.username, { method: 'password' });
        return res.json({
            mfaRequired: true,
            challengeToken: challenge.token,
            expiresAt: challenge.expiresAt.toISOString(),
        });
    }

    res.json(await loginSession(req, user));
});

/* The second step. The challenge token stands in for the password that has
 * already been checked, so this endpoint never sees one.
 *
 * A recovery code is accepted here too, in the same field. Asking a person
 * whose phone is in a taxi to find a different form is how they end up
 * telephoning an administrator instead, and the server can tell the two
 * apart without being told. */
app.post('/api/login/mfa', async (req, res) => {
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !code) return res.status(400).json({ error: 'Challenge and code required' });

    /* No separate throttle here. The challenge counts its own attempts and
       tears itself up after five, which is the same control keyed to the
       thing that actually matters, and opening a fresh challenge costs a
       password that is throttled in its own right. Two counters over one
       action would only mean the coarser one fired first and hid the other. */
    const result = await mfaChallenges.answer(String(challengeToken), String(code));
    if (!result.ok) {
        await req.audit('auth.login_failed', 'user', '', { method: 'mfa', reason: result.reason });
        if (result.reason === 'expired' || result.reason === 'exhausted' || result.reason === 'unknown') {
            return res.status(401).json({
                error: 'That sign-in attempt has expired. Start again.',
                code: 'mfa.challenge_expired',
            });
        }
        return res.status(401).json({ error: 'That code is not right.' });
    }

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [result.userId]);
    if (!user || user.status !== 'active') {
        await req.audit('auth.login_failed', 'user', user ? user.username : '', { method: 'mfa', reason: 'disabled' });
        return res.status(403).json({ error: 'Account disabled' });
    }

    const session = await loginSession(req, user);
    /* Spending a recovery code is worth saying out loud: it usually means a
       lost phone, and it is also what an attacker who stole the printout
       would do. */
    if (result.usedRecoveryCode) {
        await req.audit('mfa.recovery_code_used', 'user', user.username, { remaining: result.recoveryCodesRemaining });
    }
    res.json({
        ...session,
        usedRecoveryCode: result.usedRecoveryCode,
        recoveryCodesRemaining: result.recoveryCodesRemaining,
    });
});

// Public: driver roster for the quick-login picker (no secrets; identifies
// drivers by route so personal emails aren't exposed publicly).
app.get('/api/drivers/list', async (req, res) => {
    // Scoped to one project when ?project= is given, so the sign-in page only
    // ever lists the couriers of the project being signed in to. Without it,
    // the legacy behaviour (every active TVHS driver) is kept for the old app.
    const code = req.query.project;
    const drivers = code
        ? await dbAll(`
            SELECT u.name, u.route, u.pin FROM users u
            JOIN memberships m ON m.user_id = u.id
            JOIN projects p ON p.id = m.project_id
            WHERE u.role = 'driver' AND u.status = 'active' AND u.route IS NOT NULL
              AND m.role = 'courier' AND p.code = ?
            ORDER BY u.name`, [String(code).toLowerCase()])
        : await dbAll("SELECT name, route, pin FROM users WHERE role = 'driver' AND status = 'active' AND route IS NOT NULL ORDER BY name");
    res.json(drivers.map(d => ({ route: d.route, name: d.name, hasPin: !!d.pin })));
});

// Public: the projects a person can sign in to, names only. The sign-in page
// asks which project first, then shows that project's couriers. No membership
// or user data is exposed here.
app.get('/api/login/projects', async (req, res) => {
    res.json(await dbAll('SELECT code, name FROM projects ORDER BY name'));
});

// Driver quick login with PIN
app.post('/api/login/pin', async (req, res) => {
    const { route, pin } = req.body;
    if (!route || !pin) return res.status(400).json({ error: 'Route and PIN required' });
    if (await throttled(req, res, throttles.pin, `route:${route}`, 'sign in with your password', { method: 'pin' })) return;

    const user = await dbGet("SELECT * FROM users WHERE role = 'driver' AND status = 'active' AND route = ?", [route]);
    if (!user || !user.pin || !bcrypt.compareSync(String(pin), user.pin)) {
        throttles.pin.fail(req.ip, `route:${route}`);
        await req.audit('auth.login_failed', 'route', String(route).slice(0, 40), { method: 'pin', reason: !user ? 'no_driver' : !user.pin ? 'no_pin' : 'bad_pin' });
        return res.status(401).json({ error: 'Incorrect PIN' });
    }
    throttles.pin.reset(req.ip, `route:${route}`);
    res.json(await loginSession(req, user));
});

// Driver first-time PIN setup / reset — gated by the driver's password
app.post('/api/login/pin/setup', async (req, res) => {
    const { route, password, pin } = req.body;
    if (!route || !password || !pin) return res.status(400).json({ error: 'Route, password and PIN required' });
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });

    /* This checks a password, so it is a password endpoint and is throttled
       like one. Without that it was a second, unlimited oracle for exactly the
       credential /api/login protects (ticket 4.2). */
    if (await throttled(req, res, throttles.password, `route:${route}`, 'ask an administrator to reset your password', { method: 'pin_setup' })) return;

    const user = await dbGet("SELECT * FROM users WHERE role = 'driver' AND status = 'active' AND route = ?", [route]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        throttles.password.fail(req.ip, `route:${route}`);
        await req.audit('auth.login_failed', 'route', String(route).slice(0, 40), { method: 'pin_setup', reason: user ? 'bad_password' : 'no_driver' });
        return res.status(401).json({ error: 'Incorrect password' });
    }
    await dbRun('UPDATE users SET pin = ? WHERE username = ?', [bcrypt.hashSync(String(pin), 10), user.username]);
    throttles.password.reset(req.ip, `route:${route}`);
    throttles.pin.reset(req.ip, `route:${route}`);
    res.json(await loginSession(req, user));
});

app.post('/api/logout', async (req, res) => {
    if (req.session.user) await req.audit('auth.logout', 'user', req.session.user.username);
    await req.sessions.destroy();
    res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
    if (req.session.user) {
        /* mfa comes from the session middleware, which reads it alongside the
           session row. The shell uses it to send a staff member straight to
           the setup screen rather than into a wall of 403s (ticket 4.3). */
        const mfa = req.mfa ?? { required: false, confirmed: false };
        res.json({ ...req.session.user, mfa: { ...mfa, enforced: mfaEnforced && mfa.required } });
    } else {
        res.status(401).json({ error: 'No session' });
    }
});

// Route definitions
tvhs.get('/routes', requireAuth, (req, res) => {
    res.json(ROUTES);
});

// App config (timezone + server's current date) so the client displays times/dates
// consistently in the operating timezone regardless of the viewer's device clock.
app.get('/api/config', (req, res) => {
    res.json({ timezone: APP_TIMEZONE, today: localDate() });
});

// ---- Check-in / Clock-in ----

// Driver: check in (clock in) for the day. Idempotent — one check-in per driver per day.
// The "day" is the driver's own local date (sent by the client) so it matches what
// they see on their device; falls back to the server's date if none/invalid is sent.
tvhs.post('/checkin', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can check in' });

    const bodyDate = req.body && req.body.date;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? bodyDate : localDate();
    const existing = await dbGet('SELECT checkin_at FROM checkins WHERE project_id = ? AND username = ? AND date = ?', [req.project.id, user.username, date]);
    if (existing) {
        return res.json({ checkedIn: true, checkin_at: existing.checkin_at, date, alreadyCheckedIn: true });
    }

    const checkinAt = new Date().toISOString();
    await dbRun('INSERT INTO checkins (project_id, username, date, checkin_at) VALUES (?, ?, ?, ?)', [req.project.id, user.username, date, checkinAt]);
    await req.audit('checkin.create', 'checkin', `${user.username}:${date}`, { date });
    res.json({ checkedIn: true, checkin_at: checkinAt, date });
});

// Driver: own check-in status for a date (defaults to today)
tvhs.get('/checkin', requireAuth, async (req, res) => {
    const user = req.session.user;
    const date = req.query.date || localDate();
    const row = await dbGet('SELECT checkin_at FROM checkins WHERE project_id = ? AND username = ? AND date = ?', [req.project.id, user.username, date]);
    res.json({ checkedIn: !!row, checkin_at: row ? row.checkin_at : null, date });
});

// Driver: own check-in history within a date range
tvhs.get('/checkins/history', requireAuth, async (req, res) => {
    const user = req.session.user;
    const { startDate, endDate } = req.query;

    let query = 'SELECT date, checkin_at FROM checkins WHERE project_id = ? AND username = ?';
    const params = [req.project.id, user.username];
    if (startDate) { query += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND date <= ?'; params.push(endDate); }
    query += ' ORDER BY date ASC';

    res.json(await dbAll(query, params));
});

// Admin: check-in roster for all drivers on a given date (defaults to today)
tvhs.get('/admin/checkins', requireAdmin, async (req, res) => {
    const date = req.query.date || localDate();
    const drivers = await dbAll(`
        SELECT u.username, u.name, u.route FROM users u
        JOIN memberships m ON m.user_id = u.id
        WHERE u.role = 'driver' AND m.project_id = ?
        ORDER BY u.name
    `, [req.project.id]);
    const rows = await dbAll('SELECT username, checkin_at FROM checkins WHERE project_id = ? AND date = ?', [req.project.id, date]);
    const byUser = {};
    rows.forEach(r => { byUser[r.username] = r.checkin_at; });

    const roster = drivers.map(d => ({
        username: d.username,
        name: d.name,
        route: d.route,
        checkedIn: !!byUser[d.username],
        checkin_at: byUser[d.username] || null
    }));
    res.json({ date, drivers: roster });
});

// Admin: check-in history with driver + date-range filters
tvhs.get('/admin/checkins/history', requireAdmin, async (req, res) => {
    const { driver, route, startDate, endDate } = req.query;

    let query = `
        SELECT c.username, c.date, c.checkin_at, u.name as driver_name, u.route as driver_route
        FROM checkins c
        JOIN users u ON c.username = u.username
        WHERE u.role = 'driver' AND c.project_id = ?
    `;
    const params = [req.project.id];

    if (driver && driver !== 'all') { query += ' AND c.username = ?'; params.push(driver); }
    if (route && route !== 'all') { query += ' AND u.route = ?'; params.push(route); }
    if (startDate) { query += ' AND c.date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND c.date <= ?'; params.push(endDate); }

    query += ' ORDER BY u.name, c.date ASC';
    res.json(await dbAll(query, params));
});

// Get logs for a specific user and date range
tvhs.get('/logs', requireAuth, async (req, res) => {
    const { username, startDate, endDate } = req.query;
    const user = req.session.user;

    // Drivers can only see their own logs
    const targetUser = (user.role === 'admin' && username) ? username : user.username;
    // An admin reading one specific driver's data is recorded; self reads are not.
    if (targetUser !== user.username) {
        await req.audit('logs.read', 'user', targetUser, { startDate: startDate || null, endDate: endDate || null });
    }

    let query = 'SELECT * FROM logs WHERE project_id = ? AND username = ?';
    const params = [req.project.id, targetUser];

    if (startDate) {
        query += ' AND date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND date <= ?';
        params.push(endDate);
    }

    query += ' ORDER BY date ASC, leg_index ASC';
    res.json(await dbAll(query, params));
});

// Save/update logs for a day
tvhs.post('/logs', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can submit logs' });

    const { date, legs } = req.body;
    if (!date || !Array.isArray(legs)) return res.status(400).json({ error: 'date and legs array required' });

    const sql = `
        INSERT INTO logs (project_id, username, date, leg_index, leg_from, leg_to, start_time, end_time, sterile, soiled, miles, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username, date, leg_index)
        DO UPDATE SET leg_from=excluded.leg_from, leg_to=excluded.leg_to,
                      start_time=excluded.start_time, end_time=excluded.end_time,
                      sterile=excluded.sterile, soiled=excluded.soiled,
                      miles=excluded.miles, updated_at=CURRENT_TIMESTAMP
    `;

    const label = (v) => String(v || '').trim().slice(0, 60);

    const stmts = legs.map((leg, i) => ({
        sql,
        args: [
            req.project.id,
            user.username,
            date,
            i,
            label(leg.legFrom),
            label(leg.legTo),
            leg.startTime || '',
            leg.endTime || '',
            parseInt(leg.sterile) || 0,
            parseInt(leg.soiled) || 0,
            parseFloat(leg.miles) || 0
        ]
    }));

    // Drop any extra legs the driver removed since the last save (rows beyond
    // the submitted list), so deletions actually stick.
    stmts.push({
        sql: 'DELETE FROM logs WHERE project_id = ? AND username = ? AND date = ? AND leg_index >= ?',
        args: [req.project.id, user.username, date, legs.length]
    });

    await db.batch(stmts, 'write');
    await req.audit('logs.save', 'logs', `${user.username}:${date}`, { date, legs: legs.length });
    res.json({ ok: true });
});

// Clear logs for a specific day
tvhs.delete('/logs', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can modify logs' });

    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });

    await dbRun('DELETE FROM logs WHERE project_id = ? AND username = ? AND date = ?', [req.project.id, user.username, date]);
    await req.audit('logs.clear', 'logs', `${user.username}:${date}`, { date });
    res.json({ ok: true });
});

// Admin: get all logs with filters
tvhs.get('/admin/logs', requireAdmin, async (req, res) => {
    const { driver, route, startDate, endDate } = req.query;

    let query = `
        SELECT l.*, u.name as driver_name, u.route as driver_route
        FROM logs l
        JOIN users u ON l.username = u.username
        WHERE u.role = 'driver' AND l.project_id = ?
    `;
    const params = [req.project.id];

    if (driver && driver !== 'all') {
        query += ' AND l.username = ?';
        params.push(driver);
    }
    if (route && route !== 'all') {
        query += ' AND u.route = ?';
        params.push(route);
    }
    if (startDate) {
        query += ' AND l.date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND l.date <= ?';
        params.push(endDate);
    }

    query += ' ORDER BY l.date ASC, l.username, l.leg_index ASC';
    res.json(await dbAll(query, params));
});

// Admin: get stats
tvhs.get('/admin/stats', requireAdmin, async (req, res) => {
    const pid = req.project.id;
    const drivers = (await dbGet(`
        SELECT COUNT(*) as cnt FROM users u
        JOIN memberships m ON m.user_id = u.id
        WHERE u.role = 'driver' AND m.project_id = ?
    `, [pid])).cnt;
    const logDays = (await dbGet('SELECT COUNT(DISTINCT username || date) as cnt FROM logs WHERE project_id = ?', [pid])).cnt;
    const totals = await dbGet('SELECT COALESCE(SUM(miles),0) as miles, COALESCE(SUM(sterile + soiled),0) as totes FROM logs WHERE project_id = ?', [pid]);
    res.json({
        drivers,
        logEntries: logDays,
        totalMiles: totals.miles,
        totalTotes: totals.totes
    });
});

// Admin: get drivers list
tvhs.get('/admin/drivers', requireAdmin, async (req, res) => {
    const drivers = await dbAll(`
        SELECT u.username, u.name, u.route FROM users u
        JOIN memberships m ON m.user_id = u.id
        WHERE u.role = 'driver' AND m.project_id = ?
        ORDER BY u.name
    `, [req.project.id]);
    res.json(drivers);
});

// Admin: export Excel in original format
tvhs.get('/admin/export', requireAdmin, async (req, res) => {
    const ExcelJS = require('exceljs');
    const { driver, route, startDate, endDate } = req.query;

    // Get filtered logs grouped by driver
    let query = `
        SELECT l.*, u.name as driver_name, u.route as driver_route
        FROM logs l JOIN users u ON l.username = u.username
        WHERE u.role = 'driver' AND l.project_id = ?
    `;
    const params = [req.project.id];
    if (driver && driver !== 'all') { query += ' AND l.username = ?'; params.push(driver); }
    if (route && route !== 'all') { query += ' AND u.route = ?'; params.push(route); }
    if (startDate) { query += ' AND l.date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND l.date <= ?'; params.push(endDate); }
    query += ' ORDER BY l.username, l.date ASC, l.leg_index ASC';

    const logs = await dbAll(query, params);
    if (logs.length === 0) return res.status(404).json({ error: 'No data to export' });
    await req.audit('logs.export', 'logs', driver && driver !== 'all' ? driver : 'all', {
        driver: driver || 'all', route: route || 'all', startDate: startDate || null, endDate: endDate || null, rows: logs.length,
    });

    // Group by driver
    const byDriver = {};
    logs.forEach(log => {
        if (!byDriver[log.username]) byDriver[log.username] = { name: log.driver_name, route: log.driver_route, days: {} };
        if (!byDriver[log.username].days[log.date]) byDriver[log.username].days[log.date] = [];
        byDriver[log.username].days[log.date].push(log);
    });

    const wb = new ExcelJS.Workbook();

    // Style definitions
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F2937' } };
    const headerFont = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    const totalsFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F0FDF4' } };
    const totalsFont = { bold: true, size: 11 };
    const dayHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DCFCE7' } };
    const titleFont = { bold: true, size: 16, color: { argb: '14532D' } };
    const labelFont = { bold: true, size: 11 };
    const borderThin = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const [username, driverData] of Object.entries(byDriver)) {
        const routeDef = ROUTES[driverData.route];
        if (!routeDef) continue;

        const isNorth = driverData.route === 'northbound';
        const sheetTitle = isNorth ? 'Driver Log' : 'Driver Invoice';
        const ws = wb.addWorksheet(`${driverData.name}`);

        // Column widths
        ws.columns = [
            { width: 16 }, { width: 30 }, { width: 14 }, { width: 14 },
            { width: 14 }, { width: 14 }, { width: 16 }, { width: 12 }, { width: 12 }
        ];

        // Row 1: Title
        let r = 1;
        ws.getCell(`A${r}`).value = sheetTitle;
        ws.getCell(`A${r}`).font = titleFont;

        // Row 2: submit to
        r = 2;
        ws.getCell(`F${r}`).value = 'Submit to:';
        ws.getCell(`F${r}`).font = labelFont;

        // Row 3: Driver name + company
        r = 3;
        ws.getCell(`A${r}`).value = 'Driver Name:';
        ws.getCell(`A${r}`).font = labelFont;
        ws.getCell(`B${r}`).value = driverData.name;
        ws.getCell(`F${r}`).value = 'Izy Global Services LLC';
        ws.getCell(`F${r}`).font = labelFont;

        // Row 4: Date + address
        r = 4;
        ws.getCell(`A${r}`).value = isNorth ? 'Log Date:' : 'Invoice Date:';
        ws.getCell(`A${r}`).font = labelFont;
        const dates = Object.keys(driverData.days).sort();
        ws.getCell(`B${r}`).value = dates[dates.length - 1];
        ws.getCell(`F${r}`).value = '4869 Madyson Ridge Dr.';

        // Row 5: address cont
        r = 5;
        ws.getCell(`A${r}`).value = isNorth ? 'Log Number:' : 'Invoice Number:';
        ws.getCell(`A${r}`).font = labelFont;
        ws.getCell(`F${r}`).value = 'Fort Worth, TX 76133';

        // Row 6: phone/email
        r = 6;
        ws.getCell(`F${r}`).value = 'Phone: (713) 992-0481 | Email: freights@izymovers.com';

        // Row 8: Weekly totals (will fill later)
        r = 8;
        ws.getCell(`A${r}`).value = 'Total Weekly Miles:';
        ws.getCell(`A${r}`).font = labelFont;
        const weeklyMilesCell = `B${r}`;

        r = 9;
        ws.getCell(`A${r}`).value = 'Total Routes Completed:';
        ws.getCell(`A${r}`).font = labelFont;
        const weeklyRoutesCell = `B${r}`;

        // Build per-day blocks
        r = 11;
        let grandTotalMiles = 0;
        let grandTotalRoutes = 0;

        dates.forEach((dateStr, dateIdx) => {
            const dayLogs = driverData.days[dateStr];
            const dateObj = new Date(dateStr + 'T00:00:00');
            const dayName = DAY_NAMES[dateObj.getDay()];

            // Day header row
            r++;
            const headerRow = r;
            ['Date', 'Route Leg', 'Leg Start Time', 'Leg Completion', 'Sterile Transported', 'Soiled Transported', 'Total Totes Transported', 'Miles Driven'].forEach((h, ci) => {
                const cell = ws.getCell(r, ci + 1);
                cell.value = h;
                cell.fill = headerFill;
                cell.font = headerFont;
                cell.border = borderThin;
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            });

            // Route leg rows
            let dayMiles = 0, daySterile = 0, daySoiled = 0, dayTotes = 0, dayRoutes = 0;
            const firstDataRow = r + 1;

            dayRows(routeDef, dayLogs).forEach((row, legIdx) => {
                r++;
                const st = row.startTime;
                const et = row.endTime;
                const sterile = row.sterile;
                const soiled = row.soiled;
                const miles = row.miles;
                const totes = sterile + soiled;

                // Date column: day name on first row, date on second, blank on rest
                if (legIdx === 0) {
                    ws.getCell(r, 1).value = dayName;
                    ws.getCell(r, 1).font = labelFont;
                } else if (legIdx === 1) {
                    ws.getCell(r, 1).value = dateStr;
                }

                ws.getCell(r, 2).value = row.label;
                ws.getCell(r, 3).value = st;
                ws.getCell(r, 3).alignment = { horizontal: 'center' };
                ws.getCell(r, 4).value = et;
                ws.getCell(r, 4).alignment = { horizontal: 'center' };
                ws.getCell(r, 5).value = sterile;
                ws.getCell(r, 5).alignment = { horizontal: 'center' };
                ws.getCell(r, 6).value = soiled;
                ws.getCell(r, 6).alignment = { horizontal: 'center' };
                ws.getCell(r, 7).value = totes;
                ws.getCell(r, 7).alignment = { horizontal: 'center' };
                ws.getCell(r, 8).value = miles;
                ws.getCell(r, 8).alignment = { horizontal: 'center' };

                // Borders
                for (let ci = 1; ci <= 8; ci++) {
                    ws.getCell(r, ci).border = borderThin;
                }

                dayMiles += miles;
                daySterile += sterile;
                daySoiled += soiled;
                dayTotes += totes;
                if (st && et) dayRoutes++;
            });

            // Daily totals row
            r++;
            ws.getCell(r, 4).value = 'Daily Totals:';
            ws.getCell(r, 4).font = totalsFont;
            ws.getCell(r, 5).value = daySterile;
            ws.getCell(r, 6).value = daySoiled;
            ws.getCell(r, 7).value = dayTotes;
            ws.getCell(r, 8).value = dayMiles;
            ws.getCell(r, 9).value = dayMiles;
            for (let ci = 4; ci <= 9; ci++) {
                ws.getCell(r, ci).fill = totalsFill;
                ws.getCell(r, ci).font = totalsFont;
                ws.getCell(r, ci).border = borderThin;
                ws.getCell(r, ci).alignment = { horizontal: 'center' };
            }

            grandTotalMiles += dayMiles;
            grandTotalRoutes += dayRoutes;

            r++; // blank row between days
        });

        // Fill weekly totals
        ws.getCell(weeklyMilesCell).value = grandTotalMiles;
        ws.getCell(weeklyMilesCell).font = { bold: true, size: 12, color: { argb: '16A34A' } };
        ws.getCell(weeklyRoutesCell).value = grandTotalRoutes;
        ws.getCell(weeklyRoutesCell).font = { bold: true, size: 12, color: { argb: '16A34A' } };

        // Notes section
        r += 1;
        ws.getCell(`A${r}`).value = 'Notes:';
        ws.getCell(`A${r}`).font = labelFont;
        r++;
        ws.getCell(`A${r}`).value = '- Submit this invoice every Friday for the current week.';
        r++;
        ws.getCell(`A${r}`).value = '- Attach scanned BOLs or mileage logs as supporting documentation.';

        // Signature
        r += 2;
        ws.getCell(`A${r}`).value = 'Driver Signature';
        ws.getCell(`A${r}`).font = labelFont;
        ws.getCell(`B${r}`).value = driverData.name;
        ws.getCell(`E${r}`).value = 'Date:';
        ws.getCell(`E${r}`).font = labelFont;
        ws.getCell(`F${r}`).value = dates[dates.length - 1];
        ws.getCell(`I${r}`).value = grandTotalMiles;
        ws.getCell(`I${r}`).font = { bold: true, size: 12, color: { argb: '16A34A' } };
    }

    // Send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const fname = `TVHS_Courier_Logs_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
});

// Driver: export own logs in original format
tvhs.get('/logs/export', requireAuth, async (req, res) => {
    const ExcelJS = require('exceljs');
    const user = req.session.user;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const userInfo = await dbGet('SELECT * FROM users WHERE username = ?', [user.username]);
    if (!userInfo) return res.status(404).json({ error: 'User not found' });

    const logs = await dbAll('SELECT * FROM logs WHERE project_id = ? AND username = ? AND date >= ? AND date <= ? ORDER BY date ASC, leg_index ASC',
        [req.project.id, user.username, startDate, endDate]);

    if (logs.length === 0) return res.status(404).json({ error: 'No data to export' });
    await req.audit('logs.export_own', 'logs', user.username, { startDate, endDate, rows: logs.length });

    const routeDef = ROUTES[userInfo.route];
    if (!routeDef) return res.status(400).json({ error: 'Unknown route' });

    const isNorth = userInfo.route === 'northbound';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isNorth ? 'Driver Log' : 'Driver Invoice');

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F2937' } };
    const headerFont = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    const totalsFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F0FDF4' } };
    const totalsFont = { bold: true, size: 11 };
    const titleFont = { bold: true, size: 16, color: { argb: '14532D' } };
    const labelFont = { bold: true, size: 11 };
    const borderThin = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    ws.columns = [
        { width: 16 }, { width: 30 }, { width: 14 }, { width: 14 },
        { width: 14 }, { width: 14 }, { width: 16 }, { width: 12 }, { width: 12 }
    ];

    const sheetTitle = isNorth ? 'Driver Log' : 'Driver Invoice';
    ws.getCell('A1').value = sheetTitle;
    ws.getCell('A1').font = titleFont;
    ws.getCell('F2').value = 'Submit to:';
    ws.getCell('F2').font = labelFont;
    ws.getCell('A3').value = 'Driver Name:';
    ws.getCell('A3').font = labelFont;
    ws.getCell('B3').value = userInfo.name;
    ws.getCell('F3').value = 'Izy Global Services LLC';
    ws.getCell('F3').font = labelFont;
    ws.getCell('A4').value = isNorth ? 'Log Date:' : 'Invoice Date:';
    ws.getCell('A4').font = labelFont;
    ws.getCell('B4').value = endDate;
    ws.getCell('F4').value = '4869 Madyson Ridge Dr.';
    ws.getCell('F5').value = 'Fort Worth, TX 76133';
    ws.getCell('F6').value = 'Phone: (713) 992-0481 | Email: freights@izymovers.com';

    ws.getCell('A8').value = 'Total Weekly Miles:';
    ws.getCell('A8').font = labelFont;
    ws.getCell('A9').value = 'Total Routes Completed:';
    ws.getCell('A9').font = labelFont;

    // Group logs by date
    const byDate = {};
    logs.forEach(l => { if (!byDate[l.date]) byDate[l.date] = []; byDate[l.date].push(l); });
    const dates = Object.keys(byDate).sort();

    let r = 11;
    let grandMiles = 0, grandRoutes = 0;

    dates.forEach(dateStr => {
        const dayLogs = byDate[dateStr];
        const dateObj = new Date(dateStr + 'T00:00:00');
        const dayName = DAY_NAMES[dateObj.getDay()];

        r++;
        ['Date', 'Route Leg', 'Leg Start Time', 'Leg Completion', 'Sterile Transported', 'Soiled Transported', 'Total Totes Transported', 'Miles Driven'].forEach((h, ci) => {
            const cell = ws.getCell(r, ci + 1);
            cell.value = h;
            cell.fill = headerFill;
            cell.font = headerFont;
            cell.border = borderThin;
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        });

        let dayMiles = 0, daySterile = 0, daySoiled = 0, dayTotes = 0, dayRoutes = 0;

        dayRows(routeDef, dayLogs).forEach((row, legIdx) => {
            r++;
            const st = row.startTime;
            const et = row.endTime;
            const sterile = row.sterile;
            const soiled = row.soiled;
            const miles = row.miles;
            const totes = sterile + soiled;

            if (legIdx === 0) { ws.getCell(r, 1).value = dayName; ws.getCell(r, 1).font = labelFont; }
            else if (legIdx === 1) { ws.getCell(r, 1).value = dateStr; }
            ws.getCell(r, 2).value = row.label;
            ws.getCell(r, 3).value = st; ws.getCell(r, 3).alignment = { horizontal: 'center' };
            ws.getCell(r, 4).value = et; ws.getCell(r, 4).alignment = { horizontal: 'center' };
            ws.getCell(r, 5).value = sterile; ws.getCell(r, 5).alignment = { horizontal: 'center' };
            ws.getCell(r, 6).value = soiled; ws.getCell(r, 6).alignment = { horizontal: 'center' };
            ws.getCell(r, 7).value = totes; ws.getCell(r, 7).alignment = { horizontal: 'center' };
            ws.getCell(r, 8).value = miles; ws.getCell(r, 8).alignment = { horizontal: 'center' };
            for (let ci = 1; ci <= 8; ci++) ws.getCell(r, ci).border = borderThin;

            dayMiles += miles; daySterile += sterile; daySoiled += soiled; dayTotes += totes;
            if (st && et) dayRoutes++;
        });

        r++;
        ws.getCell(r, 4).value = 'Daily Totals:'; ws.getCell(r, 4).font = totalsFont;
        ws.getCell(r, 5).value = daySterile; ws.getCell(r, 6).value = daySoiled;
        ws.getCell(r, 7).value = dayTotes; ws.getCell(r, 8).value = dayMiles; ws.getCell(r, 9).value = dayMiles;
        for (let ci = 4; ci <= 9; ci++) {
            ws.getCell(r, ci).fill = totalsFill; ws.getCell(r, ci).font = totalsFont;
            ws.getCell(r, ci).border = borderThin; ws.getCell(r, ci).alignment = { horizontal: 'center' };
        }
        grandMiles += dayMiles; grandRoutes += dayRoutes;
        r++;
    });

    ws.getCell('B8').value = grandMiles;
    ws.getCell('B8').font = { bold: true, size: 12, color: { argb: '16A34A' } };
    ws.getCell('B9').value = grandRoutes;
    ws.getCell('B9').font = { bold: true, size: 12, color: { argb: '16A34A' } };

    r++;
    ws.getCell(`A${r}`).value = 'Notes:'; ws.getCell(`A${r}`).font = labelFont;
    r++; ws.getCell(`A${r}`).value = '- Submit this invoice every Friday for the current week.';
    r++; ws.getCell(`A${r}`).value = '- Attach scanned BOLs or mileage logs as supporting documentation.';
    r += 2;
    ws.getCell(`A${r}`).value = 'Driver Signature'; ws.getCell(`A${r}`).font = labelFont;
    ws.getCell(`B${r}`).value = userInfo.name;
    ws.getCell(`E${r}`).value = 'Date:'; ws.getCell(`E${r}`).font = labelFont;
    ws.getCell(`F${r}`).value = dates[dates.length - 1];
    ws.getCell(`I${r}`).value = grandMiles;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const fname = `${isNorth ? 'Driver_Log' : 'Driver_Invoice'}_${userInfo.name.replace(/\s/g, '_')}_${startDate}_to_${endDate}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
});

// ---- Start ----
// `ready` resolves once the bootstrap users are reconciled. Migrations must
// already have run (src/index.ts and the test harness do this before requiring
// this file); running `node server.js` directly against an unmigrated database
// is no longer supported.
const ready = (async function init() {
    await bootstrapAdmin();
})();

// Bind the HTTP listener. Resolves with the http.Server once listening.
function start(port = PORT) {
    return ready.then(() => new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            const addr = server.address();
            const shown = typeof addr === 'object' && addr ? addr.port : port;
            console.log(`TVHS RMD Courier Log System running at http://localhost:${shown}`);
            console.log(`Database: ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : dbUrl}`);
            resolve(server);
        });
        server.on('error', reject);
    }));
}

module.exports = { app, ready, start, db };

if (require.main === module) {
    start().catch((err) => {
        console.error('Failed to start:', err);
        process.exit(1);
    });
}
