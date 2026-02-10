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
            { from: 'Nashville', to: 'Murfreesboro', defaultMiles: 35 },
            { from: 'Murfreesboro', to: 'Nashville', defaultMiles: 35 },
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

    const logs = db.prepare(query).all(...params);
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

    const userInfo = db.prepare('SELECT * FROM users WHERE username = ?').get(user.username);
    if (!userInfo) return res.status(404).json({ error: 'User not found' });

    const logs = db.prepare('SELECT * FROM logs WHERE username = ? AND date >= ? AND date <= ? ORDER BY date ASC, leg_index ASC')
        .all(user.username, startDate, endDate);

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
app.listen(PORT, () => {
    console.log(`TVHS RMD Courier Log System running at http://localhost:${PORT}`);
});
