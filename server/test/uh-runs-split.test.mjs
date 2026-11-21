/* Splitting one counter's list between the drivers standing at it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THESE TWO ROUTES REPLACE.
 *
 * Dispatch downloaded the day's list, pasted it into an external chat
 * assistant with every patient name and address on it, asked for clusters,
 * downloaded one spreadsheet per driver and imported them back. This does
 * the same split without the list leaving the building, and ends with the
 * drivers actually assigned rather than with seven files to shuffle.
 *
 * The engine is tested on its own in uh-cluster-balance.test.mjs, against a
 * Tuesday. What is tested HERE is the part the engine cannot see: that the
 * right orders are offered, that a stale accept is refused rather than
 * half-applied, and that accepting it really does put the work on runs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

/* A SERVICE DATE PER TEST, rather than clearing orders between them.
   Orders cannot be deleted once they exist: custody events reference them
   and the trigger from drizzle/0009 makes that table append-only, which is
   the point of it. So each test gets its own day and they cannot see each
   other's work. */
let dayCount = 0;
let DAY = '2026-11-24';
const nextDay = () => {
    dayCount += 1;
    const d = new Date(Date.UTC(2026, 10, 24));
    d.setUTCDate(d.getUTCDate() + dayCount);
    return d.toISOString().slice(0, 10);
};

let srv;
let admin;
let projectId;
let siteId;
let otherSiteId;
/** A counter nobody is mapped to, for the unconfigured-contract case. */
let bareSiteId;

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/** A courier on this contract, with a home pharmacy and optionally a shift. */
async function driver(username, name, homeSiteId, onShift) {
    await admin.post('/api/users').send({ username, name, password: 'split-pass-1', role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`)
        .send({ role: 'courier', settings: homeSiteId === null ? {} : { homeSiteId } });
    await sql('DELETE FROM shifts WHERE courier_username = ?', [username]);
    if (onShift) {
        await sql('INSERT INTO shifts (project_id, courier_username, started_at) VALUES (?, ?, ?)',
            [projectId, username, new Date().toISOString()]);
    }
}

/** `n` deliveries at `site`, all to one ZIP, on DAY. */
let seq = 0;
async function orders(site, zip, n, serviceType = 'adhoc') {
    const made = [];
    for (let i = 0; i < n; i += 1) {
        seq += 1;
        const r = await admin.post(`${UH}/orders`).send({
            siteId: site, serviceType,
            recipientName: `Split Patient ${seq}`,
            addressLine: `${100 + seq} Rehearsal Way`,
            zip, description: 'Oral solids', quantity: 1,
        });
        expect(r.status, r.text).toBe(201);
        await sql('UPDATE orders SET service_date = ? WHERE id = ?', [DAY, r.body.id]);
        made.push(r.body.id);
    }
    return made;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    const sites = (await admin.get(`${UH}/sites`)).body;
    siteId = sites.find((s) => s.code === 'discharge').id;
    otherSiteId = sites.find((s) => s.code === 'green').id;
    bareSiteId = sites.find((s) => s.code === 'southeast').id;
    expect(bareSiteId, 'the third counter the roster tests need').toBeTruthy();

    await driver('split.ana', 'Ana Driver', siteId, true);
    await driver('split.ben', 'Ben Driver', siteId, true);
    await driver('split.cal', 'Cal Driver', siteId, false);
    /* Mapped to another counter and on shift: the discharge dialog must
       not offer them, which is the whole of the 21 November change. */
    await driver('split.far', 'Far Driver', otherSiteId, true);
    /* Mapped nowhere and on shift: not offered while anybody is mapped
       here, offered at a counter nobody is mapped to. */
    await driver('split.loose', 'Loose Driver', null, true);
}, 60_000);

afterAll(async () => { await srv?.stop(); });

beforeEach(async () => {
    await sql('DELETE FROM run_stops');
    await sql('DELETE FROM runs');
    DAY = nextDay();
});

const split = (q) => admin.get(`${UH}/runs/split?${q}`);

describe('what it refuses to answer', () => {
    it('will not split without a pharmacy', async () => {
        const r = await split(`serviceDate=${DAY}&couriers=split.ana`);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('split.noSite');
    });

    it('answers with the counter’s drivers when none are ticked yet', async () => {
        /* CHANGED DELIBERATELY. This used to refuse. The screen has to draw
           the tick boxes before anybody can tick one, and reading them from
           /runs/propose was wrong: that roster is stripped to what
           staffProposal takes and carries no shift state, so every driver
           came back looking off shift and nobody was ticked. */
        const r = await split(`serviceDate=${DAY}&site=discharge`);
        expect(r.status, r.text).toBe(200);
        expect(r.body.rounds).toEqual([]);
        expect(r.body.drivers.map((d) => d.username)).toContain('split.ana');
    });

    it('offers only the drivers mapped here who are on shift', async () => {
        /* THE SHORT LIST, which is the point of it. Thirty-five names on
           this contract and eleven people standing at the counter; the
           first cut of this dialog showed all thirty-five and dispatch
           asked for the eleven. Three different people are left out here
           and each is left out for its own reason. */
        const r = await split(`serviceDate=${DAY}&site=discharge`);
        const names = r.body.drivers.map((d) => d.username);
        expect(names).toEqual(['split.ana', 'split.ben']);
        /* Mapped here, not on shift. */
        expect(names).not.toContain('split.cal');
        /* On shift, mapped to another counter. */
        expect(names).not.toContain('split.far');
        /* On shift, mapped nowhere, and somebody IS mapped here. */
        expect(names).not.toContain('split.loose');
        expect(r.body.drivers.every((d) => d.onShift)).toBe(true);
        expect(r.body.unmapped).toBe(false);
    });

    it('counts the ones who are mapped here and resting, rather than listing them', async () => {
        /* So the screen can say where everybody is without putting the
           long list back on it by another route. */
        const r = await split(`serviceDate=${DAY}&site=discharge`);
        expect(r.body.restingHere).toBe(1);
    });

    it('falls back to the unplaced drivers at a counter nobody is mapped to, and says so', async () => {
        /* THE UNCONFIGURED CONTRACT. UH's thirty-five drivers were loaded
           with no home pharmacy; a strict reading would open an empty
           dialog every morning and the list could not be split at all.
           The unplaced drivers on shift are offered instead and `unmapped`
           admits it. Somebody mapped to a DIFFERENT counter is still not
           offered -- that is the board's business. */
        const r = await split(`serviceDate=${DAY}&site=southeast`);
        expect(r.status, r.text).toBe(200);
        const names = r.body.drivers.map((d) => d.username);
        expect(names).toEqual(['split.loose']);
        expect(names).not.toContain('split.far');
        expect(r.body.unmapped).toBe(true);
        expect(r.body.restingHere).toBe(0);
    });

    it('will not take a name that is not a driver here', async () => {
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,nobody.here`);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('split.notDrivers');
    });
});

describe('what it offers', () => {
    it('splits the counter list between the ticked drivers and leaves nothing out', async () => {
        const made = await orders(siteId, '78207', 9);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.ben`);
        expect(r.status, r.text).toBe(200);
        expect(r.body.rounds).toHaveLength(2);
        const placed = r.body.rounds.flatMap((x) => x.orderIds).sort((a, b) => a - b);
        expect(placed).toEqual([...made].sort((a, b) => a - b));
    });

    it('offers each round to one of the ticked drivers, nobody else', async () => {
        await orders(siteId, '78207', 6);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.ben`);
        const names = r.body.rounds.map((x) => x.courier?.username);
        expect(new Set(names)).toEqual(new Set(['split.ana', 'split.ben']));
    });

    it('leaves another counter alone', async () => {
        await orders(siteId, '78207', 4);
        const elsewhere = await orders(otherSiteId, '78207', 4);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        const placed = r.body.rounds.flatMap((x) => x.orderIds);
        for (const id of elsewhere) expect(placed).not.toContain(id);
    });

    it('holds STATs back rather than burying them in a round', async () => {
        /* A STAT has an hour from pickup and cannot hold that inside a full
           loop. It must come back named, not silently included. */
        await orders(siteId, '78207', 5);
        const stats = await orders(siteId, '78207', 2, 'stat');
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.ben`);
        const placed = r.body.rounds.flatMap((x) => x.orderIds);
        for (const id of stats) expect(placed).not.toContain(id);
        expect(r.body.urgent.sort((a, b) => a - b)).toEqual([...stats].sort((a, b) => a - b));
        expect(r.body.notes.join(' ')).toMatch(/STAT/);
    });

    it('says when a ticked driver is not on shift, without refusing', async () => {
        await orders(siteId, '78207', 4);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.cal`);
        expect(r.status).toBe(200);
        expect(r.body.notes.join(' ')).toMatch(/not on shift: Cal Driver/);
    });

    it('does not offer an order that is already on somebody else’s run', async () => {
        const made = await orders(siteId, '78207', 4);
        const run = await admin.post(`${UH}/runs`)
            .send({ courierUsername: 'split.cal', serviceDate: DAY, orderIds: [made[0]] });
        expect(run.status, run.text).toBe(201);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        expect(r.body.rounds.flatMap((x) => x.orderIds)).not.toContain(made[0]);
    });

    it('writes nothing: asking twice changes no run', async () => {
        await orders(siteId, '78207', 6);
        await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.ben`);
        await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.ben`);
        const runs = await sql('SELECT COUNT(*) n FROM runs');
        expect(Number(runs.rows[0].n)).toBe(0);
    });
});

describe('accepting it', () => {
    async function proposeThenApply(couriers) {
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=${couriers}`);
        expect(r.status, r.text).toBe(200);
        return admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: r.body.rounds.map((x) => ({
                courierUsername: x.courier.username, orderIds: x.orderIds,
            })),
        });
    }

    it('creates a run per round and puts every stop on one', async () => {
        const made = await orders(siteId, '78207', 8);
        const out = await proposeThenApply('split.ana,split.ben');
        expect(out.status, out.text).toBe(201);
        expect(out.body.runs).toHaveLength(2);

        const stops = await sql('SELECT order_id FROM run_stops');
        expect(stops.rows.map((x) => Number(x.order_id)).sort((a, b) => a - b))
            .toEqual([...made].sort((a, b) => a - b));
    });

    it('assigns the orders, so the board stops calling them unassigned', async () => {
        await orders(siteId, '78207', 6);
        await proposeThenApply('split.ana,split.ben');
        const left = await sql(
            `SELECT COUNT(*) n FROM orders o WHERE o.service_date = ? AND o.status IN ('ready','pending')
               AND NOT EXISTS (SELECT 1 FROM run_stops rs WHERE rs.order_id = o.id)`, [DAY]);
        expect(Number(left.rows[0].n)).toBe(0);
    });

    it('refuses the whole thing when one order has moved since', async () => {
        /* The dangerous case: the dispatcher accepts a split worked out a
           minute ago, and in that minute somebody else took an order. Half
           applying it would split the list across two plans. */
        const made = await orders(siteId, '78207', 6);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana,split.ben`);
        await admin.post(`${UH}/runs`)
            .send({ courierUsername: 'split.cal', serviceDate: DAY, orderIds: [made[0]] });

        const out = await admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: r.body.rounds.map((x) => ({
                courierUsername: x.courier.username, orderIds: x.orderIds,
            })),
        });
        expect(out.status).toBe(409);
        expect(out.body.code).toBe('split.stale');
        expect(out.body.orderIds).toContain(made[0]);

        /* Nothing half-made: only Cal's run exists. */
        const runs = await sql('SELECT courier_username FROM runs');
        expect(runs.rows.map((x) => String(x.courier_username))).toEqual(['split.cal']);
    });

    it('refuses one order on two rounds', async () => {
        const made = await orders(siteId, '78207', 4);
        const out = await admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: [
                { courierUsername: 'split.ana', orderIds: [made[0], made[1]] },
                { courierUsername: 'split.ben', orderIds: [made[1], made[2]] },
            ],
        });
        expect(out.status).toBe(400);
        expect(out.body.code).toBe('split.duplicateOrder');
        expect(Number((await sql('SELECT COUNT(*) n FROM runs')).rows[0].n)).toBe(0);
    });

    it('refuses a courier who is not on this contract', async () => {
        const made = await orders(siteId, '78207', 2);
        const out = await admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: [{ courierUsername: 'nobody.here', orderIds: made }],
        });
        expect(out.status).toBe(400);
        expect(out.body.code).toBe('split.notDrivers');
    });

    it('refuses an order from another counter, even if it exists', async () => {
        const elsewhere = await orders(otherSiteId, '78207', 2);
        const out = await admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: [{ courierUsername: 'split.ana', orderIds: elsewhere }],
        });
        expect(out.status).toBe(409);
        expect(out.body.code).toBe('split.stale');
    });
});
