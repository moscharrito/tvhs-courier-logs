/* Is there a row cap on a list upload, and where?
 *
 * Reported from 2 November: "approximately 102 entries per upload", with
 * prescriptions beyond it never appearing on a manifest and nobody told.
 * This drives the real endpoint with a list well past that and counts what
 * came out at every stage a row could be lost: parsed, previewed, written,
 * and then read back the way a courier's screen reads it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startServer } from './helpers/server.mjs';

const BASE = '/api/projects/uh/uh/imports';
const N = 260;

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
}, 60_000);
afterAll(async () => { await srv?.stop(); });

async function sheetOf(n) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Manifest');
    ws.addRow(['Daily courier list']);
    ws.addRow([]);
    ws.addRow(['Rx #', 'Patient Name', 'Address 1', 'City', 'State', 'Zip Code', 'Qty']);
    for (let i = 1; i <= n; i += 1) {
        ws.addRow([`RX-${90000 + i}`, `Patient ${i}`, `${i} Probe Street`, 'San Antonio', 'TX', '78215', '1']);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
}

const upload = (bytes, options) => admin
    .post(`${BASE}?options=${encodeURIComponent(JSON.stringify(options))}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Upload-Filename', 'probe.xlsx')
    .send(bytes);

describe('a list bigger than a hundred rows', () => {
    it('previews, imports and reads back every row', async () => {
        const bytes = await sheetOf(N);
        const day = '2026-09-22';

        const preview = await admin
            .post(`${BASE}/preview?options=${encodeURIComponent(JSON.stringify({ siteId: dischargeId, serviceDate: day }))}`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Upload-Filename', 'probe.xlsx')
            .send(bytes);
        expect(preview.status, preview.text).toBe(200);
        expect(preview.body.summary.total, 'rows the preview saw').toBe(N);
        expect(preview.body.summary.willImport, 'rows the preview would import').toBe(N);

        const res = await upload(bytes, { siteId: dischargeId, serviceDate: day });
        expect(res.status, res.text).toBe(201);
        expect(res.body.summary.imported, 'orders the import says it made').toBe(N);

        /* What the database actually holds, which is the number that decides
           whether a prescription reaches a courier. */
        const rs = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM orders WHERE daily_list_id = ?',
            args: [res.body.id],
        });
        expect(Number(rs.rows[0].n), 'orders in the database').toBe(N);

        /* And what the orders screen hands back when nobody asks for a page,
           which is how a manifest is built. */
        /* AND THE READ SIDE, WHICH IS WHERE A ROW CAN STILL GO MISSING.
           One unpaged read hands back a page, not the list -- 200 of them,
           PAGE_DEFAULT in modules/uh/orders.ts. Nothing is lost: `total`
           is honest and `nextCursor` is there to follow. What is pinned
           here is that the count is TOLD, so a caller cannot mistake a page
           for the whole thing without ignoring the number beside it. */
        const listed = await admin.get(`/api/projects/uh/uh/orders?serviceDate=${day}&siteId=${dischargeId}`);
        expect(listed.status, listed.text).toBe(200);
        expect(listed.body.total, 'total the orders list reports').toBe(N);
        expect(listed.body.orders.length).toBeLessThan(N);
        expect(listed.body.nextCursor, 'a cursor to the rest').not.toBeNull();

        /* Asking for them all works, which is what an export or a manifest
           does. */
        const all = await admin.get(`/api/projects/uh/uh/orders?serviceDate=${day}&siteId=${dischargeId}&limit=1000`);
        expect(all.body.orders.length, 'orders when the whole list is asked for').toBe(N);
    }, 120_000);
});
