import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

describe('driver check-in', () => {
    it('reports not checked in before the first check-in', async () => {
        const a = await srv.login('north');
        const res = await a.get('/api/checkin?date=2026-01-05');
        expect(res.body).toEqual({ checkedIn: false, checkin_at: null, date: '2026-01-05' });
    });

    it('checks in for a client-supplied date and is idempotent', async () => {
        const a = await srv.login('north');
        const first = await a.post('/api/checkin').send({ date: '2026-01-05' });
        expect(first.status).toBe(200);
        expect(first.body.checkedIn).toBe(true);
        expect(first.body.date).toBe('2026-01-05');
        expect(first.body.alreadyCheckedIn).toBeUndefined();
        expect(new Date(first.body.checkin_at).toString()).not.toBe('Invalid Date');

        const second = await a.post('/api/checkin').send({ date: '2026-01-05' });
        expect(second.status).toBe(200);
        expect(second.body.alreadyCheckedIn).toBe(true);
        expect(second.body.checkin_at).toBe(first.body.checkin_at);
    });

    it('falls back to the server date when the client date is invalid', async () => {
        const a = await srv.login('south');
        const cfg = await a.get('/api/config');
        const res = await a.post('/api/checkin').send({ date: 'not-a-date' });
        expect(res.status).toBe(200);
        expect(res.body.date).toBe(cfg.body.today);
    });

    it('returns own history in date order and honours the range filters', async () => {
        const a = await srv.login('north');
        await a.post('/api/checkin').send({ date: '2026-01-07' });
        await a.post('/api/checkin').send({ date: '2026-01-06' });

        const all = await a.get('/api/checkins/history?startDate=2026-01-01&endDate=2026-01-31');
        expect(all.body.map(r => r.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);

        const narrowed = await a.get('/api/checkins/history?startDate=2026-01-06');
        expect(narrowed.body.map(r => r.date)).toEqual(['2026-01-06', '2026-01-07']);
    });
});

describe('admin check-in views', () => {
    it('roster lists every driver with their status for the date', async () => {
        const admin = await srv.login('admin');
        const res = await admin.get('/api/admin/checkins?date=2026-01-05');
        expect(res.status).toBe(200);
        expect(res.body.date).toBe('2026-01-05');
        const byRoute = Object.fromEntries(res.body.drivers.map(d => [d.route, d]));
        expect(byRoute.northbound).toMatchObject({ name: 'Bereket Nigusse', checkedIn: true });
        expect(byRoute.northbound.checkin_at).toBeTruthy();
        expect(byRoute.southbound).toMatchObject({ name: 'Mohamed Djemai', checkedIn: false, checkin_at: null });
    });

    it('history filters by driver, route and date range', async () => {
        const admin = await srv.login('admin');

        const all = await admin.get('/api/admin/checkins/history?startDate=2026-01-01&endDate=2026-01-31');
        expect(all.body).toHaveLength(3);
        expect(all.body[0]).toMatchObject({ username: 'north.driver', driver_name: 'Bereket Nigusse', driver_route: 'northbound' });

        const byRoute = await admin.get('/api/admin/checkins/history?route=southbound&startDate=2026-01-01&endDate=2026-01-31');
        expect(byRoute.body).toHaveLength(0);

        const byDriver = await admin.get('/api/admin/checkins/history?driver=north.driver&startDate=2026-01-06&endDate=2026-01-06');
        expect(byDriver.body.map(r => r.date)).toEqual(['2026-01-06']);

        const allKeyword = await admin.get('/api/admin/checkins/history?driver=all&route=all&startDate=2026-01-01&endDate=2026-01-31');
        expect(allKeyword.body).toHaveLength(3);
    });
});
