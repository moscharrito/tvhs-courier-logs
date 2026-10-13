/* The conversation about one delivery.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS ACTUALLY AT RISK HERE.
 *
 * Not "can two people talk". This endpoint is the first thing in the system
 * that lets a pharmacy write free text that another organisation reads, and
 * three ways of getting it wrong all leak:
 *
 *   Robert B. Green reading a Discharge thread. The thread carries a patient
 *   by name in practice, so the scope has to be the ORDER's scope and not a
 *   room anybody can join.
 *
 *   A mention used as a directory. "Did that username work?" answers whether
 *   a person exists and whether they can see Discharge's deliveries, to
 *   anybody who can type.
 *
 *   A notification carrying the message. It is read on a lock screen in a
 *   corridor, so it may say who and which delivery and nothing else.
 *
 * Every name and address here is invented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const THREADS = `${UH}/threads`;

let srv;
let admin;
let discharge;
let green;
let dischargeOrder;
let greenOrder;

const agentFor = async (username, password) => {
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password });
    expect(res.status, `${username} could not sign in`).toBe(200);
    return a;
};

let seq = 0;
async function makeOrder(siteId) {
    seq += 1;
    const res = await admin.post(`${UH}/orders`).send({
        siteId,
        serviceType: 'adhoc',
        recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Test Street`,
        zip: '78215',
        description: 'Oral solids',
        quantity: 1,
        externalRef: `TH-${7000 + seq}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');

    /* One account per counter, scoped the way create:portals scopes them. */
    for (const [username, siteIds] of [
        ['th.discharge', [discharge.id]],
        ['th.green', [green.id]],
    ]) {
        await admin.post('/api/users').send({ username, name: username, password: 'portal-pass-1', role: 'staff' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'pharmacy', settings: { siteIds } });
    }
    /* The contract manager, who covers both. */
    await admin.post('/api/users').send({ username: 'th.manager', name: 'Karthik Manager', password: 'portal-pass-1', role: 'staff' });
    await admin.put('/api/users/th.manager/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: [discharge.id, green.id] },
    });
    /* The site lead for Discharge. Izy staff, at the counter, and the
       person a pharmacy would actually want to reach. */
    await admin.post('/api/users').send({ username: 'th.lead', name: 'Site Lead', password: 'portal-pass-1', role: 'staff' });
    await admin.put('/api/users/th.lead/memberships/uh').send({ role: 'lead', settings: { siteIds: [discharge.id] } });

    /* And a courier, who is not one of the three channels this is for. */
    await admin.post('/api/users').send({ username: 'th.courier', name: 'Ada Courier', password: 'portal-pass-1', role: 'driver' });
    await admin.put('/api/users/th.courier/memberships/uh').send({ role: 'courier', settings: {} });

    dischargeOrder = await makeOrder(discharge.id);
    greenOrder = await makeOrder(green.id);
});
afterAll(async () => { await srv.stop(); });

describe('talking about a delivery', () => {
    it('keeps the thread on the order, oldest first', async () => {
        const pharmacy = await agentFor('th.discharge', 'portal-pass-1');
        expect((await pharmacy.post(`${THREADS}/${dischargeOrder.id}`)
            .send({ body: 'This one was not in the tote.' })).status).toBe(201);
        expect((await admin.post(`${THREADS}/${dischargeOrder.id}`)
            .send({ body: 'Checked with the driver, collecting at 14:00.' })).status).toBe(201);

        const res = await pharmacy.get(`${THREADS}/${dischargeOrder.id}`);
        expect(res.status).toBe(200);
        expect(res.body.messages.map((m) => m.body)).toEqual([
            'This one was not in the tote.',
            'Checked with the driver, collecting at 14:00.',
        ]);
        /* Names, so a thread does not read as a list of usernames. */
        expect(res.body.messages[1].authorName).toBeTruthy();
    });

    it('is empty rather than missing for a delivery nobody has written on', async () => {
        const res = await admin.get(`${THREADS}/${greenOrder.id}`);
        expect(res.status).toBe(200);
        expect(res.body.messages).toEqual([]);
    });

    it('refuses an empty message', async () => {
        expect((await admin.post(`${THREADS}/${dischargeOrder.id}`).send({ body: '   ' })).status).toBe(400);
    });
});

describe('who may see a thread', () => {
    it('lets a pharmacy read and write its own', async () => {
        const pharmacy = await agentFor('th.discharge', 'portal-pass-1');
        expect((await pharmacy.get(`${THREADS}/${dischargeOrder.id}`)).status).toBe(200);
    });

    it('refuses another pharmacy entirely, read AND write', async () => {
        /* THE ONE THAT MATTERS. A thread names a patient in practice. */
        const other = await agentFor('th.green', 'portal-pass-1');
        expect((await other.get(`${THREADS}/${dischargeOrder.id}`)).status).toBe(404);
        expect((await other.post(`${THREADS}/${dischargeOrder.id}`).send({ body: 'hello' })).status).toBe(404);
    });

    it('says "not found" rather than "not yours"', async () => {
        /* A 403 here would confirm that order 41 exists and belongs to
           somebody, which is an order-number oracle for any counter. */
        const other = await agentFor('th.green', 'portal-pass-1');
        const mine = await other.get(`${THREADS}/${dischargeOrder.id}`);
        const nonexistent = await other.get(`${THREADS}/99999999`);
        expect(mine.status).toBe(nonexistent.status);
    });

    it('lets the contract manager see both counters', async () => {
        const manager = await agentFor('th.manager', 'portal-pass-1');
        expect((await manager.get(`${THREADS}/${dischargeOrder.id}`)).status).toBe(200);
        expect((await manager.get(`${THREADS}/${greenOrder.id}`)).status).toBe(200);
    });

    it('lets the site lead for that counter in, and keeps them out of the other', async () => {
        /* Falls out of the shared scope rather than being a rule of its own,
           which is why it is pinned here: a lead holds siteIds like a
           pharmacy does, so they see their own counter's threads. They are
           the person who badges the driver in and counts the tote. */
        const lead = await agentFor('th.lead', 'portal-pass-1');
        expect((await lead.get(`${THREADS}/${dischargeOrder.id}`)).status).toBe(200);
        expect((await lead.get(`${THREADS}/${greenOrder.id}`)).status).toBe(404);
    });

    it('refuses a courier, who is not one of the three channels', async () => {
        /* Dispatch, the contract manager and each pharmacy. A courier's
           route to dispatch is the driver app, and a thread can carry
           commercial talk about a delivery they are carrying. */
        const courier = await agentFor('th.courier', 'portal-pass-1');
        expect((await courier.get(`${THREADS}/${dischargeOrder.id}`)).status).toBe(404);
    });

    it('refuses anybody who is not signed in', async () => {
        expect((await srv.agent().get(`${THREADS}/${dischargeOrder.id}`)).status).toBe(401);
    });
});

describe('tagging somebody', () => {
    it('records a mention of a person who can see the delivery', async () => {
        const res = await admin.post(`${THREADS}/${dischargeOrder.id}`)
            .send({ body: 'Can you confirm the count?', mentions: ['th.discharge'] });
        expect(res.status).toBe(201);

        const thread = (await admin.get(`${THREADS}/${dischargeOrder.id}`)).body;
        const last = thread.messages[thread.messages.length - 1];
        expect(last.mentions).toEqual(['th.discharge']);
    });

    it('drops a mention of somebody who cannot see it, rather than refusing', async () => {
        /* Refusing would answer "does th.green exist, and can they see
           Discharge's deliveries" for anybody who can type a username. */
        const res = await admin.post(`${THREADS}/${dischargeOrder.id}`)
            .send({ body: 'Checking.', mentions: ['th.green', 'th.discharge'] });
        expect(res.status).toBe(201);

        const thread = (await admin.get(`${THREADS}/${dischargeOrder.id}`)).body;
        const last = thread.messages[thread.messages.length - 1];
        expect(last.mentions).toEqual(['th.discharge']);
    });

    it('drops a username that does not exist, with the same answer', async () => {
        const res = await admin.post(`${THREADS}/${dischargeOrder.id}`)
            .send({ body: 'Anyone?', mentions: ['nobody.at.all'] });
        expect(res.status).toBe(201);
        const thread = (await admin.get(`${THREADS}/${dischargeOrder.id}`)).body;
        expect(thread.messages[thread.messages.length - 1].mentions).toEqual([]);
    });

    it('tells the mentioned person, naming the delivery and never the patient', async () => {
        await admin.post(`${THREADS}/${dischargeOrder.id}`)
            .send({ body: 'Mrs Vargas rang about this one.', mentions: ['th.discharge'] });

        const rs = await srv.core.client.execute({
            sql: `SELECT kind, body FROM notifications
                   WHERE username = 'th.discharge' AND kind = 'thread.mention'
                   ORDER BY id DESC LIMIT 1`,
        });
        const note = rs.rows[0];
        expect(note, 'no mention notification was written').toBeTruthy();
        /* It is read on a lock screen in a corridor. */
        expect(String(note.body)).toContain(dischargeOrder.externalRef);
        expect(String(note.body)).not.toContain('Vargas');
        expect(String(note.body)).not.toContain('Recipient');
    });
});

describe('who the box offers to tag', () => {
    it('offers the people who may already see the delivery', async () => {
        const res = await admin.get(`${THREADS}/${dischargeOrder.id}`);
        const usernames = res.body.people.map((p) => p.username);
        expect(usernames).toContain('th.discharge');
        expect(usernames).toContain('th.manager');
        /* THE ONE THAT MATTERS. Another counter is not on this list, so a
           pharmacy cannot learn of it by reading its own thread. */
        expect(usernames).not.toContain('th.green');
    });

    it('is the same list a pharmacy sees, so the box cannot be a directory', async () => {
        /* Without this the tag box would be a free-text username field, and
           a free-text username field answers "who exists" to anybody who
           can watch whether a mention stuck. */
        const pharmacy = await agentFor('th.discharge', 'portal-pass-1');
        const usernames = (await pharmacy.get(`${THREADS}/${dischargeOrder.id}`)).body.people.map((p) => p.username);
        expect(usernames).not.toContain('th.green');
        expect(usernames).toContain('th.discharge');
    });

    it('carries names, so a tag list does not read as usernames', async () => {
        const res = await admin.get(`${THREADS}/${dischargeOrder.id}`);
        expect(res.body.people.find((p) => p.username === 'th.manager').name).toBe('Karthik Manager');
    });
});

describe('what cannot be taken back', () => {
    it('is append-only: nothing offers an edit or a delete', async () => {
        const id = (await admin.post(`${THREADS}/${dischargeOrder.id}`).send({ body: 'Said once.' })).body.id;
        expect((await admin.patch(`${THREADS}/${dischargeOrder.id}`).send({ body: 'Said differently.' })).status).toBe(404);
        expect((await admin.delete(`${THREADS}/${dischargeOrder.id}/${id}`)).status).toBe(404);
    });

    it('is append-only in the database too, not only in the routes', async () => {
        /* A bug that reaches past the API should fail loudly rather than
           leave a quiet gap in a record somebody is relying on. */
        await expect(srv.core.client.execute({
            sql: 'UPDATE order_messages SET body = ? WHERE order_id = ?',
            args: ['rewritten', dischargeOrder.id],
        })).rejects.toThrow(/append-only/);
        await expect(srv.core.client.execute({
            sql: 'DELETE FROM order_messages WHERE order_id = ?',
            args: [dischargeOrder.id],
        })).rejects.toThrow(/append-only/);
    });
});
