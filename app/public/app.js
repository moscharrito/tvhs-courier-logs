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
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginUser').value.trim().toLowerCase();
    const password = document.getElementById('loginPass').value;

    try {
        currentUser = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });

        if (currentUser.role === 'admin') {
            showScreen('adminScreen');
            initAdmin();
        } else {
            showScreen('driverScreen');
            initDriver();
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
    return false;
}

async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    currentUser = null;
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    showScreen('loginScreen');
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// ---- Session Check on Load ----
async function checkSession() {
    try {
        currentUser = await api('/api/session');
        routeDefs = await api('/api/routes');

        if (currentUser.role === 'admin') {
            showScreen('adminScreen');
            initAdmin();
        } else {
            showScreen('driverScreen');
            initDriver();
        }
    } catch (e) {
        showScreen('loginScreen');
    }
}

// ---- Driver View Toggle ----
let driverHistoryPeriod = 'week';

function showDriverView(view) {
    document.getElementById('navTabEntry').classList.toggle('active', view === 'entry');
    document.getElementById('navTabHistory').classList.toggle('active', view === 'history');
    document.getElementById('driverEntryView').style.display = view === 'entry' ? '' : 'none';
    document.getElementById('driverHistoryView').style.display = view === 'history' ? '' : 'none';

    if (view === 'history') {
        initHistoryPicker();
    }
}

// ---- Driver Interface ----
async function initDriver() {
    if (!routeDefs || !Object.keys(routeDefs).length) {
        routeDefs = await api('/api/routes');
    }

    document.getElementById('driverNameDisplay').textContent = currentUser.name;
    const route = routeDefs[currentUser.route];
    document.getElementById('driverRouteDisplay').textContent = route.label;

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
            const routeLeg = route.legs[log.leg_index];
            if (!routeLeg) return;

            const totes = (parseInt(log.sterile) || 0) + (parseInt(log.soiled) || 0);
            const miles = parseFloat(log.miles) || 0;
            dayMiles += miles;
            dayTotes += totes;

            if (log.start_time && log.end_time) totalRoutes++;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${dateFormatted}</td>
                <td>${dayName}</td>
                <td>${routeLeg.from} &rarr; ${routeLeg.to}</td>
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

function buildLogTable(dateStr) {
    const route = routeDefs[currentUser.route];
    const dayLogs = weekLogCache[dateStr] || [];

    const tbody = document.getElementById('logTableBody');
    tbody.innerHTML = '';

    route.legs.forEach((leg, i) => {
        // Find existing log for this leg
        const existing = dayLogs.find(l => l.leg_index === i);
        const startTime = existing ? existing.start_time : '';
        const endTime = existing ? existing.end_time : '';
        const sterile = existing ? existing.sterile : 0;
        const soiled = existing ? existing.soiled : 0;
        const miles = existing ? existing.miles : 0;
        const totalTotes = (parseInt(sterile) || 0) + (parseInt(soiled) || 0);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div class="route-label">
                    <span class="route-index">${i + 1}</span>
                    ${leg.from} <span class="route-arrow">&#9654;</span> ${leg.to}
                </div>
            </td>
            <td><input type="time" value="${startTime}" data-leg="${i}" data-field="startTime" onchange="onCellChange(this)"></td>
            <td><input type="time" value="${endTime}" data-leg="${i}" data-field="endTime" onchange="onCellChange(this)"></td>
            <td><input type="number" min="0" value="${sterile}" data-leg="${i}" data-field="sterile" onchange="onCellChange(this)" oninput="updateTotals()"></td>
            <td><input type="number" min="0" value="${soiled}" data-leg="${i}" data-field="soiled" onchange="onCellChange(this)" oninput="updateTotals()"></td>
            <td><div class="auto-cell" id="totes-${i}">${totalTotes}</div></td>
            <td><input type="number" min="0" step="0.1" value="${miles}" data-leg="${i}" data-field="miles" onchange="onCellChange(this)" oninput="updateTotals()"></td>
        `;
        tbody.appendChild(tr);
    });

    updateTotals();
}

function onCellChange(input) {
    if (input.dataset.field === 'sterile' || input.dataset.field === 'soiled') {
        updateTotals();
    }
}

function updateTotals() {
    const route = routeDefs[currentUser.route];
    let totalSterile = 0, totalSoiled = 0, totalTotes = 0, totalMiles = 0;

    route.legs.forEach((leg, i) => {
        const sterile = parseInt(document.querySelector(`[data-leg="${i}"][data-field="sterile"]`)?.value) || 0;
        const soiled = parseInt(document.querySelector(`[data-leg="${i}"][data-field="soiled"]`)?.value) || 0;
        const miles = parseFloat(document.querySelector(`[data-leg="${i}"][data-field="miles"]`)?.value) || 0;
        const totes = sterile + soiled;

        const totesCell = document.getElementById(`totes-${i}`);
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
    const route = routeDefs[currentUser.route];
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + currentDayIndex);
    const dateStr = formatDate(dayDate);

    const legs = route.legs.map((leg, i) => ({
        startTime: document.querySelector(`[data-leg="${i}"][data-field="startTime"]`)?.value || '',
        endTime: document.querySelector(`[data-leg="${i}"][data-field="endTime"]`)?.value || '',
        sterile: parseInt(document.querySelector(`[data-leg="${i}"][data-field="sterile"]`)?.value) || 0,
        soiled: parseInt(document.querySelector(`[data-leg="${i}"][data-field="soiled"]`)?.value) || 0,
        miles: parseFloat(document.querySelector(`[data-leg="${i}"][data-field="miles"]`)?.value) || 0,
    }));

    try {
        await api('/api/logs', {
            method: 'POST',
            body: JSON.stringify({ date: dateStr, legs })
        });

        // Update local cache
        weekLogCache[dateStr] = legs.map((l, i) => ({
            leg_index: i,
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
    const route = routeDefs[currentUser.route];
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + currentDayIndex);
    const dateStr = formatDate(dayDate);

    try {
        await api('/api/logs', {
            method: 'DELETE',
            body: JSON.stringify({ date: dateStr })
        });

        delete weekLogCache[dateStr];

        // Reset UI fields
        route.legs.forEach((_, i) => {
            const st = document.querySelector(`[data-leg="${i}"][data-field="startTime"]`);
            const et = document.querySelector(`[data-leg="${i}"][data-field="endTime"]`);
            const se = document.querySelector(`[data-leg="${i}"][data-field="sterile"]`);
            const so = document.querySelector(`[data-leg="${i}"][data-field="soiled"]`);
            const mi = document.querySelector(`[data-leg="${i}"][data-field="miles"]`);
            if (st) st.value = '';
            if (et) et.value = '';
            if (se) se.value = 0;
            if (so) so.value = 0;
            if (mi) mi.value = 0;
        });

        updateTotals();
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

    // Populate driver filter dynamically
    try {
        const drivers = await api('/api/admin/drivers');
        const select = document.getElementById('filterDriver');
        select.innerHTML = '<option value="all">All Drivers</option>';
        drivers.forEach(d => {
            const routeLabel = routeDefs[d.route]?.label || d.route;
            const opt = document.createElement('option');
            opt.value = d.username;
            opt.textContent = `${d.name} (${routeLabel})`;
            select.appendChild(opt);
        });
    } catch (e) { /* fallback: just "All Drivers" */ }

    applyFilters();
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
                    const routeLeg = route.legs[log.leg_index];
                    if (!routeLeg) return;
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
                        <td>${routeLeg.from} &rarr; ${routeLeg.to}</td>
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

// ---- Utilities ----
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
