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
import ExcelJS from 'exceljs';
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

/* ───────────────────── the order each round is driven in (21 November)
 *
 * Clustering answers who carries which stops. Until the BAA landed on
 * 20 November nothing answered what order they drive them in: rounds came
 * out sorted by deadline and the spreadsheet a driver was handed zig-zagged
 * across the city. These are about the other half of "cluster by nearest
 * neighbour to reduce drive time".
 */
describe('the order each round is driven in', () => {
    /** Put a point on the pickup counter, which is the route's origin. */
    const originAt = (lat, lng) =>
        sql('UPDATE sites SET lat = ?, lng = ? WHERE id = ?', [lat, lng, siteId]);
    const pointAt = (orderId, lat, lng) =>
        sql('UPDATE orders SET lat = ?, lng = ?, geocode_status = ? WHERE id = ?',
            [lat, lng, 'ok', orderId]);

    it('falls back to deadline order when the stops have no coordinates', async () => {
        /* THE STATE OF THE CONTRACT TODAY. Nothing is geocoded, so this is
           what every split currently does, and it has to say so rather than
           implying the drive was solved. */
        await originAt(29.5077, -98.5764);
        const made = await orders(siteId, '78207', 4);
        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);

        expect(r.status, r.text).toBe(200);
        expect(r.body.rounds[0].ordering).toBe('due');
        expect(r.body.rounds[0].driveMiles).toBeNull();
        expect(r.body.rounds[0].orderIds).toHaveLength(made.length);
        expect(r.body.notes.join(' ')).toMatch(/deadline order instead of driving order/i);
    });

    it('puts the stops in nearest-neighbour order from the pharmacy', async () => {
        /* Three stops due north of the counter at increasing distance, made
           in an order that is NOT the driving order, so a pass-through
           cannot pass by accident. */
        await originAt(29.50, -98.50);
        const [far, near, middle] = await orders(siteId, '78207', 3);
        await pointAt(far, 29.60, -98.50);
        await pointAt(near, 29.51, -98.50);
        await pointAt(middle, 29.55, -98.50);

        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        expect(r.status, r.text).toBe(200);
        expect(r.body.rounds).toHaveLength(1);
        expect(r.body.rounds[0].ordering).toBe('nearest');
        expect(r.body.rounds[0].orderIds).toEqual([near, middle, far]);
        expect(r.body.rounds[0].driveMiles).toBeGreaterThan(0);
        expect(r.body.notes.join(' ')).toMatch(/takes no account of deadlines/i);
    });

    it('sends a whole round back to deadline order if one stop has no coordinates', async () => {
        /* REFUSES RATHER THAN DEGRADES, which is sequencing.ts's rule and
           not this endpoint's to overrule. A route that is geographic for
           two stops out of three is worse than one that is not: the
           dispatcher believes the drive is solved and it is not. */
        await originAt(29.50, -98.50);
        const [a, b, c] = await orders(siteId, '78207', 3);
        await pointAt(a, 29.51, -98.50);
        await pointAt(b, 29.55, -98.50);
        void c;

        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        expect(r.body.rounds[0].ordering).toBe('due');
        expect(r.body.rounds[0].driveMiles).toBeNull();
        expect(r.body.rounds[0].orderIds).toHaveLength(3);
    });

    it('falls back when the pharmacy itself has never been looked up', async () => {
        /* There is no point to measure a route FROM. Ticket 1.4's button is
           on the Pickup locations panel and may simply not have been
           pressed. */
        await sql('UPDATE sites SET lat = NULL, lng = NULL WHERE id = ?', [siteId]);
        const made = await orders(siteId, '78207', 2);
        await pointAt(made[0], 29.51, -98.50);
        await pointAt(made[1], 29.55, -98.50);

        const r = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        expect(r.body.rounds[0].ordering).toBe('due');
        expect(r.body.notes.join(' ')).toMatch(/pharmacy addresses have not been looked up/i);
    });

    it('writes the stops in that order, so the phone and the sheet agree with the screen', async () => {
        /* The apply honours the array it is given rather than re-deriving
           it. If it did not, the dispatcher would accept one route and the
           driver would be handed another. */
        await originAt(29.50, -98.50);
        const [far, near, middle] = await orders(siteId, '78207', 3);
        await pointAt(far, 29.60, -98.50);
        await pointAt(near, 29.51, -98.50);
        await pointAt(middle, 29.55, -98.50);

        const seen = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        const round = seen.body.rounds[0];
        const out = await admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: [{ courierUsername: round.courier.username, orderIds: round.orderIds }],
        });
        expect(out.status, out.text).toBe(201);

        const stops = await sql(
            'SELECT order_id FROM run_stops WHERE run_id = ? ORDER BY sequence',
            [out.body.runs[0].id],
        );
        expect(stops.rows.map((x) => Number(x.order_id))).toEqual([near, middle, far]);
    });
});

/* ────────────────────────── the file each driver is handed (21 November)
 *
 * WHAT WAS WRONG WITH IT, which is worth writing down because it looked
 * fine. The dialog's per-driver Excel link pointed at /runs/export.xlsx --
 * the runs REGISTER -- filtered to that courier and that day. The right
 * filter on the wrong file: it downloaded cleanly, it was named
 * runs-2026-11-21.xlsx whoever it was for, and it contained one row of run
 * metadata with a COUNT of stops rather than the stops. A dispatcher who
 * clustered fifty deliveries between three drivers got three files with
 * three lines in them and no address anywhere.
 *
 * These are about the manifest that replaced it: that it is the stops, that
 * they are in the order the clusterer put them in, and that it is named
 * after the person it is for.
 */
describe("the file each driver is handed", () => {
    const asBuffer = (res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    };

    const originAt = (lat, lng) =>
        sql('UPDATE sites SET lat = ?, lng = ? WHERE id = ?', [lat, lng, siteId]);
    const pointAt = (orderId, lat, lng) =>
        sql('UPDATE orders SET lat = ?, lng = ?, geocode_status = ? WHERE id = ?',
            [lat, lng, 'ok', orderId]);

    /** Cluster the day to one driver, accept it, and hand back the run. */
    async function clusterToAna() {
        const seen = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        const round = seen.body.rounds[0];
        const out = await admin.post(`${UH}/runs/split/apply`).send({
            serviceDate: DAY,
            siteId,
            rounds: [{ courierUsername: round.courier.username, orderIds: round.orderIds }],
        });
        expect(out.status, out.text).toBe(201);
        return out.body.runs[0];
    }

    const sheetOf = async (res) => {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        return wb;
    };

    /** The values of one column, top row down, header excluded. */
    const column = (sheet, header) => {
        const head = sheet.getRow(1).values;
        const at = head.indexOf(header);
        expect(at, `a column called ${header}`).toBeGreaterThan(0);
        const out = [];
        sheet.eachRow((row, n) => { if (n > 1) out.push(row.getCell(at).value); });
        return out;
    };

    it('is named after the driver, not after the day', async () => {
        /* Three drivers, three downloads, one folder. "runs-2026-11-21.xlsx"
           three times over is two files called runs-2026-11-21(2).xlsx and a
           dispatcher opening each one to find out whose it is. */
        await orders(siteId, '78207', 2);
        const run = await clusterToAna();

        const res = await admin.get(`${UH}/runs/${run.id}/manifest.xlsx`).buffer(true).parse(asBuffer);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect(res.headers['content-disposition']).toMatch(/Ana Driver/);
        expect(res.headers['content-disposition']).not.toMatch(/^.*runs-/);
    });

    it('holds the stops themselves, one row each, with what is needed at the door', async () => {
        const made = await orders(siteId, '78207', 3);
        const run = await clusterToAna();

        const res = await admin.get(`${UH}/runs/${run.id}/manifest.xlsx`).buffer(true).parse(asBuffer);
        const wb = await sheetOf(res);
        const stops = wb.getWorksheet('Stops');

        expect(stops.rowCount - 1, 'one row per stop').toBe(made.length);
        expect(column(stops, 'Stop')).toEqual([1, 2, 3]);
        /* The things the dispatcher used to get back from the outside
           assistant, and the things a courier is asked for at the door. */
        for (const header of ['RX #', 'Patient', 'Phone', 'Address', 'City', 'ZIP', 'Due', 'Handling']) {
            expect(column(stops, header).length).toBe(made.length);
        }
        expect(column(stops, 'Address').every((a) => /Rehearsal Way/.test(String(a)))).toBe(true);
    });

    it('lists them in the order they are to be driven, nearest stop first', async () => {
        /* THE WHOLE ASK: "list the orders in each clustered file based on
           the zip closest to each other". The sheet is read top to bottom,
           so the row order has to be the sequence the clusterer worked out
           -- not the order they were imported in and not the order they
           happen to come out of the table. */
        await originAt(29.50, -98.50);
        const [far, near, middle] = await orders(siteId, '78207', 3);
        await pointAt(far, 29.60, -98.50);
        await pointAt(near, 29.51, -98.50);
        await pointAt(middle, 29.55, -98.50);

        const run = await clusterToAna();
        const res = await admin.get(`${UH}/runs/${run.id}/manifest.xlsx`).buffer(true).parse(asBuffer);
        const wb = await sheetOf(res);

        const refs = column(wb.getWorksheet('Stops'), 'RX #').map(String);
        const refOf = async (id) =>
            String((await sql('SELECT external_ref FROM orders WHERE id = ?', [id])).rows[0].external_ref);
        expect(refs).toEqual([await refOf(near), await refOf(middle), await refOf(far)]);
    });

    it('says on the file which kind of order that is', async () => {
        /* Numbered rows get followed top to bottom whether or not anybody
           measured a distance. Today nothing is geocoded on this contract,
           so the honest line is the deadline one -- and a driver handed a
           sheet that implies the drive was solved when it was not is the
           failure this whole feature exists to stop. */
        await originAt(29.50, -98.50);
        await orders(siteId, '78207', 2);
        const run = await clusterToAna();

        const res = await admin.get(`${UH}/runs/${run.id}/manifest.xlsx`).buffer(true).parse(asBuffer);
        const wb = await sheetOf(res);
        const about = JSON.stringify(wb.getWorksheet('About').getSheetValues());

        expect(about).toMatch(/Stop order/);
        expect(about).toMatch(/By delivery deadline/);
        expect(about).toMatch(/2 of 2 stops have no map point/);
        /* And it declares what is in it, because it is full of patients. */
        expect(about).toMatch(/Contains patient data/);
    });

    it('is not another driver\u2019s to download', async () => {
        await orders(siteId, '78207', 2);
        const run = await clusterToAna();

        const ben = srv.agent();
        const in_ = await ben.post('/api/login').send({ username: 'split.ben', password: 'split-pass-1' });
        expect(in_.status, in_.text).toBe(200);
        expect((await ben.get(`${UH}/runs/${run.id}/manifest.xlsx`)).status).toBe(403);
    });
});

/* ───────────── and WITHOUT the permission, nothing is sent anywhere
 *
 * The counterpart to the test in uh-geocode-orders.test.mjs, which boots
 * with GEO_BAA_COVERS_PATIENT_ADDRESSES set. This suite does not, which is
 * the state of any deployment without an agreement -- and the clusterer
 * reaching for a lookup it is not permitted to use would be the leak the
 * whole gate exists to stop. A `patientAddresses &&` is one refactor away
 * from being deleted by somebody tidying up, so it is pinned here.
 */
describe('a deployment with no agreement', () => {
    it('clusters without touching the delivery addresses', async () => {
        const [id] = await orders(siteId, '78207', 1);

        const res = await split(`serviceDate=${DAY}&site=discharge&couriers=split.ana`);
        expect(res.status, res.text).toBe(200);

        const row = (await sql('SELECT lat, lng, geocode_status FROM orders WHERE id = ?', [id])).rows[0];
        expect(row.lat).toBeNull();
        /* 'pending', not 'failed': a failure is a lookup that was tried. */
        expect(row.geocode_status).toBe('pending');
    });
});
