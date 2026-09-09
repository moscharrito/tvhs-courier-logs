import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

// A full northbound day: 6 standard legs + 1 driver-added extra leg
function northDay() {
    return [
        { startTime: '05:00', endTime: '06:30', sterile: 4, soiled: 0, miles: 80 },
        { startTime: '06:40', endTime: '07:00', sterile: 0, soiled: 3, miles: 15 },
        { startTime: '07:10', endTime: '07:30', sterile: 2, soiled: 0, miles: 15 },
        { startTime: '07:40', endTime: '09:10', sterile: 0, soiled: 5, miles: 80 },
        { startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 },
        { startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 },
        { legFrom: 'Murfreesboro', legTo: 'Smyrna', startTime: '10:00', endTime: '10:30', sterile: 1, soiled: 1, miles: 12.5 },
    ];
}

describe('route definitions', () => {
    it('exposes the two fixed routes with their legs and default miles', async () => {
        const a = await srv.login('north');
        const res = await a.get('/api/routes');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body)).toEqual(['northbound', 'southbound']);
        expect(res.body.northbound.label).toBe('NorthBound');
        expect(res.body.northbound.legs).toHaveLength(6);
        expect(res.body.northbound.legs[0]).toEqual({ from: 'Murfreesboro', to: 'Clarksville', defaultMiles: 80 });
        expect(res.body.southbound.legs).toHaveLength(4);
        expect(res.body.southbound.legs[0]).toEqual({ from: 'Murfreesboro', to: 'Chattanooga', defaultMiles: 122.6 });
    });
});

describe('driver daily logs', () => {
    it('rejects a save without date or legs', async () => {
        const a = await srv.login('north');
        expect((await a.post('/api/logs').send({ legs: [] })).status).toBe(400);
        expect((await a.post('/api/logs').send({ date: '2026-01-05' })).status).toBe(400);
    });

    it('saves standard and extra legs, coercing numbers and storing extra leg labels', async () => {
        const a = await srv.login('north');
        const save = await a.post('/api/logs').send({ date: '2026-01-05', legs: northDay() });
        expect(save.status).toBe(200);
        expect(save.body).toEqual({ ok: true });

        const rows = (await a.get('/api/logs?startDate=2026-01-05&endDate=2026-01-05')).body;
        expect(rows).toHaveLength(7);
        expect(rows.map(r => r.leg_index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(rows[0]).toMatchObject({ username: 'north.driver', date: '2026-01-05', start_time: '05:00', end_time: '06:30', sterile: 4, soiled: 0, miles: 80, leg_from: '', leg_to: '' });
        expect(rows[6]).toMatchObject({ leg_index: 6, leg_from: 'Murfreesboro', leg_to: 'Smyrna', sterile: 1, soiled: 1, miles: 12.5 });
    });

    it('coerces malformed numeric input to zero and truncates long labels to 60 chars', async () => {
        const a = await srv.login('south');
        const legs = [
            { startTime: '05:00', endTime: '08:00', sterile: 'abc', soiled: null, miles: 'x' },
            { legFrom: 'A'.repeat(100), legTo: '  B  ', startTime: '', endTime: '', sterile: 2, soiled: 2, miles: 1 },
        ];
        // southbound has 4 standard legs; index 1 here is still a standard slot, labels are stored regardless
        expect((await a.post('/api/logs').send({ date: '2026-01-05', legs })).status).toBe(200);
        const rows = (await a.get('/api/logs?startDate=2026-01-05&endDate=2026-01-05')).body;
        expect(rows[0]).toMatchObject({ sterile: 0, soiled: 0, miles: 0 });
        expect(rows[1].leg_from).toHaveLength(60);
        expect(rows[1].leg_to).toBe('B');
    });

    it('re-saving with fewer legs upserts the rest and deletes the dropped extra legs', async () => {
        const a = await srv.login('north');
        const shorter = northDay().slice(0, 6);
        shorter[0].miles = 81;
        expect((await a.post('/api/logs').send({ date: '2026-01-05', legs: shorter })).status).toBe(200);

        const rows = (await a.get('/api/logs?startDate=2026-01-05&endDate=2026-01-05')).body;
        expect(rows).toHaveLength(6);
        expect(rows[0].miles).toBe(81);
        expect(rows.find(r => r.leg_index === 6)).toBeUndefined();
    });

    it('a driver only ever sees their own logs even when asking for another username', async () => {
        const south = await srv.login('south');
        const rows = (await south.get('/api/logs?username=north.driver&startDate=2026-01-05&endDate=2026-01-05')).body;
        expect(rows.every(r => r.username === 'south.driver')).toBe(true);
        expect(rows).toHaveLength(2);
    });

    it('DELETE clears a whole day for the driver', async () => {
        const a = await srv.login('south');
        expect((await a.delete('/api/logs').send({})).status).toBe(400);
        expect((await a.delete('/api/logs').send({ date: '2026-01-05' })).body).toEqual({ ok: true });
        expect((await a.get('/api/logs?startDate=2026-01-05&endDate=2026-01-05')).body).toHaveLength(0);
    });
});

describe('admin log views', () => {
    beforeAll(async () => {
        // Seed a second day for north and a day for south so filters have something to bite on
        const north = await srv.login('north');
        await north.post('/api/logs').send({ date: '2026-01-06', legs: northDay() });
        const south = await srv.login('south');
        await south.post('/api/logs').send({
            date: '2026-01-06',
            legs: [{ startTime: '06:00', endTime: '08:30', sterile: 6, soiled: 0, miles: 122.6 }, { startTime: '09:00', endTime: '11:30', sterile: 0, soiled: 6, miles: 123 }]
        });
    });

    it('admin can read any driver by username', async () => {
        const admin = await srv.login('admin');
        const rows = (await admin.get('/api/logs?username=south.driver&startDate=2026-01-06&endDate=2026-01-06')).body;
        expect(rows).toHaveLength(2);
        expect(rows[0].username).toBe('south.driver');
    });

    it('lists all logs joined to driver name and route, ordered by date, driver, leg', async () => {
        const admin = await srv.login('admin');
        const rows = (await admin.get('/api/admin/logs?startDate=2026-01-01&endDate=2026-01-31')).body;
        expect(rows).toHaveLength(6 + 7 + 2);
        expect(rows[0]).toMatchObject({ date: '2026-01-05', driver_name: 'Bereket Nigusse', driver_route: 'northbound', leg_index: 0 });
        const jan6 = rows.filter(r => r.date === '2026-01-06');
        expect(jan6[0].username).toBe('north.driver');
        expect(jan6[jan6.length - 1].username).toBe('south.driver');
    });

    it('filters by driver, by route and by date range', async () => {
        const admin = await srv.login('admin');
        expect((await admin.get('/api/admin/logs?route=southbound')).body).toHaveLength(2);
        expect((await admin.get('/api/admin/logs?driver=north.driver&startDate=2026-01-06')).body).toHaveLength(7);
        expect((await admin.get('/api/admin/logs?driver=all&route=all&endDate=2026-01-05')).body).toHaveLength(6);
    });

    it('stats count drivers, distinct log days, miles and totes', async () => {
        const admin = await srv.login('admin');
        const s = (await admin.get('/api/admin/stats')).body;
        expect(s.drivers).toBe(2);
        expect(s.logEntries).toBe(3);                 // north Jan 5, north Jan 6, south Jan 6
        expect(s.totalMiles).toBeCloseTo(191 + 202.5 + 245.6, 5); // north Jan 5 (re-saved, 81 on leg 0) + north Jan 6 + south Jan 6
        expect(s.totalTotes).toBe(14 + 16 + 12);
    });

    it('driver list for admin filters', async () => {
        const admin = await srv.login('admin');
        const d = (await admin.get('/api/admin/drivers')).body;
        expect(d).toEqual([
            { username: 'north.driver', name: 'Bereket Nigusse', route: 'northbound' },
            { username: 'south.driver', name: 'Mohamed Djemai', route: 'southbound' },
        ]);
    });
});
