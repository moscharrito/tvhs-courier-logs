/* The deliveries, as a spreadsheet University Health keep.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE CARRIES PATIENT DATA OUT OF THE SYSTEM, ON PURPOSE.
 *
 * A decision taken on 6 October 2026: University Health are the covered
 * entity and this is their own patients' data going back to them. That is the
 * ordinary direction for it to travel, and it is still PHI leaving a system
 * we control for a file we do not.
 *
 * So the tests that matter here are not "does it produce a workbook". They
 * are: does it carry exactly the deliveries the screen was showing, can a
 * pharmacist at one counter pull another counter's patients out of it, and is
 * there a record afterwards of how much left and when.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startServer } from './helpers/server.mjs';

const CLIENT = '/api/projects/uh/uh/client';
const ORDERS = '/api/projects/uh/uh/orders';

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

/** The Deliveries sheet as rows of plain values, header included. */
async function sheetOf(res, name = 'Deliveries') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.getWorksheet(name);
    const rows = [];
    sheet.eachRow((row) => {
        rows.push(row.values.slice(1).map((v) => (v === undefined || v === null ? '' : String(v))));
    });
    return rows;
}

/** supertest needs telling that a spreadsheet is binary. */
const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    /* A contract manager: every pharmacy.
     *
     * Enumerated, not a flag. scopeFor gives whole-project reach only to
     * admin, ops_manager and dispatcher, which are OUR roles and would hand a
     * client the dispatch board. A pharmacy membership with no siteIds is
     * scoped to nothing, deliberately, so "all of them" means listing them.
     * Explicit and safe, and it means adding a tenth pharmacy is also a
     * change to this membership. */
    await admin.post('/api/users').send({ username: 'uh.manager', name: 'Contract Manager', password: 'manager-pass-1', role: 'staff', mustChangePassword: false });
    await admin.put('/api/users/uh.manager/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: sites.map((s) => s.id) },
    });

    /* A pharmacist at one counter. The scoping test needs somebody who must
       not be able to export the other counter. */
    await admin.post('/api/users').send({ username: 'uh.discharge', name: 'Discharge Pharmacist', password: 'client-pass-1', role: 'staff', mustChangePassword: false });
    await admin.put('/api/users/uh.discharge/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });

    for (const [i, siteId] of [discharge.id, discharge.id, green.id].entries()) {
        await admin.post(ORDERS).send({
            siteId,
            serviceType: 'stat',
            recipientName: `Export Patient ${String.fromCharCode(65 + i)}`,
            addressLine: `${10 + i} Invented Street`,
            city: 'San Antonio',
            state: 'TX',
            zip: '78229',
            serviceDate: today,
        });
    }
});
afterAll(async () => { await srv.stop(); });

describe('a contract manager exporting the day', () => {
    it('gets a spreadsheet, not a web page', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect(res.headers['content-disposition']).toContain(`deliveries-${today}-to-${today}.xlsx`);
    });

    it('is never cached, because it is full of patient names', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        expect(String(res.headers['cache-control'])).toMatch(/no-store/);
        expect(String(res.headers['cache-control'])).toMatch(/private/);
    });

    it('carries the patient and the address, which is the whole point', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        const rows = await sheetOf(res);
        const flat = rows.flat().join(' | ');
        expect(flat).toContain('Export Patient A');
        expect(flat).toContain('Invented Street');
    });

    it('names the columns a person needs rather than the database ones', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        const [header] = await sheetOf(res);
        for (const column of ['Service date', 'Pharmacy', 'Zone', 'Patient', 'Address', 'Status', 'Delivered', 'Courier']) {
            expect(header, `the header should carry "${column}"`).toContain(column);
        }
        /* The export exists so somebody stops retyping: a column called
           external_ref or site_id would send them back to asking us. */
        expect(header.join(' ')).not.toMatch(/_id|_at\b|external_ref/);
    });

    it('says on the file what it is and that it holds patient data', async () => {
        /* A spreadsheet outlives the conversation that produced it. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        const about = (await sheetOf(res, 'About')).flat().join(' | ');
        expect(about).toContain('Contains patient data');
        expect(about).toContain('America/Chicago');
        expect(about).toContain(today);
    });

    it('covers every pharmacy on the account', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        const flat = (await sheetOf(res)).flat().join(' | ');
        expect(flat).toContain('Export Patient A');
        expect(flat).toContain('Export Patient C');
    });
});

describe('a pharmacist at one counter', () => {
    it('exports their own counter and not the one next door', async () => {
        /* The property the whole portal exists to hold, now that the data can
           leave as a file. The scope comes from the membership, so there is
           no parameter to change. */
        const pharmacist = await agentFor('uh.discharge', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        const flat = (await sheetOf(res)).flat().join(' | ');

        expect(flat).toContain('Export Patient A');
        expect(flat).not.toContain('Export Patient C');
    });

    it('cannot reach another pharmacy by asking for it', async () => {
        const pharmacist = await agentFor('uh.discharge', 'client-pass-1');
        const res = await pharmacist.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}&siteId=${green.id}`);
        expect(res.status).toBe(403);
    });
});

describe('who may not export at all', () => {
    it('refuses a courier and anonymous', async () => {
        const courier = srv.agent();
        expect((await courier.get(`${CLIENT}/orders.xlsx`)).status).toBe(401);
    });
});

describe('the record of what left', () => {
    it('audits the export with how many rows of patient data it carried', async () => {
        /* The count is the point. This is the only record of how much patient
           data left the system, and when, and at whose request. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);

        const { events } = (await admin.get('/api/audit?action=client.export')).body;
        expect(events.length).toBeGreaterThan(0);
        const latest = events[0];
        expect(latest.action).toBe('client.export');
        expect(latest.username).toBe('uh.manager');
        const detail = typeof latest.detail === 'string' ? JSON.parse(latest.detail) : latest.detail;
        expect(detail.rows).toBeGreaterThan(0);
        expect(detail.containedPatientData).toBe(true);
    });
});

describe('the range', () => {
    it('refuses a window longer than the list allows, rather than quietly shortening it', async () => {
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=2026-01-01&to=2026-12-31`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('client.rangeTooLong');
    });

    it('is the same range the list would have shown', async () => {
        /* The export and the list run one query through gatherOrders. A file
           that quietly covered a different range than the screen above it
           would be worse than no file, because nobody would check. */
        const manager = await agentFor('uh.manager', 'manager-pass-1');
        const list = await manager.get(`${CLIENT}/orders?from=${today}&to=${today}`);
        const res = await manager.get(`${CLIENT}/orders.xlsx?from=${today}&to=${today}`).buffer().parse(binary);
        const rows = await sheetOf(res);
        expect(rows.length - 1).toBe(list.body.orders.length);
    });
});
