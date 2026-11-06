/* A proposed cluster, downloaded as a sheet before anybody drives it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM /runs/:id/export.
 *
 * A cluster is not a run. The dispatch board groups a counter's waiting
 * stops and offers each pile to a driver, and nothing is created until
 * somebody presses the button -- which is the control University Health
 * asked for when they turned auto-assign off on 2 November. So there is a
 * window where the most useful thing on the screen has no run id to export,
 * and two people want it on paper: a dispatcher deciding whether forty
 * stops are one person's afternoon, and a lead at the counter pulling that
 * pile off the shelf.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE IDS COME FROM THE CALLER, AND THAT IS THE DESIGN.
 *
 * Re-running the planner inside the download would group whatever is in the
 * table at that second. An import landing at 12:05 would then hand back a
 * different pile under the same button, and a paper copy that disagrees
 * with the screen is worse than no paper copy. So the sheet is of the stops
 * named in the URL, in the order they were named.
 *
 * Which makes the scoping the thing to test hardest: naming an id is not
 * permission to read it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const RUNS = `${UH}/runs`;
const ORDERS = `${UH}/orders`;

let srv;
let admin;
let sites;
let green;
let southeast;

const siteId = (code) => sites.find((s) => s.code === code).id;

const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const sheetOf = async (res, name) => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.getWorksheet(name);
    if (!sheet) return [];
    const rows = [];
    sheet.eachRow((row) => {
        rows.push(row.values.slice(1).map((v) => (v === undefined || v === null ? '' : String(v))));
    });
    return rows;
};

const download = (agent, query) => agent.get(`${RUNS}/propose.xlsx${query}`).buffer().parse(binary);

let seq = 0;
async function order(code, over = {}) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: siteId(code),
        serviceType: 'adhoc',
        recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Test Street`,
        zip: '78215',
        description: 'Oral solids',
        quantity: 1,
        externalRef: `RX-${8000 + seq}`,
        ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    sites = (await admin.get(`${UH}/sites`)).body;

    green = [
        await order('green', { recipientName: 'Ada Lovelace', addressLine: '1 Analytical Way', zip: '78207', quantity: 3 }),
        await order('green', { recipientName: 'Grace Hopper', addressLine: '2 Compiler Street', zip: '78228' }),
        await order('green', { recipientName: 'Alan Turing', addressLine: '3 Lattice Road', zip: '78223' }),
    ];
    southeast = [await order('southeast', { recipientName: 'Karen Sparck', addressLine: '4 Beacon Avenue', zip: '78210' })];
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('downloading a proposed cluster', () => {
    it('comes back as a spreadsheet nobody caches', async () => {
        const res = await download(admin, `?orders=${green.map((o) => o.id).join(',')}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect(res.headers['content-disposition']).toMatch(/proposed-run-\d{4}-\d{2}-\d{2}\.xlsx/);
        /* Patient addresses. Not something a proxy keeps a copy of. */
        expect(String(res.headers['cache-control'])).toMatch(/no-store/);
        expect(String(res.headers['cache-control'])).toMatch(/private/);
    });

    it('carries the stops a driver needs to find the door', async () => {
        const res = await download(admin, `?orders=${green.map((o) => o.id).join(',')}`);
        const rows = await sheetOf(res, 'Proposed run');
        const flat = rows.flat().join(' | ');

        expect(rows[0]).toContain('Patient');
        expect(rows[0]).toContain('Address');
        expect(rows[0]).toContain('Handling');
        expect(flat).toMatch(/Ada Lovelace/);
        expect(flat).toMatch(/1 Analytical Way/);
        expect(flat).toMatch(/78207/);
        /* Three stops and a header. */
        expect(rows).toHaveLength(4);
    });

    it('keeps the order it was asked for, because that is the drive order', async () => {
        /* The planner sequences a cluster by deadline and the paper has to
           agree with the screen. Sorting by id in the handler would quietly
           reorder the round. Asked for backwards, it comes back backwards. */
        const backwards = [...green].reverse().map((o) => o.id);
        const res = await download(admin, `?orders=${backwards.join(',')}`);
        const rows = await sheetOf(res, 'Proposed run');
        const patients = rows.slice(1).map((r) => r[3]);
        expect(patients).toEqual(['Alan Turing', 'Grace Hopper', 'Ada Lovelace']);
        expect(rows.slice(1).map((r) => r[0])).toEqual(['1', '2', '3']);
    });

    it('says on the file that nothing here is assigned yet', async () => {
        /* A sheet of stops that are not on a run looks exactly like a sheet
           of stops that are, and somebody will read this one in a fortnight. */
        const res = await download(admin, `?orders=${green[0].id}`);
        const about = (await sheetOf(res, 'About')).flat().join(' | ');
        expect(about).toMatch(/Not a run/);
        expect(about).toMatch(/Contains patient data/);
    });

    it('refuses to guess which stops are wanted', async () => {
        expect((await admin.get(`${RUNS}/propose.xlsx`)).status).toBe(400);
        expect((await admin.get(`${RUNS}/propose.xlsx?orders=`)).status).toBe(400);
        expect((await admin.get(`${RUNS}/propose.xlsx?orders=nonsense`)).status).toBe(400);
    });

    it('answers 404 rather than an empty sheet for stops that are not here', async () => {
        /* An empty spreadsheet downloads and looks like a quiet day. */
        const res = await admin.get(`${RUNS}/propose.xlsx?orders=99999998,99999999`);
        expect(res.status).toBe(404);
    });

    it('ignores a repeated id rather than printing the stop twice', async () => {
        const id = green[0].id;
        const res = await download(admin, `?orders=${id},${id},${id}`);
        const rows = await sheetOf(res, 'Proposed run');
        expect(rows).toHaveLength(2);
    });

    it('will not hand a lead another pharmacy\'s patients', async () => {
        /* NAMING AN ID IS NOT PERMISSION TO READ IT. The ids are in the URL,
           so the only thing standing between a lead at Green and the whole
           contract's addresses is the scope on this handler. */
        await admin.post('/api/users').send({
            username: 'green.lead', name: 'Green Lead', password: 'green-lead-pass-1', role: 'driver',
        });
        await admin.put('/api/users/green.lead/memberships/uh').send({
            role: 'lead', settings: { siteIds: [siteId('green')] },
        });
        const lead = srv.agent();
        const login = await lead.post('/api/login').send({ username: 'green.lead', password: 'green-lead-pass-1' });
        expect(login.status, login.text).toBe(200);

        /* Their own counter: fine. */
        const mine = await download(lead, `?orders=${green[0].id}`);
        expect(mine.status).toBe(200);
        expect((await sheetOf(mine, 'Proposed run')).flat().join(' ')).toMatch(/Ada Lovelace/);

        /* Somebody else's: not in the sheet at all. */
        const theirs = await lead.get(`${RUNS}/propose.xlsx?orders=${southeast[0].id}`);
        expect(theirs.status).toBe(404);

        /* And mixed, the case that matters: the one they may see, and only
           that one, with the sheet saying something was left out. */
        const both = await download(lead, `?orders=${green[0].id},${southeast[0].id}`);
        expect(both.status).toBe(200);
        const rows = await sheetOf(both, 'Proposed run');
        expect(rows).toHaveLength(2);
        expect(rows.flat().join(' ')).not.toMatch(/Karen Sparck/);
        expect((await sheetOf(both, 'About')).flat().join(' | ')).toMatch(/Not included/);
    });

    it('refuses a courier outright', async () => {
        await admin.post('/api/users').send({
            username: 'plain.courier', name: 'Plain Courier', password: 'plain-courier-pass-1', role: 'driver',
        });
        await admin.put('/api/users/plain.courier/memberships/uh').send({
            role: 'courier', settings: { homeSiteId: siteId('green') },
        });
        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'plain.courier', password: 'plain-courier-pass-1' });
        expect((await courier.get(`${RUNS}/propose.xlsx?orders=${green[0].id}`)).status).toBe(403);
    });

    it('refuses anonymous', async () => {
        expect((await srv.agent().get(`${RUNS}/propose.xlsx?orders=${green[0].id}`)).status).toBe(401);
    });
});
