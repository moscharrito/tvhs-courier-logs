/* Proposing the noon wave.
 *
 * The clustering itself is tested against a Tuesday in uh-cluster.test.mjs,
 * which needs no database. What is tested here is the part that only a real
 * server can answer: that the endpoint reads the right orders, that it
 * writes nothing, and that the proposal it hands back can be turned into
 * actual runs by the path that already exists.
 *
 * The last one matters most. A proposal whose orderIds POST /runs will
 * reject is a proposal that wasted a dispatcher's noon. Names are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const RUNS = '/api/projects/uh/uh/runs';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
let dischargeId;
let greenId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    greenId = sites.find((s) => s.code === 'green').id;
    await admin.post('/api/users').send({
        username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver',
    });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
async function makeOrder(over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        /* Ad hoc, not scheduled: POST /orders takes the work that is
           phoned in, and scheduled deliveries only arrive on a
           pharmacy's daily list. Clustering treats both the same -- the
           only service type it separates out is STAT. */
        siteId: dischargeId, serviceType: 'adhoc',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `RX-${9000 + seq}`, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

const propose = (query = '') => admin.get(`${RUNS}/propose${query}`);

describe('the proposal', () => {
    it('groups the unassigned work and says what it did', async () => {
        const made = [];
        for (let i = 0; i < 6; i += 1) made.push(await makeOrder({ zip: '78215' }));

        const res = await propose();
        expect(res.status).toBe(200);
        expect(res.body.runs.length).toBeGreaterThan(0);

        const mine = new Set(made.map((o) => o.id));
        const onRuns = res.body.runs.flatMap((r) => r.orderIds).filter((id) => mine.has(id));
        expect(onRuns.length).toBe(made.length);
    });

    it('plans for the people on the roster, not for a number in the contract', async () => {
        /* It used to default to eighteen -- the fleet in the contract rather
           than the one standing in a car park -- so a morning with five
           drivers produced a plan that could not be driven and the
           dispatcher found out by assigning it. */
        const res = await propose();
        expect(res.body.settings.drivers).toBe(res.body.fleet.roster);
        expect(res.body.fleet.roster).toBeGreaterThan(0);
    });

    it('says whether the plan was built from people or from a list', async () => {
        /* Nobody has tapped Go on shift in this file, so it falls back to
           the roster -- and has to say so. A plan built from a list of who
           normally drives is a different thing from one built from who
           turned up, and a dispatcher acting on it needs to know which. */
        const res = await propose();
        expect(res.body.planningFrom).toBe('roster');
        expect(res.body.fleet.onShift).toBe(0);
        expect(res.body.notes.join(' ')).toMatch(/nobody is on shift/i);
    });

    it('puts a name on each proposed run', async () => {
        /* The point of the exercise. A dispatcher picking twenty-three
           couriers out of a dropdown one at a time is the slowest part of
           the morning, and it happens while deadlines run. */
        const res = await propose();
        expect(res.body.suggested).toHaveLength(res.body.runs.length);
        const named = res.body.suggested.filter(Boolean);
        expect(named.length).toBeGreaterThan(0);
        for (const s of named) {
            expect(typeof s.username).toBe('string');
            expect(['home', 'floater', 'cover']).toContain(s.why);
        }
    });

    it('writes nothing, so reading it twice is the same as reading it once', async () => {
        /* The whole reason it is a GET. A dispatcher must be able to look at
           what eighteen people's day would be without that being the day. */
        const before = await propose();
        const runsBefore = (await admin.get(RUNS)).body;

        const again = await propose();
        const runsAfter = (await admin.get(RUNS)).body;

        expect(again.body.runs).toEqual(before.body.runs);
        expect(runsAfter.length).toBe(runsBefore.length);
    });

    it('leaves out work somebody is already carrying', async () => {
        /* An order on a run belongs to a courier who may have collected it.
           Proposing it to somebody else is how a package is in two places. */
        const order = await makeOrder({ zip: '78224' });
        const run = (await admin.post(RUNS).send({
            courierUsername: 'ada.courier', label: 'Already out', orderIds: [order.id],
        })).body;
        expect(run.id).toBeGreaterThan(0);

        const res = await propose();
        expect(res.body.runs.flatMap((r) => r.orderIds)).not.toContain(order.id);
    });

    it('keeps STAT off the long loops', async () => {
        const stat = await makeOrder({ serviceType: 'stat', zip: '78216' });
        const res = await propose();
        const carrying = res.body.runs.find((r) => r.orderIds.includes(stat.id));
        expect(carrying.kind).toBe('stat');
    });

    it('answers for the fleet actually on shift, not the one on paper', async () => {
        /* Eighteen is the fleet in the contract. A dispatcher at 12:05 with
           fifteen needs to see fifteen before they start ringing people. */
        const res = await propose('?drivers=2&maxStopsPerRun=2');
        expect(res.body.settings.drivers).toBe(2);
        expect(res.body.runs.filter((r) => r.kind === 'standard').length).toBeLessThanOrEqual(2);
    });

    it('ignores a nonsense capacity rather than stranding the day on it', async () => {
        /* A typo must not become a fleet of zero. It falls back to the
           roster, which is now the default, rather than to the contract's
           eighteen. */
        const expected = (await propose()).body.fleet.roster;
        for (const q of ['?drivers=0', '?drivers=-4', '?drivers=abc', '?drivers=']) {
            expect((await propose(q)).body.settings.drivers, q).toBe(expected);
        }
    });

    it('is refused to a pharmacy account', async () => {
        /* It reports the shape of the whole day across every counter, which
           is not a thing one pharmacy may read. */
        await admin.post('/api/users').send({
            username: 'uh.counter.test', name: 'Counter', password: 'counter-pass-1', role: 'staff',
        });
        await admin.put('/api/users/uh.counter.test/memberships/uh').send({
            role: 'pharmacy', settings: { siteIds: [dischargeId] },
        });
        const a = srv.agent();
        await a.post('/api/login').send({ username: 'uh.counter.test', password: 'counter-pass-1' });
        expect((await a.get(`${RUNS}/propose`)).status).toBe(403);
    });
});

describe('turning a proposal into runs', () => {
    it('hands back order ids that POST /runs accepts, which is the whole point', async () => {
        /* A proposal the create path rejects is a proposal that wasted the
           noon it was meant to save. This is the join between the two. */
        for (let i = 0; i < 4; i += 1) await makeOrder({ siteId: greenId, zip: '78207' });

        /* An explicit fleet, because this is testing the join between
           propose and create rather than the fleet logic. Left to default,
           the roster in this file is one courier and the STAT from an
           earlier case takes the only seat, so there is no standard run to
           create and the test would fail for an unrelated reason. */
        const proposal = (await propose('?drivers=18')).body;
        const run = proposal.runs.find((r) => r.kind === 'standard' && r.orderIds.length > 0);
        expect(run).toBeTruthy();

        const created = await admin.post(RUNS).send({
            courierUsername: 'ada.courier',
            label: 'From the proposal',
            orderIds: run.orderIds,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);

        const full = (await admin.get(`${RUNS}/${created.body.id}`)).body;
        expect(full.stops.map((s) => s.orderId)).toEqual(run.orderIds);

        /* And they are gone from the next proposal, because they are now
           somebody's work. */
        const after = (await propose('?drivers=18')).body;
        for (const id of run.orderIds) {
            expect(after.runs.flatMap((r) => r.orderIds)).not.toContain(id);
        }
    });
});
