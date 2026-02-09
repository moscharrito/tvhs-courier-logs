/* ============================================
   TVHS RMD Courier Log System — Backend Server
   Express + SQLite + Session Auth
   ============================================ */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Database Setup ----
const db = new Database(path.join(__dirname, 'courier_logs.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
`);

// ---- Seed Default Users (if empty) ----
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
if (userCount === 0) {
    const insert = db.prepare('INSERT INTO users (username, password, name, role, route) VALUES (?, ?, ?, ?, ?)');
    const salt = bcrypt.genSaltSync(10);
    insert.run('djemai', bcrypt.hashSync('driver123', salt), 'Mohamed Djemai', 'driver', 'northbound');
    insert.run('ramic', bcrypt.hashSync('driver123', salt), 'Muhammed Ramic', 'driver', 'southbound');
    insert.run('admin', bcrypt.hashSync('admin123', salt), 'Administrator', 'admin', null);
    console.log('Default users seeded.');
}

// ---- Middleware ----
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

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
            { from: 'Murfreesboro', to: 'Chattanooga', defaultMiles: 122.6 },
            { from: 'Chattanooga', to: 'Murfreesboro', defaultMiles: 123.0 },
            { from: 'Murfreesboro', to: 'Chattanooga', defaultMiles: 122.6 },
            { from: 'Chattanooga', to: 'Murfreesboro', defaultMiles: 123.0 },
        ]
    },
    southbound: {
        label: 'SouthBound',
        legs: [
            { from: 'Murfreesboro', to: 'Clarksville', defaultMiles: 80 },
            { from: 'Clarksville', to: 'Fort Campbell', defaultMiles: 15 },
            { from: 'Fort Campbell', to: 'Clarksville', defaultMiles: 15 },
            { from: 'Clarksville', to: 'Murfreesboro', defaultMiles: 80 },
            { from: 'Murfreesboro', to: 'Nashville', defaultMiles: 35 },
            { from: 'Nashville', to: 'Murfreesboro', defaultMiles: 35 },
        ]
    }
};

// ---- API Routes ----

// Auth
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
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

// Get logs for a specific user and date range
app.get('/api/logs', requireAuth, (req, res) => {
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
    const logs = db.prepare(query).all(...params);
    res.json(logs);
});

// Save/update logs for a day
app.post('/api/logs', requireAuth, (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can submit logs' });

    const { date, legs } = req.body;
    if (!date || !Array.isArray(legs)) return res.status(400).json({ error: 'date and legs array required' });

    const upsert = db.prepare(`
        INSERT INTO logs (username, date, leg_index, start_time, end_time, sterile, soiled, miles, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username, date, leg_index)
        DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time,
                      sterile=excluded.sterile, soiled=excluded.soiled,
                      miles=excluded.miles, updated_at=CURRENT_TIMESTAMP
    `);

    const transaction = db.transaction(() => {
        legs.forEach((leg, i) => {
            upsert.run(
                user.username,
                date,
                i,
                leg.startTime || '',
                leg.endTime || '',
                parseInt(leg.sterile) || 0,
                parseInt(leg.soiled) || 0,
                parseFloat(leg.miles) || 0
            );
        });
    });

    transaction();
    res.json({ ok: true });
});

// Clear logs for a specific day
app.delete('/api/logs', requireAuth, (req, res) => {
    const user = req.session.user;
    if (user.role !== 'driver') return res.status(403).json({ error: 'Only drivers can modify logs' });

    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });

    db.prepare('DELETE FROM logs WHERE username = ? AND date = ?').run(user.username, date);
    res.json({ ok: true });
});

// Admin: get all logs with filters
app.get('/api/admin/logs', requireAdmin, (req, res) => {
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
    const logs = db.prepare(query).all(...params);
    res.json(logs);
});

// Admin: get stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const drivers = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'driver'").get().cnt;
    const logDays = db.prepare('SELECT COUNT(DISTINCT username || date) as cnt FROM logs').get().cnt;
    const totals = db.prepare('SELECT COALESCE(SUM(miles),0) as miles, COALESCE(SUM(sterile + soiled),0) as totes FROM logs').get();
    res.json({
        drivers,
        logEntries: logDays,
        totalMiles: totals.miles,
        totalTotes: totals.totes
    });
});

// Admin: get drivers list
app.get('/api/admin/drivers', requireAdmin, (req, res) => {
    const drivers = db.prepare("SELECT username, name, route FROM users WHERE role = 'driver' ORDER BY name").all();
    res.json(drivers);
});

// ---- Start ----
app.listen(PORT, () => {
    console.log(`TVHS RMD Courier Log System running at http://localhost:${PORT}`);
});
