/* Finding an order: by the courier who has it, and by who it is for.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE COURIER BOX RETURNED NOTHING AND LOOKED LIKE AN ANSWER.
 *
 * Reported on 10 November: "the search input boxes don't produce what's on
 * the list". The list prints a courier's NAME -- "Rosa Delacroix", resolved
 * through people.ts because the column only holds a username -- and the box
 * under it matched `assigned_to_username = ?`, exactly and case sensitively.
 * So the one thing a dispatcher can actually read off the row was the one
 * thing the filter could not accept, and an empty table is indistinguishable
 * from a courier with nothing on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND A PATIENT'S NAME, WHICH MAY NOT BE IN A URL.
 *
 * Dispatch take calls from patients who give a name and not a prescription
 * number, so the filter is wanted. The reason the screen refused it is still
 * true and is still printed on the screen: a GET puts its filters in the
 * address bar, and an address reaches browser history, the referrer sent to
 * anything the page loads, proxies and access logs. Nothing about wanting
 * the feature makes a name safe to put there.
 *
 * So it arrives in a body and only in a body. The last two tests in this
 * file are that fence: a ?recipientName= on the GET does nothing at all, and
 * the audit trail records that the filter was used without recording whom it
 * was used on.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv, admin, siteId;

/* Invented people. The courier's name differs from their username in both
   case and shape, which is the whole point of the first group. */
const COURIER = { username: 'rosa', name: 'Rosa Delacroix' };
const OTHER = { username: 'tobias', name: 'Tobias Marchetti' };

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;

    for (const who of [COURIER, OTHER]) {
        await admin.post('/api/users').send({
            username: who.username, name: who.name, password: 'courier-pass-123', role: 'driver',
        });
        await admin.put(`/api/users/${who.username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }

    let seq = 0;
    const make = async (recipientName, assignTo) => {
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId, serviceType: 'stat', externalRef: `RX-FIND-${seq}`,
            recipientName, addressLine: `${seq} Example Street`, zip: '78229',
            description: 'Prescription', quantity: 1, signatureRequired: false,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const order = created.body;
        if (assignTo) {
            const run = await admin.post(RUNS).send({
                courierUsername: assignTo, label: `Run ${seq}`, orderIds: [order.id],
            });
            expect(run.status, JSON.stringify(run.body)).toBe(201);
        }
        return order.id;
    };

    await make('Dorothy Ashby', COURIER.username);
    await make('Alice Coltrane', COURIER.username);
    await make('Dorothy Donegan', OTHER.username);
    await make('Mary Lou Williams', null);
});
afterAll(async () => { await srv.stop(); });

const idsOf = (body) => body.orders.map((o) => o.recipientName).sort();

describe('the Courier box, filtering a list that prints names', () => {
    it('still takes the username exactly, as it always did', async () => {
        const res = await admin.get(`${ORDERS}?assignedTo=rosa`);
        expect(res.status).toBe(200);
        expect(idsOf(res.body)).toEqual(['Alice Coltrane', 'Dorothy Ashby']);
    });

    /* ── THE REPORTED FAULT. This is what a dispatcher types, because it is
     * what the row beside the box says. */
    it('takes the name printed on the row', async () => {
        const res = await admin.get(`${ORDERS}?assignedTo=${encodeURIComponent('Rosa Delacroix')}`);
        expect(idsOf(res.body)).toEqual(['Alice Coltrane', 'Dorothy Ashby']);
    });

    it('takes part of a name, and does not care about case', async () => {
        for (const typed of ['rosa delacroix', 'Delacroix', 'ROSA', 'Delac']) {
            const res = await admin.get(`${ORDERS}?assignedTo=${encodeURIComponent(typed)}`);
            expect(idsOf(res.body), `typed: ${typed}`).toEqual(['Alice Coltrane', 'Dorothy Ashby']);
        }
    });

    /* ── AN EXACT USERNAME STILL MEANS THAT ONE ACCOUNT. Otherwise a
     * username that happens to be a substring of somebody else's name would
     * quietly widen a filter somebody used to settle a pay query. */
    it('prefers an exact username over anybody it is a substring of', async () => {
        await admin.post('/api/users').send({
            username: 'mar', name: 'Mar Okonkwo', password: 'courier-pass-123', role: 'driver',
        });
        await admin.put('/api/users/mar/memberships/uh').send({ role: 'courier', settings: {} });

        const res = await admin.get(`${ORDERS}?assignedTo=mar`);
        /* 'mar' is also inside 'Mary Lou Williams', but that is a recipient
           and not a courier, and inside no courier's name here. The point is
           that the exact account wins and the query does not fall through to
           the substring branch at all. */
        expect(res.status).toBe(200);
        expect(res.body.orders).toEqual([]);
    });

    /* ── NOBODY MATCHING IS NOT NO FILTER, which is the dangerous failure:
     * a mistyped courier returning all 2962 orders reads as an answer. */
    it('returns nothing for a courier who does not exist', async () => {
        const res = await admin.get(`${ORDERS}?assignedTo=${encodeURIComponent('Nobody At All')}`);
        expect(res.status).toBe(200);
        expect(res.body.orders).toEqual([]);
        expect(res.body.total).toBe(0);
    });

    /* ── A TWO LETTER PREFIX, WHICH IS WHAT SOMEBODY ACTUALLY TYPES ─────
     * Reported from production as "Courier produced nothing" with `Mo` in
     * the box. The cause there was a forgotten name search ANDed with it,
     * but the matcher itself is what got blamed, so it is pinned here: a
     * short prefix of a name finds that courier and nothing else is needed
     * alongside it. */
    it('finds a courier from the first two letters of their name', async () => {
        await admin.post('/api/users').send({
            username: 'tdomingo', name: 'Mona Okafor', password: 'courier-pass-123', role: 'driver',
        });
        await admin.put('/api/users/tdomingo/memberships/uh').send({ role: 'courier', settings: {} });

        const created = await admin.post(ORDERS).send({
            siteId, serviceType: 'stat', externalRef: 'RX-FIND-MO',
            recipientName: 'Nina Simone', addressLine: '9 Example Street', zip: '78229',
            description: 'Prescription', quantity: 1, signatureRequired: false,
        });
        await admin.post(RUNS).send({
            courierUsername: 'tdomingo', label: 'Run Mo', orderIds: [created.body.id],
        });

        /* The name begins with it; the username does not contain it at all,
           so this can only pass through the name branch. */
        const res = await admin.get(`${ORDERS}?assignedTo=Mo`);
        expect(res.status).toBe(200);
        expect(idsOf(res.body)).toEqual(['Nina Simone']);
    });

    it('still understands unassigned', async () => {
        const res = await admin.get(`${ORDERS}?assignedTo=unassigned`);
        expect(idsOf(res.body)).toEqual(['Mary Lou Williams']);
    });
});

describe('searching by a patient name, through a body', () => {
    it('finds the orders for that person', async () => {
        const res = await admin.post(`${ORDERS}/search`).send({ recipientName: 'Dorothy' });
        expect(res.status).toBe(200);
        expect(idsOf(res.body)).toEqual(['Dorothy Ashby', 'Dorothy Donegan']);
    });

    it('does not care about case, and takes part of a name', async () => {
        const res = await admin.post(`${ORDERS}/search`).send({ recipientName: 'coltrane' });
        expect(idsOf(res.body)).toEqual(['Alice Coltrane']);
    });

    /* A wildcard typed by a person is a literal, not a pattern: somebody
       searching for "100%" is searching for that, and an unescaped _ would
       match any character at all. */
    it('treats a wildcard as a character somebody typed', async () => {
        const res = await admin.post(`${ORDERS}/search`).send({ recipientName: '%' });
        expect(res.body.orders).toEqual([]);
    });

    it('combines with the other filters rather than replacing them', async () => {
        const res = await admin.post(`${ORDERS}/search`).send({
            recipientName: 'Dorothy', assignedTo: 'Rosa Delacroix',
        });
        expect(idsOf(res.body)).toEqual(['Dorothy Ashby']);
    });

    /* ── THE HEADER CANNOT DISAGREE WITH THE TABLE. The summary route is a
     * GET and cannot be told the name, so the counts ride with the page. */
    it('returns the counts for the same set it returned', async () => {
        const res = await admin.post(`${ORDERS}/search`).send({ recipientName: 'Dorothy' });
        expect(res.body.summary.total).toBe(2);
        expect(res.body.total).toBe(2);
    });

    /* ── AND THE FENCE ───────────────────────────────────────────────────── */

    it('ignores a patient name on the query string entirely', async () => {
        /* Not an error, not a filtered list: the parameter simply does not
           exist on the GET, so this is every order. If this ever starts
           filtering, a name can be put in a URL, and a URL goes to places
           nobody audits. */
        const all = await admin.get(ORDERS);
        const tried = await admin.get(`${ORDERS}?recipientName=Dorothy`);
        expect(tried.body.total).toBe(all.body.total);
        expect(tried.body.total).toBeGreaterThan(2);
    });

    it('records that the filter was used, never who it was used on', async () => {
        await admin.post(`${ORDERS}/search`).send({ recipientName: 'Dorothy' });
        const audit = await admin.get('/api/audit?action=order.list&limit=5');
        const text = JSON.stringify(audit.body);

        expect(text).toContain('recipientName');
        /* The term itself is a patient's name and is not written down. */
        expect(text).not.toContain('Dorothy');
    });
});
