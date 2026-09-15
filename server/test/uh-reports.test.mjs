/* The SLA report.
 *
 * The arithmetic is easy. What is worth testing is the part that gets argued
 * about in a contract meeting: which deliveries are in the denominator, what
 * happens to the ones that cannot be measured, and whether the number this
 * reports is the one Scope 1.2.5 asks for or the one its wording literally
 * describes. Those are asserted explicitly, because a report nobody can
 * reproduce is worse than no report at all.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startServer } from './helpers/server.mjs';
import {
    bucketFor, dayType, addFact, ratesFor, sliceBy, emptyTotals,
    DEFINITIONS, COMPLETION_TARGET, GROUPINGS,
} from '../src/modules/uh/reports.ts';

const REPORTS = '/api/projects/uh/uh/reports';

/* supertest parses a response body by content type and has no parser for a
   spreadsheet, so it hands back an object. Collect the bytes instead. */
const asBuffer = (res, cb) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const workbook = async (path) => {
    const res = await admin.get(path).buffer(true).parse(asBuffer);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    return { res, wb };
};
const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let discharge;

const NOW = new Date('2026-09-16T23:00:00.000Z');

const fact = (over = {}) => ({
    serviceDate: '2026-09-14', serviceType: 'stat', siteId: 1, siteName: 'Discharge',
    zone: 1, status: 'delivered', dueAt: '2026-09-14T19:00:00.000Z',
    arrivedAt: '2026-09-14T18:30:00.000Z', deliveredAt: '2026-09-14T18:35:00.000Z', ...over,
});

const fold = (facts) => facts.reduce((acc, f) => addFact(acc, f, NOW), emptyTotals());

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    discharge = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge');
    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

/* ---------------------------------------------------------------- buckets */

describe('grouping a range', () => {
    it('puts a day in itself', () => {
        expect(bucketFor('2026-09-14', 'day')).toEqual({ key: '2026-09-14', label: '2026-09-14' });
    });

    it('starts a week on Monday, and labels it with a date rather than a number', () => {
        // A quality team reports on a working week, and "2026-W38" is a number
        // people have to look up.
        expect(bucketFor('2026-09-14', 'week').key).toBe('2026-09-14'); // Monday
        expect(bucketFor('2026-09-20', 'week').key).toBe('2026-09-14'); // Sunday
        expect(bucketFor('2026-09-21', 'week').key).toBe('2026-09-21'); // next Monday
        expect(bucketFor('2026-09-16', 'week').label).toBe('week of 2026-09-14');
    });

    it('groups months and quarters', () => {
        expect(bucketFor('2026-09-14', 'month').key).toBe('2026-09');
        expect(bucketFor('2026-01-31', 'quarter')).toEqual({ key: '2026-Q1', label: '2026 Q1' });
        expect(bucketFor('2026-04-01', 'quarter').key).toBe('2026-Q2');
        expect(bucketFor('2026-12-31', 'quarter').key).toBe('2026-Q4');
    });

    it('tells a weekend from a weekday, from the local service date', () => {
        /* The service date is already local, so this must not go near a
           timezone: 2026-09-12 is a Saturday in San Antonio and stays one. */
        expect(dayType('2026-09-12')).toBe('weekend');
        expect(dayType('2026-09-13')).toBe('weekend');
        expect(dayType('2026-09-14')).toBe('weekday');
    });
});

/* ------------------------------------------------------------------ rates */

describe('what goes into a rate', () => {
    it('counts delivered over attempted, not over everything', () => {
        const totals = fold([
            fact(), fact(), fact(),
            fact({ status: 'failed', deliveredAt: null }),
            fact({ status: 'cancelled', arrivedAt: null, deliveredAt: null }),
            fact({ status: 'picked_up', arrivedAt: null, deliveredAt: null }),
        ]);
        expect(totals).toMatchObject({ orders: 6, delivered: 3, notDelivered: 1, cancelled: 1, stillOpen: 1, attempts: 4 });
        // 3 of 4 attempts, not 3 of 6 deliveries.
        expect(ratesFor(totals).completionRate).toBe(75);
        expect(ratesFor(totals).dryRunRate).toBe(25);
    });

    it('leaves a cancelled delivery out of every rate', () => {
        // Called off before a courier took custody is not a performance
        // outcome either way.
        const totals = fold([fact(), fact({ status: 'cancelled' })]);
        expect(totals.attempts).toBe(1);
        expect(ratesFor(totals).completionRate).toBe(100);
    });

    it('measures on time at arrival, not at delivery', () => {
        /* Addendum 1 counts an on-time arrival as a success even when the
           recipient is unavailable: reached the door at 18:58, handed over at
           19:05, deadline 19:00. */
        const totals = fold([fact({
            dueAt: '2026-09-14T19:00:00.000Z',
            arrivedAt: '2026-09-14T18:58:00.000Z',
            deliveredAt: '2026-09-14T19:05:00.000Z',
        })]);
        expect(totals.onTimeMet).toBe(1);
        expect(ratesFor(totals).onTimeRate).toBe(100);
    });

    it('counts an attempt that cannot be measured, rather than dropping it', () => {
        /* Dropping it would leave the on-time denominator unexplainable
           against the attempt count, which is exactly the argument this
           report exists to avoid. */
        const totals = fold([
            fact(),
            fact({ dueAt: null }),
            fact({ status: 'failed', arrivedAt: null, deliveredAt: null, dueAt: null }),
        ]);
        expect(totals.attempts).toBe(3);
        expect(totals.onTimeMet + totals.onTimeMissed).toBe(1);
        expect(totals.notMeasured).toBe(2);
    });

    it('reports Scope 1.2.5 as written as well as the sensible way up', () => {
        /* The clause says "attempts divided by successful deliveries" and also
           requires 85 per cent. Those cannot both be true, so the report shows
           both numbers and labels them rather than choosing quietly. */
        const totals = fold([fact(), fact(), fact(), fact({ status: 'failed' })]);
        const rates = ratesFor(totals);
        expect(rates.completionRate).toBe(75);
        expect(rates.literalScopeRatio).toBeCloseTo(4 / 3, 3);
        expect(rates.literalScopeRatio).toBeGreaterThan(1);
    });

    it('answers null rather than zero when there is nothing to divide', () => {
        // A zero completion rate and no deliveries at all are different facts.
        const rates = ratesFor(emptyTotals());
        expect(rates.completionRate).toBeNull();
        expect(rates.onTimeRate).toBeNull();
        expect(rates.literalScopeRatio).toBeNull();
    });

    it('slices without losing anybody', () => {
        const facts = [
            fact({ serviceType: 'stat' }), fact({ serviceType: 'stat', status: 'failed' }),
            fact({ serviceType: 'scheduled' }),
        ];
        const slices = sliceBy(facts, (f) => ({ key: f.serviceType, label: f.serviceType }), NOW);
        expect(slices.map((s) => s.key)).toEqual(['scheduled', 'stat']);
        expect(slices.reduce((n, s) => n + s.totals.orders, 0)).toBe(3);
        expect(slices.find((s) => s.key === 'stat').rates.completionRate).toBe(50);
    });
});

describe('the definitions', () => {
    it('name the contract target and the discrepancy in its formula', () => {
        const completion = DEFINITIONS.find((d) => d.measure === 'Completion rate');
        expect(completion.note).toContain(String(COMPLETION_TARGET));
        expect(completion.note).toMatch(/cannot be a percentage/);
        expect(completion.note).toMatch(/open item/i);
    });

    it('say what is excluded, not only what is counted', () => {
        const text = DEFINITIONS.map((d) => `${d.measure} ${d.definition} ${d.note}`).join(' ');
        expect(text).toMatch(/Cancelled/);
        expect(text).toMatch(/Still open/i);
        expect(text).toMatch(/arrival/i);
    });
});

/* ------------------------------------------------------------------ routes */

let seq = 0;
async function delivery(outcome, over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: discharge.id, serviceType: 'stat', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Test Street`, zip: '78215', description: 'Oral solids',
        quantity: 1, externalRef: `RX-${3000 + seq}`, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    if (outcome === 'ready') return order;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    if (outcome === 'delivered') {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Recipient' });
    } else if (outcome === 'failed') {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'no_access' });
    }
    return order;
}

describe('the report endpoint', () => {
    let today;
    beforeAll(async () => {
        today = (await admin.get('/api/projects/uh/uh/board')).body.serviceDate;
        await delivery('delivered');
        await delivery('delivered');
        await delivery('delivered');
        await delivery('failed');
        await delivery('ready');
    });

    it('reports the day with every breakdown the ticket asks for', async () => {
        const res = await admin.get(`${REPORTS}/sla?from=${today}&to=${today}`);
        expect(res.status).toBe(200);
        expect(res.body.totals).toMatchObject({ delivered: 3, notDelivered: 1, attempts: 4, stillOpen: 1 });
        expect(res.body.rates.completionRate).toBe(75);
        expect(res.body.byServiceType.length).toBeGreaterThan(0);
        expect(res.body.bySite.length).toBeGreaterThan(0);
        expect(res.body.byZone.length).toBeGreaterThan(0);
        expect(res.body.byDayType.length).toBe(1);
        expect(res.body.byPeriod.length).toBe(1);
        expect(res.body.definitions.length).toBeGreaterThan(3);
    });

    it('says whether the contract figure was met, and what that figure is', async () => {
        const res = await admin.get(`${REPORTS}/sla?from=${today}&to=${today}`);
        expect(res.body.target).toEqual({ completion: COMPLETION_TARGET, internalGoal: 95 });
        // 75 per cent against a floor of 85.
        expect(res.body.meetsContract).toBe(false);
    });

    it('groups by week, month and quarter as well as by day', async () => {
        for (const groupBy of GROUPINGS) {
            const res = await admin.get(`${REPORTS}/sla?from=${today}&to=${today}&groupBy=${groupBy}`);
            expect(res.status).toBe(200);
            expect(res.body.grouping).toBe(groupBy);
            expect(res.body.byPeriod).toHaveLength(1);
        }
    });

    it('refuses a range longer than a year, and one that runs backwards', async () => {
        expect((await admin.get(`${REPORTS}/sla?from=2020-01-01&to=${today}`)).body.code).toBe('reports.rangeTooLong');
        expect((await admin.get(`${REPORTS}/sla?from=${today}&to=2020-01-01`)).status).toBe(400);
    });

    it('is staff only: not couriers, not the client', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.get(`${REPORTS}/sla`)).status).toBe(403);
        expect((await ada.get(`${REPORTS}/sla.xlsx`)).status).toBe(403);

        await admin.post('/api/users').send({ username: 'uh.quality', name: 'Quality Person', password: 'client-pass-1', role: 'staff' });
        await admin.put('/api/users/uh.quality/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });
        const uh = srv.agent();
        await uh.post('/api/login').send({ username: 'uh.quality', password: 'client-pass-1' });
        /* The client gets their numbers from us in a workbook we have looked
           at, not from a live endpoint that could disagree with the invoice. */
        expect((await uh.get(`${REPORTS}/sla`)).status).toBe(403);
    });

    it('records that a report was produced', async () => {
        await admin.get(`${REPORTS}/sla?from=${today}&to=${today}`);
        const audit = await admin.get('/api/audit?action=reports.sla&limit=3');
        expect(audit.body.events[0].detail).toMatchObject({ grouping: 'day' });
        // Aggregate only: no patient data can reach an audit row from here.
        expect(JSON.stringify(audit.body)).not.toMatch(/Recipient \d/);
    });
});

describe('the workbook', () => {
    let today;
    beforeAll(async () => {
        today = (await admin.get('/api/projects/uh/uh/board')).body.serviceDate;
    });

    it('is a real xlsx with the sheets a quality team would look for', async () => {
        const { res, wb } = await workbook(`${REPORTS}/sla.xlsx?from=${today}&to=${today}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect(res.headers['content-disposition']).toContain(`sla-${today}-to-${today}.xlsx`);
        expect(wb.worksheets.map((w) => w.name)).toEqual([
            'Summary', 'By period', 'By service type', 'By pharmacy', 'By zone', 'By day type', 'Definitions',
        ]);
    });

    it('carries the definitions, including the one about the inverted formula', async () => {
        const { wb } = await workbook(`${REPORTS}/sla.xlsx?from=${today}&to=${today}`);
        const sheet = wb.getWorksheet('Definitions');
        const text = [];
        sheet.eachRow((row) => text.push(row.values.join(' ')));
        const blob = text.join('\n');
        expect(blob).toMatch(/Completion rate/);
        expect(blob).toMatch(/cannot be a percentage/);
        // And that the layout is not yet agreed, which is true and load-bearing.
        expect(blob).toMatch(/has not yet been agreed with University Health Quality Services/);
    });

    it('writes rates as percentages a spreadsheet can chart, not as text', async () => {
        const { wb } = await workbook(`${REPORTS}/sla.xlsx?from=${today}&to=${today}`);
        const summary = wb.getWorksheet('Summary');
        let completion = null;
        summary.eachRow((row) => {
            if (String(row.getCell(1).value) === 'Completion rate') completion = row.getCell(2);
        });
        expect(completion).not.toBeNull();
        expect(typeof completion.value).toBe('number');
        // 0.75 formatted as a percentage, not the string "75%".
        expect(completion.value).toBeCloseTo(0.75, 3);
        expect(completion.numFmt).toBe('0.0%');
    });

    it('says n/a rather than zero when a rate has no denominator', async () => {
        const empty = '2019-01-02';
        const { wb } = await workbook(`${REPORTS}/sla.xlsx?from=${empty}&to=${empty}`);
        const summary = wb.getWorksheet('Summary');
        let completion = null;
        summary.eachRow((row) => {
            if (String(row.getCell(1).value) === 'Completion rate') completion = row.getCell(2).value;
        });
        expect(completion).toBe('n/a');
    });

    it('is not cached anywhere', async () => {
        const res = await admin.get(`${REPORTS}/sla.xlsx?from=${today}&to=${today}`);
        expect(res.headers['cache-control']).toMatch(/no-store/);
    });
});
