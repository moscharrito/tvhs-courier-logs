/* A week of deliveries and the proof of every one of them, in one file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACED, AND WHY THE TESTS ARE ABOUT RECONCILIATION.
 *
 * University Health's billing staff were checking an invoice line against the
 * signature behind it by opening each delivery in the portal and downloading
 * its document one at a time. A week of one pharmacy is two hundred of those.
 * So the question these tests ask is not "is it a zip" -- it is: can somebody
 * go from a row in the spreadsheet to the document that proves it without
 * searching, and is it still impossible for one counter to pull another
 * counter's patients out.
 *
 * THE LARGEST QUANTITY OF PATIENT DATA THAT LEAVES THIS SYSTEM IN ONE ACT.
 * Every delivery's patient, address, signature and doorstep photograph. The
 * scope and the audit trail are therefore tested as hard as the contents.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startServer } from './helpers/server.mjs';
import { readZip, zipMap } from './helpers/zip.mjs';

const CLIENT = '/api/projects/uh/uh/client';
const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let discharge;
let green;
let today;

const agentFor = async (username, password) => {
    const a = srv.agent();
    await a.post('/api/login').send({ username, password });
    return a;
};

/** supertest needs telling that an archive is binary. */
const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const bundle = (agent, query) => agent.get(`${CLIENT}/orders-with-pod.zip?${query}`).buffer().parse(binary);

/** The Deliveries sheet of the workbook inside the archive. */
async function sheetOf(zipBuffer, name = 'Deliveries') {
    const entry = [...zipMap(zipBuffer).entries()].find(([n]) => n.endsWith('.xlsx'));
    expect(entry, 'no spreadsheet in the archive').toBeTruthy();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(entry[1].data);
    const rows = [];
    wb.getWorksheet(name).eachRow((row) => {
        rows.push(row.values.slice(1).map((v) => (v === undefined || v === null ? '' : String(v))));
    });
    return rows;
}

let seq = 0;
async function order(over = {}) {
    seq += 1;
    const { siteId = discharge.id, ...rest } = over;
    const created = await admin.post(ORDERS).send({
        siteId, serviceType: 'stat', recipientName: `Bundle Patient ${seq}`,
        addressLine: `${seq} Reconciled Street`, city: 'San Antonio', state: 'TX', zip: '78229',
        description: 'Oral solids', quantity: 2, externalRef: `RX-B${7000 + seq}`,
        serviceDate: today, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
}

/** One that reached an outcome, which is what earns a document. */
async function delivered(over = {}) {
    const o = await order(over);
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [o.id] });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'delivered', signedName: 'Ines Vargas' });
    return o;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Boleyn Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });

    /* The contract manager and, from 12 November 2026, the billing staff
       beside him: one membership naming every pharmacy. Enumerated rather
       than a flag, because scopeFor's whole-project branch is for OUR roles
       and would hand a client the dispatch board. */
    await admin.post('/api/users').send({ username: 'uh.manager', name: 'Contract Manager', password: 'manager-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.manager/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: sites.map((s) => s.id) },
    });

    /* A pharmacist at one counter, who is the reason the scope tests exist. */
    await admin.post('/api/users').send({ username: 'uh.discharge', name: 'Discharge Pharmacist', password: 'client-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.discharge/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });

    await delivered();
    await delivered({ siteId: green.id });
    /* Still out. It belongs in the spreadsheet and must NOT have a document:
       a proof of delivery for a delivery that has not happened is a page
       saying nothing happened. */
    await order();
});
afterAll(async () => { await srv.stop(); });

describe('the bundle a billing clerk downloads', () => {
    it('is an archive, named for the range it covers', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/zip/);
        expect(res.headers['content-disposition']).toContain(`deliveries-and-proof-${today}-to-${today}.zip`);
    });

    it('opens, which is the only thing a bundle has to do', async () => {
        /* Read from the format by helpers/zip.mjs, not by the writer turned
           round. See that file. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        const files = readZip(res.body);
        expect(files.length).toBeGreaterThan(1);
        for (const f of files) expect(f.data.length, f.name).toBe(f.size);
    });

    it('holds the spreadsheet and a document per completed delivery', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        const names = readZip(res.body).map((f) => f.name);

        expect(names.filter((n) => n.endsWith('.xlsx'))).toHaveLength(1);
        const pdfs = names.filter((n) => n.endsWith('.pdf'));
        expect(pdfs).toHaveLength(2);
        /* A folder per pharmacy, so a bundle covering nine counters is nine
           folders rather than nine hundred files in a heap. */
        expect(pdfs.every((n) => n.includes('/'))).toBe(true);
        expect(new Set(pdfs.map((n) => n.split('/')[0])).size).toBe(2);
    });

    it('puts real documents in it, not placeholders', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        for (const f of readZip(res.body).filter((x) => x.name.endsWith('.pdf'))) {
            expect(f.data.subarray(0, 5).toString('latin1'), f.name).toBe('%PDF-');
            expect(f.data.subarray(-6).toString('latin1'), f.name).toMatch(/%%EOF/);
        }
    });

    it('lets a row find its own proof without anybody searching a folder', async () => {
        /* THE WHOLE FEATURE, in one assertion: the path from an invoice line
           to the signature behind it is a column. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        const rows = await sheetOf(res.body);
        const [header, ...body] = rows;
        const column = header.indexOf('Proof of delivery');
        expect(column, 'the spreadsheet should name the document for each row').toBeGreaterThan(-1);

        const inside = new Set(readZip(res.body).map((f) => f.name));
        const named = body.map((r) => r[column]).filter((p) => p.endsWith('.pdf'));
        expect(named).toHaveLength(2);
        for (const p of named) expect(inside.has(p), `${p} is named in the sheet`).toBe(true);
    });

    it('says "no proof yet" for one still in the air rather than pointing at nothing', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        const [header, ...body] = await sheetOf(res.body);
        const column = header.indexOf('Proof of delivery');
        const open = body.filter((r) => !r[column].endsWith('.pdf'));
        expect(open).toHaveLength(1);
        expect(open[0][column]).toMatch(/no proof yet/i);
    });

    it('says on the spreadsheet that the documents are beside it', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        const about = (await sheetOf(res.body, 'About')).flat().join(' | ');
        expect(about).toContain('Proof of delivery');
        expect(about).toContain('Contains patient data');
    });

    it('is never cached, because every page of it is patient data', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, `from=${today}&to=${today}`);
        expect(String(res.headers['cache-control'])).toMatch(/no-store/);
        expect(String(res.headers['cache-control'])).toMatch(/private/);
    });
});

describe('a pharmacist at one counter', () => {
    it('bundles their own counter and not the one next door', async () => {
        /* The property the whole portal exists to hold. The scope comes from
           the membership, so there is no parameter to change. */
        const pharmacist = await agentFor('uh.discharge', 'client-pass-1');
        const res = await bundle(pharmacist, `from=${today}&to=${today}`);
        expect(res.status).toBe(200);

        const pdfs = readZip(res.body).filter((f) => f.name.endsWith('.pdf'));
        expect(pdfs).toHaveLength(1);
        expect(pdfs[0].name.startsWith(green.name)).toBe(false);

        const flat = (await sheetOf(res.body)).flat().join(' | ');
        expect(flat).not.toContain(green.name);
    });

    it('cannot reach another pharmacy by asking for it', async () => {
        const pharmacist = await agentFor('uh.discharge', 'client-pass-1');
        const res = await bundle(pharmacist, `from=${today}&to=${today}&siteId=${green.id}`);
        expect(res.status).toBe(403);
    });

    it('is refused for a courier and for nobody at all', async () => {
        const anon = srv.agent();
        expect((await anon.get(`${CLIENT}/orders-with-pod.zip`)).status).toBe(401);
        const ada = await agentFor('ada.courier', 'courier-pass-1');
        expect((await ada.get(`${CLIENT}/orders-with-pod.zip`)).status).toBe(403);
    });
});

describe('what it refuses, before the first byte', () => {
    it('refuses a range with nothing finished in it, and says where the rows are', async () => {
        /* A zip containing one spreadsheet and no documents looks like a
           failure. Saying so in words, with the export named, is the
           difference between that and a support call. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, 'from=2026-01-05&to=2026-01-05');
        expect(res.status).toBe(400);
        const body = JSON.parse(res.body.toString('utf8'));
        expect(body.code).toBe('client.bundleEmpty');
        expect(body.error).toMatch(/Excel export/i);
    });

    it('refuses a range longer than the portal serves at all', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await bundle(manager, 'from=2025-01-01&to=2026-12-31');
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body.toString('utf8')).code).toBe('client.rangeTooLong');
    });
});

describe('the record of what left', () => {
    it('audits the documents as well as the rows', async () => {
        /* A bundle is a different quantity of patient data from a
           spreadsheet, and the trail has to say so in those terms: this is
           the only record of how much went out, and when, at whose request. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        await bundle(manager, `from=${today}&to=${today}`);

        const { events } = (await admin.get('/api/audit?action=client.export_bundle')).body;
        expect(events.length, 'the bundle should be audited').toBeGreaterThan(0);
        const latest = events[0];
        expect(latest.action).toBe('client.export_bundle');
        expect(latest.username).toBe('uh.manager');
        const detail = typeof latest.detail === 'string' ? JSON.parse(latest.detail) : latest.detail;
        expect(detail.documents).toBe(2);
        expect(detail.rows).toBe(3);
        expect(detail.containedPatientData).toBe(true);
    });
});
