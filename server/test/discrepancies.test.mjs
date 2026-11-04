/* The log of what did not match.
 *
 * Ticket 5.2. The shadow week's acceptance criterion is "every discrepancy
 * logged and fixed", so the two things worth testing are that anybody who
 * notices one can file it, and that nothing can be closed without somebody
 * saying what they did about it.
 *
 * The second is the one that matters. A log that can be emptied with a click
 * produces a clean Friday and teaches nobody anything.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const BASE = `${UH}/discrepancies`;
const DAY = '2026-11-24';

let srv;
let admin;
let courier;
let dispatcher;
let orderId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;

    for (const [username, role] of [['shadow.courier', 'courier'], ['shadow.dispatch', 'admin']]) {
        await admin.post('/api/users').send({ username, name: username, password: 'shadow-pass-11', role: 'staff' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    }
    const signIn = async (username) => {
        const a = srv.agent();
        expect((await a.post('/api/login').send({ username, password: 'shadow-pass-11' })).status).toBe(200);
        return a;
    };
    courier = await signIn('shadow.courier');
    dispatcher = await signIn('shadow.dispatch');

    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'stat', recipientName: 'Shadow Recipient', addressLine: '1 Shadow Street',
        zip: '78215', description: 'Oral solids', quantity: 1, externalRef: 'RX-SHADOW-1', signatureRequired: false,
    });
    expect(created.status, created.text).toBe(201);
    orderId = created.body.id;
});
afterAll(async () => { await srv.stop(); });

const aReport = (over = {}) => ({
    serviceDate: DAY,
    kind: 'delivery',
    severity: 'major',
    expected: 'The board said it was still on the way.',
    actual: 'The pharmacy had already had it back for an hour.',
    ...over,
});

describe('reporting one', () => {
    it('lets a courier file it, because the courier is who notices', async () => {
        /* A report the person holding the package cannot file is a report
           that becomes a shrug. */
        const res = await courier.post(BASE).send(aReport());
        expect(res.status, res.text).toBe(201);
        expect(res.body.status).toBe('open');
        expect(res.body.reportedBy).toBe('shadow.courier');
    });

    it('carries the delivery it is about, by id rather than by name', async () => {
        const res = await dispatcher.post(BASE).send(aReport({ orderId }));
        expect(res.status).toBe(201);
        expect(res.body.orderId).toBe(orderId);
        // The reference comes back so a person can find it without a lookup.
        expect(res.body.reference).toBe('RX-SHADOW-1');
    });

    it('refuses a delivery from another project', async () => {
        const res = await dispatcher.post(BASE).send(aReport({ orderId: 999999 }));
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/not a delivery in this project/);
    });

    it('wants a description of both sides, not one word', async () => {
        const res = await dispatcher.post(BASE).send(aReport({ expected: 'no', actual: 'x' }));
        expect(res.status).toBe(400);
    });

    it('keeps what was typed out of the audit trail', async () => {
        /* Somebody under time pressure will type a patient's name into
           "what actually happened" however firmly the screen asks otherwise,
           so the audit detail carries codes and counts and none of the text. */
        const res = await dispatcher.post(BASE).send(aReport({
            expected: 'System said delivered to Ines Vargas',
            actual: 'Ines Vargas was not there',
        }));
        expect(res.status).toBe(201);

        const rows = await srv.core.client.execute(
            "SELECT detail FROM audit_events WHERE action = 'discrepancy.report' ORDER BY id DESC LIMIT 1",
        );
        expect(String(rows.rows[0].detail)).not.toMatch(/Vargas/);
        expect(String(rows.rows[0].detail)).toMatch(/severity/);
    });
});

describe('closing one', () => {
    it('cannot be closed without saying what was done', async () => {
        const made = await dispatcher.post(BASE).send(aReport());
        const res = await dispatcher.patch(`${BASE}/${made.body.id}`).send({ status: 'resolved', resolution: 'fixed' });
        expect(res.status).toBe(400);
    });

    it('records who closed it and how', async () => {
        const made = await dispatcher.post(BASE).send(aReport());
        const res = await dispatcher.patch(`${BASE}/${made.body.id}`)
            .send({ status: 'resolved', resolution: 'The return was recorded late; the courier has been shown where the button is.' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.status).toBe('resolved');
        expect(res.body.resolvedBy).toBe('shadow.dispatch');
        expect(res.body.resolvedAt).toBeTruthy();
    });

    it('can be accepted rather than fixed, with the reason written down', async () => {
        /* Not everything found in a shadow week is a defect. Some of it is
           the old process being wrong, and that answer has to be recordable
           or it gets recorded as "fixed" instead. */
        const made = await dispatcher.post(BASE).send(aReport({ kind: 'billing', severity: 'minor' }));
        const res = await dispatcher.patch(`${BASE}/${made.body.id}`)
            .send({ status: 'accepted', resolution: 'The spreadsheet was double counting this stop. The system is right.' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('accepted');
    });

    it('will not be closed twice', async () => {
        const made = await dispatcher.post(BASE).send(aReport());
        await dispatcher.patch(`${BASE}/${made.body.id}`).send({ status: 'resolved', resolution: 'Corrected on the board and confirmed.' });
        const again = await dispatcher.patch(`${BASE}/${made.body.id}`).send({ status: 'accepted', resolution: 'Changed my mind about this one.' });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('discrepancy.closed');
    });

    it('is not something a courier does, because it is a judgement about the contract', async () => {
        const made = await courier.post(BASE).send(aReport());
        const res = await courier.patch(`${BASE}/${made.body.id}`).send({ status: 'resolved', resolution: 'I had a look and it seems fine now.' });
        expect(res.status).toBe(403);
    });
});

describe('the list', () => {
    it('puts what is open and worst at the top', async () => {
        const critical = await dispatcher.post(BASE).send(aReport({ severity: 'critical' }));
        const res = await dispatcher.get(`${BASE}?status=open`);
        expect(res.status).toBe(200);
        expect(res.body[0].id).toBe(critical.body.id);
        expect(res.body.every((d) => d.status === 'open')).toBe(true);
    });

    it('filters by day, which is how the week is reviewed', async () => {
        await dispatcher.post(BASE).send(aReport({ serviceDate: '2026-11-25' }));
        const res = await dispatcher.get(`${BASE}?serviceDate=2026-11-25`);
        expect(res.body.every((d) => d.serviceDate === '2026-11-25')).toBe(true);
    });

    /* ─────────────────────────────────────────────────────────────────────
     * AND BY PHARMACY (4 November 2026).
     *
     * The log showed every open dispute on the contract. Across nine
     * counters that is a list nobody can act on: the question somebody
     * actually has is "what is outstanding at Wheatley for Tuesday".
     *
     * A discrepancy has no site of its own and should not grow one -- it is
     * a dispute about an order, and the order already knows which counter
     * released it. Read through the join, so there is one answer to "which
     * pharmacy is this" rather than a copy that drifts.
     * ───────────────────────────────────────────────────────────────────── */

    it('filters by pharmacy, through the delivery it is about', async () => {
        const sites = (await admin.get(`${UH}/sites`)).body;
        const discharge = sites.find((s) => s.code === 'discharge').id;
        const green = sites.find((s) => s.code === 'green').id;

        const elsewhere = await admin.post(`${UH}/orders`).send({
            siteId: green, serviceType: 'stat', recipientName: 'Green Recipient',
            addressLine: '2 Shadow Street', zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: 'RX-SHADOW-GREEN', signatureRequired: false,
        });
        expect(elsewhere.status, elsewhere.text).toBe(201);

        const mine = await dispatcher.post(BASE).send(aReport({ orderId, serviceDate: '2026-11-26' }));
        const theirs = await dispatcher.post(BASE).send(aReport({ orderId: elsewhere.body.id, serviceDate: '2026-11-26' }));

        const atDischarge = await dispatcher.get(`${BASE}?siteId=${discharge}&serviceDate=2026-11-26`);
        expect(atDischarge.status, atDischarge.text).toBe(200);
        const ids = atDischarge.body.map((d) => d.id);
        expect(ids).toContain(mine.body.id);
        expect(ids).not.toContain(theirs.body.id);
    });

    it('leaves out a dispute about no delivery when a pharmacy is named', async () => {
        /* A short trolley raised against the day rather than against an
           order belongs to no pharmacy, so asking for one pharmacy's
           disputes is asking not to see it. Unfiltered it is still there,
           which is the half that matters: it must not become invisible. */
        const sites = (await admin.get(`${UH}/sites`)).body;
        const discharge = sites.find((s) => s.code === 'discharge').id;
        const orphan = await dispatcher.post(BASE).send(aReport({ serviceDate: '2026-11-27' }));

        const unfiltered = await dispatcher.get(`${BASE}?serviceDate=2026-11-27`);
        expect(unfiltered.body.map((d) => d.id)).toContain(orphan.body.id);

        const filtered = await dispatcher.get(`${BASE}?siteId=${discharge}&serviceDate=2026-11-27`);
        expect(filtered.body.map((d) => d.id)).not.toContain(orphan.body.id);
    });

    it('ignores a pharmacy that is not a number rather than refusing the list', async () => {
        /* The log is read during a go-live review. A junk query string
           should narrow nothing, not take the page away. */
        const res = await dispatcher.get(`${BASE}?siteId=not-a-number`);
        expect(res.status, res.text).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
    });

    it('is not readable by a courier, who can report but not review', async () => {
        expect((await courier.get(BASE)).status).toBe(403);
    });
});

describe('the go-live question', () => {
    it('answers it as a number rather than a feeling, and refuses to decide', async () => {
        const res = await dispatcher.get(`${BASE}/summary`);
        expect(res.status).toBe(200);
        expect(res.body.goLive.openCritical).toBeGreaterThan(0);
        expect(res.body.goLive.ready).toBe(false);
        expect(res.body.goLive.why).toMatch(/critical/);
        expect(res.body.days.length).toBeGreaterThan(0);
    });

    it('says nothing open is necessary and not sufficient', async () => {
        /* A clean board is not a decision. Somebody still signs off, and the
           wording says so rather than showing a green tick. */
        const open = await dispatcher.get(`${BASE}?status=open`);
        for (const d of open.body) {
            await dispatcher.patch(`${BASE}/${d.id}`).send({ status: 'resolved', resolution: 'Closed while checking the summary behaves.' });
        }
        const res = await dispatcher.get(`${BASE}/summary`);
        expect(res.body.goLive.ready).toBe(true);
        expect(res.body.goLive.why).toMatch(/necessary and not sufficient/);
        expect(res.body.totals.open).toBe(0);
    });
});
