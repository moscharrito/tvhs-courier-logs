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
    await admin.post('/api/users').send({ username: 'uh.pharmacist', name: 'Karthik Pharmacist', password: 'client-pass-1', role: 'staff', mustChangePassword: false });
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });

    // And one with no pharmacies named at all.
    await admin.post('/api/users').send({ username: 'uh.newstarter', name: 'New Starter', password: 'client-pass-2', role: 'staff', mustChangePassword: false });
    await admin.put('/api/users/uh.newstarter/memberships/uh').send({ role: 'pharmacy', settings: {} });
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
        expect(scopeFor('admin', {})).toEqual({ siteIds: [], wholeProject: true });
    });

    it('gives a client viewer exactly the sites named on their membership', () => {
        expect(scopeFor('pharmacy', { siteIds: [4, 7, 4] })).toEqual({ siteIds: [4, 7], wholeProject: false });
    });

    it('gives an unscoped client viewer nothing, not everything', () => {
        /* The failure mode this prevents: a mistake in a settings form quietly
           handing one pharmacy the other eight pharmacies' patients. */
        expect(scopeFor('pharmacy', {})).toEqual({ siteIds: [], wholeProject: false });
        expect(scopeFor('pharmacy', { siteIds: 'all' })).toEqual({ siteIds: [], wholeProject: false });
        expect(scopeFor('pharmacy', { siteIds: [0, -3, 'x'] })).toEqual({ siteIds: [], wholeProject: false });
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
        for (const word of ['price', 'total', 'surcharge', 'cents']) {
            expect(blob).not.toContain(word);
        }
    });

    it('does show the zone, which is theirs and is not a price', async () => {
        /* `zone` WAS ON THE LIST ABOVE AND CAME OFF IT ON 6 OCTOBER 2026.
         *
         * It was there as a pricing dimension, which is half right: a zone
         * decides which rate applies. But the ZIP-to-zone mapping is
         * University Health's own published Bid Table BT-89AO. Showing it
         * back to them reveals nothing they did not define, and it is how
         * they think about where a delivery is going and how long it ought to
         * take. Operational, not commercial.
         *
         * What must still never appear is the RATE, which is what the loop
         * above is really protecting, and it still passes unchanged. */
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        expect(res.body).toHaveProperty('zone');
        /* A number, or null for out of area, which is the value that matters
           to somebody scanning: nobody has agreed a price for it. */
        expect(res.body.zone === null || typeof res.body.zone === 'number').toBe(true);
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

    it('offers the proof of delivery document', async () => {
        const order = await delivered();
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get(`${CLIENT}/orders/${order.id}`);
        expect(res.body.proofOfDelivery).toMatchObject({ available: true });

        const pdf = await uh.get(`${CLIENT}/orders/${order.id}/pod.pdf`);
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toBe('application/pdf');
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

describe('the doorstep photograph', () => {
    /* Until this route existed, University Health could not see a photograph
       at all: the PDF writer embeds no images, and every core/files route is
       admin and courier only. The photograph existed and its owner could not
       look at it. */

    it('says nothing about a photograph when none was taken', async () => {
        const order = await delivered();
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders/${order.id}`);

        expect(res.status).toBe(200);
        expect(res.body.photo).toEqual({ available: false, reason: '' });
        /* And specifically NOT the old hardcoded sentence about storage,
           which was printed for every doorstep delivery whether or not
           storage was configured. */
        expect(res.body.proofOfDelivery.reason).toBe('');
    });

    it('answers 404, not 403, for another pharmacy\'s delivery', async () => {
        /* A 403 would confirm the delivery exists, which is itself something
           this viewer is not entitled to know. Same rule as the detail route,
           and worth its own test because it is a separate code path. */
        const other = await delivered({ siteId: green.id });
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');

        const res = await pharmacist.get(`${CLIENT}/orders/${other.id}/photo`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Delivery not found');
    });

    it('answers 404 when the delivery is theirs and carries no photograph', async () => {
        const order = await delivered();
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');

        const res = await pharmacist.get(`${CLIENT}/orders/${order.id}/photo`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('No photograph was taken for this delivery');
    });

    it('answers 404 for a delivery that does not exist', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders/999999/photo`);
        expect(res.status).toBe(404);
    });

    it('does not let a courier read a pharmacy\'s photograph route', async () => {
        const order = await delivered();
        const courier = await agentFor('ada.courier', 'courier-pass-1');
        const res = await courier.get(`${CLIENT}/orders/${order.id}/photo`);
        expect(res.status).toBe(403);
    });
});

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
        /* /imports is NOT on this list any more, and that is a deliberate
           narrowing rather than a hole. A pharmacy uploads its own daily list
           now, so the endpoint answers them: what it answers with is their
           own counters and nothing else, which is asserted on its own below
           and in uh-client-import.test.mjs. Leaving the row here would have
           been simpler and would have been a lie. */
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

    it('lets a client viewer read imports, and only its own', async () => {
        /* The row taken out of the table above, written out properly. The
           endpoint used to refuse them outright; now it answers, so the thing
           worth pinning is what it leaves out. An import holds a pharmacy's
           whole list, patients included, so one counter seeing another's is
           the same disclosure as handing over the spreadsheet. */
        const uh = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await uh.get('/api/projects/uh/uh/imports');
        expect(res.status).toBe(200);
        for (const l of res.body) {
            expect(l.site.id, 'only the counter on their membership').toBe(discharge.id);
        }
    });

    it('still shuts a courier out of imports entirely', async () => {
        /* Widening the role to let a pharmacy in must not have let anybody
           else in on the way past. */
        const ada = await agentFor('ada.courier', 'courier-pass-1');
        expect((await ada.get('/api/projects/uh/uh/imports')).status).toBe(403);
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

/* ------------------------------------------------ what the client reports */

describe('the reporting Karthik asked for', () => {
    /* His list, in his order. Each of these was already computed for the
       administrator's screen; what was missing was the client being able to
       read their own, scoped to the counters they are entitled to see. */

    it('answers every figure on his list', async () => {
        await delivered();
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/reports?from=${today}&to=${today}`);

        expect(res.status).toBe(200);
        expect(res.body.totals.orders).toBeGreaterThan(0);          // total deliveries
        expect(res.body.totals).toHaveProperty('delivered');         // completed
        expect(res.body.totals).toHaveProperty('onTimeMet');         // on time
        expect(res.body.totals).toHaveProperty('onTimeMissed');      // delayed
        expect(res.body.totals).toHaveProperty('notDelivered');      // failed
        expect(res.body).toHaveProperty('failureReasons');           // why they failed
        expect(res.body.turnaround).toHaveProperty('inOurHands');    // turnaround
        expect(res.body).toHaveProperty('bySite');                   // by location
        expect(res.body).toHaveProperty('byServiceType');            // by service level
        expect(res.body).toHaveProperty('byPeriod');                 // by date range
        expect(res.body.followUp).toHaveProperty('reattempts');      // reattempted
        expect(res.body.totals).toHaveProperty('cancelled');         // cancelled
        expect(res.body.followUp).toHaveProperty('returned');        // returned
    });

    it('carries the definition behind every rate', async () => {
        /* The standing rule here: a figure whose basis is a click away is a
           figure somebody quotes without the basis. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/reports?from=${today}&to=${today}`);
        expect(Array.isArray(res.body.definitions)).toBe(true);
        expect(res.body.definitions.length).toBeGreaterThan(3);
    });

    it('lets them choose the window and how it is broken up', async () => {
        /* "Report frequency, customization options" in his words. A client
           who can ask for last quarter by month needs nobody to run it. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/reports?from=2026-01-01&to=${today}&groupBy=month`);
        expect(res.status).toBe(200);
        expect(res.body.grouping).toBe('month');
    });

    it('shows one pharmacy only their own numbers', async () => {
        /* Scoped in the SQL, not filtered afterwards. A pharmacist at one
           counter cannot see another counter's failures even by asking. */
        await delivered({ siteId: green.id });
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/reports?from=${today}&to=${today}`);

        const names = res.body.bySite.map((s) => s.label);
        expect(names.every((n) => !/green/i.test(n)), `saw another pharmacy: ${names.join(', ')}`).toBe(true);
    });

    it('shows an unscoped account nothing rather than everything', async () => {
        /* The failure that matters: a mistake in a settings form must not
           hand somebody the whole contract. */
        const newStarter = await agentFor('uh.newstarter', 'client-pass-2');
        const res = await newStarter.get(`${CLIENT}/reports?from=${today}&to=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.totals.orders).toBe(0);
        expect(res.body.notes.join(' ')).toMatch(/no pharmacies/i);
    });

    it('refuses a range longer than a year', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/reports?from=2020-01-01&to=${today}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('reports.rangeTooLong');
    });

    it('is not something a courier may read', async () => {
        const courier = await agentFor('ada.courier', 'courier-pass-1');
        expect((await courier.get(`${CLIENT}/reports`)).status).toBe(403);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE FIGURES AT THE TOP, AND THE ROWS BEHIND THEM.
 *
 * The counts and the list were both right about different questions and did
 * not add up to each other. The page showed sent to us, still out, delivered
 * and not delivered, and CANCELLED was in the total and in none of the other
 * three. On any day something was cancelled, a pharmacist adding the figures
 * up got less than the total with nothing on the page to explain where the
 * difference had gone.
 *
 * So the tests here are arithmetic: each figure equals the rows you get by
 * clicking it, and they equal the total between them. That is the property
 * the drill-down on the portal screen rests on, and the reason the drill-down
 * was worth having at all: a figure nobody can open is a figure somebody
 * rings us about.
 */
describe('the figures reconcile', () => {
    /* Its own service date, so the counts belong to this block alone and
       other tests creating orders cannot move them. */
    const day = '2026-10-19';

    beforeAll(async () => {
        /* One still out, one delivered and one cancelled, which is the
           combination the old four figures could not account for. */
        await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'stat', recipientName: 'Waiting Patient',
            addressLine: '1 Waiting Street', zip: '78215', serviceDate: day, externalRef: 'RX-9001',
        });
        await delivered({ serviceDate: day, externalRef: 'RX-9002' });

        const doomed = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'stat', recipientName: 'Cancelled Patient',
            addressLine: '2 Waiting Street', zip: '78215', serviceDate: day, externalRef: 'RX-9003',
        });
        expect(doomed.status, JSON.stringify(doomed.body)).toBe(201);
        const killed = await admin.post(`${ORDERS}/${doomed.body.id}/events`)
            .send({ type: 'cancelled', reason: 'The pharmacy withdrew it' });
        expect(killed.status, JSON.stringify(killed.body)).toBe(201);
    });

    const summaryFor = async (agent) => (await agent.get(`${CLIENT}/summary?date=${day}`)).body;

    it('gives a cancelled delivery a figure of its own', async () => {
        /* THE BUG. It was in the total and in none of the figures, so the
           page quietly failed to account for it. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const s = await summaryFor(pharmacist);
        expect(s.byStatus.cancelled, 'the fixture should leave one cancelled').toBe(1);
        expect(s.cancelled).toBe(1);
    });

    it('counts anything without an outcome as still out', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const s = await summaryFor(pharmacist);
        /* The one created and left alone. Orders are inserted as 'ready', so
           that is the status this is really asserting about; pending is in
           OPEN_STATUSES for completeness and nothing produces it. */
        expect(s.outstanding).toBeGreaterThanOrEqual(1);
        expect(s.outstanding).toBe(
            (s.byStatus.pending ?? 0) + (s.byStatus.ready ?? 0)
            + (s.byStatus.assigned ?? 0) + (s.byStatus.picked_up ?? 0),
        );
    });

    it('adds up to the total, which is what a reader will check', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const s = await summaryFor(pharmacist);
        expect(s.outstanding + s.delivered + s.notDelivered + s.cancelled).toBe(s.total);
    });

    it('gives the same number of rows when the still out figure is opened', async () => {
        /* The figure and the list have to be one question. Two numbers that
           disagree on one screen is how a figure ends up quoted in a contract
           meeting without the basis it was counted on. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const s = await summaryFor(pharmacist);
        const open = await pharmacist.get(`${CLIENT}/orders?from=${day}&to=${day}&status=open`);
        expect(open.status).toBe(200);
        expect(open.body.orders.length).toBe(s.outstanding);
    });

    it('gives the same number of rows for delivered and for not delivered', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const s = await summaryFor(pharmacist);
        for (const [status, figure] of [['delivered', s.delivered], ['failed', s.notDelivered]]) {
            const res = await pharmacist.get(`${CLIENT}/orders?from=${day}&to=${day}&status=${status}`);
            expect(res.body.orders.length, `${status} should match its figure`).toBe(figure);
        }
    });
});

describe('the filters the drill-down needs', () => {
    it('reads open as every status without an outcome', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders?status=open`);
        expect(res.status).toBe(200);
        for (const o of res.body.orders) {
            expect(['delivered', 'failed', 'cancelled'], `status ${o.status}`).not.toContain(o.status);
        }
    });

    it('still treats a real status as exactly that one', async () => {
        /* "open" is a group, and adding it must not have turned every status
           into a fuzzy match. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders?status=delivered`);
        expect(res.body.orders.length).toBeGreaterThan(0);
        for (const o of res.body.orders) expect(o.status).toBe('delivered');
    });

    it('filters by service level, for the rows the performance page slices', async () => {
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders?serviceType=stat`);
        expect(res.status).toBe(200);
        expect(res.body.orders.length).toBeGreaterThan(0);
        for (const o of res.body.orders) expect(o.serviceType).toBe('stat');
    });

    it('answers an unknown status with nothing rather than with everything', async () => {
        /* A typo in a link must not quietly widen the list. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders?status=nonsense`);
        expect(res.status).toBe(200);
        expect(res.body.orders).toHaveLength(0);
    });

    it('does not let either new filter reach another pharmacy', async () => {
        /* THE PROPERTY THE WHOLE PORTAL HOLDS. Two new parameters are two new
           chances to widen a query that is supposed to be narrowed by a
           membership. The scope is applied before them and neither can
           undo it. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        await delivered({ siteId: green.id, recipientName: 'Other Counter Patient', externalRef: 'RX-9100' });

        for (const qs of ['status=open', 'status=delivered', 'serviceType=stat', 'status=open&serviceType=stat']) {
            const res = await pharmacist.get(`${CLIENT}/orders?${qs}`);
            expect(res.status).toBe(200);
            const names = res.body.orders.map((o) => o.recipientName).join(' | ');
            expect(names, `with ${qs}`).not.toContain('Other Counter Patient');
            for (const o of res.body.orders) {
                expect(o.pharmacy, `with ${qs}`).not.toBe('Robert B. Green Pharmacy');
            }
        }
    });

    it('carries both filters into the export, which runs the same query', async () => {
        /* gatherOrders is shared on purpose. A filter that narrowed the
           screen and not the file would hand somebody a spreadsheet that did
           not match what they were looking at when they pressed the button. */
        const pharmacist = await agentFor('uh.pharmacist', 'client-pass-1');
        const list = await pharmacist.get(`${CLIENT}/orders?status=open&serviceType=stat`);
        expect(list.status).toBe(200);
        const file = await pharmacist
            .get(`${CLIENT}/orders.xlsx?status=open&serviceType=stat`)
            .buffer()
            .parse((res, cb) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => cb(null, Buffer.concat(chunks)));
            });
        expect(file.status).toBe(200);
        /* The audited row count is the comparable figure without parsing the
           workbook again, and uh-client-export.test.mjs already pins that
           the file is the list. */
        const audit = (await admin.get('/api/audit?action=client.export')).body.events[0];
        const detail = typeof audit.detail === 'string' ? JSON.parse(audit.detail) : audit.detail;
        expect(detail.rows).toBe(list.body.orders.length);
    });
});
