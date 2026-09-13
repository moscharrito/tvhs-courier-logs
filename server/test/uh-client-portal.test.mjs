/* What University Health sees, and what it must not.
 *
 * Two kinds of test here. The first kind is ordinary: a pharmacist can look at
 * their own day. The second kind is the point of the feature: a pharmacist
 * cannot look at anybody else's, and nothing about our couriers beyond a first
 * name reaches them. Those are written as assertions about what is ABSENT,
 * because a leak is always a field somebody added later without thinking about
 * who reads it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { courierFirstName, scopeFor } from '../src/modules/uh/client-portal.ts';

const CLIENT = '/api/projects/uh/uh/client';
const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let discharge;
let green;
let today;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // A courier with a full name, so the first-name rule has something to bite on.
    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Boleyn Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });

    // A pharmacist who may see the Discharge Pharmacy and nothing else.
    await admin.post('/api/users').send({ username: 'uh.pharmacist', name: 'Karthik Pharmacist', password: 'client-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'client_viewer', settings: { siteIds: [discharge.id] } });

    // And one with no pharmacies named at all.
    await admin.post('/api/users').send({ username: 'uh.newstarter', name: 'New Starter', password: 'client-pass-2', role: 'staff' });
    await admin.put('/api/users/uh.newstarter/memberships/uh').send({ role: 'client_viewer', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const agentFor = async (username, password) => {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password });
    return a;
};

let seq = 0;
async function delivered(over = {}) {
    seq += 1;
    const { siteId = discharge.id, ...rest } = over;
    const created = await admin.post(ORDERS).send({
        siteId, serviceType: 'stat', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids',
        quantity: 2, externalRef: `RX-${5000 + seq}`, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Ines Vargas' });
    return order;
}

/* ------------------------------------------------------------------ rules */

describe('a courier first name', () => {
    it('is the first word and never more', () => {
        expect(courierFirstName('Ada Boleyn Fitzgerald')).toBe('Ada');
        expect(courierFirstName('Mohammed')).toBe('Mohammed');
        expect(courierFirstName('  Lucia   Herrera ')).toBe('Lucia');
    });

    it('falls back rather than inventing a name', () => {
        expect(courierFirstName('', 'Courier')).toBe('Courier');
        expect(courierFirstName(null)).toBe('');
    });
});

describe('what a viewer is scoped to', () => {
    it('gives staff the whole project, so they can check what the client sees', () => {
        expect(scopeFor('dispatcher', {})).toEqual({ siteIds: [], wholeProject: true });
    });

    it('gives a client viewer exactly the sites named on their membership', () => {
        expect(scopeFor('client_viewer', { siteIds: [4, 7, 4] })).toEqual({ siteIds: [4, 7], wholeProject: false });
    });

    it('gives an unscoped client viewer nothing, not everything', () => {
        /* The failure mode this prevents: a mistake in a settings form quietly
           handing one pharmacy the other eight pharmacies' patients. */
        expect(scopeFor('client_viewer', {})).toEqual({ siteIds: [], wholeProject: false });
        expect(scopeFor('client_viewer', { siteIds: 'all' })).toEqual({ siteIds: [], wholeProject: false });
        expect(scopeFor('client_viewer', { siteIds: [0, -3, 'x'] })).toEqual({ siteIds: [], wholeProject: false });
    });
});

/* ----------------------------------------------------------------- access */

describe('who may open the portal', () => {
    it('lets a pharmacist see their own pharmacy', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders?date=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.orders.map((o) => o.id)).toContain(order.id);
        expect(res.body.pharmacies.map((p) => p.name)).toEqual([discharge.name]);
    });

    it('does not let them see another pharmacy, in the list or one at a time', async () => {
        const theirs = await delivered({ siteId: green.id });
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');

        const list = await uh.get(`${CLIENT}/orders?date=${today}`);
        expect(list.body.orders.map((o) => o.id)).not.toContain(theirs.id);

        // 404, not 403: a refusal would confirm the delivery exists.
        const one = await uh.get(`${CLIENT}/orders/${theirs.id}`);
        expect(one.status).toBe(404);

        const filtered = await uh.get(`${CLIENT}/orders?date=${today}&siteId=${green.id}`);
        expect(filtered.status).toBe(403);
    });

    it('shows an unscoped viewer nothing at all, and says why', async () => {
        await delivered();
        const uh = await agentFor('uh.newstarter', 'client-pass-2');
        const res = await uh.get(`${CLIENT}/orders?date=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.orders).toEqual([]);
        expect(res.body.notes.join(' ')).toMatch(/No pharmacies are assigned/);
    });

    it('keeps couriers out: a day of one pharmacy is not theirs to read', async () => {
        const ada = await agentFor('ada.courier', 'courier-pass-1');
        expect((await ada.get(`${CLIENT}/orders`)).status).toBe(403);
        expect((await ada.get(`${CLIENT}/summary`)).status).toBe(403);
    });

    it('keeps a client viewer out of everything else', async () => {
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        expect((await uh.get('/api/projects/uh/uh/board')).status).toBe(403);
        expect((await uh.get('/api/projects/uh/uh/orders')).status).toBe(403);
        expect((await uh.get('/api/projects/uh/uh/runs')).status).toBe(403);
        expect((await uh.post('/api/projects/uh/uh/orders').send({})).status).toBe(403);
    });

    it('lets staff see the portal, so they can check what the client is shown', async () => {
        const res = await admin.get(`${CLIENT}/orders?date=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.pharmacies.length).toBeGreaterThan(1);
    });
});

/* -------------------------------------------------------------- redaction */

describe('what reaches the client', () => {
    it('names the courier by first name only, nowhere else', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        expect(res.status).toBe(200);
        expect(res.body.courier).toBe('Ada');

        const blob = JSON.stringify(res.body);
        expect(blob).not.toContain('Boleyn');
        expect(blob).not.toContain('Fitzgerald');
        expect(blob).not.toContain('ada.courier');
        /* Recorded by a dispatcher here, which the client sees as "Dispatch":
           their question is who handled the medication, and the answer is our
           office, not a named employee of ours. */
        expect(res.body.timeline.every((e) => e.by === 'Ada' || e.by === 'Dispatch')).toBe(true);
        expect(blob).not.toContain('admin');
    });

    it('leaves out where the courier was standing', async () => {
        /* Our record for a dispute, not the client's to browse. */
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        const blob = JSON.stringify(res.body);
        expect(blob).not.toMatch(/"lat"/);
        expect(blob).not.toMatch(/"lng"/);
        expect(res.body.timeline[0]).not.toHaveProperty('lat');
    });

    it('leaves out what the delivery cost', async () => {
        // Invoicing is Scope 1.2.11 and ticket 3.4: a number quoted off a
        // tracking screen is a number we never meant as a bill.
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        const blob = JSON.stringify(res.body).toLowerCase();
        for (const word of ['price', 'total', 'surcharge', 'cents', 'zone']) {
            expect(blob).not.toContain(word);
        }
    });

    it('names our office as Dispatch, never an individual member of staff', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        // The fixture records events as the admin, standing in for a
        // dispatcher recording an event because a phone died.
        expect(res.body.timeline.some((e) => e.by === 'Dispatch')).toBe(true);
        expect(JSON.stringify(res.body)).not.toMatch(/Karthik|Admin|admin/);
    });

    it('carries the five things Scope 1.2.6 asks for', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        // Time, location, description, quantity, and who signed.
        expect(res.body).toMatchObject({
            deliveredAt: expect.any(String),
            address: expect.stringContaining('Test Street'),
            receivedBy: 'Ines Vargas',
        });
        expect(res.body.packages[0]).toMatchObject({ description: 'Oral solids', quantity: 2 });
        expect(res.body.timeline.map((e) => e.type)).toEqual(['picked_up', 'arrived', 'delivered']);
    });

    it('says the proof of delivery document is not here yet rather than offering a dead button', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        expect(res.body.proofOfDelivery).toMatchObject({ available: false });
        expect(res.body.proofOfDelivery.reason).toMatch(/3\.2/);
    });

    it('records that a client read a patient record', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        await uh.get(`${CLIENT}/orders/${order.id}`);

        const audit = await admin.get('/api/audit?action=client.read&limit=5');
        expect(audit.body.events[0]).toMatchObject({ username: 'uh.pharmacist', entity: 'order', entity_id: String(order.id) });
        // And the audit row itself carries no patient data.
        expect(JSON.stringify(audit.body)).not.toMatch(/Recipient \d/);
    });
});

/* ------------------------------------------------------------------ shape */

describe('the list and the summary', () => {
    it('summarises the day by status for the viewer scope only', async () => {
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/summary?date=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.pharmacies).toHaveLength(1);
        expect(res.body.total).toBeGreaterThan(0);
        expect(res.body.delivered).toBeGreaterThan(0);

        const staff = await admin.get(`${CLIENT}/summary?date=${today}`);
        // The whole project has at least what one pharmacy has.
        expect(staff.body.total).toBeGreaterThanOrEqual(res.body.total);
    });

    it('searches by pharmacy reference and never by patient name', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const found = await uh.get(`${CLIENT}/orders?date=${today}&reference=${order.externalRef}`);
        expect(found.body.orders.map((o) => o.id)).toEqual([order.id]);

        // There is no name parameter: asking by name simply does not filter.
        const byName = await uh.get(`${CLIENT}/orders?date=${today}&recipientName=Recipient%201`);
        expect(byName.body.orders.length).toBeGreaterThan(1);
    });

    it('reads a range of days, and refuses an unreasonable one', async () => {
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const ok = await uh.get(`${CLIENT}/orders?from=2026-09-01&to=${today}`);
        expect(ok.status).toBe(200);

        const tooLong = await uh.get(`${CLIENT}/orders?from=2020-01-01&to=${today}`);
        expect(tooLong.status).toBe(400);
        expect(tooLong.body.code).toBe('client.rangeTooLong');

        const backwards = await uh.get(`${CLIENT}/orders?from=${today}&to=2026-01-01`);
        expect(backwards.status).toBe(400);
    });

    it('shows a failed delivery with the reason, because that is what a pharmacist rings about', async () => {
        const order = await delivered();
        const second = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'stat', recipientName: 'Unreachable Person',
            addressLine: '9 Locked Gate', zip: '78215', description: 'Oral solids', quantity: 1,
        });
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [second.body.id] });
        await admin.post(`${ORDERS}/${second.body.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        await admin.post(`${ORDERS}/${second.body.id}/events`).send({ type: 'attempted', reason: 'no_access' });

        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${second.body.id}`);
        expect(res.body.status).toBe('failed');
        expect(res.body.failureReason).toBe('no_access');
        expect(order.id).toBeDefined();
    });
});

/* ------------------------------------------------------- the access matrix */

describe('what each role may read across the whole module', () => {
    /* Written as a table because the failure this catches is a route added
       later with no gate on it at all. Three of the rows below were 200 when
       this table was first written: the staff order search, the run list and
       the import list were open to any member of the project, which meant a
       client viewer could read every patient address in the contract. That is
       the kind of hole a role nobody had yet keeps hidden. */
    const READS = [
        '/api/projects/uh/uh/orders',
        '/api/projects/uh/uh/orders/summary',
        '/api/projects/uh/uh/runs',
        '/api/projects/uh/uh/runs/mine',
        '/api/projects/uh/uh/imports',
        '/api/projects/uh/uh/pricing',
        '/api/projects/uh/uh/pricing/zones',
        '/api/projects/uh/uh/board',
    ];

    it('shuts a client viewer out of every staff and courier read', async () => {
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        for (const path of READS) {
            expect(`${path} -> ${(await uh.get(path)).status}`).toBe(`${path} -> 403`);
        }
    });

    it("shuts a courier out of the rate card, the board and other people's runs", async () => {
        const ada = await agentFor('ada.courier', 'courier-pass-1');
        for (const path of [
            '/api/projects/uh/uh/pricing',
            '/api/projects/uh/uh/pricing/zones',
            '/api/projects/uh/uh/board',
            '/api/projects/uh/uh/imports',
        ]) {
            expect(`${path} -> ${(await ada.get(path)).status}`).toBe(`${path} -> 403`);
        }
        // But their own work is still theirs to read.
        expect((await ada.get('/api/projects/uh/uh/runs/mine')).status).toBe(200);
        expect((await ada.get('/api/projects/uh/uh/orders')).status).toBe(200);
    });

    it('still lets staff read everything they need', async () => {
        for (const path of READS) {
            expect(`${path} -> ${(await admin.get(path)).status}`).toBe(`${path} -> 200`);
        }
    });

    it('gives a client viewer the portal and nothing but the portal', async () => {
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        expect((await uh.get(`${CLIENT}/orders`)).status).toBe(200);
        expect((await uh.get(`${CLIENT}/summary`)).status).toBe(200);
    });
});
