/* Telling somebody something happened (ticket 6.8).
 *
 * Two things are worth testing and the rest is bookkeeping.
 *
 * The first is that a notification cannot break the thing it describes. An
 * approval is an operational act with a custody event behind it; being told
 * about it is a courtesy on top, and the courtesy failing must never take the
 * approval with it.
 *
 * The second is that the sweep's loud case actually reaches a person. A STAT
 * running out with nobody on shift was, until this ticket, visible only to
 * whoever read the HTTP response. A problem that lives in a response body is
 * a problem nobody is holding.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepUnclaimed } from '../src/modules/uh/requests.ts';

const UH = '/api/projects/uh/uh';
const REQ = `${UH}/requests`;
const NOTE = `${UH}/notifications`;

let srv;
let admin;
let ana;
let bo;
let siteId;
let projectId;

async function courier(username) {
    await admin.post('/api/users').send({ username, name: username, password: 'note-pass-1', role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password: 'note-pass-1' });
    expect(res.status, res.text).toBe(200);
    return a;
}

async function poolOrder(over = {}) {
    const res = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1, ...over,
    });
    expect(res.status, res.text).toBe(201);
    return res.body.id;
}

const inbox = (who) => who.get(NOTE).then((r) => r.body);

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = (await admin.get('/api/me/projects')).body.find((p) => p.code === 'uh').id;
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    ana = await courier('ana.note');
    bo = await courier('bo.note');
    await ana.post(`${UH}/shifts/start`).send({});
    await bo.post(`${UH}/shifts/start`).send({});
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('what a courier is told', () => {
    it('says their request was approved, and which run it went on', async () => {
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const reqId = (await admin.get(REQ)).body.requests.find((r) => r.orderId === id).id;
        await admin.post(`${REQ}/${reqId}/approve`).send({});

        const mine = await inbox(ana);
        const note = mine.notifications.find((n) => n.orderId === id && n.kind === 'request.approved');
        expect(note).toBeDefined();
        expect(note.body).toMatch(/Approved/);
        expect(mine.unread).toBeGreaterThan(0);
    });

    it('tells the loser they were pipped, not that they were refused', async () => {
        /* "Somebody got there first" is a different sentence from "no", and a
           courier who reads the wrong one twice stops asking for work. */
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        await bo.post(REQ).send({ orderIds: [id] });
        const anasRequest = (await admin.get(REQ)).body.requests
            .find((r) => r.orderId === id && r.courierUsername === 'ana.note');
        await admin.post(`${REQ}/${anasRequest.id}/approve`).send({});

        const note = (await inbox(bo)).notifications.find((n) => n.orderId === id);
        expect(note.kind).toBe('request.superseded');
        expect(note.body).toMatch(/Nothing wrong with the request/);
        expect(note.body).not.toMatch(/denied|refused/i);
    });

    it('carries the reason when they are turned down', async () => {
        const id = await poolOrder();
        await ana.post(REQ).send({ orderIds: [id] });
        const reqId = (await admin.get(REQ)).body.requests.find((r) => r.orderId === id).id;
        await admin.post(`${REQ}/${reqId}/deny`).send({ reason: 'Bo is closer to that ZIP today.' });

        const note = (await inbox(ana)).notifications.find((n) => n.orderId === id && n.kind === 'request.denied');
        expect(note.body).toMatch(/closer to that ZIP/);
    });

    it('says when the clock gave them work nobody claimed', async () => {
        const id = await poolOrder({ serviceType: 'stat' });
        await srv.core.client.execute({
            sql: 'UPDATE orders SET due_at = ? WHERE id = ?',
            args: [new Date(Date.now() + 10 * 60_000).toISOString(), id],
        });
        const serviceDate = (await admin.get(`${UH}/orders/${id}`)).body.serviceDate;
        const out = await sweepUnclaimed(srv.core.client, { projectId, projectSettings: {}, serviceDate, now: new Date() });
        const who = out.assigned.find((a) => a.orderId === id).courierUsername;

        const got = await inbox(who === 'ana.note' ? ana : bo);
        const note = got.notifications.find((n) => n.orderId === id && n.kind === 'work.assigned');
        expect(note.body).toMatch(/nobody claimed/);
    });
});

describe('mine means mine', () => {
    it('never shows one courier another courier’s messages', async () => {
        const anas = (await inbox(ana)).notifications.map((n) => n.id);
        const bos = (await inbox(bo)).notifications.map((n) => n.id);
        expect(anas.filter((id) => bos.includes(id))).toEqual([]);
    });

    it('marks read only what belongs to the caller', async () => {
        const bosFirst = (await inbox(bo)).notifications[0];
        expect(bosFirst).toBeDefined();
        /* Ana asking to mark Bo's message read. Scoped in the WHERE, so it
           matches nothing rather than being checked and refused. */
        await ana.post(`${NOTE}/read`).send({ ids: [bosFirst.id] });
        const still = (await inbox(bo)).notifications.find((n) => n.id === bosFirst.id);
        expect(still.readAt).toBeNull();
    });

    it('marks everything read when asked for nothing in particular', async () => {
        await ana.post(`${NOTE}/read`).send({});
        expect((await inbox(ana)).unread).toBe(0);
    });
});

describe('the loud case', () => {
    it('reaches every dispatcher by name when nobody can take a STAT', async () => {
        /* Until this ticket the sweep's unassignable list was visible only to
           whoever read the response. */
        await ana.post(`${UH}/shifts/end`).send({});
        await bo.post(`${UH}/shifts/end`).send({});

        const id = await poolOrder({ serviceType: 'stat' });
        await srv.core.client.execute({
            sql: 'UPDATE orders SET due_at = ? WHERE id = ?',
            args: [new Date(Date.now() + 5 * 60_000).toISOString(), id],
        });
        const serviceDate = (await admin.get(`${UH}/orders/${id}`)).body.serviceDate;

        const out = await sweepUnclaimed(srv.core.client, { projectId, projectSettings: {}, serviceDate, now: new Date() });
        expect(out.unassignable.length).toBeGreaterThan(0);

        const note = (await inbox(admin)).notifications.find((n) => n.kind === 'work.unclaimed');
        expect(note, 'a dispatcher was actually told').toBeDefined();
        expect(note.body).toMatch(/STAT/);
        expect(note.body).toMatch(/Nobody is on shift/);
    });

    it('says nothing on a dry run, because a rehearsal is not an alarm', async () => {
        const before = (await inbox(admin)).notifications.filter((n) => n.kind === 'work.unclaimed').length;
        const serviceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        await sweepUnclaimed(srv.core.client, { projectId, projectSettings: {}, serviceDate, now: new Date(), dryRun: true });
        const after = (await inbox(admin)).notifications.filter((n) => n.kind === 'work.unclaimed').length;
        expect(after).toBe(before);
    });
});

describe('a phone that has agreed to be told', () => {
    it('registers, and says plainly that nothing is being delivered yet', async () => {
        const res = await ana.post('/api/me/push-devices').send({ platform: 'android', token: 'a-token-from-the-store-1' });
        expect(res.status).toBe(201);
        expect(res.body.delivering).toBe(false);
        expect(res.body.why).toMatch(/No push channel is configured/);
    });

    it('does not turn one phone into three rows when its token rotates', async () => {
        await ana.post('/api/me/push-devices').send({ platform: 'android', token: 'a-token-from-the-store-1' });
        const rows = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM push_devices WHERE token = ?',
            args: ['a-token-from-the-store-1'],
        });
        expect(Number(rows.rows[0].n)).toBe(1);
    });

    it('leaves every notification unsent, which is the honest state', async () => {
        /* No channel exists, so nothing was pushed. The app shows them and
           `pushedAt` stays null rather than a timestamp nobody earned. */
        const mine = await inbox(ana);
        expect(mine.notifications.length).toBeGreaterThan(0);
        expect(mine.notifications.every((n) => n.pushedAt === null)).toBe(true);
    });
});
