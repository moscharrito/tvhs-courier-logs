/* What a site lead can and cannot reach.
 *
 * The access matrix proves the gate opens for a lead. This proves the gate is
 * not the protection: a lead is defined by what they cannot see, and that is
 * enforced inside the handlers by modules/uh/lead-scope.ts rather than by the
 * role check on the way in.
 *
 * The failure this guards against is the one that makes the role pointless: a
 * lead at Wheatley reading Robert B. Green's day because one query forgot to
 * narrow itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { asScreen } from './helpers/board.mjs';

const UH = '/api/projects/uh/uh';
const PASS = 'lead-pass-77';

let srv;
let admin;
let lead;
let unscoped;
let dischargeId;
let greenId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
    greenId = sites.find((s) => s.code === 'green').id;

    const make = async (username, settings) => {
        await admin.post('/api/users').send({ username, name: username, password: PASS, role: 'staff' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'lead', settings });
        const a = srv.agent();
        await a.post('/api/login').send({ username, password: PASS });
        return a;
    };
    /* One lead at Discharge, and one whose membership nobody finished. */
    lead = await make('lead.discharge', { siteIds: [dischargeId] });
    unscoped = await make('lead.nowhere', {});
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
async function orderAt(siteId) {
    seq += 1;
    const res = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Lead Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `LEAD-${seq}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

describe('a lead reading the day', () => {
    let mine;
    let theirs;

    beforeAll(async () => {
        mine = await orderAt(dischargeId);
        theirs = await orderAt(greenId);
    });

    it('sees their own pharmacy and not the other', async () => {
        const res = await lead.get(`${UH}/orders`);
        expect(res.status).toBe(200);
        const ids = res.body.orders.map((o) => o.id);
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);
    });

    it('counts only their own, so the header cannot disagree with the table', async () => {
        const res = await lead.get(`${UH}/orders`);
        const summary = await lead.get(`${UH}/orders/summary`);
        expect(summary.body.total).toBe(res.body.total);
        /* And the administrator sees more than the lead does, which is the
           whole point of the role. */
        const all = await admin.get(`${UH}/orders`);
        expect(all.body.total).toBeGreaterThan(res.body.total);
    });

    it('cannot widen itself with a query parameter', async () => {
        /* The scope is applied after every filter a caller can set, so asking
           for somebody else's pharmacy returns nothing rather than theirs. */
        const res = await lead.get(`${UH}/orders?siteId=${greenId}`);
        expect(res.status).toBe(200);
        expect(res.body.orders).toEqual([]);
        expect(res.body.total).toBe(0);
    });

    it('is told not found, not forbidden, for an order at another pharmacy', async () => {
        /* 403 would confirm the id exists, which is the one thing a lead at
           another site should not learn by trying numbers. */
        const res = await lead.get(`${UH}/orders/${theirs.id}`);
        expect(res.status).toBe(404);
        expect((await lead.get(`${UH}/orders/${mine.id}`)).status).toBe(200);
    });

    it('cannot pull the proof of delivery for another pharmacy either', async () => {
        expect((await lead.get(`${UH}/orders/${theirs.id}/pod.pdf`)).status).toBe(404);
    });

    it('gets their own board and not the whole contract', async () => {
        const res = asScreen(await lead.get(`${UH}/board`));
        expect(res.status).toBe(200);
        const onBoard = res.body.pool.flatMap((p) => p.orders).map((o) => o.id);
        expect(onBoard).not.toContain(theirs.id);
        /* The counts are the lead's day, not the project's. */
        const full = await admin.get(`${UH}/board`);
        expect(res.body.summary.total).toBeLessThan(full.body.summary.total);
    });

    it('sees nothing at all when nobody finished their membership', async () => {
        /* A half-made lead account defaults to no sites rather than to every
           site. A pharmacy membership with no siteIds means the whole project
           by design; this role is the opposite and must not inherit that. */
        const res = await unscoped.get(`${UH}/orders`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(0);
        expect((await unscoped.get(`${UH}/board`)).body.summary.total).toBe(0);
    });
});

describe('a lead moving a package', () => {
    let mine;
    let theirs;
    let run;

    beforeAll(async () => {
        mine = await orderAt(dischargeId);
        theirs = await orderAt(greenId);
        await admin.post('/api/users').send({ username: 'lead.driver', name: 'Lead Driver', password: PASS, role: 'driver' });
        await admin.put('/api/users/lead.driver/memberships/uh').send({ role: 'courier', settings: {} });
        run = (await admin.post(`${UH}/runs`).send({
            courierUsername: 'lead.driver', label: 'Lead wave', orderIds: [],
        })).body;
    });

    it('can put an order from their own pharmacy on a run', async () => {
        const res = await lead.post(`${UH}/runs/${run.id}/stops`).send({ orderIds: [mine.id] });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('can take it off again', async () => {
        const res = await lead.delete(`${UH}/runs/${run.id}/stops/${mine.id}`);
        expect([200, 204]).toContain(res.status);
    });

    it('is refused an order from another pharmacy, and told which', async () => {
        /* Named ids, because a lead moving a batch needs to know which one was
           refused. They are ids the caller sent, so nothing is disclosed. */
        const res = await lead.post(`${UH}/runs/${run.id}/stops`).send({ orderIds: [theirs.id] });
        expect(res.status).toBe(404);
        expect(res.body.orderIds).toEqual([theirs.id]);
    });

    it('refuses a whole batch when one order belongs to somebody else', async () => {
        /* All or nothing: a partial move would leave the lead believing the
           whole batch went. */
        const res = await lead.post(`${UH}/runs/${run.id}/stops`).send({ orderIds: [mine.id, theirs.id] });
        expect(res.status).toBe(404);
        expect(res.body.orderIds).toEqual([theirs.id]);

        const after = await admin.get(`${UH}/runs/${run.id}`);
        const onRun = (after.body.stops ?? []).map((s) => s.order?.id ?? s.orderId);
        expect(onRun).not.toContain(mine.id);
    });

    it('cannot create a run, resequence one, or close it', async () => {
        /* Dispatch owns routing. Moving a package at the counter is the whole
           of a lead's write access. */
        expect((await lead.post(`${UH}/runs`).send({
            courierUsername: 'lead.driver', label: 'Nope', orderIds: [],
        })).status).toBe(403);
        expect((await lead.put(`${UH}/runs/${run.id}/sequence`).send({ orderIds: [] })).status).toBe(403);
        expect((await lead.patch(`${UH}/runs/${run.id}`).send({ status: 'completed' })).status).toBe(403);
    });

    it('cannot reach pricing, invoices or the client portal', async () => {
        /* The reason this is a role rather than an admin account. */
        for (const path of ['/pricing', '/invoices', '/client/orders', '/client/reports']) {
            expect((await lead.get(`${UH}${path}`)).status, path).toBe(403);
        }
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE SAME NARROWING, IN THE FILE.
 *
 * The orders export runs filterFor, the same function the screen runs, and
 * that function applies the lead's own-pharmacies rule LAST so no query
 * parameter can reach past it. Writing a second WHERE clause for the export
 * would have been a second place to get that ordering wrong, and what it
 * would leak is every patient address in the contract, in a file somebody
 * then keeps.
 *
 * So this asserts the leak directly rather than trusting the shared function:
 * a file a lead downloads has to be as narrow as the screen they were looking
 * at, including when they ask it for somebody else's pharmacy by name.
 */
describe('a lead exporting the orders list', () => {
    const binary = (res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    };

    const sheetOf = async (res) => {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        const rows = [];
        wb.getWorksheet('Orders').eachRow((row) => {
            rows.push(row.values.slice(1).map((v) => (v === undefined || v === null ? '' : String(v))));
        });
        return rows;
    };

    let atDischarge;
    let atGreen;

    beforeAll(async () => {
        const make = async (siteId, name) => {
            const res = await admin.post(`${UH}/orders`).send({
                siteId, serviceType: 'stat', recipientName: name,
                addressLine: '4 Invented Road', zip: '78215',
            });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            return res.body;
        };
        atDischarge = await make(dischargeId, 'Export Scope Discharge');
        atGreen = await make(greenId, 'Export Scope Green');
    });

    it('gets their own pharmacy', async () => {
        const res = await lead.get(`${UH}/orders/export.xlsx`).buffer().parse(binary);
        expect(res.status).toBe(200);
        const flat = (await sheetOf(res)).flat().join(' | ');
        expect(flat).toContain('Export Scope Discharge');
        expect(atDischarge.id).toBeDefined();
    });

    it('never gets the pharmacy next door, however they ask', async () => {
        /* THE PROPERTY. A lead at Wheatley asking for Robert B. Green gets
           their own sites ANDed with that one, which is nothing. */
        for (const qs of ['', `?siteId=${greenId}`, '?status=ready', `?siteId=${greenId}&status=ready`]) {
            const res = await lead.get(`${UH}/orders/export.xlsx${qs}`).buffer().parse(binary);
            expect(res.status, `with "${qs}"`).toBe(200);
            const flat = (await sheetOf(res)).flat().join(' | ');
            expect(flat, `with "${qs}"`).not.toContain('Export Scope Green');
        }
        expect(atGreen.id).toBeDefined();
    });

    it('gives a lead with no pharmacies an empty file rather than everybody', async () => {
        /* Nothing rather than everything is the direction that matters, and
           it is the one a half-finished settings form produces. */
        const res = await unscoped.get(`${UH}/orders/export.xlsx`).buffer().parse(binary);
        expect(res.status).toBe(200);
        const rows = await sheetOf(res);
        /* The header row and nothing else. */
        expect(rows.length).toBe(1);
    });

    it('warns on the file that it holds patient data', async () => {
        /* This one does, unlike the drivers record, and the About sheet has
           to say which kind of file somebody is holding. */
        const res = await lead.get(`${UH}/orders/export.xlsx`).buffer().parse(binary);
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        const about = [];
        wb.getWorksheet('About').eachRow((row) => about.push(row.values.slice(1).join(' ')));
        expect(about.join(' | ')).toContain('Contains patient data');
    });

    it('records the copy in the audit trail, patient data flagged', async () => {
        await lead.get(`${UH}/orders/export.xlsx`).buffer().parse(binary);
        const { events } = (await admin.get('/api/audit?action=order.export')).body;
        expect(events.length).toBeGreaterThan(0);
        const detail = typeof events[0].detail === 'string' ? JSON.parse(events[0].detail) : events[0].detail;
        expect(detail.containedPatientData).toBe(true);
    });
});
