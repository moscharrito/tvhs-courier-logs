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

});

/* ── NO DATE WINDOW AT ALL, FROM 25 NOVEMBER.
 *
 * It answered from today and the next two days only, on the reasoning
 * that what goes in a pile is today's work. In use it was a scanner
 * that said "no such delivery" about deliveries we hold, and at a bench
 * that is indistinguishable from a bad read -- two separate hours went
 * on hunting a bug that was this rule working as designed.
 *
 * Every delivery with the number now comes back, newest first, and the
 * screen marks the ones that are not today. Marking, not hiding.
 */
describe('every delivery with that number, whenever it was', () => {
    it('answers about a delivery from weeks ago', async () => {
        const old = await order({ phone: '210-555-7008', on: plus(-30) });
        const res = await look(admin, { phone: '210-555-7008' });
        expect(res.body.matches.map((m) => m.orderId)).toContain(old);
    });

    it('answers about one further ahead than the old window reached', async () => {
        const later = await order({ phone: '210-555-7009', on: plus(9) });
        const res = await look(admin, { phone: '210-555-7009' });
        expect(res.body.matches.map((m) => m.orderId)).toContain(later);
    });

    it('puts the newest first, so today is not buried under March', async () => {
        await order({ phone: '210-555-7010', on: plus(-60) });
        const now = await order({ phone: '210-555-7010' });
        await order({ phone: '210-555-7010', on: plus(-20) });

        const res = await look(admin, { phone: '210-555-7010' });
        expect(res.body.matches).toHaveLength(3);
        expect(res.body.matches[0].orderId).toBe(now);
    });

    it('says what today is, so the screen can mark the rest', async () => {
        /* Marking is the whole replacement for the window: the sorter
           still has to know which card is the package in their hand. The
           project's clock decides, not the handset's. */
        await order({ phone: '210-555-7011', on: plus(-2) });
        const res = await look(admin, { phone: '210-555-7011' });
        expect(res.body.today).toBe(today);
        expect(res.body.matches[0].serviceDate).not.toBe(res.body.today);
    });

    it('still narrows by scope, which was never about dates', async () => {
        /* A courier is pinned to their own runs. Dropping the window
           must not have dropped that with it. */
        const theirs = await order({ phone: '210-555-7012', on: plus(-5) });
        await carriedBy('sort.bo', [theirs]);

        const ana = srv.agent();
        await ana.post('/api/login').send({ username: 'sort.ana', password: 'sort-pass-1' });
        const res = await look(ana, { phone: '210-555-7012' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.matches).toEqual([]);

        /* And an admin finds it, so the line above is scope and not a
           delivery that was never there. */
        expect((await look(admin, { phone: '210-555-7012' })).body.matches
            .map((m) => m.orderId)).toContain(theirs);
    });
});

/* ── WHEN THE WINDOW FINDS NOTHING, SAY WHETHER WE KNOW THE NUMBER.
 *
 * Reported from the bench on 25 November: a sheet was scanned, the
 * numbers were read off it correctly, and the page said no delivery had
 * either of them -- for an order that existed and was assigned, on an
 * earlier day. "Not on today's list" and "never heard of it" were the
 * same sentence, and there was no way to tell which had happened.
 */
describe('an older delivery comes back whole', () => {
    it('carries the patient and the driver, not just an order id', async () => {
        /* What the bench asked for in the first place: scan it, and be
           told who has it and whose it is, whenever it was loaded. */
        const old = await order({ phone: '210-555-7101', on: plus(-6), name: 'Earlier Patient' });
        await carriedBy('sort.ana', [old]);

        const res = await look(admin, { phone: '210-555-7101' });
        expect(res.status, res.text).toBe(200);
        const found = res.body.matches.find((m) => m.orderId === old);
        expect(found, JSON.stringify(res.body.matches)).toBeTruthy();
        expect(found.patient).toBe('Earlier Patient');
        expect(found.driver.name).toBeTruthy();
        expect(found.serviceDate).toBe(plus(-6));
    });

    it('is empty when the number is genuinely unknown', async () => {
        const res = await look(admin, { phone: '210-555-7103' });
        expect(res.body.matches).toEqual([]);
    });

    it('no longer reports a separate list for other days', async () => {
        /* There is one list now. A second one existed only to work round
           the window and would be a shape the screen has to explain. */
        await order({ phone: '210-555-7106', on: plus(-8) });
        const res = await look(admin, { phone: '210-555-7106' });
        expect(res.body.matches).toHaveLength(1);
        expect(res.body.elsewhere).toBeUndefined();
    });
});

/* ── A SPREADSHEET CELL WITH TWO NUMBERS IN IT.
 *
 * normalizePhone strips every non-digit and keeps the rest, so
 * "210-555-0147 / 210-555-0199" is stored as twenty digits and an
 * equality on either half never matches. University Health's own form
 * has a Mobile box and a Home box on it, so a column carrying both is
 * not a hypothetical shape -- and the failure is silent: the delivery
 * simply cannot be looked up, ever, and nothing says why.
 */
describe('an order whose telephone column held two numbers', () => {
    it('is found by the first of them', async () => {
        const id = await order({ phone: '210-555-7201 / 210-555-7202' });
        const res = await look(admin, { phone: '210-555-7201' });
        expect(res.body.matches.map((m) => m.orderId)).toEqual([id]);
    });

    it('is found by the second of them', async () => {
        const id = await order({ phone: '210-555-7203 / 210-555-7204' });
        const res = await look(admin, { phone: '210-555-7204' });
        expect(res.body.matches.map((m) => m.orderId)).toEqual([id]);
    });

    it('is not found by digits lying across the seam between them', async () => {
        /* A plain `instr` would match here and answer with a delivery
           belonging to somebody else entirely. The stored value is
           2105557205 2105557206 run together; this needle is the last
           six of the first and the first four of the second. */
        await order({ phone: '210-555-7205 / 210-555-7206' });
        const res = await look(admin, { phone: '5572052105' });
        expect(res.body.matches).toEqual([]);
    });

    it('leaves a single stored number matching exactly, as it always did', async () => {
        const id = await order({ phone: '210-555-7207' });
        const res = await look(admin, { phone: '210-555-7207' });
        expect(res.body.matches.map((m) => m.orderId)).toEqual([id]);
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
