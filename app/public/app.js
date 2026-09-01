/* ============================================
   TVHS RMD Courier- IZYGLOBALSERV Log System — Frontend
   API-backed version with editable miles
   ============================================ */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// ---- State ----
let currentUser = null;
let currentWeekStart = null;
let currentDayIndex = 0;
let routeDefs = {};      // Loaded from server
let weekLogCache = {};   // { "YYYY-MM-DD": [ {legIndex, startTime, endTime, sterile, soiled, miles}, ... ] }
let appTimezone = 'America/Chicago';  // Auto-detected from the viewer's device
let serverToday = null;               // Today's date (YYYY-MM-DD) in the viewer's timezone

// Detect the viewer's device timezone so all displayed times/dates follow it.
async function loadConfig() {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) appTimezone = tz;
    } catch (e) { /* keep default */ }
    serverToday = formatDate(new Date()); // device-local "today"
}

// Format an ISO timestamp as a time in the viewer's timezone (e.g. "8:42 AM")
function fmtTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US', {
        timeZone: appTimezone, hour: 'numeric', minute: '2-digit', hour12: true
    });
}

// ---- API Helper ----
async function api(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// ---- Auth ----
let loginDrivers = [];
let selectedDriver = null;
let pinMode = 'enter'; // 'enter' | 'setup'

function initials(name) {
    return name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function routeLabelOf(route) {
    return route === 'northbound' ? 'NorthBound' : 'SouthBound';
}

function enterApp(user) {
    currentUser = user;
    if (user.role === 'admin') {
        showScreen('adminScreen');
        initAdmin();
    } else {
        showScreen('driverScreen');
        initDriver();
    }
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function showLoginView(view) {
    document.getElementById('loginPickView').style.display = view === 'pick' ? '' : 'none';
    document.getElementById('loginPinView').style.display = view === 'pin' ? '' : 'none';
    document.getElementById('loginAdminView').style.display = view === 'admin' ? '' : 'none';
}

async function initLoginScreen() {
    showLoginView('pick');
    const container = document.getElementById('driverCards');
    try {
        loginDrivers = await api('/api/drivers/list');
        container.innerHTML = '';
        if (!loginDrivers.length) {
            container.innerHTML = '<div class="empty-state" style="padding:16px;">No drivers found.</div>';
            return;
        }
        loginDrivers.forEach(d => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'driver-card';
            btn.onclick = () => selectDriver(d);
            btn.innerHTML = `
                <span class="driver-card-avatar">${initials(d.name)}</span>
                <span class="driver-card-info">
                    <span class="driver-card-name">${d.name}</span>
                    <span class="driver-card-route">${routeLabelOf(d.route)}${d.hasPin ? '' : ' · Set up PIN'}</span>
                </span>
                <span class="driver-card-arrow">&rsaquo;</span>`;
            container.appendChild(btn);
        });
    } catch (e) {
        container.innerHTML = '<div class="empty-state" style="padding:16px;">Unable to load drivers.</div>';
    }
}

function selectDriver(d) {
    selectedDriver = d;
    pinMode = d.hasPin ? 'enter' : 'setup';
    document.getElementById('pinAvatar').textContent = initials(d.name);
    document.getElementById('pinDriverName').textContent = d.name;
    document.getElementById('pinDriverRoute').textContent = routeLabelOf(d.route);
    configurePinView();
    showLoginView('pin');
    setTimeout(() => {
        const f = document.getElementById(pinMode === 'setup' ? 'pinSetupPass' : 'pinInput');
        if (f) f.focus();
    }, 60);
}

function configurePinView() {
    const isSetup = pinMode === 'setup';
    document.getElementById('pinSetupPassGroup').style.display = isSetup ? '' : 'none';
    document.getElementById('pinLabel').textContent = isSetup ? 'Create a 4–6 digit PIN' : 'Enter your PIN';
    document.getElementById('pinSubmitBtn').textContent = isSetup ? 'Set PIN & Sign In' : 'Sign In';
    document.getElementById('forgotPinLink').style.display = isSetup ? 'none' : '';
    document.getElementById('pinInput').value = '';
    document.getElementById('pinSetupPass').value = '';
}

function startPinReset() {
    pinMode = 'setup';
    configurePinView();
    setTimeout(() => document.getElementById('pinSetupPass').focus(), 60);
}

async function submitPin(e) {
    e.preventDefault();
    if (!selectedDriver) return false;
    const pin = document.getElementById('pinInput').value.trim();
    if (!/^\d{4,6}$/.test(pin)) { showToast('PIN must be 4–6 digits', 'error'); return false; }

    try {
        let user;
        if (pinMode === 'setup') {
            const password = document.getElementById('pinSetupPass').value;
            if (!password) { showToast('Enter your password to set a PIN', 'error'); return false; }
            user = await api('/api/login/pin/setup', {
                method: 'POST',
                body: JSON.stringify({ route: selectedDriver.route, password, pin })
            });
            showToast("PIN set — you're signed in", 'success');
        } else {
            user = await api('/api/login/pin', {
                method: 'POST',
                body: JSON.stringify({ route: selectedDriver.route, pin })
            });
        }
        enterApp(user);
    } catch (err) {
        showToast(err.message, 'error');
    }
    return false;
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginUser').value.trim().toLowerCase();
    const password = document.getElementById('loginPass').value;
    if (!username || !password) { showToast('Enter username and password', 'error'); return false; }

    try {
        const user = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        enterApp(user);
    } catch (err) {
        showToast(err.message, 'error');
    }
    return false;
}

async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    currentUser = null;
    const lu = document.getElementById('loginUser'); if (lu) lu.value = '';
    const lp = document.getElementById('loginPass'); if (lp) lp.value = '';
    showScreen('loginScreen');
    initLoginScreen();
}

// ---- Session Check on Load ----
async function checkSession() {
    try {
        currentUser = await api('/api/session');
        routeDefs = await api('/api/routes');
        enterApp(currentUser);
    } catch (e) {
        showScreen('loginScreen');
        initLoginScreen();
    }
}

// ---- Driver View Toggle ----
let driverHistoryPeriod = 'week';

function showDriverView(view) {
    document.getElementById('navTabEntry').classList.toggle('active', view === 'entry');
    document.getElementById('navTabHistory').classList.toggle('active', view === 'history');
    document.getElementById('navTabCheckins').classList.toggle('active', view === 'checkins');
    document.getElementById('driverEntryView').style.display = view === 'entry' ? '' : 'none';
    document.getElementById('driverHistoryView').style.display = view === 'history' ? '' : 'none';
    document.getElementById('driverCheckinView').style.display = view === 'checkins' ? '' : 'none';

    if (view === 'history') {
        initHistoryPicker();
    } else if (view === 'checkins') {
        initMyCheckinPicker();
    }
}

// ---- Driver Interface ----
async function initDriver() {
    await loadConfig();
    if (!routeDefs || !Object.keys(routeDefs).length) {
        routeDefs = await api('/api/routes');
    }

    document.getElementById('driverNameDisplay').textContent = currentUser.name;
    const route = routeDefs[currentUser.route];
    document.getElementById('driverRouteDisplay').textContent = route.label;

    initDriverCheckin();

    flatpickr('#weekPicker', {
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        onChange: function(selectedDates) {
            if (selectedDates.length > 0) {
                selectWeek(selectedDates[0]);
            }
        }
    });
}

// ---- Driver Check-In / Clock-In ----
let checkinClockTimer = null;
let checkedInToday = false;

function initDriverCheckin() {
    // Live clock + today's date, shown in the operating timezone
    const dateEl = document.getElementById('checkinDate');
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('en-US', {
            timeZone: appTimezone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
    }
    if (checkinClockTimer) clearInterval(checkinClockTimer);
    const tick = () => {
        const clockEl = document.getElementById('checkinClock');
        if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('en-US', {
            timeZone: appTimezone, hour12: true, timeZoneName: 'short'
        });
    };
    tick();
    checkinClockTimer = setInterval(tick, 1000);

    // Fetch today's status (server decides "today" in the operating timezone)
    refreshCheckinStatus();
}

async function refreshCheckinStatus() {
    try {
        const status = await api('/api/checkin?date=' + formatDate(new Date()));
        renderCheckinState(status.checkedIn, status.checkin_at);
    } catch (e) {
        renderCheckinState(false, null);
    }
}

function renderCheckinState(checkedIn, checkinAt) {
    checkedInToday = checkedIn;
    const card = document.getElementById('checkinCard');
    const action = document.getElementById('checkinAction');
    if (!card || !action) return;

    card.classList.toggle('is-checked-in', checkedIn);

    if (checkedIn) {
        const timeStr = fmtTime(checkinAt);
        action.innerHTML = `
            <div class="checkin-status">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <div>
                    <span class="checkin-status-label">Checked in</span>
                    <span class="checkin-status-time">${timeStr}</span>
                </div>
            </div>`;
    } else {
        action.innerHTML = `
            <button class="btn btn-primary btn-checkin" id="checkinBtn" onclick="doCheckin()">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
                Start My Day
            </button>`;
    }
}

async function doCheckin() {
    const btn = document.getElementById('checkinBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking in…'; }
    try {
        const res = await api('/api/checkin', {
            method: 'POST',
            body: JSON.stringify({ date: formatDate(new Date()) })
        });
        renderCheckinState(true, res.checkin_at);
        showToast(res.alreadyCheckedIn ? 'Already checked in today' : 'Checked in — have a safe day!', 'success');
    } catch (err) {
        showToast('Check-in failed: ' + err.message, 'error');
        renderCheckinState(false, null);
    }
}

let historyPickerInit = false;
function initHistoryPicker() {
    if (historyPickerInit) return;
    historyPickerInit = true;
    flatpickr('#historyDatePicker', {
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        onChange: function(selectedDates) {
            if (selectedDates.length > 0) {
                loadDriverHistory(selectedDates[0]);
            }
        }
    });
}

function setDriverHistoryPeriod(period) {
    driverHistoryPeriod = period;
    document.querySelectorAll('#driverHistoryView .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    // Re-load if a date was already picked
    const fp = document.getElementById('historyDatePicker')._flatpickr;
    if (fp && fp.selectedDates.length > 0) {
        loadDriverHistory(fp.selectedDates[0]);
    }
}

async function loadDriverHistory(date) {
    let startDate, endDate, periodLabel;

    if (driverHistoryPeriod === 'week') {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        monday.setHours(0, 0, 0, 0);
        const friday = new Date(monday);
        friday.setDate(friday.getDate() + 4);
        startDate = formatDate(monday);
        endDate = formatDate(friday);
        const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        periodLabel = `Week: ${fmt(monday)} — ${fmt(friday)}`;
    } else {
        const d = new Date(date);
        const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        startDate = formatDate(firstDay);
        endDate = formatDate(lastDay);
        periodLabel = `Month: ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
    }

    document.getElementById('historyPeriodDisplay').textContent = periodLabel;

    try {
        const logs = await api(`/api/logs?startDate=${startDate}&endDate=${endDate}`);
        renderDriverHistory(logs, periodLabel);
    } catch (err) {
        showToast('Failed to load history: ' + err.message, 'error');
    }
}

function renderDriverHistory(logs, title) {
    const route = routeDefs[currentUser.route];
    document.getElementById('historySummaryCard').style.display = '';
    document.getElementById('historyTableCard').style.display = '';
    document.getElementById('historyTableTitle').textContent = title;

    const tbody = document.getElementById('historyLogBody');
    tbody.innerHTML = '';

    // Filter out empty entries and group by date
    const nonEmpty = logs.filter(l => l.start_time || l.end_time || l.sterile || l.soiled || l.miles);

    if (nonEmpty.length === 0) {
        document.getElementById('noHistoryMessage').style.display = '';
        document.getElementById('histMiles').textContent = '0';
        document.getElementById('histTotes').textContent = '0';
        document.getElementById('histRoutes').textContent = '0';
        document.getElementById('histDays').textContent = '0';
        return;
    }
    document.getElementById('noHistoryMessage').style.display = 'none';

    // Group by date
    const grouped = {};
    nonEmpty.forEach(log => {
        if (!grouped[log.date]) grouped[log.date] = [];
        grouped[log.date].push(log);
    });

    let totalMiles = 0, totalTotes = 0, totalRoutes = 0;
    const dates = Object.keys(grouped).sort();

    dates.forEach(dateStr => {
        const date = new Date(dateStr + 'T00:00:00');
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const dateFormatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        // Day separator row
        const sepTr = document.createElement('tr');
        sepTr.className = 'day-separator';
        sepTr.innerHTML = `<td colspan="9">${dayName}, ${dateFormatted}</td>`;
        tbody.appendChild(sepTr);

        let dayMiles = 0, dayTotes = 0;

        grouped[dateStr].forEach(log => {
            const legLabel = legLabelOf(route, log);
            if (!legLabel) return;

            const totes = (parseInt(log.sterile) || 0) + (parseInt(log.soiled) || 0);
            const miles = parseFloat(log.miles) || 0;
            dayMiles += miles;
            dayTotes += totes;

            if (log.start_time && log.end_time) totalRoutes++;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${dateFormatted}</td>
                <td>${dayName}</td>
                <td>${legLabel}</td>
                <td>${log.start_time || '-'}</td>
                <td>${log.end_time || '-'}</td>
                <td style="text-align:center">${log.sterile || 0}</td>
                <td style="text-align:center">${log.soiled || 0}</td>
                <td style="text-align:center;font-weight:600">${totes}</td>
                <td style="text-align:center">${miles}</td>
            `;
            tbody.appendChild(tr);
        });

        totalMiles += dayMiles;
        totalTotes += dayTotes;
    });

    document.getElementById('histMiles').textContent = totalMiles.toFixed(1);
    document.getElementById('histTotes').textContent = totalTotes;
    document.getElementById('histRoutes').textContent = totalRoutes;
    document.getElementById('histDays').textContent = dates.length;
}

function exportDriverLogs() {
    const fp = document.getElementById('historyDatePicker')._flatpickr;
    if (!fp || fp.selectedDates.length === 0) {
        showToast('Select a period first', 'error');
        return;
    }

    const date = fp.selectedDates[0];
    let startDate, endDate;

    if (driverHistoryPeriod === 'week') {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        monday.setHours(0, 0, 0, 0);
        const friday = new Date(monday);
        friday.setDate(friday.getDate() + 4);
        startDate = formatDate(monday);
        endDate = formatDate(friday);
    } else {
        const d = new Date(date);
        startDate = formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
        endDate = formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    }

    // Download from server-side ExcelJS endpoint
    window.location.href = `/api/logs/export?startDate=${startDate}&endDate=${endDate}`;
    showToast('Downloading Excel...', 'success');
}

// ---- Driver: My Check-In History ----
let myCheckinPeriod = 'week';
let myCheckinPickerInit = false;

function initMyCheckinPicker() {
    if (myCheckinPickerInit) return;
    myCheckinPickerInit = true;
    flatpickr('#myCheckinDate', {
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        defaultDate: serverToday || 'today',
        onChange: function(dates) { if (dates.length > 0) loadMyCheckins(dates[0]); }
    });
    // Show the current period straight away
    loadMyCheckins(new Date());
}

function setMyCheckinPeriod(period) {
    myCheckinPeriod = period;
    document.querySelectorAll('[data-mycheckin-period]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mycheckinPeriod === period);
    });
    const fp = document.getElementById('myCheckinDate')._flatpickr;
    const picked = (fp && fp.selectedDates.length > 0) ? fp.selectedDates[0] : new Date();
    loadMyCheckins(picked);
}

async function loadMyCheckins(date) {
    const { startDate, endDate, label } = periodRange(myCheckinPeriod, date);
    document.getElementById('myCheckinPeriodDisplay').textContent = label;

    try {
        const rows = await api(`/api/checkins/history?startDate=${startDate}&endDate=${endDate}`);
        renderMyCheckins(rows);
    } catch (err) {
        showToast('Failed to load check-ins: ' + err.message, 'error');
    }
}

function renderMyCheckins(rows) {
    const card = document.getElementById('myCheckinTableCard');
    const tbody = document.getElementById('myCheckinBody');
    const empty = document.getElementById('noMyCheckins');
    const summary = document.getElementById('myCheckinSummary');

    card.style.display = '';
    tbody.innerHTML = '';

    if (!rows.length) {
        empty.style.display = '';
        if (summary) summary.textContent = '';
        return;
    }
    empty.style.display = 'none';
    if (summary) summary.textContent = `${rows.length} check-in${rows.length === 1 ? '' : 's'}`;

    rows.forEach(r => {
        const dateObj = new Date(r.date + 'T00:00:00');
        const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
        const dateFormatted = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${dateFormatted}</td>
            <td>${dayName}</td>
            <td style="font-weight:600;color:var(--green-700);">${fmtTime(r.checkin_at)}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function selectWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    currentWeekStart = new Date(d.setDate(diff));
    currentWeekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 4);

    const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('selectedWeekDisplay').textContent =
        `${fmt(currentWeekStart)} — ${fmt(weekEnd)}`;

    document.getElementById('logEntrySection').style.display = '';

    // Load the week's logs from the server
    await loadWeekLogs();

    currentDayIndex = 0;
    buildDayTabs();
    selectDay(0);
}

async function loadWeekLogs() {
    weekLogCache = {};
    const startDate = formatDate(currentWeekStart);
    const endDate = formatDate(new Date(currentWeekStart.getTime() + 4 * 86400000));

    try {
        const logs = await api(`/api/logs?startDate=${startDate}&endDate=${endDate}`);
        // Group by date
        logs.forEach(log => {
            if (!weekLogCache[log.date]) weekLogCache[log.date] = [];
            weekLogCache[log.date].push(log);
        });
    } catch (e) {
        showToast('Failed to load logs', 'error');
    }
}

function buildDayTabs() {
    const container = document.getElementById('dayTabs');
    container.innerHTML = '';

    for (let i = 0; i < 5; i++) {
        const dayDate = new Date(currentWeekStart);
        dayDate.setDate(dayDate.getDate() + i);
        const dateStr = formatDate(dayDate);
        const dayLogs = weekLogCache[dateStr] || [];
        const hasData = dayLogs.some(l => l.start_time || l.end_time || l.sterile || l.soiled || l.miles);

        const btn = document.createElement('button');
        btn.className = `day-tab${i === currentDayIndex ? ' active' : ''}${hasData ? ' has-data' : ''}`;
        btn.textContent = `${DAY_NAMES[i]} ${dayDate.getDate()}`;
        btn.onclick = () => selectDay(i);
        container.appendChild(btn);
    }

    updateWeeklySummary();
}

function selectDay(index) {
    currentDayIndex = index;

    document.querySelectorAll('.day-tab').forEach((tab, i) => {
        tab.classList.toggle('active', i === index);
    });

    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + index);
    const dateStr = formatDate(dayDate);

    document.getElementById('logTableTitle').textContent =
        `${DAY_NAMES[index]}, ${dayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

    buildLogTable(dateStr);
}

// Row model for a day: every standard route leg, followed by any extra
// (off-schedule) legs the driver added. Extras are stored at leg_index >=
// route.legs.length and carry their own from/to labels.
function rowsForDate(dateStr) {
    const route = routeDefs[currentUser.route];
    const dayLogs = weekLogCache[dateStr] || [];

    const valuesOf = (log) => ({
        startTime: log ? (log.start_time || '') : '',
        endTime: log ? (log.end_time || '') : '',
        sterile: log ? (log.sterile || 0) : 0,
        soiled: log ? (log.soiled || 0) : 0,
        miles: log ? (log.miles || 0) : 0
    });

    const rows = route.legs.map((leg, i) => ({
        from: leg.from,
        to: leg.to,
        extra: false,
        ...valuesOf(dayLogs.find(l => l.leg_index === i))
    }));

    dayLogs
        .filter(l => l.leg_index >= route.legs.length)
        .sort((a, b) => a.leg_index - b.leg_index)
        .forEach(l => rows.push({
            from: l.leg_from || '',
            to: l.leg_to || '',
            extra: true,
            ...valuesOf(l)
        }));

    return rows;
}

function buildLogTable(dateStr) {
    renderLogRows(rowsForDate(dateStr));
}

function renderLogRows(rows) {
    const tbody = document.getElementById('logTableBody');
    tbody.innerHTML = '';

    rows.forEach((row, i) => {
        const totalTotes = (parseInt(row.sterile) || 0) + (parseInt(row.soiled) || 0);

        const legCell = row.extra
            ? `<div class="route-label route-label-extra">
                    <span class="route-index extra">${i + 1}</span>
                    <input type="text" class="leg-input" placeholder="From" maxlength="60" value="${escapeAttr(row.from)}" data-leg="${i}" data-field="legFrom">
                    <span class="route-arrow">&#9654;</span>
                    <input type="text" class="leg-input" placeholder="To" maxlength="60" value="${escapeAttr(row.to)}" data-leg="${i}" data-field="legTo">
                    <button type="button" class="leg-remove" title="Remove this extra leg" aria-label="Remove this extra leg" onclick="removeExtraLeg(${i})">&times;</button>
                    <span class="extra-badge">Extra</span>
               </div>`
            : `<div class="route-label">
                    <span class="route-index">${i + 1}</span>
                    ${row.from} <span class="route-arrow">&#9654;</span> ${row.to}
               </div>`;

        const tr = document.createElement('tr');
        if (row.extra) tr.className = 'extra-leg-row';
        tr.innerHTML = `
            <td class="cell-route">${legCell}</td>
            <td class="cell-input" data-label="Start Time"><input type="time" value="${row.startTime}" data-leg="${i}" data-field="startTime" onchange="onCellChange(this)"></td>
            <td class="cell-input" data-label="End Time"><input type="time" value="${row.endTime}" data-leg="${i}" data-field="endTime" onchange="onCellChange(this)"></td>
            <td class="cell-input" data-label="Sterile"><input type="number" min="0" inputmode="numeric" value="${row.sterile}" data-leg="${i}" data-field="sterile" onchange="onCellChange(this)" oninput="updateTotals()"></td>
            <td class="cell-input" data-label="Soiled"><input type="number" min="0" inputmode="numeric" value="${row.soiled}" data-leg="${i}" data-field="soiled" onchange="onCellChange(this)" oninput="updateTotals()"></td>
            <td class="cell-input" data-label="Total Totes"><div class="auto-cell">${totalTotes}</div></td>
            <td class="cell-input" data-label="Miles"><input type="number" min="0" step="0.1" inputmode="decimal" value="${row.miles}" data-leg="${i}" data-field="miles" onchange="onCellChange(this)" oninput="updateTotals()"></td>
        `;
        tbody.appendChild(tr);
    });

    updateTotals();
}

// Read the table back into the row model (the inputs are the source of truth
// between saves, so adding/removing a leg never loses typed values).
function collectRows() {
    const route = routeDefs[currentUser.route];

    return Array.from(document.querySelectorAll('#logTableBody tr')).map((tr, i) => {
        const val = (field) => tr.querySelector(`[data-field="${field}"]`)?.value || '';
        const extra = i >= route.legs.length;
        return {
            extra,
            from: extra ? val('legFrom').trim() : route.legs[i].from,
            to: extra ? val('legTo').trim() : route.legs[i].to,
            startTime: val('startTime'),
            endTime: val('endTime'),
            sterile: parseInt(val('sterile')) || 0,
            soiled: parseInt(val('soiled')) || 0,
            miles: parseFloat(val('miles')) || 0
        };
    });
}

// Append a blank off-schedule leg to the current day
function addExtraLeg() {
    const rows = collectRows();
    rows.push({ extra: true, from: '', to: '', startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 });
    renderLogRows(rows);

    const input = document.querySelector(`[data-leg="${rows.length - 1}"][data-field="legFrom"]`);
    if (input) {
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
        input.focus();
    }
}

function removeExtraLeg(index) {
    const rows = collectRows();
    const row = rows[index];
    if (!row || !row.extra) return;

    const hasData = row.startTime || row.endTime || row.sterile || row.soiled || row.miles;
    if (hasData && !confirm('Remove this extra leg and everything entered on it?')) return;

    rows.splice(index, 1);
    renderLogRows(rows);
    showToast('Extra leg removed — tap Save Log to apply');
}

function onCellChange(input) {
    if (input.dataset.field === 'sterile' || input.dataset.field === 'soiled') {
        updateTotals();
    }
}

function updateTotals() {
    let totalSterile = 0, totalSoiled = 0, totalTotes = 0, totalMiles = 0;

    document.querySelectorAll('#logTableBody tr').forEach(tr => {
        const sterile = parseInt(tr.querySelector('[data-field="sterile"]')?.value) || 0;
        const soiled = parseInt(tr.querySelector('[data-field="soiled"]')?.value) || 0;
        const miles = parseFloat(tr.querySelector('[data-field="miles"]')?.value) || 0;
        const totes = sterile + soiled;

        const totesCell = tr.querySelector('.auto-cell');
        if (totesCell) totesCell.textContent = totes;

        totalSterile += sterile;
        totalSoiled += soiled;
        totalTotes += totes;
        totalMiles += miles;
    });

    document.getElementById('totalSterile').textContent = totalSterile;
    document.getElementById('totalSoiled').textContent = totalSoiled;
    document.getElementById('totalTotes').textContent = totalTotes;
    document.getElementById('totalMiles').textContent = totalMiles.toFixed(1);
}

async function saveLog() {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + currentDayIndex);
    const dateStr = formatDate(dayDate);

    const rows = collectRows();
    if (rows.some(r => r.extra && (!r.from || !r.to))) {
        showToast('Enter From and To for each extra leg', 'error');
        return;
    }

    const legs = rows.map(r => ({
        legFrom: r.extra ? r.from : '',
        legTo: r.extra ? r.to : '',
        startTime: r.startTime,
        endTime: r.endTime,
        sterile: r.sterile,
        soiled: r.soiled,
        miles: r.miles,
    }));

    try {
        await api('/api/logs', {
            method: 'POST',
            body: JSON.stringify({ date: dateStr, legs })
        });

        // Update local cache
        weekLogCache[dateStr] = legs.map((l, i) => ({
            leg_index: i,
            leg_from: l.legFrom,
            leg_to: l.legTo,
            start_time: l.startTime,
            end_time: l.endTime,
            sterile: l.sterile,
            soiled: l.soiled,
            miles: l.miles
        }));

        buildDayTabs();
        showToast('Log saved successfully', 'success');
    } catch (err) {
        showToast('Failed to save: ' + err.message, 'error');
    }
}

async function clearCurrentDay() {
    if (!confirm('Clear all entries for this day? This cannot be undone.')) return;

    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + currentDayIndex);
    const dateStr = formatDate(dayDate);

    try {
        await api('/api/logs', {
            method: 'DELETE',
            body: JSON.stringify({ date: dateStr })
        });

        delete weekLogCache[dateStr];

        // Rebuild the day back to the standard legs, all fields blank
        buildLogTable(dateStr);
        buildDayTabs();
        showToast('Day cleared', 'success');
    } catch (err) {
        showToast('Failed to clear: ' + err.message, 'error');
    }
}

function updateWeeklySummary() {
    const route = routeDefs[currentUser.route];
    let totalMiles = 0, totalTotes = 0, routesCompleted = 0, daysLogged = 0;

    for (let i = 0; i < 5; i++) {
        const dayDate = new Date(currentWeekStart);
        dayDate.setDate(dayDate.getDate() + i);
        const dateStr = formatDate(dayDate);
        const dayLogs = weekLogCache[dateStr] || [];

        if (dayLogs.length > 0) {
            let dayHasData = false;
            dayLogs.forEach(log => {
                const st = log.start_time || log.startTime || '';
                const et = log.end_time || log.endTime || '';
                const s = parseInt(log.sterile) || 0;
                const so = parseInt(log.soiled) || 0;
                const m = parseFloat(log.miles) || 0;
                totalTotes += s + so;
                if (st || et || s || so || m) dayHasData = true;
                if (st && et) {
                    routesCompleted++;
                    totalMiles += m;
                }
            });
            if (dayHasData) daysLogged++;
        }
    }

    document.getElementById('weeklyMiles').textContent = totalMiles.toFixed(1);
    document.getElementById('weeklyTotes').textContent = totalTotes;
    document.getElementById('weeklyRoutes').textContent = routesCompleted;
    document.getElementById('weeklyDays').textContent = daysLogged;
}

// ---- Admin Interface ----
let adminPeriod = 'custom';

async function initAdmin() {
    await loadConfig();
    if (!routeDefs || !Object.keys(routeDefs).length) {
        routeDefs = await api('/api/routes');
    }

    flatpickr('#adminDateRange', {
        mode: 'range',
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        onClose: function(selectedDates) {
            if (selectedDates.length >= 2) applyFilters();
        }
    });

    flatpickr('#adminPeriodDate', {
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        onChange: function() { applyFilters(); }
    });

    // Check-in roster date picker (defaults to server's today in the operating timezone)
    flatpickr('#checkinDatePicker', {
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        defaultDate: serverToday || 'today',
        onChange: function(dates) {
            if (dates.length > 0) loadAdminCheckins(formatDate(dates[0]));
        }
    });
    loadAdminCheckins(serverToday || formatDate(new Date()));

    // Check-in history date picker (defaults to server's today)
    flatpickr('#checkinHistoryDate', {
        dateFormat: 'Y-m-d',
        maxDate: 'today',
        defaultDate: serverToday || 'today',
        onChange: function() { applyCheckinFilters(); }
    });

    // Populate driver filters dynamically (logs + check-in history)
    try {
        const drivers = await api('/api/admin/drivers');
        const selects = [document.getElementById('filterDriver'), document.getElementById('checkinFilterDriver')];
        selects.forEach(select => {
            if (!select) return;
            select.innerHTML = '<option value="all">All Drivers</option>';
            drivers.forEach(d => {
                const routeLabel = routeDefs[d.route]?.label || d.route;
                const opt = document.createElement('option');
                opt.value = d.username;
                opt.textContent = `${d.name} (${routeLabel})`;
                select.appendChild(opt);
            });
        });
    } catch (e) { /* fallback: just "All Drivers" */ }

    applyFilters();
    applyCheckinFilters();
}

function setAdminPeriod(period) {
    adminPeriod = period;
    document.querySelectorAll('[data-admin-period]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.adminPeriod === period);
    });
    document.getElementById('adminDateGroup').style.display = period === 'custom' ? '' : 'none';
    document.getElementById('adminPeriodDateGroup').style.display = period !== 'custom' ? '' : 'none';

    // Auto-apply if a date was already picked
    if (period !== 'custom') {
        const fp = document.getElementById('adminPeriodDate')._flatpickr;
        if (fp && fp.selectedDates.length > 0) applyFilters();
    }
}

function getAdminDateRange() {
    if (adminPeriod === 'custom') {
        const dateRangeEl = document.getElementById('adminDateRange');
        const dateRange = dateRangeEl._flatpickr?.selectedDates || [];
        if (dateRange.length >= 2) return { startDate: formatDate(dateRange[0]), endDate: formatDate(dateRange[1]) };
        if (dateRange.length === 1) return { startDate: formatDate(dateRange[0]), endDate: formatDate(dateRange[0]) };
        return {};
    }

    const fp = document.getElementById('adminPeriodDate')._flatpickr;
    if (!fp || fp.selectedDates.length === 0) return {};
    const date = fp.selectedDates[0];

    if (adminPeriod === 'week') {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        monday.setHours(0, 0, 0, 0);
        const friday = new Date(monday);
        friday.setDate(friday.getDate() + 4);
        return { startDate: formatDate(monday), endDate: formatDate(friday) };
    } else {
        const d = new Date(date);
        return {
            startDate: formatDate(new Date(d.getFullYear(), d.getMonth(), 1)),
            endDate: formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))
        };
    }
}

async function applyFilters() {
    const driverFilter = document.getElementById('filterDriver').value;
    const routeFilter = document.getElementById('filterRoute').value;
    const { startDate, endDate } = getAdminDateRange();

    const params = new URLSearchParams();
    if (driverFilter !== 'all') params.set('driver', driverFilter);
    if (routeFilter !== 'all') params.set('route', routeFilter);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);

    try {
        const [logs, stats] = await Promise.all([
            api(`/api/admin/logs?${params.toString()}`),
            api('/api/admin/stats')
        ]);

        // Update stats
        document.getElementById('statDrivers').textContent = stats.drivers;
        document.getElementById('statLogs').textContent = stats.logEntries;
        document.getElementById('statMiles').textContent = stats.totalMiles.toFixed(1);
        document.getElementById('statTotes').textContent = stats.totalTotes;

        // Filter out empty rows
        const nonEmpty = logs.filter(l => l.start_time || l.end_time || l.sterile || l.soiled || l.miles);

        // Group by driver then by date
        const byDriver = {};
        nonEmpty.forEach(log => {
            const key = log.username;
            if (!byDriver[key]) byDriver[key] = { name: log.driver_name, route: log.driver_route, days: {} };
            if (!byDriver[key].days[log.date]) byDriver[key].days[log.date] = [];
            byDriver[key].days[log.date].push(log);
        });

        const tbody = document.getElementById('adminLogBody');
        tbody.innerHTML = '';

        for (const [username, driverData] of Object.entries(byDriver)) {
            const route = routeDefs[driverData.route];
            if (!route) continue;
            const routeClass = driverData.route === 'northbound' ? 'north' : 'south';
            const dates = Object.keys(driverData.days).sort();

            // Driver header row
            const driverRow = document.createElement('tr');
            driverRow.className = 'driver-group-header';
            driverRow.innerHTML = `<td colspan="11"><strong>${driverData.name}</strong> <span class="route-tag ${routeClass}">${route.label}</span></td>`;
            tbody.appendChild(driverRow);

            let driverTotalMiles = 0, driverTotalTotes = 0;

            dates.forEach(dateStr => {
                const dayLogs = driverData.days[dateStr];
                const dateObj = new Date(dateStr + 'T00:00:00');
                const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
                const dateFormatted = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                // Day separator
                const sepTr = document.createElement('tr');
                sepTr.className = 'day-separator';
                sepTr.innerHTML = `<td colspan="11">${dayName}, ${dateFormatted}</td>`;
                tbody.appendChild(sepTr);

                let dayMiles = 0, daySterile = 0, daySoiled = 0, dayTotes = 0;

                dayLogs.forEach(log => {
                    const legLabel = legLabelOf(route, log);
                    if (!legLabel) return;
                    const totes = (parseInt(log.sterile) || 0) + (parseInt(log.soiled) || 0);
                    const miles = parseFloat(log.miles) || 0;
                    dayMiles += miles;
                    daySterile += (parseInt(log.sterile) || 0);
                    daySoiled += (parseInt(log.soiled) || 0);
                    dayTotes += totes;

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td></td>
                        <td></td>
                        <td>${dateFormatted}</td>
                        <td>${dayName}</td>
                        <td>${legLabel}</td>
                        <td>${log.start_time || '-'}</td>
                        <td>${log.end_time || '-'}</td>
                        <td style="text-align:center">${log.sterile || 0}</td>
                        <td style="text-align:center">${log.soiled || 0}</td>
                        <td style="text-align:center;font-weight:600">${totes}</td>
                        <td style="text-align:center">${miles}</td>
                    `;
                    tbody.appendChild(tr);
                });

                // Daily subtotal row
                const totalTr = document.createElement('tr');
                totalTr.className = 'daily-subtotal';
                totalTr.innerHTML = `
                    <td colspan="7" style="text-align:right;font-weight:700;">Daily Totals:</td>
                    <td style="text-align:center;font-weight:700;">${daySterile}</td>
                    <td style="text-align:center;font-weight:700;">${daySoiled}</td>
                    <td style="text-align:center;font-weight:700;">${dayTotes}</td>
                    <td style="text-align:center;font-weight:700;">${dayMiles.toFixed(1)}</td>
                `;
                tbody.appendChild(totalTr);

                driverTotalMiles += dayMiles;
                driverTotalTotes += dayTotes;
            });

            // Driver grand total row
            const grandTr = document.createElement('tr');
            grandTr.className = 'driver-grand-total';
            grandTr.innerHTML = `
                <td colspan="9" style="text-align:right;font-weight:700;">${driverData.name} — Period Total:</td>
                <td style="text-align:center;font-weight:700;">${driverTotalTotes}</td>
                <td style="text-align:center;font-weight:700;">${driverTotalMiles.toFixed(1)}</td>
            `;
            tbody.appendChild(grandTr);
        }

        document.getElementById('noLogsMessage').style.display = tbody.children.length === 0 ? '' : 'none';

    } catch (err) {
        showToast('Failed to load logs: ' + err.message, 'error');
    }
}

// ---- Admin: Daily Check-In Roster ----
async function loadAdminCheckins(date) {
    const roster = document.getElementById('checkinRoster');
    const summary = document.getElementById('checkinSummary');
    if (!roster) return;

    try {
        const data = await api('/api/admin/checkins' + (date ? `?date=${date}` : ''));
        const isToday = data.date === (serverToday || data.date);
        const checkedInCount = data.drivers.filter(d => d.checkedIn).length;

        if (summary) {
            summary.textContent = `${checkedInCount}/${data.drivers.length} checked in${isToday ? ' today' : ''}`;
        }

        roster.innerHTML = '';
        data.drivers.forEach(d => {
            const routeLabel = routeDefs[d.route]?.label || d.route;
            const routeClass = d.route === 'northbound' ? 'north' : 'south';
            const timeStr = d.checkin_at ? fmtTime(d.checkin_at) : null;

            const item = document.createElement('div');
            item.className = `checkin-row ${d.checkedIn ? 'in' : 'out'}`;
            item.innerHTML = `
                <div class="checkin-row-driver">
                    <span class="checkin-dot"></span>
                    <div>
                        <span class="checkin-row-name">${d.name}</span>
                        <span class="route-tag ${routeClass}">${routeLabel}</span>
                    </div>
                </div>
                <div class="checkin-row-status">
                    ${d.checkedIn
                        ? `<span class="checkin-time">${timeStr}</span><span class="checkin-badge in">Checked in</span>`
                        : `<span class="checkin-badge out">Not checked in</span>`}
                </div>`;
            roster.appendChild(item);
        });
    } catch (err) {
        roster.innerHTML = `<div class="empty-state">Unable to load check-ins.</div>`;
    }
}

// ---- Admin: Check-In History (filter + Daily/Weekly/Monthly) ----
let checkinPeriod = 'day';

function setCheckinPeriod(period) {
    checkinPeriod = period;
    document.querySelectorAll('[data-checkin-period]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.checkinPeriod === period);
    });
    applyCheckinFilters();
}

// Resolve the picked date + period into a { startDate, endDate, label } range
function getCheckinRange() {
    const fp = document.getElementById('checkinHistoryDate')._flatpickr;
    const picked = (fp && fp.selectedDates.length > 0) ? fp.selectedDates[0] : new Date();
    return periodRange(checkinPeriod, picked);
}

async function applyCheckinFilters() {
    const { startDate, endDate, label } = getCheckinRange();
    const driver = document.getElementById('checkinFilterDriver').value;
    const route = document.getElementById('checkinFilterRoute').value;

    const display = document.getElementById('checkinPeriodDisplay');
    if (display) display.textContent = label;

    const params = new URLSearchParams();
    if (driver !== 'all') params.set('driver', driver);
    if (route !== 'all') params.set('route', route);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);

    try {
        const rows = await api(`/api/admin/checkins/history?${params.toString()}`);
        renderCheckinHistory(rows);
    } catch (err) {
        showToast('Failed to load check-in history: ' + err.message, 'error');
    }
}

function renderCheckinHistory(rows) {
    const tbody = document.getElementById('checkinHistoryBody');
    const empty = document.getElementById('noCheckinHistory');
    const summary = document.getElementById('checkinHistorySummary');
    tbody.innerHTML = '';

    if (!rows.length) {
        empty.style.display = '';
        if (summary) summary.textContent = '';
        return;
    }
    empty.style.display = 'none';
    if (summary) summary.textContent = `${rows.length} check-in${rows.length === 1 ? '' : 's'}`;

    // Group by driver
    const byDriver = {};
    rows.forEach(r => {
        if (!byDriver[r.username]) byDriver[r.username] = { name: r.driver_name, route: r.driver_route, items: [] };
        byDriver[r.username].items.push(r);
    });

    for (const driverData of Object.values(byDriver)) {
        const routeLabel = routeDefs[driverData.route]?.label || driverData.route;
        const routeClass = driverData.route === 'northbound' ? 'north' : 'south';

        const header = document.createElement('tr');
        header.className = 'driver-group-header';
        header.innerHTML = `<td colspan="5"><strong>${driverData.name}</strong> <span class="route-tag ${routeClass}">${routeLabel}</span> <span class="checkin-count">${driverData.items.length} day${driverData.items.length === 1 ? '' : 's'}</span></td>`;
        tbody.appendChild(header);

        driverData.items.forEach(r => {
            const dateObj = new Date(r.date + 'T00:00:00');
            const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            const dateFormatted = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td></td>
                <td></td>
                <td>${dateFormatted}</td>
                <td>${dayName}</td>
                <td style="font-weight:600;color:var(--green-700);">${fmtTime(r.checkin_at)}</td>
            `;
            tbody.appendChild(tr);
        });
    }
}

// ---- Excel Export ----
function exportToExcel() {
    const driverFilter = document.getElementById('filterDriver').value;
    const routeFilter = document.getElementById('filterRoute').value;
    const { startDate, endDate } = getAdminDateRange();

    const params = new URLSearchParams();
    if (driverFilter !== 'all') params.set('driver', driverFilter);
    if (routeFilter !== 'all') params.set('route', routeFilter);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);

    // Download from server-side ExcelJS endpoint (matching original Excel format)
    window.location.href = `/api/admin/export?${params.toString()}`;
    showToast('Downloading Excel...', 'success');
}

// Resolve a period ('day' | 'week' | 'month') + a date into { startDate, endDate, label }.
// Week is Monday–Friday to match the rest of the system.
function periodRange(period, dateInput) {
    const picked = dateInput ? new Date(dateInput) : new Date();

    if (period === 'week') {
        const d = new Date(picked);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
        const monday = new Date(d.setDate(diff));
        monday.setHours(0, 0, 0, 0);
        const friday = new Date(monday);
        friday.setDate(friday.getDate() + 4);
        const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return { startDate: formatDate(monday), endDate: formatDate(friday), label: `Week: ${fmt(monday)} — ${fmt(friday)}` };
    }

    if (period === 'month') {
        const d = new Date(picked);
        const first = new Date(d.getFullYear(), d.getMonth(), 1);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        return {
            startDate: formatDate(first),
            endDate: formatDate(last),
            label: `Month: ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
        };
    }

    const ds = formatDate(picked);
    return {
        startDate: ds,
        endDate: ds,
        label: `Day: ${picked.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}`
    };
}

// ---- Utilities ----

// Driver-typed text (extra leg names) is escaped before it goes into markup.
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
}

// Display label for a saved log row: standard legs come from the route
// definition, extra legs carry their own from/to. Returns null for rows that
// belong to neither (e.g. a leg removed from the schedule).
function legLabelOf(route, log) {
    const leg = route.legs[log.leg_index];
    if (leg) return `${escapeHtml(leg.from)} &rarr; ${escapeHtml(leg.to)}`;
    if (log.leg_from || log.leg_to) {
        return `${escapeHtml(log.leg_from || '—')} &rarr; ${escapeHtml(log.leg_to || '—')} <span class="extra-badge">Extra</span>`;
    }
    return null;
}

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', checkSession);
