/* Two signatures on a controlled-substance handover.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROMISE THIS KEEPS.
 *
 * §6 of the courier offer letter, in writing to every driver who signs one:
 *
 *   "Never open, alter, or separate a sealed package. Controlled-substance
 *    items require a documented two-signature handoff."
 *
 * Nothing in the system did that. A handover recorded one signature -- the
 * pharmacy's at the counter, the recipient's at the door -- and the courier
 * was only the `actor` on the custody row. One party to a transfer of
 * custody is not a two-signature handoff, and that row is what a DEA
 * question would be answered from.
 *
 * What is tested is mostly the refusals. A system that captures a second
 * signature when it is offered, and shrugs when it is not, has not kept the
 * promise: it has made keeping it optional.
 *
 * Every name and address here is invented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let dischargeId;
let ada;

const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.5, y: 0.2, t: 40 }, { x: 0.8, y: 0.6, t: 90 }]];
const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
async function pickedUpOrder(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `CS-${6000 + seq}`,
        signatureRequired: true, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

/* No strokes. Nothing captures a delivery signature any more, so a helper
   that quietly added one would be testing a request no client sends. Callers
   that need the delivery to succeed pass courierFormFileId, which is now the
   proof on every delivery rather than only on controlled ones. */
const deliver = (order, body) => ada.post(`${ORDERS}/${order.id}/deliver`).send({
    signedName: 'Ines Vargas', ...body,
});

/* A stored photograph of part 2 of the docket. order_id stays NULL the way
   the uploader leaves it; the handler binds it when the delivery is
   recorded. */
async function storedForm() {
    const at = new Date().toISOString();
    const rs = await sql(
        `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
         VALUES ((SELECT id FROM projects WHERE code = 'uh'), NULL, 'courier_form', ?, 'image/jpeg', 2048, 'stored', 'ada.courier', ?, ?)
         RETURNING id`,
        [`uh/test/form/${Math.random()}.jpg`, at, at],
    );
    return Number(rs.rows[0].id);
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    await admin.post('/api/users').send({
        username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver',
    });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    ada = srv.agent();
    expect((await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' })).status).toBe(200);
});
afterAll(async () => { await srv.stop(); });

describe('an ordinary delivery', () => {
    it('still takes one signature, because the second mark is about controlled drugs', async () => {
        /* Not widened to every delivery. A second signature demanded at
           every door would be a second signature nobody reads, and the one
           place it means something would stop meaning anything. */
        const order = await pickedUpOrder({ controlled: false });
        const res = await deliver(order, { courierFormFileId: await storedForm() });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
});

describe('a controlled drug at the door', () => {
    it('is refused without the photograph of the signed form', async () => {
        /* BOTH SIGNATURES ARE ON PART 2 OF THE DOCKET. The recipient signs
           the courier's copy at the door and the courier photographs it, so
           the photograph is what documents the two-signature handoff. This
           used to demand countersignStrokes, a mark drawn on glass, which
           asked the courier to sign a second time for one handover. */
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.formPhotographRequired');
        /* It says what to do, not just that it will not. */
        expect(res.body.error).toMatch(/Photograph the signed courier form/i);
    });

    it('takes the courier name from the session, never from the request', async () => {
        /* A countersignature is by whoever is signed in. Asking the app to
           say who that is invites it to say somebody else, and it saves the
           one person who cannot usefully be asked -- the courier -- from
           typing their own name at a door in the rain. */
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order, {
            courierFormFileId: await storedForm(),
            countersignStrokes: STROKES,
            countersignedName: 'Somebody Else Entirely',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const rs = await sql(
            `SELECT countersigned_name FROM custody_events WHERE order_id = ? AND type = 'delivered'`,
            [order.id],
        );
        expect(rs.rows[0].countersigned_name).toBe('Ada Courier');
    });

    it('offers no "there was no form" escape, unlike an ordinary delivery', async () => {
        /* An ordinary delivery may record that there was no signed form, at
           the cost of a written reason, because a counter may genuinely not
           have produced one and a screen that will not move stops the round.
           A controlled item does not move without a docket, so that argument
           does not reach it: with the signatures on paper, a controlled
           delivery recorded without the photograph has no evidence of
           either. */
        const order = await pickedUpOrder({ controlled: true });
        const res = await deliver(order, {
            strokes: [],
            noSignatureReason: 'The pharmacy sent no form with this one',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.formPhotographRequired');
    });

    it('goes through on the photograph alone, and keeps it against the order', async () => {
        const order = await pickedUpOrder({ controlled: true });
        const fileId = await storedForm();
        const res = await deliver(order, { courierFormFileId: fileId, countersignStrokes: STROKES });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        /* Bound to the order, so the portal and the proof-of-delivery
           document can find the picture that carries both signatures. */
        const file = await sql('SELECT order_id FROM files WHERE id = ?', [fileId]);
        expect(Number(file.rows[0].order_id)).toBe(Number(order.id));

        const rs = await sql(
            `SELECT signed_name, signature_key, countersigned_name, countersignature_key
               FROM custody_events WHERE order_id = ? AND type = 'delivered'`,
            [order.id],
        );
        const row = rs.rows[0];
        expect(row.signed_name).toBe('Ines Vargas');
        expect(row.countersigned_name).toBe('Ada Courier');
        /* Two different signature rows, not one key written twice. */
        expect(String(row.signature_key)).toMatch(/^local:signature:\d+$/);
        expect(String(row.countersignature_key)).toMatch(/^local:signature:\d+$/);
        expect(row.countersignature_key).not.toBe(row.signature_key);
    });

    it('stores the courier mark as drawn, never as typed initials', async () => {
        /* The initials route exists because persuading somebody ELSE to
           scrawl on a phone stops the round. It does not apply to the person
           holding it, and "the courier signed" has to mean one thing. */
        const order = await pickedUpOrder({ controlled: true });
        await deliver(order, {
            courierFormFileId: await storedForm(),
            countersignStrokes: STROKES,
            captureMethod: 'initials',
        });

        const rs = await sql(
            `SELECT capture_method FROM signatures WHERE signed_name = 'Ada Courier' ORDER BY id DESC LIMIT 1`,
        );
        expect(rs.rows[0].capture_method).toBe('drawn');
    });
});

describe('a controlled drug at the counter', () => {
    /* The other handover. Pickup is a transfer of custody too, and §6 sits
       in the chain-of-custody section rather than the delivery one. */
    async function waitingRun(over = {}) {
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'adhoc',
            recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
            description: 'Oral solids', quantity: 1, externalRef: `CSP-${6500 + seq}`,
            signatureRequired: true, ...over,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const run = await admin.post(RUNS).send({
            courierUsername: 'ada.courier', label: 'Collect', orderIds: [created.body.id],
        });
        return { order: created.body, runId: run.body.id };
    }

    const collect = (runId, body) => ada.post(`${RUNS}/${runId}/pickup`).send({
        siteId: dischargeId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 1, ...body,
    });

    it('is NOT refused at the counter, because the paper is still travelling', async () => {
        /* INVERTED ON 19 OCTOBER, deliberately, and this is the test that
           says why rather than a deleted one that says nothing.
        
           The counter signs part 1 of the docket and keeps it; part 2 goes
           with the courier and collects the recipient's signature at the
           door, where it is photographed. So at the counter there is no
           digital artefact to demand: the evidence for this handover is a
           piece of paper that has not finished being signed.
        
           §6 is kept where the paper stops moving. The delivery is refused
           without the photograph, and that photograph carries both marks. */
        const { runId } = await waitingRun({ controlled: true });
        const res = await collect(runId);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('goes through when the courier signs too', async () => {
        const { order, runId } = await waitingRun({ controlled: true });
        const res = await collect(runId, { countersignStrokes: STROKES });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const rs = await sql(
            `SELECT countersigned_name FROM custody_events WHERE order_id = ? AND type = 'picked_up'`,
            [order.id],
        );
        expect(rs.rows[0].countersigned_name).toBe('Ada Courier');
    });

    it('covers the whole tote when a mark is offered, not just the controlled part', async () => {
        /* The handover is one act: a lead hands over a tote and the courier
           takes it. A signature per order would be the same mark recorded
           several times, and asking only for the controlled part would mean
           the courier signs for some of what they are carrying. */
        seq += 1;
        const plain = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
            addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: `CSB-${6800 + seq}`, controlled: false,
        });
        seq += 1;
        const controlled = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
            addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: `CSB-${6900 + seq}`, controlled: true,
        });
        const run = await admin.post(RUNS).send({
            courierUsername: 'ada.courier', label: 'Mixed tote',
            orderIds: [plain.body.id, controlled.body.id],
        });

        /* No longer refused here: see the test above for why the counter
           demands nothing. What is still asserted is the half that matters
           when a mark IS offered -- it covers the whole tote rather than the
           controlled part of it, because the handover is one act and signing
           for part of what you are carrying is not one. */
        const ok = await ada.post(`${RUNS}/${run.body.id}/pickup`).send({
            siteId: dischargeId, signedName: 'Pharmacy Tech', strokes: STROKES, countedPackages: 2,
            countersignStrokes: STROKES,
        });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);

        /* And it lands on BOTH orders' custody rows: the courier signed for
           the tote, and the tote is what they drove away with. */
        for (const id of [plain.body.id, controlled.body.id]) {
            const rs = await sql(
                `SELECT countersigned_name FROM custody_events WHERE order_id = ? AND type = 'picked_up'`,
                [id],
            );
            expect(rs.rows[0].countersigned_name, `order ${id}`).toBe('Ada Courier');
        }
    });

    it('tells the phone a tote is controlled BEFORE it is submitted', async () => {
        /* Without this the courier taps Record, gets a 400, and is asking
           for a signature from a pharmacist who has already walked away.
           The screen has to know while they are both still standing there. */
        const { runId } = await waitingRun({ controlled: true });
        const board = await ada.get(`${RUNS}/${runId}/pickup`);
        expect(board.status).toBe(200);
        const site = board.body.sites.find((g) => g.site.id === dischargeId);
        expect(site.controlled).toBe(true);
        expect(site.orders.some((o) => o.controlled === true)).toBe(true);
    });

    it('does not flag a tote with nothing controlled in it', async () => {
        const { runId } = await waitingRun({ controlled: false });
        const board = await ada.get(`${RUNS}/${runId}/pickup`);
        const site = board.body.sites.find((g) => g.site.id === dischargeId);
        expect(site.controlled).toBe(false);
    });

    it('does not ask when nothing in the tote is controlled', async () => {
        const { runId } = await waitingRun({ controlled: false });
        const res = await collect(runId);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
});
