/* The screen that makes storing patient replies worth anything.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO PROPERTIES CARRY THIS FILE, and neither would look broken if it
 * regressed.
 *
 * A PHARMACY MUST NOT SEE THESE. Every other screen in this module is
 * scoped by site so a counter sees its own work, and the natural thing to
 * build here was the same. A reply is a patient's unprompted free text,
 * addressed to the courier who texted them -- "I am at the hospital today",
 * "my husband will be in after four" -- and a counter needs none of it to
 * dispense. A scoped version would hand nine pharmacies a feed of their
 * patients' own words on the grounds that it was technically theirs.
 *
 * AN UNPLACEABLE REPLY MUST STILL BE SHOWN. A reply is tied to an order
 * only when the number matches something we sent; when it does not,
 * project_id is null. Those are the ones most likely to need a person, and
 * they are exactly the ones a site-scoped query drops without trace.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const REPLIES = `${UH}/patient-replies`;

let srv;
let client;
let admin;
let projectId;
let orderId;

const rows = async (sql, args = []) => (await client.execute({ sql, args })).rows;

/** A reply as the inbound webhook would have written it. */
async function reply(over = {}) {
    const o = {
        provider_id: `IN${Math.random().toString(36).slice(2, 10)}`,
        phone: '2105559876',
        body: 'not home till 6',
        order_id: orderId,
        project_id: projectId,
        kind: 'message',
        received_at: new Date().toISOString(),
        ...over,
    };
    await client.execute({
        sql: `INSERT INTO patient_replies
                (provider_id, phone, body, order_id, project_id, kind, received_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [o.provider_id, o.phone, o.body, o.order_id, o.project_id, o.kind, o.received_at],
    });
    const [row] = await rows('SELECT id FROM patient_replies WHERE provider_id = ?', [o.provider_id]);
    return Number(row.id);
}

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;
    admin = await srv.login('admin');
    projectId = Number((await rows("SELECT id FROM projects WHERE code = 'uh'"))[0].id);

    const site = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge');
    const made = await admin.post(`${UH}/orders`).send({
        siteId: site.id, serviceType: 'stat', recipientName: 'Wendell Fairbrass',
        addressLine: '12 Rehearsal Way', zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: 'RX-REPLY-1',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    orderId = made.body.id;

    /* A counter, to prove it is refused rather than merely unlinked. */
    await admin.post('/api/users').send({
        username: 'reply.pharmacist', name: 'Counter Staff', password: 'client-pass-7', role: 'staff',
    });
    await admin.put('/api/users/reply.pharmacist/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: [site.id] },
    });
});
afterAll(async () => { await srv.stop(); });

beforeEach(async () => { await client.execute('DELETE FROM patient_replies'); });

const agentFor = async (username, password) => {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password });
    return a;
};

describe('who may read what a patient texted', () => {
    it('refuses a pharmacy, which is the one thing about their own deliveries they do not get', async () => {
        await reply();
        const counter = await agentFor('reply.pharmacist', 'client-pass-7');
        const res = await counter.get(REPLIES);
        expect(res.status).toBe(403);
        /* Not merely an empty list: the body must not be reachable at all. */
        expect(JSON.stringify(res.body)).not.toContain('not home till 6');
    });

    it('gives it to dispatch', async () => {
        await reply();
        const res = await admin.get(REPLIES);
        expect(res.status).toBe(200);
        expect(res.body.replies).toHaveLength(1);
        expect(res.body.replies[0].body).toBe('not home till 6');
    });
});

describe('what the list holds', () => {
    it('names the delivery it answers, so a dispatcher knows who is talking', async () => {
        await reply();
        const [row] = (await admin.get(REPLIES)).body.replies;
        expect(row.order.id).toBe(orderId);
        expect(row.order.patient).toBe('Wendell Fairbrass');
        expect(row.order.reference).toBe('RX-REPLY-1');
        expect(row.phone).toBe('2105559876');
    });

    it('keeps one it cannot place against any delivery', async () => {
        /* THE ONE A SCOPED QUERY WOULD HAVE DROPPED. project_id is null
           because the number matched nothing we ever sent, which is the
           reply most likely to need somebody to ring back. */
        await reply({ order_id: null, project_id: null, body: 'who is this' });
        const { replies } = (await admin.get(REPLIES)).body;
        expect(replies).toHaveLength(1);
        expect(replies[0].order).toBeNull();
        expect(replies[0].body).toBe('who is this');
    });

    it('shows the outstanding ones and counts them', async () => {
        await reply({ body: 'one' });
        const second = await reply({ body: 'two' });
        await admin.post(`${REPLIES}/${second}/handled`).send({});

        const res = await admin.get(REPLIES);
        expect(res.body.replies.map((r) => r.body)).toEqual(['one']);
        expect(res.body.outstanding).toBe(1);
    });

    it('shows the handled ones too when asked, and still counts only the outstanding', async () => {
        /* THE COUNT IS NOT OF THE ROWS RETURNED, deliberately. It feeds a
           badge whose job is "is there anything waiting", and a badge taken
           from the rows would climb every time somebody pressed Done while
           the all filter was on. */
        const one = await reply({ body: 'one' });
        await reply({ body: 'two' });
        await admin.post(`${REPLIES}/${one}/handled`).send({});

        const res = await admin.get(`${REPLIES}?all=1`);
        expect(res.body.replies).toHaveLength(2);
        expect(res.body.outstanding).toBe(1);
    });

    it('puts the newest first, because that is the one being asked about', async () => {
        await reply({ body: 'older', received_at: '2026-11-27T10:00:00.000Z' });
        await reply({ body: 'newer', received_at: '2026-11-27T18:00:00.000Z' });
        expect((await admin.get(REPLIES)).body.replies.map((r) => r.body))
            .toEqual(['newer', 'older']);
    });
});

describe('marking one dealt with', () => {
    it('records who did it and when', async () => {
        const id = await reply();
        const res = await admin.post(`${REPLIES}/${id}/handled`).send({});
        expect(res.status).toBe(200);
        expect(res.body.handled).toBe(true);
        expect(res.body.handledBy).toBe('admin');
        expect(res.body.handledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('can be undone, because somebody presses Done on the wrong row', async () => {
        const id = await reply();
        await admin.post(`${REPLIES}/${id}/handled`).send({});
        const res = await admin.post(`${REPLIES}/${id}/handled`).send({ handled: false });
        expect(res.body.handled).toBe(false);
        expect(res.body.handledBy).toBe('');
        expect((await admin.get(REPLIES)).body.outstanding).toBe(1);
    });

    it('refuses a pharmacy, who may not report on our own work', async () => {
        const id = await reply();
        const counter = await agentFor('reply.pharmacist', 'client-pass-7');
        expect((await counter.post(`${REPLIES}/${id}/handled`).send({})).status).toBe(403);
    });

    it('is a 404 for an id this project does not have', async () => {
        expect((await admin.post(`${REPLIES}/999999/handled`).send({})).status).toBe(404);
        expect((await admin.post(`${REPLIES}/not-a-number/handled`).send({})).status).toBe(404);
    });

    it('keeps the patient out of the audit row', async () => {
        /* Every other audit entry here is safe to read in bulk. This one
           would carry a patient's own words into a log that is exported and
           searched, so it carries the id and the kind and nothing else. */
        const id = await reply({ body: 'my husband will be in after four' });
        await admin.post(`${REPLIES}/${id}/handled`).send({});
        /* Scoped to this reply: earlier tests in this file mark their own
           rows handled and the audit table is not cleared between them. */
        const audit = await rows(
            "SELECT action, entity_id, detail FROM audit_events "
            + "WHERE action = 'patient.reply.handled' AND entity_id = ?",
            [String(id)],
        );
        expect(audit).toHaveLength(1);
        expect(JSON.stringify(audit[0])).not.toContain('husband');
        expect(JSON.stringify(audit[0])).not.toContain('2105559876');
    });
});
