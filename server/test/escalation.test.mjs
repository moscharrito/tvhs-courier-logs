/* What happens to work nobody has been given.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE OTHER TWO THIRDS OF THIS FILE WERE DELETED WITH THE FEATURE.
 *
 * Tickets 6.4 and 6.5 built a pull model -- couriers browsing unassigned
 * deliveries and asking for the ones they wanted -- and it was removed on 16
 * October 2026 because operations never ran that way: dispatch assigns every
 * delivery from the forecast. The tests for browsing, asking and deciding
 * went with it.
 *
 * WHAT IS LEFT IS THE PART THAT WAS NEVER ABOUT ASKING. An unclaimed STAT is
 * never nobody's problem. Our rates are fixed, so there is no surge pricing
 * to clear a market, and the sweep is the only thing standing between a
 * delivery nobody was given and a missed two-hour deadline that Izy is
 * answerable for. That matters more under a push model than it did under a
 * pull one, not less: when dispatch assigns everything, the deliveries this
 * catches are the ones dispatch MISSED.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepUnclaimed, SWEEP_THRESHOLDS } from '../src/modules/uh/escalation.ts';

const UH = '/api/projects/uh/uh';
const ESC = `${UH}/escalation`;

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

    /* ON SHIFT, SAID OUT LOUD. The sweep hands work to whoever is on shift
       and carrying least, so a shift is its precondition -- and until this
       file was split out, these tests inherited one opened by the "asking"
       tests that used to run above them. A precondition held by a describe
       block somebody else might delete is not a precondition. */
    await ana.post(`${UH}/shifts/start`).send({});
    await bo.post(`${UH}/shifts/start`).send({});
}, 60_000);

afterAll(async () => { await srv?.stop(); });

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
        const res = await admin.post(`${ESC}/sweep?dryRun=true`).send({});
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.assigned)).toBe(true);
        expect(Array.isArray(res.body.couriers)).toBe(true);
    });

    it('says whether the clock is actually running (8.2)', async () => {
        /* A dispatcher looking at a button that hands out deliveries has no
           other way to tell whether it also happens on its own, and the two
           readings lead to opposite behaviour: one person presses it every
           ten minutes for nothing, the next assumes it is automatic and a
           STAT sits there. SWEEP_INTERVAL_SECONDS is unset in the test
           environment, as it is everywhere else today. */
        const res = await admin.get(ESC);
        expect(res.status).toBe(200);
        expect(res.body.sweep).toEqual({ automatic: false, everySeconds: null });
    });
});

