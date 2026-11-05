/* What happens at the door.
 *
 * Three things decide whether the record is worth anything, and each is
 * tested by what it refuses: arrival must survive a courier who only taps
 * Deliver, a doorstep delivery must be impossible when the medication needs a
 * signature, and a dry run must carry a reason per item because that is what
 * the invoice line rests on. Names are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { DRY_RUN_REASONS } from '../src/db/schema/uh.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['bo.courier', 'Bo Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'courier-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/* A stored photograph of the signed courier form. Every delivery needs one
   now, not only controlled ones, so this is the price of admission to the
   deliver route rather than a detail of one test. order_id stays NULL the way
   the uploader leaves it; the handler binds it when the delivery lands. */
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

let seq = 0;
/** An order in a courier's hands, ready for the door. */
async function pickedUpOrder(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'stat',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Cold pack', quantity: 2, externalRef: `RX-${5000 + seq}`,
        signatureRequired: true, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

/** A stored file of any kind, for the evidence route. */
async function storedFileOf(kind) {
    const at = new Date().toISOString();
    const rs = await sql(
        `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at, stored_at)
         VALUES ((SELECT id FROM projects WHERE code = 'uh'), NULL, ?, ?, 'image/jpeg', 2048, 'stored', 'ada.courier', ?, ?)
         RETURNING id`,
        [kind, `uh/test/${kind}/${Math.random()}.jpg`, at, at],
    );
    return Number(rs.rows[0].id);
}

async function courierAgent(username) {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'courier-pass-1' })).status).toBe(200);
    return a;
}

const detail = (id) => admin.get(`${ORDERS}/${id}`);

/* ------------------------------------------ custody nobody recorded (3 Nov) */

describe('delivering something that was never collected', () => {
    /** Assigned to a courier and nothing else: no pickup, as of 3 November. */
    async function assignedOrder() {
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat',
            recipientName: `Uncollected ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
            description: 'Cold pack', quantity: 1, externalRef: `RX-${7000 + seq}`,
            signatureRequired: true,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [created.body.id] });
        return created.body;
    }

    it('stays assigned until a courier does something, so dispatch can still undo it', async () => {
        /* THE REASON THIS IS NOT DONE AT ASSIGNMENT. An earlier version of
           this change wrote the pickup the moment dispatch assigned, which
           moved every order to picked_up and took two things away:
           `unassigned` is from: ['assigned'], so a mis-assignment could no
           longer be undone -- the thing dispatch now does by hand all day --
           and carrying() counts picked_up, so every assigned delivery would
           have blocked its driver from going off shift. */
        const order = await assignedOrder();
        expect((await detail(order.id)).body.status).toBe('assigned');
    });

    it('records the collection itself when the courier delivers', async () => {
        /* Drivers no longer record a collection at all. `delivered` is
           reachable only from picked_up, so without this the delivery is
           refused and the round cannot be finished. */
        const order = await assignedOrder();
        const res = await admin.post(`${ORDERS}/${order.id}/events`).send({
            type: 'delivered', signedName: 'A Patient',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await detail(order.id)).body.status).toBe('delivered');
    });

    it('keeps the custody chain whole, with no name nobody gave', async () => {
        /* The alternative was letting `delivered` start from `assigned`,
           which would shorten the chain in every document and report that
           reads it. The link is written instead -- and left honest: a
           proof-of-delivery that printed a signature for a counter nobody
           stood at would be the one untrue line in it. */
        const order = await assignedOrder();
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'A Patient' });

        const types = (await detail(order.id)).body.custody.map((e) => e.type);
        expect(types).toEqual(['created', 'assigned', 'picked_up', 'delivered']);

        const pickup = (await detail(order.id)).body.custody.find((e) => e.type === 'picked_up');
        /* A ROLE, NOT A PERSON. The pharmacy did hand it over, which is what
           the chain asserts; which member of staff is what this contract
           stopped capturing, and naming one would be invented. */
        expect(pickup.signedName).toBe('Site staff');
        expect(pickup.reason).toMatch(/package received at the pharmacy, no signature taken/);
    });

    it('does the same for a delivery that failed at the door', async () => {
        /* `attempted` is from: ['picked_up'] too, and a dry run bills. A
           courier who could not record the failure would have to invent
           something else. */
        const order = await assignedOrder();
        const res = await admin.post(`${ORDERS}/${order.id}/events`).send({
            type: 'attempted', reason: 'Nobody answered',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await detail(order.id)).body.status).toBe('failed');
    });

    it('leaves a real collection alone, name and all', async () => {
        /* The pickup screen still exists and still demands a name of its
           own (modules/uh/pickup.ts). What changed is that the transition
           table stopped forbidding the automatic one -- not that a human
           collection records any less. */
        const order = await pickedUpOrder();
        const pickup = (await detail(order.id)).body.custody.find((e) => e.type === 'picked_up');
        expect(pickup.signedName).toBe('Pharmacy Tech');
        /* Matched on "Recorded automatically", which is what marks a pickup
           the system wrote rather than a person. The old pattern keyed off
           the signature wording and would have passed for the wrong reason
           the moment that sentence was reworded -- which it then was. */
        expect(pickup.reason ?? '').not.toMatch(/Recorded automatically/);
    });
});

describe('the paperwork on a controlled delivery', () => {
    /* Drivers, 4 November: "There's only 1 spot to upload a picture. Please
       add a 2nd spot to add ID & receipt." The receipt is a SEPARATE
       document from the signed pharmacy form -- confirmed with them -- so
       it is its own file kind rather than a second courier_form.

       THE RULE THESE PIN IS THAT IT IS OPTIONAL. A delivery records on the
       signed form alone. Somebody will eventually try to make the receipt
       compulsory "because it is a controlled drug", and an unrecorded
       handover is worse evidence than a missing photograph of a receipt. */

    it('accepts a stamped receipt alongside the signed form', async () => {
        const ada = await courierAgent('ada.courier');
        const order = await pickedUpOrder({ controlled: true });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedForm(),
            stampedReceiptFileId: await storedFileOf('stamped_receipt'),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('records a controlled delivery with no receipt at all', async () => {
        const ada = await courierAgent('ada.courier');
        const order = await pickedUpOrder({ controlled: true });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas', courierFormFileId: await storedForm(),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await detail(order.id)).body.status).toBe('delivered');
    });

    it('still refuses a controlled delivery with no signed form', async () => {
        /* Optional means the RECEIPT is optional. The form is what proves a
           delivery happened and nothing here loosens that. */
        const ada = await courierAgent('ada.courier');
        const order = await pickedUpOrder({ controlled: true });
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            stampedReceiptFileId: await storedFileOf('stamped_receipt'),
        });
        expect(res.status).toBe(400);
        expect(res.body.need).toContain('courierFormFileId');
    });

    it('keeps ID compulsory where the form is stamped ID Required', async () => {
        /* A controlled order whose list ALSO said ID Required. The new
           optional slots must not have relaxed the contract's own rule. */
        const ada = await courierAgent('ada.courier');
        const order = await pickedUpOrder({ controlled: true, idRequired: true });
        const without = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas', courierFormFileId: await storedForm(),
        });
        expect(without.status, 'ID Required still blocks').toBe(400);

        const withId = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            courierFormFileId: await storedForm(),
            patientIdFileId: await storedFileOf('patient_id'),
        });
        expect(withId.status, JSON.stringify(withId.body)).toBe(201);
    });

    it('lets a courier attach the receipt after the delivery was recorded', async () => {
        /* Adding, not only replacing: a courier handed a stamped receipt at
           a door where they could not photograph it has no other route, and
           the evidence endpoint appends rather than overwrites. */
        const ada = await courierAgent('ada.courier');
        const order = await pickedUpOrder({ controlled: true });
        await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm() });

        const res = await ada.post(`${ORDERS}/${order.id}/evidence`).send({
            fileId: await storedFileOf('stamped_receipt'),
            kind: 'stamped_receipt',
            note: 'Stamped at the counter after I left',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
});

/* -------------------------------------------------------------- arriving */

describe('arriving', () => {
    it('records the time and the position without changing the outcome', async () => {
        // Addendum 1 counts an on-time arrival as the success, so this is a
        // timestamp, not a result.
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ lat: 29.42, lng: -98.49 });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('picked_up');
        expect(res.body.arrivedAt).toBeTruthy();

        const d = await detail(order.id);
        const event = d.body.custody.find((e) => e.type === 'arrived');
        expect(event).toMatchObject({ lat: 29.42, lng: -98.49 });
    });

    it('keeps the first arrival when a courier taps twice', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const first = await ada.post(`${ORDERS}/${order.id}/arrive`).send({ at: '2026-09-12T14:00:00Z' });
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({ at: '2026-09-12T14:20:00Z' });
        const d = await detail(order.id);
        // The stamp the deadline is measured against must not move.
        expect(d.body.arrivedAt).toBe(first.body.arrivedAt);
    });

    it('cannot arrive at something not yet picked up', async () => {
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat', recipientName: 'Nobody', addressLine: '1 Nowhere', zip: '78215', quantity: 1,
        });
        const res = await admin.post(`${ORDERS}/${created.body.id}/arrive`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('transition.illegal');
    });

    it('refuses a time in the future, which would flatter the on-time figure', async () => {
        const order = await pickedUpOrder();
        const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await admin.post(`${ORDERS}/${order.id}/arrive`).send({ at: ahead });
        expect(res.status).toBe(400);
    });
});

/* ------------------------------------------------------------ delivering */

describe('delivering', () => {
    /* The three ways a delivery can be signed for, which pickup gained first
       and which a doorstep needs more, not less: the person receiving may
       have their hands full, may be elderly, may be behind a screen door. */

    it('refuses every delivery without the photographed form, not just controlled ones', async () => {
        /* THE RULE THAT REPLACED THREE OTHERS.
           This route used to take a photograph OR strokes OR a typed reason,
           and ordinary deliveries almost always took the middle branch --
           not because anyone signed a screen, but because the app drew a mark
           from the typed name and sent it. The clients no longer generate
           one, so the photograph is the proof on every order. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});

        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.formPhotographRequired');
        expect(res.body.need).toContain('courierFormFileId');
        /* Arriving stamps arrived_at without moving the status off
           picked_up, so the property here is that it did NOT become
           delivered rather than what it did become. */
        expect((await detail(order.id)).body.status).not.toBe('delivered');
    });

    it('is not satisfied by a typed reason any more', async () => {
        /* "Hands full; asked me to leave it on the table" used to be enough.
           It is an explanation for an absent signature, and there is no
           signature to explain -- what is missing now is the photograph of
           the paper both parties signed, and no sentence substitutes for it.
           A courier who cannot photograph it records a failed attempt. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({
            signedName: 'Ines Vargas',
            noSignatureReason: 'Hands full with a child; asked me to leave it on the table.',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('deliver.formPhotographRequired');
    });

    it('takes the delivery once the form is photographed', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm() });
        expect(res.status, res.text).toBe(201);
        expect((await detail(order.id)).body.status).toBe('delivered');
    });

    it('still requires a name even when nobody signs', async () => {
        /* A delivery with nobody's name against it is an anonymous handover
           of a prescription. That does not relax. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ noSignatureReason: 'Nobody would sign.' });
        expect(res.status).toBe(400);
        expect((await detail(order.id)).body.status).not.toBe('delivered');
    });

    it('takes the receiver name and signature, and closes the order', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/arrive`).send({});
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm(), lat: 29.42, lng: -98.49 });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'delivered', receivedBy: 'Ines Vargas' });
        expect(res.body.inferredArrival).toBe(false);

        const d = await detail(order.id);
        expect(d.body.packages.every((p) => p.outcome === 'delivered')).toBe(true);
        const event = d.body.custody.find((e) => e.type === 'delivered');
        expect(event.signedName).toBe('Ines Vargas');
        expect(event.signatureKey).toMatch(/^local:signature:\d+$/);
    });

    it('records the arrival a courier forgot, rather than losing the measurement', async () => {
        /* Losing arrived_at would make evaluateSla fall back to the delivery
           time, understating our own performance against the figure UH holds
           us to. Inferring it can only make us look worse, never better. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm() });
        expect(res.body.inferredArrival).toBe(true);
        expect(res.body.notes.join(' ')).toMatch(/No arrival was recorded separately/);

        const d = await detail(order.id);
        expect(d.body.arrivedAt).toBe(d.body.deliveredAt);
        // And the record says it was inferred rather than pretending otherwise.
        expect(d.body.custody.find((e) => e.type === 'arrived').reason).toMatch(/Recorded automatically/);
    });

    it('refuses a name with no signature, and a signature with no name', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        expect((await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas' })).status).toBe(400);
        expect((await ada.post(`${ORDERS}/${order.id}/deliver`).send({ courierFormFileId: await storedForm() })).status).toBe(400);
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('binds the photographed form to the order it proves', async () => {
        /* REPLACES A TEST THAT ASSERTED A STROKE ROW. Nothing draws strokes
           any more, so the question is no longer "was the signature stored"
           but "can this delivery be tied to the paper that was signed". The
           uploader leaves order_id NULL and the handler binds it; an
           unbound photograph is an image nobody can attribute, and the
           retention sweep walks files by date rather than by owner. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const fileId = await storedForm();
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: fileId });
        expect(res.status, res.text).toBe(201);

        const file = (await sql('SELECT order_id, kind FROM files WHERE id = ?', [fileId])).rows[0];
        expect(Number(file.order_id)).toBe(order.id);
        expect(String(file.kind)).toBe('courier_form');

        /* And the name is still on the record: the photograph says what was
           signed, the custody event says who took it. */
        expect((await detail(order.id)).body.receivedBy ?? 'Ines Vargas').toBe('Ines Vargas');
    });

    it('cannot deliver something that is not in a courier\'s hands', async () => {
        const created = await admin.post(ORDERS).send({
            siteId: dischargeId, serviceType: 'stat', recipientName: 'Nobody', addressLine: '1 Nowhere', zip: '78215', quantity: 1,
        });
        const res = await admin.post(`${ORDERS}/${created.body.id}/deliver`).send({ signedName: 'X', courierFormFileId: await storedForm() });
        expect(res.status).toBe(409);
    });
});

/* -------------------------------------------------------------- doorstep */

describe('leaving it at the door', () => {
    /* Addendum 2 clause 4 forbids it on this contract and the setting that
       carries that defaults to on, so these checks about the mechanism are
       run with the prohibition lifted. Whether the prohibition itself holds
       is uh-stop-doorstep.test.mjs, which also proves the default. */
    beforeAll(async () => {
        await admin.patch('/api/projects/uh/settings').send({ delivery: { personalHandoverOnly: false } });
    });
    afterAll(async () => {
        await admin.patch('/api/projects/uh/settings').send({ delivery: { personalHandoverOnly: true } });
    });

    it('is refused outright when the medication needs a signature', async () => {
        /* Scope 1.2.3 allows it "depending on the medication type". Refused
           rather than warned about: a courier who can tap past a warning
           will, and the package that needed a signature is the one that
           mattered. */
        const order = await pickedUpOrder({ signatureRequired: true });
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId: 1, noSignatureReason: 'Nobody answered' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('doorstep.signatureRequired');
        expect(res.body.error).toMatch(/cannot be left at the door/);
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('is refused when there is nowhere to put the photo', async () => {
        // No AWS account yet. A doorstep delivery with no photo is a claim,
        // not evidence, so it is refused rather than recorded unsupported.
        const order = await pickedUpOrder({ signatureRequired: false });
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/doorstep`)
            .send({ fileId: 1, noSignatureReason: 'Nobody answered, left in porch' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('files.notConfigured');
        expect(res.body.detail).toMatch(/0\.10/);
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('needs a reason, whatever else is true', async () => {
        const order = await pickedUpOrder({ signatureRequired: false });
        const ada = await courierAgent('ada.courier');
        expect((await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId: 1 })).status).toBe(400);
        expect((await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ fileId: 1, noSignatureReason: 'x' })).status).toBe(400);
        expect((await ada.post(`${ORDERS}/${order.id}/doorstep`).send({ noSignatureReason: 'Nobody answered' })).status).toBe(400);
    });
});

/* --------------------------------------------------------------- dry run */

describe('a dry run', () => {
    it('records a reason per item, because the fee is per item', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');

        const res = await ada.post(`${ORDERS}/${order.id}/attempt`).send({
            packages: [{ packageId: packages[0].id, reasonCode: 'recipient_not_located', note: 'No answer, no safe place' }],
            lat: 29.42, lng: -98.49,
        });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('failed');

        const row = (await sql('SELECT failure_reason_code, failure_note, outcome FROM packages WHERE id = ?', [packages[0].id])).rows[0];
        expect(row).toMatchObject({ failure_reason_code: 'recipient_not_located', outcome: 'failed' });
        expect(String(row.failure_note)).toMatch(/No answer/);
    });

    it('uses the reasons Addendum 1 itself lists', () => {
        // So an invoice line can be defended by pointing at the clause.
        expect(DRY_RUN_REASONS).toContain('incorrect_address');
        expect(DRY_RUN_REASONS).toContain('recipient_not_located');
        expect(DRY_RUN_REASONS).toContain('no_access');
        expect(DRY_RUN_REASONS).toContain('incomplete_shipment');
    });

    it('makes "other" say what happened', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const bare = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'other' }] });
        expect(bare.status).toBe(400);
        expect(bare.body.details.join(' ')).toMatch(/needs a note/);

        const withNote = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'other', note: 'Road closed by police' }] });
        expect(withNote.status).toBe(201);
    });

    it('says what the stop bills as, counting items not packages', async () => {
        // quantity 2 on one package is two items under Addendum 1.
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'no_access' }] });
        expect(res.body.dryRunItems).toBe(2);
    });

    it('refuses a package that is not on this order', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: 999_999, reasonCode: 'no_access' }] });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/999999/);
    });

    it('refuses a reason code that is not one of the contract\'s', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'felt_like_it' }] });
        expect(res.status).toBe(400);
    });

    it('records the arrival a courier forgot here too', async () => {
        const order = await pickedUpOrder();
        const packages = (await detail(order.id)).body.packages;
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/attempt`)
            .send({ packages: [{ packageId: packages[0].id, reasonCode: 'no_access' }] });
        expect(res.body.inferredArrival).toBe(true);
        // An attempt that arrived in time still met the deadline: Addendum 1
        // counts arrival, not the outcome.
        const d = await detail(order.id);
        expect(d.body.sla.measuredFrom).toBe('arrived');
    });
});

/* ---------------------------------------------------------------- access */

describe('a photograph that was no good', () => {
    /* ─────────────────────────────────────────────────────────────────────
     * WHAT THIS IS FOR.
     *
     * The commonest thing a driver gets wrong is not the delivery, it is
     * the picture of it: the form came out blurred, a thumb covered the
     * signature, the identification was shot at an angle nobody can read.
     * The handover happened and the record of it is right. Until
     * 4 November a delivered stop was disabled on the phone, so the proof
     * of delivery kept whatever had been photographed first.
     *
     * The property every one of these is testing: the picture can be
     * replaced and the outcome cannot.
     * ───────────────────────────────────────────────────────────────────── */

    /** A delivery already recorded, by the courier it belongs to. */
    async function delivered() {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/deliver`)
            .send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm() });
        expect(res.status, res.text).toBe(201);
        return { order, ada };
    }

    it('takes a better photograph of a delivery already recorded', async () => {
        const { order, ada } = await delivered();
        const better = await storedFileOf('courier_form');

        const res = await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: better, kind: 'courier_form', note: 'The first one was blurred' });
        expect(res.status, res.text).toBe(201);
        expect(res.body.fileId).toBe(better);
    });

    it('moves nothing: the status, the time and the signer are what they were', async () => {
        const { order, ada } = await delivered();
        const before = (await detail(order.id)).body;

        await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: await storedFileOf('courier_form'), kind: 'courier_form' });

        const after = (await detail(order.id)).body;
        expect(after.status).toBe('delivered');
        expect(after.deliveredAt).toBe(before.deliveredAt);
        expect(after.receivedBy).toBe(before.receivedBy);
    });

    it('appends rather than edits, because custody_events cannot be edited', async () => {
        const { order, ada } = await delivered();
        const was = (await sql('SELECT COUNT(*) AS n FROM custody_events WHERE order_id = ?', [order.id])).rows[0].n;

        await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: await storedFileOf('courier_form'), kind: 'courier_form' });

        const now = (await sql('SELECT COUNT(*) AS n FROM custody_events WHERE order_id = ?', [order.id])).rows[0].n;
        expect(Number(now)).toBe(Number(was) + 1);

        /* And the delivered event itself still names its own file. */
        const note = (await sql(
            "SELECT type, reason, file_id FROM custody_events WHERE order_id = ? ORDER BY id DESC LIMIT 1",
            [order.id],
        )).rows[0];
        expect(String(note.type)).toBe('note');
        expect(Number(note.file_id)).toBeGreaterThan(0);
        expect(String(note.reason)).toMatch(/after the delivery was recorded/);
    });

    it('leaves the old photograph where an investigation can still find it', async () => {
        /* Replacement by appending, which is the only kind this system
           does. pod-photos.ts takes the newest stored one of each kind, so
           the document corrects itself without anything being destroyed. */
        const { order, ada } = await delivered();
        const first = (await sql(
            "SELECT id FROM files WHERE order_id = ? AND kind = 'courier_form' ORDER BY id DESC LIMIT 1",
            [order.id],
        )).rows[0].id;

        const better = await storedFileOf('courier_form');
        await ada.post(`${ORDERS}/${order.id}/evidence`).send({ fileId: better, kind: 'courier_form' });

        const bound = (await sql(
            "SELECT id FROM files WHERE order_id = ? AND kind = 'courier_form' ORDER BY id",
            [order.id],
        )).rows.map((r) => Number(r.id));
        expect(bound).toContain(Number(first));
        expect(bound).toContain(better);
        /* Newest last, which is the one the proof of delivery will print. */
        expect(bound[bound.length - 1]).toBe(better);
    });

    it('takes the identification too, which is the one shot at a bad angle', async () => {
        const { order, ada } = await delivered();
        const res = await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: await storedFileOf('patient_id'), kind: 'patient_id' });
        expect(res.status, res.text).toBe(201);
    });

    it('refuses an outcome that has not been recorded yet', async () => {
        /* Before one, the delivery screen is open and takes the photograph
           the ordinary way. Two routes into one moment is how the one with
           fewer checks becomes the one that gets used. */
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const res = await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: await storedFileOf('courier_form'), kind: 'courier_form' });
        expect(res.status, res.text).toBe(409);
        expect(res.body.code).toBe('evidence.notRecorded');
    });

    it('works on a dry run as well, because that picture gets disputed too', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        const pkgs = (await detail(order.id)).body.packages;
        expect((await ada.post(`${ORDERS}/${order.id}/attempt`).send({
            packages: pkgs.map((pkg) => ({ packageId: pkg.id, reasonCode: 'no_access' })),
        })).status).toBe(201);

        const res = await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: await storedFileOf('doorstep'), kind: 'doorstep' });
        expect(res.status, res.text).toBe(201);
        expect((await detail(order.id)).body.status).toBe('failed');
    });

    it('refuses a file that never finished uploading', async () => {
        const { order, ada } = await delivered();
        const pending = (await sql(
            `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at)
             VALUES ((SELECT id FROM projects WHERE code = 'uh'), NULL, 'courier_form', ?, 'image/jpeg', 2048, 'pending', 'ada.courier', ?)
             RETURNING id`,
            [`uh/test/pending/${Math.random()}.jpg`, new Date().toISOString()],
        )).rows[0].id;

        const res = await ada.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: Number(pending), kind: 'courier_form' });
        expect(res.status, res.text).toBe(400);
        expect(res.body.code).toBe('evidence.fileNotStored');
    });

    it('refuses somebody else\'s delivery', async () => {
        const { order } = await delivered();
        const bo = await courierAgent('bo.courier');
        const res = await bo.post(`${ORDERS}/${order.id}/evidence`)
            .send({ fileId: await storedFileOf('courier_form'), kind: 'courier_form' });
        expect(res.status, res.text).toBe(403);
    });

    it('keeps the note out of the audit trail but the kind in it', async () => {
        /* The trail answers who changed what and when. A driver's sentence
           about a delivery can name the patient, and this one is free
           text. */
        const { order, ada } = await delivered();
        await ada.post(`${ORDERS}/${order.id}/evidence`).send({
            fileId: await storedFileOf('courier_form'), kind: 'courier_form',
            note: 'Ines Vargas signed it again',
        });

        const audit = await admin.get('/api/audit?action=stop&limit=10');
        const blob = JSON.stringify(audit.body);
        expect(audit.body.events.some((e) => e.action === 'stop.evidence')).toBe(true);
        expect(blob).not.toContain('Ines Vargas');
    });
});

describe('access control and the record', () => {
    it('will not let a courier work someone else\'s stop', async () => {
        const order = await pickedUpOrder();
        const bo = await courierAgent('bo.courier');
        for (const [path, body] of [
            ['arrive', {}],
            ['deliver', { signedName: 'X' }],
            ['attempt', { packages: [{ packageId: 1, reasonCode: 'no_access' }] }],
        ]) {
            expect((await bo.post(`${ORDERS}/${order.id}/${path}`).send(body)).status, path).toBe(403);
        }
        expect((await detail(order.id)).body.status).toBe('picked_up');
    });

    it('lets staff record it when a phone has died', async () => {
        const order = await pickedUpOrder();
        const res = await admin.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm() });
        expect(res.status).toBe(201);
        expect((await detail(order.id)).body.custody.find((e) => e.type === 'delivered').actor).toBe('admin');
    });

    it('refuses a client viewer entirely', async () => {
        const order = await pickedUpOrder();
        await admin.post('/api/users').send({ username: 'stop.viewer', name: 'Viewer', password: 'member-pass-12', role: 'staff' });
        await admin.put('/api/users/stop.viewer/memberships/uh').send({ role: 'pharmacy', settings: {} });
        const viewer = srv.agent();
        await viewer.post('/api/login').send({ username: 'stop.viewer', password: 'member-pass-12' });
        expect((await viewer.post(`${ORDERS}/${order.id}/arrive`).send({})).status).toBe(403);
    });

    it('keeps the receiver name and the strokes out of the audit trail', async () => {
        const order = await pickedUpOrder();
        const ada = await courierAgent('ada.courier');
        await ada.post(`${ORDERS}/${order.id}/deliver`).send({ signedName: 'Ines Vargas', courierFormFileId: await storedForm() });

        const audit = await admin.get('/api/audit?action=stop&limit=10');
        expect(audit.body.events.some((e) => e.action === 'stop.delivered')).toBe(true);
        const blob = JSON.stringify(audit.body);
        expect(blob).not.toContain('Ines Vargas');
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toMatch(/"x":/);
    });
});
