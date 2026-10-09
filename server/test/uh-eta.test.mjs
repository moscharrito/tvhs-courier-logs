/* Roughly when a delivery will arrive.
 *
 * The property behind every one of these: no patient address leaves this
 * system to produce the number. It is a position in the courier's queue
 * multiplied by what a stop has been taking, and where it cannot say that
 * honestly it refuses instead of guessing. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { minutesPerStop, etaFor, MIN_SAMPLES, MAX_USEFUL_MINUTES } from '../src/modules/uh/eta.ts';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

let srv, admin, client, discharge, pharmacist, projectId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
    /* Looked up rather than assumed to be 1: TVHS is also a project in
       this database, and the ids depend on the order they were created. */
    projectId = Number((await client.execute({ sql: "SELECT id FROM projects WHERE code = 'uh'" })).rows[0].id);
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');

    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    await admin.post('/api/users').send({ username: 'uh.pharmacist', name: 'A Pharmacist', password: 'client-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });

    pharmacist = srv.agent();
    await pharmacist.post('/api/login').send({ username: 'uh.pharmacist', password: 'client-pass-1' });
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
async function order(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: discharge.id, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Rehearsal Way`, zip: '78215', description: 'Oral solids',
        quantity: 1, externalRef: `ETA-${seq}`, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
}

const eta = (o, now) => etaFor(client, {
    projectId, orderId: o.id, status: o.status ?? 'ready',
    arrivedAt: o.arrivedAt ?? null, pickupAt: o.pickupAt ?? null,
}, now);

/* Completed stops for the learner to work from: pairs of deliveries on one
   run, a known number of minutes apart. */
async function teachHistory(gapMinutes, howMany) {
    const runRes = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'History', orderIds: [] });
    const runId = runRes.body?.id;
    let at = Date.parse('2026-09-20T14:00:00.000Z');
    for (let i = 0; i < howMany + 1; i += 1) {
        const o = await order();
        await client.execute({
            sql: 'UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?',
            args: ['delivered', new Date(at).toISOString(), o.id],
        });
        await client.execute({
            sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
            args: [projectId, runId, o.id, i + 1],
        });
        at += gapMinutes * 60000;
    }
}

describe('what it refuses to estimate', () => {
    it('says nothing when the delivery is not in a run', async () => {
        const o = await order();
        const got = await eta(o);
        expect(got.basis).toBe('no_run');
        expect(got.minutes).toBeNull();
        expect(got.note).toMatch(/not yet planned/i);
    });

    it('says nothing before the medication has been collected', async () => {
        const o = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [o.id] });
        const got = await eta({ ...o, pickupAt: null });
        expect(got.basis).toBe('not_collected');
        expect(got.minutes).toBeNull();
    });

    it('says nothing once the courier is at the door', async () => {
        const o = await order();
        const got = await eta({ ...o, arrivedAt: '2026-09-20T15:00:00.000Z', pickupAt: '2026-09-20T14:00:00.000Z' });
        expect(got.basis).toBe('arrived');
        expect(got.minutes).toBeNull();
    });

    it('says nothing about a delivery that is already finished', async () => {
        const o = await order();
        for (const status of ['delivered', 'failed', 'cancelled']) {
            const got = await eta({ ...o, status, pickupAt: '2026-09-20T14:00:00.000Z' });
            expect(got.minutes, status).toBeNull();
        }
    });

    it('refuses rather than inventing a median from two stops', async () => {
        /* A pharmacist reading "we cannot estimate this yet" is better served
           than one reading a confident number derived from nothing. */
        expect(await minutesPerStop(client, projectId, new Date('2026-09-21T00:00:00.000Z'))).toBeNull();
        expect(MIN_SAMPLES).toBeGreaterThanOrEqual(5);
    });
});

describe('what it learns from', () => {
    it('takes the median gap between consecutive stops on one run', async () => {
        await teachHistory(12, MIN_SAMPLES + 2);
        const perStop = await minutesPerStop(client, projectId, new Date('2026-09-21T00:00:00.000Z'));
        expect(perStop).toBe(12);
    });

    it('ignores a gap that is a lunch break rather than a stop', async () => {
        /* Over two hours between two completions is a break, a shift change
           or a correction. None of them describes how long a stop takes. */
        const runRes = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Break', orderIds: [] });
        const runId = runRes.body?.id;
        let at = Date.parse('2026-09-20T20:00:00.000Z');
        for (const gap of [0, 600, 600]) {
            const o = await order();
            at += gap * 60000;
            await client.execute({ sql: 'UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?', args: ['delivered', new Date(at).toISOString(), o.id] });
            await client.execute({ sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)', args: [projectId, runId, o.id, 1] });
        }
        // The twelve-minute history above still rules; the ten-hour gaps are gone.
        expect(await minutesPerStop(client, projectId, new Date('2026-09-21T00:00:00.000Z'))).toBe(12);
    });
});

describe('the estimate itself', () => {
    it('counts the stops ahead and multiplies by what a stop takes', async () => {
        const ahead1 = await order();
        const ahead2 = await order();
        const mine = await order();
        const runRes = await admin.post(RUNS).send({
            courierUsername: 'ada.courier', label: 'Today',
            orderIds: [ahead1.id, ahead2.id, mine.id],
        });
        expect(runRes.status, JSON.stringify(runRes.body)).toBe(201);

        const got = await eta({ ...mine, status: 'picked_up', pickupAt: '2026-09-20T14:00:00.000Z' },
            new Date('2026-09-21T00:00:00.000Z'));

        expect(got.basis).toBe('estimated');
        expect(got.stopsAhead).toBe(2);
        // Two ahead plus its own drive, at the twelve minutes it learned.
        expect(got.minutes).toBe(36);
    });

    it('still allows for a drive when nothing is ahead of it', async () => {
        const mine = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Solo', orderIds: [mine.id] });
        const got = await eta({ ...mine, status: 'picked_up', pickupAt: '2026-09-20T14:00:00.000Z' },
            new Date('2026-09-21T00:00:00.000Z'));

        expect(got.stopsAhead).toBe(0);
        // A courier with nothing ahead of them is still travelling to the door.
        expect(got.minutes).toBe(12);
        expect(got.note).toMatch(/on the way now/i);
    });

    it('speaks in stops rather than in a clock time', async () => {
        /* A clock time reads like a promise. This is an average multiplied by
           a queue position and it says so. */
        const ahead = await order();
        const mine = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Two', orderIds: [ahead.id, mine.id] });
        const got = await eta({ ...mine, status: 'picked_up', pickupAt: '2026-09-20T14:00:00.000Z' },
            new Date('2026-09-21T00:00:00.000Z'));
        expect(got.note).toContain('1 stop ahead of it');
        expect(got.note).not.toMatch(/\d{1,2}:\d{2}/);
    });

    it('declines to estimate something hours out', async () => {
        expect(MAX_USEFUL_MINUTES).toBeLessThanOrEqual(240);
        const many = [];
        for (let i = 0; i < 25; i += 1) many.push((await order()).id);
        const mine = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Long', orderIds: [...many, mine.id] });

        const got = await eta({ ...mine, status: 'picked_up', pickupAt: '2026-09-20T14:00:00.000Z' },
            new Date('2026-09-21T00:00:00.000Z'));
        expect(got.basis).toBe('too_far');
        expect(got.minutes).toBeNull();
        // It still says how many stops, which is the useful half.
        expect(got.stopsAhead).toBe(25);
    });
});

describe('what the pharmacy is shown', () => {
    it('carries the estimate and its basis on the delivery', async () => {
        const o = await order();
        const res = await pharmacist.get(`${UH}/client/orders/${o.id}`);
        expect(res.status).toBe(200);
        expect(res.body.eta).toBeTruthy();
        expect(typeof res.body.eta.basis).toBe('string');
        // Not planned yet, so it says that rather than showing a figure.
        expect(res.body.eta.minutes).toBeNull();
        expect(res.body.eta.note).toMatch(/not yet planned/i);
    });
});
