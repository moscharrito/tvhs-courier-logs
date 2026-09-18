/* Couriers asking for work, and what happens to what nobody asks for.
 *
 * Tickets 6.4 and 6.5. Three things are worth testing here and the rest is
 * bookkeeping:
 *
 *   The claimable list does not hand every courier every patient's name and
 *   street address. A pull model means twenty people browsing forty
 *   deliveries that are not theirs, and that is where minimum-necessary
 *   quietly dies.
 *
 *   Approval goes through the custody transition, so the guarantee that
 *   nothing reaches a van without a recorded event survives the new model.
 *
 *   An unclaimed STAT is never nobody's problem. Our rates are fixed, so
 *   there is no surge pricing to clear a pull market, and the sweep is the
 *   only thing standing between "drivers choose" and a missed two-hour
 *   deadline that Izy is answerable for.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepUnclaimed, SWEEP_THRESHOLDS } from '../src/modules/uh/requests.ts';

const UH = '/api/projects/uh/uh';
const REQ = `${UH}/requests`;

let srv;
let admin;
let ana;
let bo;
let siteId;
let projectId;

const PATIENT = 'Marguerite Okafor';
const STREET = '4410 Callaghan Rd';

async function courier(username) {
    await admin.post('/api/users').send({ username, name: username, password: 'req-pass-1', role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password: 'req-pass-1' });
    expect(res.status, res.text).toBe(200);
    return a;
}

/** An unassigned order sitting in the pool, ready to be asked for. */
async function poolOrder(over = {}) {
    const res = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: PATIENT,
        addressLine: STREET, zip: '78229', description: 'Cold pack', quantity: 1, ...over,
    });
    expect(res.status, res.text).toBe(201);
    return res.body.id;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const project = (await admin.get('/api/me/projects')).body.find((p) => p.code === 'uh');
    projectId = project.id;
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    ana = await courier('ana.req');
    bo = await courier('bo.req');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('what a courier may browse', () => {
    it('shows where and when, and not who lives there', async () => {
        /* The quiet widening this ticket had to avoid. A courier deciding
           between stops needs the ZIP, the zone, the deadline and how many
           packages. They do not need the patient's name or street until the
           delivery is actually theirs. */
        const id = await poolOrder();
        await ana.post(`${UH}/shifts/start`).send({});

        const res = await ana.get(`${REQ}/available`);
        expect(res.status).toBe(200);
        const row = res.body.available.find((a) => a.orderId === id);
        expect(row).toBeDefined();
        expect(row.zip).toBe('78229');
        expect(row.dueAt).toBeTruthy();
        expect(row.packages).toBeGreaterThan(0);

        const text = JSON.stringify(res.body);
        expect(text, 'no patient name in the claimable list').not.toMatch(new RegExp(PATIENT, 'i'));
        expect(text, 'no street address either').not.toMatch(new RegExp(STREET, 'i'));
    });

    it('marks what this courier has already asked for', async () => {
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const res = await ana.get(`${REQ}/available`);
        expect(res.body.available.find((a) => a.orderId === id).requested).toBe(true);
    });
});

describe('asking', () => {
    it('refuses somebody who is not on shift', async () => {
        const id = await poolOrder();
        const res = await bo.post(REQ).send({ orderIds: [id] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('request.notOnShift');
    });

    it('assigns nothing by itself', async () => {
        /* A request is an expression of interest. The order is exactly where
           it was: unassigned, on nobody's run. */
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const order = await admin.get(`${UH}/orders/${id}`);
        expect(order.body.status).toBe('ready');
        expect(order.body.assignedTo).toBeFalsy();
    });

    it('lets two couriers want the same stop, which is the ordinary case', async () => {
        const id = await poolOrder();
        await bo.post(`${UH}/shifts/start`).send({});
        expect((await ana.post(REQ).send({ orderIds: [id] })).status).toBe(201);
        expect((await bo.post(REQ).send({ orderIds: [id] })).status).toBe(201);

        const queue = await admin.get(REQ);
        expect(queue.body.requests.filter((r) => r.orderId === id)).toHaveLength(2);
    });

    it('shrugs off a double tap rather than making two requests', async () => {
        const id = await poolOrder();
        expect((await ana.post(REQ).send({ orderIds: [id] })).status).toBe(201);
        const again = await ana.post(REQ).send({ orderIds: [id] });
        expect(again.status).toBe(409);
        expect(again.body.refused[0].code).toBe('request.already');
    });

    it('will not let one person claim the whole board', async () => {
        const many = Array.from({ length: 13 }, (_, i) => i + 1);
        expect((await ana.post(REQ).send({ orderIds: many })).status).toBe(400);
    });
});

describe('deciding', () => {
    it('assigns through the custody chain, not by writing a stop', async () => {
        /* The guarantee that has held since ticket 2.x: nothing puts work in
           a van without a recorded event. A pull model adds two new ways for
           an order to reach a courier and neither may skip it. */
        const id = await poolOrder();
        const made = await ana.post(REQ).send({ orderIds: [id] });
        expect(made.status).toBe(201);
        const reqId = (await admin.get(REQ)).body.requests.find((r) => r.orderId === id).id;

        const ok = await admin.post(`${REQ}/${reqId}/approve`).send({});
        expect(ok.status, ok.text).toBe(200);

        const order = await admin.get(`${UH}/orders/${id}`);
        expect(order.body.status).toBe('assigned');
        expect(order.body.assignedTo).toBe('ana.req');
        const assignedEvent = order.body.custody.find((e) => e.type === 'assigned');
        expect(assignedEvent, 'the custody row exists').toBeDefined();
        expect(assignedEvent.to).toBe('assigned');
    });

    it('supersedes the others rather than denying them', async () => {
        /* They asked for something reasonable and somebody got there first.
           That is a different sentence to read on a phone than "no". */
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        await bo.post(REQ).send({ orderIds: [id] });
        const mine = (await admin.get(REQ)).body.requests.filter((r) => r.orderId === id);

        const res = await admin.post(`${REQ}/${mine[0].id}/approve`).send({});
        expect(res.body.superseded).toBe(1);

        const loser = (await bo.get(`${REQ}/mine`)).body.requests.find((r) => r.orderId === id)
            ?? (await ana.get(`${REQ}/mine`)).body.requests.find((r) => r.orderId === id);
        expect(['superseded', 'approved']).toContain(loser.status);
    });

    it('will not deny without telling the courier why', async () => {
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const reqId = (await admin.get(REQ)).body.requests.find((r) => r.orderId === id).id;

        expect((await admin.post(`${REQ}/${reqId}/deny`).send({ reason: '' })).status).toBe(400);
        expect((await admin.post(`${REQ}/${reqId}/deny`).send({ reason: 'Bo is closer to that ZIP today.' })).status).toBe(200);

        const seen = (await ana.get(`${REQ}/mine`)).body.requests.find((r) => r.id === reqId);
        expect(seen.status).toBe('denied');
        expect(seen.decisionReason).toMatch(/closer/);
    });

    it('refuses to decide the same request twice', async () => {
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const reqId = (await admin.get(REQ)).body.requests.find((r) => r.orderId === id).id;
        await admin.post(`${REQ}/${reqId}/deny`).send({ reason: 'Not this one.' });
        const again = await admin.post(`${REQ}/${reqId}/approve`).send({});
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('request.decided');
    });

    it('lets a courier take it back', async () => {
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const reqId = (await ana.get(`${REQ}/mine`)).body.requests.find((r) => r.orderId === id).id;
        expect((await ana.delete(`${REQ}/${reqId}`)).status).toBe(200);
        expect((await ana.delete(`${REQ}/${reqId}`)).status).toBe(409);
    });
});

describe('what nobody asks for', () => {
    const core = () => srv.core.client;

    /** Put an order's deadline a chosen number of minutes from now. */
    async function dueIn(orderId, minutes) {
        const at = new Date(Date.now() + minutes * 60_000).toISOString();
        await core().execute({ sql: 'UPDATE orders SET due_at = ? WHERE id = ?', args: [at, orderId] });
    }

    it('leaves alone what still has time', async () => {
        const id = await poolOrder();
        await dueIn(id, SWEEP_THRESHOLDS.adhoc + 30);
        const out = await sweepUnclaimed(core(), {
            projectId, projectSettings: {}, serviceDate: (await admin.get(`${UH}/orders/${id}`)).body.serviceDate,
            now: new Date(), dryRun: true,
        });
        expect(out.assigned.map((a) => a.orderId)).not.toContain(id);
    });

    it('hands out a STAT that is running out, to whoever is carrying least', async () => {
        const id = await poolOrder({ serviceType: 'stat' });
        await dueIn(id, SWEEP_THRESHOLDS.stat - 10);
        const serviceDate = (await admin.get(`${UH}/orders/${id}`)).body.serviceDate;

        const out = await sweepUnclaimed(core(), { projectId, projectSettings: {}, serviceDate, now: new Date() });
        const got = out.assigned.find((a) => a.orderId === id);
        expect(got, 'the STAT was handed out').toBeDefined();
        expect(out.couriers.map((c) => c.courierUsername)).toContain(got.courierUsername);

        const order = await admin.get(`${UH}/orders/${id}`);
        expect(order.body.status).toBe('assigned');
        /* Not a person. Somebody reading this a year from now should see that
           nobody chose it, a clock did. */
        expect(order.body.custody.find((e) => e.type === 'assigned').actor).toBe('system');
    });

    it('says so loudly when there is nobody to give it to', async () => {
        /* The case the sweep cannot fix. Saying nothing would leave it as
           invisible as it was before there was a sweep at all. */
        await ana.post(`${UH}/shifts/end`).send({});
        await bo.post(`${UH}/shifts/end`).send({});

        const id = await poolOrder({ serviceType: 'stat' });
        await dueIn(id, 5);
        const serviceDate = (await admin.get(`${UH}/orders/${id}`)).body.serviceDate;

        const out = await sweepUnclaimed(core(), { projectId, projectSettings: {}, serviceDate, now: new Date() });
        const stuck = out.unassignable.find((u) => u.orderId === id);
        expect(stuck).toBeDefined();
        expect(stuck.reason).toMatch(/Nobody is on shift/);
        expect(out.assigned).toEqual([]);
    });

    it('spreads the load rather than filling one van', async () => {
        await ana.post(`${UH}/shifts/start`).send({});
        await bo.post(`${UH}/shifts/start`).send({});

        const ids = [await poolOrder({ serviceType: 'stat' }), await poolOrder({ serviceType: 'stat' })];
        for (const id of ids) await dueIn(id, 10);
        const serviceDate = (await admin.get(`${UH}/orders/${ids[0]}`)).body.serviceDate;

        const out = await sweepUnclaimed(core(), { projectId, projectSettings: {}, serviceDate, now: new Date() });
        const mine = out.assigned.filter((a) => ids.includes(a.orderId));
        expect(mine).toHaveLength(2);
        expect(new Set(mine.map((a) => a.courierUsername)).size, 'two vans, not one').toBe(2);
    });

    it('changes nothing on a dry run', async () => {
        const id = await poolOrder({ serviceType: 'stat' });
        await dueIn(id, 5);
        const serviceDate = (await admin.get(`${UH}/orders/${id}`)).body.serviceDate;

        const out = await sweepUnclaimed(core(), { projectId, projectSettings: {}, serviceDate, now: new Date(), dryRun: true });
        expect(out.assigned.map((a) => a.orderId)).toContain(id);
        expect((await admin.get(`${UH}/orders/${id}`)).body.status).toBe('ready');
    });

    it('is reachable by dispatch and records what it did', async () => {
        const res = await admin.post(`${REQ}/sweep?dryRun=true`).send({});
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.assigned)).toBe(true);
        expect(Array.isArray(res.body.couriers)).toBe(true);
    });

    it('tells the queue whether the clock is actually running (8.2)', async () => {
        /* A dispatcher looking at a button that hands out deliveries has no
           other way to tell whether it also happens on its own, and the two
           readings lead to opposite behaviour: one person presses it every
           ten minutes for nothing, the next assumes it is automatic and a
           STAT sits there. SWEEP_INTERVAL_SECONDS is unset in the test
           environment, as it is everywhere else today. */
        const res = await admin.get(`${REQ}?status=pending`);
        expect(res.status).toBe(200);
        expect(res.body.sweep).toEqual({ automatic: false, everySeconds: null });
    });
});
