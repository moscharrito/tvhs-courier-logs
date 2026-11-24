/* Which van does this package go in.
 *
 * A telephone number off the waybill, back a driver's name. The whole
 * feature is one route, and what has to be true of it is: it finds the
 * right delivery, it answers "nobody yet" rather than nothing when a
 * package is unassigned, it cannot be used to read another counter's
 * patients, and it never writes the number down anywhere.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

let srv;
let admin;
let projectId;
let siteId;
let otherSiteId;
/** Today, on the project's clock, which is what the route searches from. */
let today;

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });
const look = (agent, body) => agent.post(`${UH}/sort/lookup`).send(body);

let seq = 0;
/** A delivery with a telephone number on it, on `on`. */
async function order({ phone, at, on, name } = {}) {
    seq += 1;
    const r = await admin.post(`${UH}/orders`).send({
        siteId: at ?? siteId,
        serviceType: 'adhoc',
        recipientName: name ?? `Sort Patient ${seq}`,
        recipientPhone: phone ?? '210-555-0147',
        addressLine: `${100 + seq} Rehearsal Way`,
        zip: '78207',
        description: 'Oral solids',
        quantity: 1,
    });
    expect(r.status, r.text).toBe(201);
    await sql('UPDATE orders SET service_date = ? WHERE id = ?', [on ?? today, r.body.id]);
    return r.body.id;
}

/** Put it on a run, the way an accepted cluster would have. */
async function carriedBy(username, orderIds, status = 'planned') {
    const run = await sql(
        `INSERT INTO runs (project_id, courier_username, service_date, label, status, created_by)
         VALUES (?, ?, ?, 'Wheatley 1', ?, 'admin') RETURNING id`,
        [projectId, username, today, status],
    );
    const runId = Number(run.rows[0].id);
    let n = 1;
    for (const id of orderIds) {
        await sql(
            'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
            [projectId, runId, id, n],
        );
        await sql("UPDATE orders SET status = 'assigned' WHERE id = ?", [id]);
        n += 1;
    }
    return runId;
}

const plus = (days) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    const sites = (await admin.get(`${UH}/sites`)).body;
    siteId = sites.find((s) => s.code === 'discharge').id;
    otherSiteId = sites.find((s) => s.code === 'green').id;
    today = (await admin.get(`${UH}/board`)).body.serviceDate;

    await admin.post('/api/users').send({
        username: 'sort.ana', name: 'Ana Driver', password: 'sort-pass-1', role: 'driver',
    });
    await admin.put('/api/users/sort.ana/memberships/uh').send({ role: 'courier', settings: {} });
}, 60_000);

afterAll(async () => { await srv?.stop(); });

beforeEach(async () => {
    await sql('DELETE FROM run_stops');
    await sql('DELETE FROM runs');
    /* Orders cannot be deleted -- custody_events is append-only by the
       trigger in drizzle/0009 -- so each test uses a number of its own
       rather than a clean table. */
});

describe('finding the driver', () => {
    it('answers with the name off a whole number', async () => {
        const id = await order({ phone: '(210) 555-7001' });
        await carriedBy('sort.ana', [id]);

        const res = await look(admin, { phone: '210-555-7001' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.matches).toHaveLength(1);
        expect(res.body.matches[0].driver.name).toBe('Ana Driver');
        expect(res.body.matches[0].driver.stop).toBe(1);
        expect(res.body.matches[0].orderId).toBe(id);
    });

    it('takes the last four, which is what somebody types when the camera fails', async () => {
        const id = await order({ phone: '210-555-7002' });
        await carriedBy('sort.ana', [id]);

        const res = await look(admin, { phone: '7002' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.matches.some((m) => m.orderId === id)).toBe(true);
    });

    it('matches the END of the number, not the middle of it', async () => {
        /* A contains would make "5557" match an area code and hand back
           half a pharmacy's day. */
        await order({ phone: '210-555-7003' });
        const res = await look(admin, { phone: '2105' });
        expect(res.body.matches.every((m) => m.orderId !== undefined)).toBe(true);
        expect(res.body.matches).toHaveLength(0);
    });

    it('names the patient, because four digits is not unique', async () => {
        /* The sorter is holding a sheet with the name printed on it. Two
           answers and no names is a guess. */
        const id = await order({ phone: '210-555-7004', name: 'Test Patient Alpha' });
        await carriedBy('sort.ana', [id]);
        const res = await look(admin, { phone: '210-555-7004' });
        expect(res.body.matches[0].patient).toBe('Test Patient Alpha');
    });

    it('says nobody has it rather than saying nothing', async () => {
        /* A package nobody is carrying must not go in a pile, and the
           silence of "no match" would send it into one. */
        await order({ phone: '210-555-7005' });
        const res = await look(admin, { phone: '210-555-7005' });
        expect(res.body.matches).toHaveLength(1);
        expect(res.body.matches[0].driver).toBeNull();
    });

    it('carries the handling flags, which decide where it is put down', async () => {
        const id = await order({ phone: '210-555-7006' });
        await sql('UPDATE orders SET refrigerated = 1 WHERE id = ?', [id]);
        await carriedBy('sort.ana', [id]);
        const res = await look(admin, { phone: '210-555-7006' });
        expect(res.body.matches[0].handling).toContain('Fridge');
    });
});

describe('what it will not answer', () => {
    it('refuses fewer than four digits', async () => {
        const res = await look(admin, { phone: '99' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('sort.tooShort');
    });

    it('refuses an empty body', async () => {
        const res = await look(admin, {});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('sort.noPhone');
    });

    it('leaves a cancelled delivery out, it being in nobody’s pile', async () => {
        const id = await order({ phone: '210-555-7007' });
        await sql("UPDATE orders SET status = 'cancelled' WHERE id = ?", [id]);
        const res = await look(admin, { phone: '210-555-7007' });
        expect(res.body.matches).toHaveLength(0);
    });

    it('looks at today and the next two days, and no further', async () => {
        /* Sorting happens the evening before as often as the morning of,
           so today alone would answer "no such delivery" to a package in
           somebody's hand. A week would turn the answer into history. */
        const soon = await order({ phone: '210-555-7008', on: plus(1) });
        const later = await order({ phone: '210-555-7008', on: plus(9) });

        const res = await look(admin, { phone: '210-555-7008' });
        const ids = res.body.matches.map((m) => m.orderId);
        expect(ids).toContain(soon);
        expect(ids).not.toContain(later);
    });

});

describe('what a courier may resolve', () => {
    /* ── THIS ROUTE WAS CLOSED TO COURIERS UNTIL 24 NOVEMBER 2026, and the
       test here asserted the 403. The objection was that it "would let them
       ask about somebody else's patients", which is answered now by scope
       rather than by the door: a driver is pinned to their own runs.

       So the replacement is not one test but three, because "a courier gets
       a 200" on its own would pass just as happily if the scope had been
       left off entirely. The two that matter are the ones that come back
       EMPTY, each paired with an admin lookup proving the delivery is there
       to be found. */

    async function asAna() {
        const ana = srv.agent();
        const signed = await ana.post('/api/login').send({ username: 'sort.ana', password: 'sort-pass-1' });
        expect(signed.status, signed.text).toBe(200);
        return ana;
    }

    it('finds a package on their own round, and says where it sits', async () => {
        const mine = await order({ phone: '210-555-7020' });
        await carriedBy('sort.ana', [mine]);

        const res = await look(await asAna(), { phone: '210-555-7020' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.matches.map((m) => m.orderId)).toEqual([mine]);
        /* The stop number is the half of the answer the round on their phone
           already gives them; the other half is that this parcel is that
           stop, which is the thing they are standing there trying to work out. */
        expect(res.body.matches[0].driver.username).toBe('sort.ana');
        expect(res.body.matches[0].driver.stop).toBe(1);
    });

    it('says nothing at all about a package on another driver’s round', async () => {
        await admin.post('/api/users').send({
            username: 'sort.bo', name: 'Bo Courier', password: 'sort-pass-1', role: 'driver',
        });
        await admin.put('/api/users/sort.bo/memberships/uh').send({ role: 'courier', settings: {} });

        const mine = await order({ phone: '210-555-7021' });
        const theirs = await order({ phone: '210-555-7021' });
        await carriedBy('sort.ana', [mine]);
        await carriedBy('sort.bo', [theirs]);

        const res = await look(await asAna(), { phone: '210-555-7021' });
        expect(res.status, res.text).toBe(200);
        const ids = res.body.matches.map((m) => m.orderId);
        expect(ids).toContain(mine);
        /* Not "it belongs to Bo". Not the patient's name. No row at all. */
        expect(ids).not.toContain(theirs);

        /* Scope, not absence: an admin asking the same question sees both. */
        const both = (await look(admin, { phone: '210-555-7021' })).body.matches.map((m) => m.orderId);
        expect(both).toEqual(expect.arrayContaining([mine, theirs]));
    });

    it('leaves out a delivery that is on no round yet, it being nobody’s pile', async () => {
        /* `r` is LEFT JOINed, so this is the behaviour that falls out of
           requiring a courier username on it -- asserted rather than
           assumed, because a later change to that join would silently hand
           drivers the unassigned pool. */
        const loose = await order({ phone: '210-555-7022' });

        const res = await look(await asAna(), { phone: '210-555-7022' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.matches.map((m) => m.orderId)).not.toContain(loose);

        const seen = (await look(admin, { phone: '210-555-7022' })).body.matches.map((m) => m.orderId);
        expect(seen).toContain(loose);
    });
});

describe('what a pharmacy may resolve', () => {
    it('sees its own counter and not the one next door', async () => {
        /* The counter staff sort their own packages. The route is open to
           them for that and for nothing else, and an unscoped pharmacy
           account gets NOTHING rather than the whole contract. */
        await admin.post('/api/users').send({
            username: 'sort.counter', name: 'Counter', password: 'sort-pass-1', role: 'driver',
        });
        await admin.put('/api/users/sort.counter/memberships/uh')
            .send({ role: 'pharmacy', settings: { siteIds: [siteId] } });

        const mine = await order({ phone: '210-555-7010', at: siteId });
        const theirs = await order({ phone: '210-555-7010', at: otherSiteId });

        const counter = srv.agent();
        const signed = await counter.post('/api/login')
            .send({ username: 'sort.counter', password: 'sort-pass-1' });
        expect(signed.status, signed.text).toBe(200);

        const res = await look(counter, { phone: '210-555-7010' });
        expect(res.status, res.text).toBe(200);
        const ids = res.body.matches.map((m) => m.orderId);
        expect(ids).toContain(mine);
        expect(ids).not.toContain(theirs);

        /* And an admin sees both, so the test above is about scope and not
           about the delivery being missing. */
        const both = (await look(admin, { phone: '210-555-7010' })).body.matches.map((m) => m.orderId);
        expect(both).toEqual(expect.arrayContaining([mine, theirs]));
    });
});

describe('what it writes down', () => {
    it('records that a lookup happened and NOT the number', async () => {
        /* Every read of patient data here leaves a trail, and this one is
           no exception. What it must not become is a second copy of the
           contact list: a counter sorting two hundred packages a day would
           otherwise build one by Friday. */
        await order({ phone: '210-555-7011' });
        await look(admin, { phone: '210-555-7011' });

        const rows = (await sql(
            "SELECT detail FROM audit_events WHERE action = 'sort.lookup' ORDER BY id DESC LIMIT 1",
        )).rows;
        expect(rows).toHaveLength(1);
        const detail = String(rows[0].detail);
        expect(detail).toMatch(/"digits":10/);
        expect(detail).toMatch(/"matched"/);
        expect(detail).not.toMatch(/5557011/);
        expect(detail).not.toMatch(/Sort Patient/);
    });

    it('creates nothing and changes nothing', async () => {
        /* No scan history, no sort log. The counter asked to identify a
           package, not to be given a register of having identified it. */
        const id = await order({ phone: '210-555-7012' });
        const before = (await sql('SELECT * FROM orders WHERE id = ?', [id])).rows[0];
        const runsBefore = (await sql('SELECT COUNT(*) AS n FROM runs')).rows[0].n;

        await look(admin, { phone: '210-555-7012' });

        const after = (await sql('SELECT * FROM orders WHERE id = ?', [id])).rows[0];
        expect(after).toEqual(before);
        expect((await sql('SELECT COUNT(*) AS n FROM runs')).rows[0].n).toBe(runsBefore);
    });
});
