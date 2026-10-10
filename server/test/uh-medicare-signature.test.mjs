/* Medicare: the patient, and nobody else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE PHARMACIES SAID.
 *
 * "We'll put Medicare signature required ... for the actual patient to be
 * required to sign for the package." And, unprompted and emphatic, on what
 * happens when the patient is not there:
 *
 *   "So if the secondary party is not home to sign and we call the patient
 *    and the patient is like, hey, just give it to my neighbor. That is not
 *    acceptable. ... Because we're still liable for everything inside that
 *    package."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A REASON AND NOT A REFUSAL.
 *
 * The courier is looking at a highlighted paper form, a human being and
 * their identification. The server is looking at two strings. Married names,
 * nicknames, transcription out of the pharmacy's system, and a patient who
 * says "Alma" when the list says "Alma-Rose" would all fail an exact match
 * at a door at seven in the morning with the medication in the courier's
 * hand and nobody to appeal to.
 *
 * So what is refused is the SILENT case: recording a patient-only handover
 * to an unnamed person with nothing said about it. The same shape as the
 * package count mismatch at pickup, which also asks for a note rather than
 * stopping the round.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const STROKES = [[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.8, y: 0.6, t: 90 }]];

let srv;
let admin;
let dischargeId;
let seq = 0;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    await admin.post('/api/users').send({
        username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver',
    });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    dischargeId = sites.find((s) => s.code === 'discharge').id;
});
afterAll(async () => { await srv.stop(); });

const courier = async () => {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' })).status).toBe(200);
    return a;
};

/** An order at the door, with whatever handling the test needs. */
async function atTheDoor(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Alma Reyes ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 1, externalRef: `RX-${8000 + seq}`,
        signatureRequired: true, ...over,
    });
    expect(created.status, created.text).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    const ada = await courier();
    await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
    return { order, ada };
}

describe('an ordinary delivery', () => {
    it('is unaffected: anybody at the address may sign, with no explanation', async () => {
        const { order, ada } = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'A Neighbour', strokes: STROKES });
        expect(res.status, res.text).toBe(201);
    });
});

describe('a Medicare delivery', () => {
    it('is recorded without comment when the patient signs', async () => {
        const { order, ada } = await atTheDoor({ signatureRule: 'patient_only' });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: order.recipientName, strokes: STROKES });
        expect(res.status, res.text).toBe(201);
    });

    it('forgives how the name was typed, but not who it is', async () => {
        const { order, ada } = await atTheDoor({ signatureRule: 'patient_only' });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: `  ${order.recipientName.toUpperCase()}  `, strokes: STROKES });
        expect(res.status, res.text).toBe(201);
    });

    it('refuses a silent handover to somebody else, and names both people', async () => {
        /* THE NEIGHBOUR. Refused with the patient's name and the signer's
           name in the message, because a courier reading it at a door needs
           to see the mismatch rather than be told there is one. */
        const { order, ada } = await atTheDoor({ signatureRule: 'patient_only' });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'A Neighbour', strokes: STROKES });
        expect(res.status, res.text).toBe(400);
        expect(res.body.code).toBe('deliver.notThePatient');
        expect(res.body.error).toContain(order.recipientName);
        expect(res.body.error).toContain('A Neighbour');
    });

    it('leaves the delivery unrecorded when it refuses', async () => {
        /* A refusal that half-recorded the handover would be worse than no
           check: the pharmacy would see it delivered and the courier would
           see an error. */
        const { order, ada } = await atTheDoor({ signatureRule: 'patient_only' });
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'A Neighbour', strokes: STROKES });
        const after = await admin.get(`${ORDERS}/${order.id}`);
        expect(after.body.status).not.toBe('delivered');
        expect(after.body.deliveredAt).toBeFalsy();
    });

    it('lets it through when the courier says why', async () => {
        const { order, ada } = await atTheDoor({ signatureRule: 'patient_only' });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'A Neighbour',
            strokes: STROKES,
            signerNotPatientReason: 'Patient bedbound; daughter produced the patient ID at the door.',
        });
        expect(res.status, res.text).toBe(201);
    });

    it('puts that explanation on the chain of custody, not only in the audit', async () => {
        /* custody_events is append-only and is what the proof of delivery
           prints, so the pharmacy reads the explanation on the document they
           already ask for rather than having to ask us for a log. */
        const { order, ada } = await atTheDoor({ signatureRule: 'patient_only' });
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'A Neighbour', strokes: STROKES,
            signerNotPatientReason: 'Daughter produced the patient ID.',
        });
        const rs = await srv.core.client.execute({
            sql: `SELECT reason FROM custody_events WHERE order_id = ? AND type = 'delivered'`,
            args: [order.id],
        });
        const reason = String(rs.rows[0].reason ?? '');
        expect(reason).toContain('A Neighbour');
        expect(reason).toContain('not the patient');
        expect(reason).toContain('Daughter produced the patient ID.');
    });

    it('accepts the caregiver the pharmacy named, with nothing to explain', async () => {
        /* The pharmacy already made that decision, in advance, with the
           patient on the telephone. Asking the courier to justify it would
           be asking them to re-litigate it at a door. */
        const { order, ada } = await atTheDoor({
            signatureRule: 'patient_only',
            authorisedSigners: 'Delphine Okonkwo (daughter)',
        });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Delphine Okonkwo', strokes: STROKES });
        expect(res.status, res.text).toBe(201);
    });

    it('still refuses somebody who is not the named caregiver', async () => {
        const { order, ada } = await atTheDoor({
            signatureRule: 'patient_only',
            authorisedSigners: 'Delphine Okonkwo (daughter)',
        });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Marcus Ibarra', strokes: STROKES });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.notThePatient');
    });
});

describe('what the courier is told before they knock', () => {
    it('carries the rule in words on their own run, not just a flag', async () => {
        /* A courier plans the round off this list. "patient_only" is not a
           thing to show anybody; "Alma Reyes must sign. Nobody else." is. */
        const { order, ada } = await atTheDoor({
            signatureRule: 'patient_only', refrigerated: true, controlled: true,
        });
        const mine = await ada.get('/api/projects/uh/uh/runs/mine');
        expect(mine.status, mine.text).toBe(200);

        const payload = JSON.stringify(mine.body);
        expect(payload).toContain('must sign');
        expect(payload).toContain('Nobody else');

        /* And the flags that decide what goes in the cooler, and in what
           order. Asserted against the whole payload rather than a stop
           picked out of it: the shape of the manifest is not what this test
           is about, and digging for a stop is how it ends up asserting
           nothing. */
        expect(payload, order.id + ' should be on the run').toContain(String(order.id));
        expect(payload).toContain('Fridge');
        expect(payload).toContain('Controlled');
    });
});
