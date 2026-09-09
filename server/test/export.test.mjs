import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startServer, binaryParser } from './helpers/server.mjs';

let srv;
beforeAll(async () => {
    srv = await startServer();
    const north = await srv.login('north');
    await north.post('/api/logs').send({
        date: '2026-01-05', // a Monday
        legs: [
            { startTime: '05:00', endTime: '06:30', sterile: 4, soiled: 0, miles: 80 },
            { startTime: '06:40', endTime: '07:00', sterile: 0, soiled: 3, miles: 15 },
            { startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 },
            { startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 },
            { startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 },
            { startTime: '', endTime: '', sterile: 0, soiled: 0, miles: 0 },
            { legFrom: 'Murfreesboro', legTo: 'Smyrna', startTime: '10:00', endTime: '10:30', sterile: 1, soiled: 1, miles: 12.5 },
        ]
    });
    const south = await srv.login('south');
    await south.post('/api/logs').send({
        date: '2026-01-06',
        legs: [
            { startTime: '06:00', endTime: '08:30', sterile: 6, soiled: 0, miles: 122.6 },
            { startTime: '09:00', endTime: '11:30', sterile: 0, soiled: 6, miles: 123 },
        ]
    });
});
afterAll(async () => { await srv.stop(); });

async function workbookFrom(res) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    return wb;
}
const v = (ws, addr) => ws.getCell(addr).value;

describe('admin Excel export', () => {
    it('404s when the filter matches nothing', async () => {
        const admin = await srv.login('admin');
        const res = await admin.get('/api/admin/export?startDate=2030-01-01&endDate=2030-01-02');
        expect(res.status).toBe(404);
    });

    it('produces one worksheet per driver in the original log and invoice layout', async () => {
        const admin = await srv.login('admin');
        const res = await admin.get('/api/admin/export?startDate=2026-01-01&endDate=2026-01-31').buffer().parse(binaryParser);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect(res.headers['content-disposition']).toMatch(/TVHS_Courier_Logs_2026-01-01_to_2026-01-31\.xlsx/);

        const wb = await workbookFrom(res);
        expect(wb.worksheets.map(w => w.name).sort()).toEqual(['Bereket Nigusse', 'Mohamed Djemai']);

        // NorthBound sheet is a "Driver Log"
        const n = wb.getWorksheet('Bereket Nigusse');
        expect(v(n, 'A1')).toBe('Driver Log');
        expect(v(n, 'A3')).toBe('Driver Name:');
        expect(v(n, 'B3')).toBe('Bereket Nigusse');
        expect(v(n, 'A4')).toBe('Log Date:');
        expect(v(n, 'B4')).toBe('2026-01-05');
        expect(v(n, 'A5')).toBe('Log Number:');
        expect(v(n, 'F3')).toBe('Izy Global Services LLC');
        expect(v(n, 'F4')).toBe('4869 Madyson Ridge Dr.');
        expect(v(n, 'F5')).toBe('Fort Worth, TX 76133');
        expect(v(n, 'A8')).toBe('Total Weekly Miles:');
        expect(v(n, 'B8')).toBeCloseTo(107.5, 5);   // 80 + 15 + 12.5
        expect(v(n, 'A9')).toBe('Total Routes Completed:');
        expect(v(n, 'B9')).toBe(3);                 // legs with both start and end

        // Day block: header at row 12, then 6 standard legs + 1 extra, then totals
        expect(v(n, 'A12')).toBe('Date');
        expect(v(n, 'B12')).toBe('Route Leg');
        expect(v(n, 'H12')).toBe('Miles Driven');
        expect(v(n, 'A13')).toBe('Monday');
        expect(v(n, 'A14')).toBe('2026-01-05');
        expect(v(n, 'B13')).toBe('Murfreesboro to Clarksville');
        expect(v(n, 'C13')).toBe('05:00');
        expect(v(n, 'D13')).toBe('06:30');
        expect(v(n, 'E13')).toBe(4);
        expect(v(n, 'G13')).toBe(4);
        expect(v(n, 'H13')).toBe(80);
        expect(v(n, 'B19')).toBe('Murfreesboro to Smyrna (Extra)');
        expect(v(n, 'H19')).toBe(12.5);
        expect(v(n, 'D20')).toBe('Daily Totals:');
        expect(v(n, 'E20')).toBe(5);
        expect(v(n, 'F20')).toBe(4);
        expect(v(n, 'G20')).toBe(9);
        expect(v(n, 'H20')).toBeCloseTo(107.5, 5);

        // SouthBound sheet is a "Driver Invoice"
        const s = wb.getWorksheet('Mohamed Djemai');
        expect(v(s, 'A1')).toBe('Driver Invoice');
        expect(v(s, 'A4')).toBe('Invoice Date:');
        expect(v(s, 'A5')).toBe('Invoice Number:');
        expect(v(s, 'B8')).toBeCloseTo(245.6, 5);
        expect(v(s, 'B9')).toBe(2);
        expect(v(s, 'A13')).toBe('Tuesday');
        expect(v(s, 'B13')).toBe('Murfreesboro to Chattanooga');
        expect(v(s, 'B16')).toBe('Chattanooga to Murfreesboro');
        expect(v(s, 'D17')).toBe('Daily Totals:');
    });

    it('honours the route filter', async () => {
        const admin = await srv.login('admin');
        const res = await admin.get('/api/admin/export?route=southbound').buffer().parse(binaryParser);
        const wb = await workbookFrom(res);
        expect(wb.worksheets.map(w => w.name)).toEqual(['Mohamed Djemai']);
    });
});

describe('driver self export', () => {
    it('requires a date range', async () => {
        const a = await srv.login('north');
        expect((await a.get('/api/logs/export')).status).toBe(400);
        expect((await a.get('/api/logs/export?startDate=2026-01-01')).status).toBe(400);
    });

    it('404s when the driver has no data in the range', async () => {
        const a = await srv.login('north');
        expect((await a.get('/api/logs/export?startDate=2030-01-01&endDate=2030-01-31')).status).toBe(404);
    });

    it('exports only the calling driver, in their route layout', async () => {
        const a = await srv.login('south');
        const res = await a.get('/api/logs/export?startDate=2026-01-01&endDate=2026-01-31').buffer().parse(binaryParser);
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toMatch(/Driver_Invoice_Mohamed_Djemai_2026-01-01_to_2026-01-31\.xlsx/);
        const wb = await workbookFrom(res);
        expect(wb.worksheets).toHaveLength(1);
        const ws = wb.worksheets[0];
        expect(ws.name).toBe('Driver Invoice');
        expect(v(ws, 'B3')).toBe('Mohamed Djemai');
        expect(v(ws, 'B4')).toBe('2026-01-31');        // driver export stamps the requested end date
        expect(v(ws, 'B8')).toBeCloseTo(245.6, 5);
        expect(v(ws, 'B9')).toBe(2);
    });
});
