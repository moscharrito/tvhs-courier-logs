/* Roughly when a delivery will arrive.
 *
 * The property behind every one of these: no patient address leaves this
 * system to produce the number. It is a position in the courier's queue
 * multiplied by what a stop has been taking, and where it cannot say that
 * honestly it refuses instead of guessing. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { minutesPerStop, etaFor, etasFor, forgetMedians, MIN_SAMPLES, MAX_USEFUL_MINUTES } from '../src/modules/uh/eta.ts';

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

/* ───────────────────────────────────────────── a page at a time
 *
 * The estimate was computed for one delivery and shown on no screen, which
 * made "track our deliveries" something a pharmacy could only do one row at a
 * time. Putting it on the list is only useful if the list stays quick, so
 * these hold the query count as well as the figures.
 */
describe('the whole page at once', () => {
    /* A stand-in that records what was asked, so "three queries, not three a
       row" is a test rather than a claim in a comment. */
    const counting = () => {
        const calls = [];
        return { calls, client: { execute: (q) => { calls.push(q); return client.execute(q); } } };
    };

    const input = (o, over = {}) => ({
        projectId, orderId: o.id, status: o.status ?? 'ready',
        arrivedAt: null, pickupAt: null, ...over,
    });

    it('answers every row it is given', async () => {
        const some = [await order(), await order(), await order()];
        const got = await etasFor(client, projectId, some.map((o) => input(o)));
        expect(got.size).toBe(3);
        for (const o of some) expect(got.get(o.id).basis, `#${o.id}`).toBe('no_run');
    });

    it('spends nothing at all on deliveries that are already finished', async () => {
        /* Forty delivered rows is what a pharmacy's afternoon looks like. The
           answer needs no lookup, so it should cost no lookup. */
        const spy = counting();
        const inputs = [];
        for (let i = 1; i <= 40; i += 1) {
            inputs.push({ projectId, orderId: 900000 + i, status: 'delivered', arrivedAt: null, pickupAt: null });
        }
        const got = await etasFor(spy.client, projectId, inputs);
        expect(spy.calls.length).toBe(0);
        expect(got.size).toBe(40);
        expect(got.get(900001).basis).toBe('arrived');
    });

    it('costs three queries for a page rather than three a row', async () => {
        const ids = [];
        for (let i = 0; i < 20; i += 1) ids.push((await order()).id);
        const runRes = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Page', orderIds: ids });
        expect(runRes.status, JSON.stringify(runRes.body)).toBe(201);

        forgetMedians();
        const spy = counting();
        const page = ids.map((id) => ({
            projectId, orderId: id, status: 'picked_up',
            arrivedAt: null, pickupAt: '2026-09-20T14:00:00.000Z',
        }));
        const at = new Date('2026-09-21T00:00:00.000Z');
        const got = await etasFor(spy.client, projectId, page, at);

        expect(got.size).toBe(20);
        /* The placements, the median, and the open stops on the runs those
           touch. Twenty rows the old way would have been sixty. */
        expect(spy.calls.length).toBe(3);

        /* And the portal reloads every twenty seconds. The median is a
           four-week figure that cannot have moved, so the second poll does
           not read four weeks of stops again. */
        const again = counting();
        await etasFor(again.client, projectId, page, at);
        expect(again.calls.length).toBe(2);
    });

    it('learns the median again once what it remembered is stale', async () => {
        /* Ten minutes, so a project that starts delivering does not look
           unestimable all afternoon. Asked about a different four weeks is a
           different question, which is also how the tests above get a fresh
           answer while the live endpoint gets a cached one. */
        const mine = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Stale', orderIds: [mine.id] });
        const one = [{
            projectId, orderId: mine.id, status: 'picked_up',
            arrivedAt: null, pickupAt: '2026-09-20T14:00:00.000Z',
        }];

        forgetMedians();
        await etasFor(client, projectId, one, new Date('2026-09-21T00:00:00.000Z'));
        const spy = counting();
        await etasFor(spy.client, projectId, one, new Date('2026-09-21T01:00:00.000Z'));
        expect(spy.calls.length).toBe(3);
    });

    it('gives the same answer as opening that one delivery', async () => {
        const ahead = await order();
        const mine = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Agree', orderIds: [ahead.id, mine.id] });
        const one = { projectId, orderId: mine.id, status: 'picked_up', arrivedAt: null, pickupAt: '2026-09-20T14:00:00.000Z' };
        const at = new Date('2026-09-21T00:00:00.000Z');

        const batched = (await etasFor(client, projectId, [one], at)).get(mine.id);
        const alone = await etaFor(client, one, at);
        expect(batched).toEqual(alone);
        expect(batched.basis).toBe('estimated');
    });

    it('cannot be looking at two runs, because a stop belongs to one', async () => {
        /* Both lookups pick the newest run_stops row for an order, which
           sounds like it decides something and does not: the schema allows
           only one. Asserted so that the day somebody relaxes the index to
           let a delivery be replanned, this is a failing test rather than a
           silent choice of whichever row came back first. */
        const mine = await order();
        const first = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'First plan', orderIds: [mine.id] });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const second = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Second plan', orderIds: [] });

        await expect(client.execute({
            sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
            args: [projectId, second.body.id, mine.id, 1],
        })).rejects.toThrow(/UNIQUE/i);
    });
});

describe('the list the pharmacy actually reads', () => {
    /* The history the rest of this file teaches is dated September, and the
       endpoint learns from the real clock: twenty-eight days back, which is
       what LEARN_DAYS is for. A list test therefore needs its own recent
       history or the server honestly answers "not enough completed stops". */
    async function teachRecentHistory(gapMinutes, howMany) {
        const runRes = await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Recent', orderIds: [] });
        let at = Date.now() - (howMany + 2) * gapMinutes * 60000;
        for (let i = 0; i < howMany + 1; i += 1) {
            const o = await order();
            await client.execute({
                sql: 'UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?',
                args: ['delivered', new Date(at).toISOString(), o.id],
            });
            await client.execute({
                sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
                args: [projectId, runRes.body.id, o.id, i + 1],
            });
            at += gapMinutes * 60000;
        }
    }

    it('carries how far away each delivery is', async () => {
        await teachRecentHistory(10, MIN_SAMPLES + 2);
        const ahead = await order();
        const mine = await order();
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'On the list', orderIds: [ahead.id, mine.id] });
        /* Collected, so there is a journey to be part of. */
        await client.execute({
            sql: "UPDATE orders SET status = 'picked_up', pickup_at = ? WHERE id IN (?, ?)",
            args: [new Date().toISOString(), ahead.id, mine.id],
        });

        const res = await pharmacist.get(`${UH}/client/orders`);
        expect(res.status).toBe(200);
        /* Every row, not only the ones with a figure: a missing key reads as
           "no estimate" to one caller and throws in another. */
        for (const row of res.body.orders) expect(row.eta, `#${row.id}`).toBeTruthy();

        const row = res.body.orders.find((o) => o.id === mine.id);
        expect(row.eta.basis).toBe('estimated');
        expect(row.eta.stopsAhead).toBe(1);
        expect(row.eta.minutes).toBeGreaterThan(0);
        // A queue position, not a clock time. See the module header.
        expect(row.eta.note).not.toMatch(/\d{1,2}:\d{2}/);
    });

    /* Whether it stays off the spreadsheet is asserted in
       uh-client-export.test.mjs, where the workbook is actually opened. */
});
