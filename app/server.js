/* ============================================
   TVHS RMD Courier Log System — Backend Server
   Express + libSQL (Turso / SQLite) + Session Auth
   ============================================ */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ---- Minimal .env loader (no external dependency) ----
// Loads KEY=VALUE lines from app/.env into process.env (values kept literal).
// .env is gitignored so real credentials never enter tracked source.
(function loadEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
            if (!m || line.trim().startsWith('#')) continue;
            let val = m[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (!(m[1] in process.env)) process.env[m[1]] = val;
        }
    } catch (e) { /* ignore malformed .env */ }
})();

const app = express();
const PORT = process.env.PORT || 3000;

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

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('driver','admin')),
        route TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS logs (
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

    CREATE TABLE IF NOT EXISTS checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        date TEXT NOT NULL,
        checkin_at DATETIME NOT NULL,
        UNIQUE(username, date),
        FOREIGN KEY(username) REFERENCES users(username)
    );
`;

// ---- Seed / sync users from environment ----
// Runs on every boot and is idempotent. Accounts are identified by a stable key
// (admin by role, drivers by route), so updating a credential in the environment
// (e.g. Render's Environment tab) updates the login on the next deploy WITHOUT
// wiping data. A username change cascades to logs/checkins so records stay linked.
// If an env credential is absent, the existing value is left untouched — never
// reset to a placeholder.
async function ensureUser(existing, envUser, envPass, name, role, route, fallbackUser) {
    const wantUser = envUser ? String(envUser).toLowerCase().trim() : null;

    if (!existing) {
        const uname = wantUser || fallbackUser;
        const pass = envPass || 'changeme';
        await dbRun('INSERT INTO users (username, password, name, role, route) VALUES (?, ?, ?, ?, ?)',
            [uname, bcrypt.hashSync(pass, 10), name, role, route]);
        console.log(`User created: ${role}${route ? '/' + route : ''} -> ${uname}`);
        return;
    }

    let username = existing.username;

    // Rename (and cascade to data) if the env username changed — atomic batch
    if (wantUser && wantUser !== username) {
        await db.batch([
            { sql: 'UPDATE users SET username = ? WHERE username = ?', args: [wantUser, username] },
            { sql: 'UPDATE logs SET username = ? WHERE username = ?', args: [wantUser, username] },
            { sql: 'UPDATE checkins SET username = ? WHERE username = ?', args: [wantUser, username] },
        ], 'write');
        console.log(`User renamed: ${username} -> ${wantUser}`);
        username = wantUser;
    }

    // Update password only when one is supplied
    if (envPass) {
        await dbRun('UPDATE users SET password = ? WHERE username = ?', [bcrypt.hashSync(envPass, 10), username]);
    }

    // Keep display name / route current
    await dbRun('UPDATE users SET name = ?, route = ? WHERE username = ?', [name, route, username]);
}

async function syncUsers() {
    const adminRow = await dbGet("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    await ensureUser(adminRow, process.env.ADMIN_USER, process.env.ADMIN_PASS, 'Administrator', 'admin', null, 'admin');

    const southRow = await dbGet("SELECT * FROM users WHERE role = 'driver' AND route = 'southbound' LIMIT 1");
    await ensureUser(southRow, process.env.DRIVER1_USER, process.env.DRIVER1_PASS, 'Mohamed Djemai', 'driver', 'southbound', 'driver1');

    const northRow = await dbGet("SELECT * FROM users WHERE role = 'driver' AND route = 'northbound' LIMIT 1");
    await ensureUser(northRow, process.env.DRIVER2_USER, process.env.DRIVER2_PASS, 'Bereket Nigusse', 'driver', 'northbound', 'driver2');
}

// ---- Middleware ----
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// A fixed SESSION_SECRET keeps users logged in across restarts/deploys.
// Falls back to a random per-boot secret (logs everyone out on restart) if unset.
app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

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

// ---- API Routes ----

// Auth
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username.toLowerCase().trim()]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.user = {
        username: user.username,
        name: user.name,
        role: user.role,
        route: user.route
    };

    res.json({
        username: user.username,
        name: user.name,
        role: user.role,
        route: user.route
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
    if (req.session.user) {
        res.json(req.session.user);
    } else {
        res.status(401).json({ error: 'No session' });
    }
});

// Route definitions
app.get('/api/routes', requireAuth, (req, res) => {
    res.json(ROUTES);
});

// App config (timezone + server's current date) so the client displays times/dates
// consistently in the operating timezone regardless of the viewer's device clock.
app.get('/api/config', (req, res) => {
    res.json({ timezone: APP_TIMEZONE, today: localDate() });
});

// ---- Check-in / Clock-in ----

// Driver: check in (clock in) for the day. Idempotent — one check-in per driver per day.
// The day is always the server's current date in APP_TIMEZONE, never client-supplied,
// so a driver can only check in for "today" and can't backdate.
app.post('/api/checkin', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can check in' });

    const date = localDate();
    const existing = await dbGet('SELECT checkin_at FROM checkins WHERE username = ? AND date = ?', [user.username, date]);
    if (existing) {
        return res.json({ checkedIn: true, checkin_at: existing.checkin_at, date, alreadyCheckedIn: true });
    }

    const checkinAt = new Date().toISOString();
    await dbRun('INSERT INTO checkins (username, date, checkin_at) VALUES (?, ?, ?)', [user.username, date, checkinAt]);
    res.json({ checkedIn: true, checkin_at: checkinAt, date });
});

// Driver: own check-in status for a date (defaults to today)
app.get('/api/checkin', requireAuth, async (req, res) => {
    const user = req.session.user;
    const date = req.query.date || localDate();
    const row = await dbGet('SELECT checkin_at FROM checkins WHERE username = ? AND date = ?', [user.username, date]);
    res.json({ checkedIn: !!row, checkin_at: row ? row.checkin_at : null, date });
});

// Driver: own check-in history within a date range
app.get('/api/checkins/history', requireAuth, async (req, res) => {
    const user = req.session.user;
    const { startDate, endDate } = req.query;

    let query = 'SELECT date, checkin_at FROM checkins WHERE username = ?';
    const params = [user.username];
    if (startDate) { query += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND date <= ?'; params.push(endDate); }
    query += ' ORDER BY date ASC';

    res.json(await dbAll(query, params));
});

// Admin: check-in roster for all drivers on a given date (defaults to today)
app.get('/api/admin/checkins', requireAdmin, async (req, res) => {
    const date = req.query.date || localDate();
    const drivers = await dbAll("SELECT username, name, route FROM users WHERE role = 'driver' ORDER BY name");
    const rows = await dbAll('SELECT username, checkin_at FROM checkins WHERE date = ?', [date]);
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
app.get('/api/admin/checkins/history', requireAdmin, async (req, res) => {
    const { driver, route, startDate, endDate } = req.query;

    let query = `
        SELECT c.username, c.date, c.checkin_at, u.name as driver_name, u.route as driver_route
        FROM checkins c
        JOIN users u ON c.username = u.username
        WHERE u.role = 'driver'
    `;
    const params = [];

    if (driver && driver !== 'all') { query += ' AND c.username = ?'; params.push(driver); }
    if (route && route !== 'all') { query += ' AND u.route = ?'; params.push(route); }
    if (startDate) { query += ' AND c.date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND c.date <= ?'; params.push(endDate); }

    query += ' ORDER BY u.name, c.date ASC';
    res.json(await dbAll(query, params));
});

// Get logs for a specific user and date range
app.get('/api/logs', requireAuth, async (req, res) => {
    const { username, startDate, endDate } = req.query;
    const user = req.session.user;

    // Drivers can only see their own logs
    const targetUser = (user.role === 'admin' && username) ? username : user.username;

    let query = 'SELECT * FROM logs WHERE username = ?';
    const params = [targetUser];

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
app.post('/api/logs', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can submit logs' });

    const { date, legs } = req.body;
    if (!date || !Array.isArray(legs)) return res.status(400).json({ error: 'date and legs array required' });

    const sql = `
        INSERT INTO logs (username, date, leg_index, start_time, end_time, sterile, soiled, miles, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username, date, leg_index)
        DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time,
                      sterile=excluded.sterile, soiled=excluded.soiled,
                      miles=excluded.miles, updated_at=CURRENT_TIMESTAMP
    `;

    const stmts = legs.map((leg, i) => ({
        sql,
        args: [
            user.username,
            date,
            i,
            leg.startTime || '',
            leg.endTime || '',
            parseInt(leg.sterile) || 0,
            parseInt(leg.soiled) || 0,
            parseFloat(leg.miles) || 0
        ]
    }));

    if (stmts.length) await db.batch(stmts, 'write');
    res.json({ ok: true });
});

// Clear logs for a specific day
app.delete('/api/logs', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can modify logs' });

    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });

    await dbRun('DELETE FROM logs WHERE username = ? AND date = ?', [user.username, date]);
    res.json({ ok: true });
});

// Admin: get all logs with filters
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
    const { driver, route, startDate, endDate } = req.query;

    let query = `
        SELECT l.*, u.name as driver_name, u.route as driver_route
        FROM logs l
        JOIN users u ON l.username = u.username
        WHERE u.role = 'driver'
    `;
    const params = [];

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
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    const drivers = (await dbGet("SELECT COUNT(*) as cnt FROM users WHERE role = 'driver'")).cnt;
    const logDays = (await dbGet('SELECT COUNT(DISTINCT username || date) as cnt FROM logs')).cnt;
    const totals = await dbGet('SELECT COALESCE(SUM(miles),0) as miles, COALESCE(SUM(sterile + soiled),0) as totes FROM logs');
    res.json({
        drivers,
        logEntries: logDays,
        totalMiles: totals.miles,
        totalTotes: totals.totes
    });
});

// Admin: get drivers list
app.get('/api/admin/drivers', requireAdmin, async (req, res) => {
    const drivers = await dbAll("SELECT username, name, route FROM users WHERE role = 'driver' ORDER BY name");
    res.json(drivers);
});

// Admin: export Excel in original format
app.get('/api/admin/export', requireAdmin, async (req, res) => {
    const ExcelJS = require('exceljs');
    const { driver, route, startDate, endDate } = req.query;

    // Get filtered logs grouped by driver
    let query = `
        SELECT l.*, u.name as driver_name, u.route as driver_route
        FROM logs l JOIN users u ON l.username = u.username
        WHERE u.role = 'driver'
    `;
    const params = [];
    if (driver && driver !== 'all') { query += ' AND l.username = ?'; params.push(driver); }
    if (route && route !== 'all') { query += ' AND u.route = ?'; params.push(route); }
    if (startDate) { query += ' AND l.date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND l.date <= ?'; params.push(endDate); }
    query += ' ORDER BY l.username, l.date ASC, l.leg_index ASC';

    const logs = await dbAll(query, params);
    if (logs.length === 0) return res.status(404).json({ error: 'No data to export' });

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

            routeDef.legs.forEach((leg, legIdx) => {
                r++;
                const logEntry = dayLogs.find(l => l.leg_index === legIdx);
                const st = logEntry ? logEntry.start_time : '';
                const et = logEntry ? logEntry.end_time : '';
                const sterile = logEntry ? logEntry.sterile : 0;
                const soiled = logEntry ? logEntry.soiled : 0;
                const miles = logEntry ? logEntry.miles : 0;
                const totes = sterile + soiled;

                // Date column: day name on first row, date on second, blank on rest
                if (legIdx === 0) {
                    ws.getCell(r, 1).value = dayName;
                    ws.getCell(r, 1).font = labelFont;
                } else if (legIdx === 1) {
                    ws.getCell(r, 1).value = dateStr;
                }

                ws.getCell(r, 2).value = `${leg.from} to ${leg.to}`;
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
app.get('/api/logs/export', requireAuth, async (req, res) => {
    const ExcelJS = require('exceljs');
    const user = req.session.user;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

    const userInfo = await dbGet('SELECT * FROM users WHERE username = ?', [user.username]);
    if (!userInfo) return res.status(404).json({ error: 'User not found' });

    const logs = await dbAll('SELECT * FROM logs WHERE username = ? AND date >= ? AND date <= ? ORDER BY date ASC, leg_index ASC',
        [user.username, startDate, endDate]);

    if (logs.length === 0) return res.status(404).json({ error: 'No data to export' });

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

        routeDef.legs.forEach((leg, legIdx) => {
            r++;
            const entry = dayLogs.find(l => l.leg_index === legIdx);
            const st = entry ? entry.start_time : '';
            const et = entry ? entry.end_time : '';
            const sterile = entry ? entry.sterile : 0;
            const soiled = entry ? entry.soiled : 0;
            const miles = entry ? entry.miles : 0;
            const totes = sterile + soiled;

            if (legIdx === 0) { ws.getCell(r, 1).value = dayName; ws.getCell(r, 1).font = labelFont; }
            else if (legIdx === 1) { ws.getCell(r, 1).value = dateStr; }
            ws.getCell(r, 2).value = `${leg.from} to ${leg.to}`;
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
(async function start() {
    try {
        await db.executeMultiple(SCHEMA);
        await syncUsers();
        app.listen(PORT, () => {
            console.log(`TVHS RMD Courier Log System running at http://localhost:${PORT}`);
            console.log(`Database: ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : dbUrl}`);
        });
    } catch (err) {
        console.error('Failed to start:', err);
        process.exit(1);
    }
})();
