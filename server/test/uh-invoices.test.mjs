/* Invoicing.
 *
 * The failures worth catching here all cost money or trust: a delivery billed
 * twice, a delivery billed at zero because nobody had its mileage, an issued
 * invoice whose total moves after it was sent, and a correction with nobody's
 * reason attached. Those are what most of these assert.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startServer } from './helpers/server.mjs';
import { toCents, toDollars, money, renderInvoice } from '../src/modules/uh/invoices.ts';

const INVOICES = '/api/projects/uh/uh/invoices';
const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv;
let admin;
let discharge;

/* A closed period well inside the contract term, so a price schedule is in
   effect and the period can never include today. */
const FROM = '2026-06-01';
const TO = '2026-06-07';

const asBuffer = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** Text out of an uncompressed PDF. Parentheses are escaped in a PDF string,
 *  so they have to be unescaped or "(continued)" is never found. */
const pdfText = (latin1) =>
    [...latin1.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
        .map((m) => m[1].replace(/\\([()\\])/g, '$1'))
        .join('\n');

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    discharge = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge');
    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Courier', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });
    await admin.post('/api/users').send({ username: 'dee.dispatcher', name: 'Dee Dispatcher', password: 'dispatch-pass-1', role: 'staff' });
    await admin.put('/api/users/dee.dispatcher/memberships/uh').send({ role: 'dispatcher', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

let seq = 0;
/**
 * A billable delivery on a chosen service date.
 *
 * The service date is set directly afterwards: the app stamps today, and an
 * invoice has to be tested against a period that is definitely over.
 */
async function billable(outcome, over = {}) {
    seq += 1;
    const { serviceDate = FROM, zip = '78215', serviceType = 'scheduled', quantity = 1, ...rest } = over;
    /* Created as STAT because the manual endpoint only takes stat or adhoc:
       a scheduled order arrives from the daily list. The service type is set
       to what the test wants below, alongside the service date. */
    const created = await admin.post(ORDERS).send({
        siteId: discharge.id, serviceType: 'stat', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Test Street`, zip, description: 'Oral solids',
        quantity, externalRef: `RX-${7000 + seq}`, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    if (outcome === 'delivered') {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Recipient' });
    } else {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'no_access' });
    }
    /* Move it into the billing period, and pin the performed instant to the
       middle of a business day so an after-hours surcharge cannot appear or
       disappear depending on when the suite runs. */
    await sql(
        `UPDATE orders SET service_date = ?, service_type = ?, received_at = ?, pickup_at = ?, arrived_at = ?,
             delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE ? END
         WHERE id = ?`,
        [
            serviceDate, serviceType,
            `${serviceDate}T15:00:00.000Z`, `${serviceDate}T16:00:00.000Z`,
            `${serviceDate}T17:00:00.000Z`, `${serviceDate}T17:05:00.000Z`, order.id,
        ],
    );
    return order;
}

const draft = async (over = {}) => {
    const res = await admin.post(INVOICES).send({ from: FROM, to: TO, ...over });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
};

/* ------------------------------------------------------------------ money */

describe('money', () => {
    it('is integer cents, because a dollar is not a binary fraction', () => {
        expect(toCents(12.5)).toBe(1250);
        expect(toCents(0.1) + toCents(0.2)).toBe(30);
        // The thing this avoids: 0.1 + 0.2 === 0.30000000000000004.
        expect(toDollars(toCents(0.1) + toCents(0.2))).toBe(0.3);
    });

    it('formats a credit as a negative amount rather than hiding the sign', () => {
        expect(money(1250)).toBe('$12.50');
        // Grouped: $1500.00 and $15000.00 are one glance apart on a document
        // somebody pays from.
        expect(money(150000)).toBe('$1,500.00');
        expect(money(123456789)).toBe('$1,234,567.89');
        expect(money(-1250)).toBe('-$12.50');
        expect(money(0)).toBe('$0.00');
    });
});

/* ------------------------------------------------------------- the draft */

describe('a draft invoice', () => {
    let invoice;
    beforeAll(async () => {
        await billable('delivered');
        await billable('delivered', { serviceType: 'stat' });
        await billable('failed', { quantity: 3 });
        // Cancelled and still-open deliveries are not billable and not errors.
        const open = await billable('delivered');
        await sql("UPDATE orders SET status = 'picked_up', delivered_at = NULL WHERE id = ?", [open.id]);
        invoice = await draft();
    });

    it('bills deliveries and dry runs, and nothing else', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(res.status).toBe(200);
        expect(res.body.lines.length).toBe(3);
        expect(res.body.lines.filter((l) => l.dryRun)).toHaveLength(1);
        expect(res.body.totalCents).toBeGreaterThan(0);
    });

    it('charges a dry run per item, because Addendum 1 says per item', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        const dry = res.body.lines.find((l) => l.dryRun);
        expect(dry.items).toBe(3);
        expect(dry.dryRunCents).toBeGreaterThan(0);
    });

    it('carries no patient name and no street address', async () => {
        /* An invoice goes to a finance team, who need the date, the reference
           and the charge. The ZIP is there to justify the zone; a ZIP with no
           name and no street is not a patient. */
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        const blob = JSON.stringify(res.body);
        expect(blob).not.toMatch(/Recipient \d/);
        expect(blob).not.toContain('Test Street');
        expect(res.body.lines[0].deliveryZip).toMatch(/^\d{5}$/);
        expect(res.body.lines[0].reference).toMatch(/^RX-/);
    });

    it('says out loud that it is still moving', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(res.body.status).toBe('draft');
        expect(res.body.recomputes).toBe(true);
    });

    it('recomputes when a delivery in the period changes', async () => {
        const before = (await admin.get(`${INVOICES}/${invoice.id}`)).body.totalCents;
        await billable('delivered');
        const after = (await admin.get(`${INVOICES}/${invoice.id}`)).body.totalCents;
        expect(after).toBeGreaterThan(before);
    });

    it('groups by zone and by service type', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(res.body.byZone.length).toBeGreaterThan(0);
        expect(res.body.byServiceType.map((t) => t.serviceType)).toContain('scheduled');
        const summed = res.body.byZone.reduce((n, z) => n + z.cents, 0);
        expect(summed).toBe(res.body.subtotalCents);
    });
});

describe('the period', () => {
    it('will not bill a period that is not over', async () => {
        const today = (await admin.get('/api/projects/uh/uh/board')).body.serviceDate;
        const res = await admin.post(INVOICES).send({ from: today, to: today });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invoice.periodNotClosed');
    });

    it('will not open a second invoice over the same days', async () => {
        // Two invoices covering one delivery is how a client gets billed twice.
        const res = await admin.post(INVOICES).send({ from: '2026-06-03', to: '2026-06-10' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.overlaps');
    });

    it('allows a period next to an existing one', async () => {
        const res = await admin.post(INVOICES).send({ from: '2026-06-08', to: '2026-06-14' });
        expect(res.status).toBe(201);
    });
});

/* ------------------------------------------------------------- exceptions */

describe('a delivery that cannot be priced', () => {
    let invoice;
    beforeAll(async () => {
        // Out of area: no zone, and no mileage until ticket 1.9 exists.
        await billable('delivered', { serviceDate: '2026-07-06', zip: '78006' });
        await billable('delivered', { serviceDate: '2026-07-06' });
        invoice = await draft({ from: '2026-07-06', to: '2026-07-12' });
    });

    it('is listed as an exception, not billed at zero', async () => {
        /* Billing it at zero would quietly under-charge us while looking
           settled, which is the worst of both. */
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(res.body.exceptions).toHaveLength(1);
        expect(res.body.exceptions[0].reason).toMatch(/mileage/i);
        /* The road distance needs a geocoder that may be sent a delivery
           address, which Google Maps may not be. Ticket 1.9. */
        expect(res.body.exceptions[0].reason).toMatch(/1\.9/);
        expect(res.body.lines).toHaveLength(1);
    });

    it('refuses to be issued until somebody decides what to do about it', async () => {
        const res = await admin.post(`${INVOICES}/${invoice.id}/issue`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.unpriceable');
        expect(res.body.exceptions).toHaveLength(1);
    });

    it('can be issued without it once that is said explicitly, and records it', async () => {
        const res = await admin.post(`${INVOICES}/${invoice.id}/issue`).send({ excludeUnpriceable: true });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.status).toBe('issued');
        expect(res.body.excludedCount).toBe(1);
        expect(res.body.excludedNote).toMatch(/could not be priced/);
        // Reads properly for one as well as for many.
        expect(res.body.excludedNote).toMatch(/^1 delivery could not be priced and was left off/);
    });
});

/* ----------------------------------------------------------- issuing */

describe('issuing', () => {
    let invoice;
    let order;
    beforeAll(async () => {
        order = await billable('delivered', { serviceDate: '2026-08-03' });
        invoice = await draft({ from: '2026-08-03', to: '2026-08-09' });
    });

    it('freezes the lines, so a later change cannot move a sent total', async () => {
        const issued = await admin.post(`${INVOICES}/${invoice.id}/issue`).send({});
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
        const total = issued.body.totalCents;
        expect(total).toBeGreaterThan(0);
        expect(issued.body.recomputes).toBe(false);

        // A delivery lands in the period afterwards, as a late event would.
        await billable('delivered', { serviceDate: '2026-08-04' });
        const again = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(again.body.totalCents).toBe(total);
        expect(again.body.lines).toHaveLength(1);
    });

    it('cannot be issued twice', async () => {
        const res = await admin.post(`${INVOICES}/${invoice.id}/issue`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.notDraft');
    });

    it('refuses a period with nothing billable in it', async () => {
        const empty = await draft({ from: '2019-01-01', to: '2019-01-07' });
        const res = await admin.post(`${INVOICES}/${empty.id}/issue`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.empty');
    });

    it('moves to paid only from issued', async () => {
        const paid = await admin.post(`${INVOICES}/${invoice.id}/paid`).send({});
        expect(paid.status).toBe(200);
        expect(paid.body.status).toBe('paid');
        expect(paid.body.paidAt).toBeTruthy();

        const again = await admin.post(`${INVOICES}/${invoice.id}/paid`).send({});
        expect(again.status).toBe(409);
    });

    it('is voided with a reason, never deleted', async () => {
        /* A missing invoice number is a question nobody can answer a year
           later, so the number stays used and the reason stays on it. */
        const res = await admin.post(`${INVOICES}/${invoice.id}/void`).send({ reason: 'Superseded by a corrected invoice' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'void', voidReason: 'Superseded by a corrected invoice' });
        expect((await sql('SELECT number FROM invoices WHERE id = ?', [invoice.id])).rows).toHaveLength(1);
    });

    it('needs a reason to void', async () => {
        const other = await draft({ from: '2026-08-10', to: '2026-08-16' });
        const res = await admin.post(`${INVOICES}/${other.id}/void`).send({});
        expect(res.status).toBe(400);
    });
});

/* -------------------------------------------------------- adjustments */

describe('an adjustment', () => {
    let invoice;
    beforeAll(async () => {
        await billable('delivered', { serviceDate: '2026-08-17' });
        invoice = await draft({ from: '2026-08-17', to: '2026-08-23' });
    });

    it('needs a reason attached', async () => {
        const res = await admin.post(`${INVOICES}/${invoice.id}/adjustments`).send({ description: 'Goodwill', amount: -25 });
        expect(res.status).toBe(400);
        expect(res.body.details.join(' ')).toMatch(/reason/);
    });

    it('changes the total and stays visible on the invoice', async () => {
        const before = (await admin.get(`${INVOICES}/${invoice.id}`)).body.totalCents;
        const res = await admin.post(`${INVOICES}/${invoice.id}/adjustments`).send({
            description: 'Goodwill credit', amount: -25, reason: 'Late delivery on 2026-08-18 agreed with Karthik',
        });
        expect(res.status).toBe(201);
        expect(res.body.totalCents).toBe(before - 2500);
        expect(res.body.adjustments[0]).toMatchObject({ amountCents: -2500, reason: expect.stringContaining('Karthik') });
    });

    it('can be removed while the invoice is a draft, and not afterwards', async () => {
        const withAdjustment = await admin.get(`${INVOICES}/${invoice.id}`);
        const adjustmentId = withAdjustment.body.adjustments[0].id;

        const removed = await admin.delete(`${INVOICES}/${invoice.id}/adjustments/${adjustmentId}`);
        expect(removed.status).toBe(200);
        expect(removed.body.adjustments).toHaveLength(0);

        await admin.post(`${INVOICES}/${invoice.id}/adjustments`).send({
            description: 'Goodwill credit', amount: -25, reason: 'Agreed with Karthik',
        });
        await admin.post(`${INVOICES}/${invoice.id}/issue`).send({});
        const after = await admin.get(`${INVOICES}/${invoice.id}`);
        const stuck = await admin.delete(`${INVOICES}/${invoice.id}/adjustments/${after.body.adjustments[0].id}`);
        expect(stuck.status).toBe(409);
        expect(stuck.body.code).toBe('invoice.notDraft');
    });

    it('survives issuing, and is part of the frozen total', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(res.body.status).toBe('issued');
        expect(res.body.adjustments).toHaveLength(1);
        expect(res.body.totalCents).toBe(res.body.subtotalCents - 2500);
    });
});

/* ------------------------------------------------------------ access */

describe('who may bill', () => {
    it('lets a dispatcher read an invoice but not create or issue one', async () => {
        const dee = srv.agent();
        await dee.post('/api/login').send({ username: 'dee.dispatcher', password: 'dispatch-pass-1' });
        expect((await dee.get(INVOICES)).status).toBe(200);
        expect((await dee.post(INVOICES).send({ from: FROM, to: TO })).status).toBe(403);
    });

    it('keeps couriers and the client out entirely', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.get(INVOICES)).status).toBe(403);

        await admin.post('/api/users').send({ username: 'uh.finance', name: 'Finance Person', password: 'client-pass-1', role: 'staff' });
        await admin.put('/api/users/uh.finance/memberships/uh').send({ role: 'client_viewer', settings: { siteIds: [discharge.id] } });
        const uh = srv.agent();
        await uh.post('/api/login').send({ username: 'uh.finance', password: 'client-pass-1' });
        /* The client receives an invoice from us as a document somebody has
           checked, not from an endpoint that could show them a draft. */
        expect((await uh.get(INVOICES)).status).toBe(403);
    });
});

/* --------------------------------------------------------- documents */

describe('the documents', () => {
    let invoice;
    beforeAll(async () => {
        await billable('delivered', { serviceDate: '2026-08-24', serviceType: 'stat' });
        await billable('failed', { serviceDate: '2026-08-25', quantity: 2 });
        invoice = await draft({ from: '2026-08-24', to: '2026-08-30' });
        await admin.post(`${INVOICES}/${invoice.id}/adjustments`).send({
            description: 'Fuel credit', amount: -10, reason: 'Agreed for the period',
        });
        await admin.post(`${INVOICES}/${invoice.id}/issue`).send({});
    });

    it('exports a workbook with a line per delivery and a total that adds up', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}/invoice.xlsx`).buffer(true).parse(asBuffer);
        expect(res.status).toBe(200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        expect(wb.worksheets.map((w) => w.name)).toEqual(['Invoice', 'Summary']);

        const sheet = wb.getWorksheet('Invoice');
        const rows = [];
        sheet.eachRow((row) => rows.push(row.values));
        const total = rows.find((r) => r.includes('Total'));
        const detail = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(total[total.length - 1]).toBeCloseTo(detail.body.total, 2);
    });

    it('renders a PDF a reader can open, with the total on it', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        const body = Buffer.from(res.body).toString('latin1');
        expect(body.startsWith('%PDF-1.4')).toBe(true);
        expect(body.trimEnd().endsWith('%%EOF')).toBe(true);

        const text = pdfText(body);
        const detail = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(text).toContain(detail.body.number);
        expect(text).toContain('Total');
        expect(text).toMatch(/Fuel credit/);
        // No patient data on a document that goes to accounts payable.
        expect(text).not.toMatch(/Recipient \d/);
        expect(text).not.toContain('Test Street');
    });

    it('paginates rather than running off the page', () => {
        /* A month of a nine-pharmacy contract is thousands of lines. Fifty is
           enough to prove the break happens and the totals still land. */
        const lines = Array.from({ length: 120 }, (_, i) => ({
            orderId: i + 1, serviceDate: '2026-08-24', reference: `RX-${i}`, pharmacy: 'Discharge Pharmacy',
            deliveryZip: '78215', zone: 1, serviceType: 'scheduled', dryRun: false, items: 1,
            baseCents: 1250, statCents: 0, afterHoursCents: 0, dryRunCents: 0,
            outOfAreaMiles: null, outOfAreaCents: 0, amountCents: 1250, note: '',
        }));
        const pdf = renderInvoice({
            number: 'IZY-UH-2026-08-0001', status: 'issued', periodFrom: '2026-08-24', periodTo: '2026-08-30',
            lines, adjustments: [], byZone: [{ zone: 'zone 1', count: 120, cents: 150000 }],
            byServiceType: [{ serviceType: 'scheduled', count: 120, cents: 150000 }],
            dryRuns: { count: 0, items: 0, cents: 0 },
            subtotalCents: 150000, totalCents: 150000, excludedCount: 0, excludedNote: '', notes: '',
            issuedAt: '2026-09-01T12:00:00.000Z',
        });
        const body = pdf.toString('latin1');
        expect(body).toMatch(/\/Count [2-9]/);
        const text = pdfText(body);
        expect(text).toContain('Page 1 of');
        expect(text).toContain('(continued)');
        expect(text).toContain('$1,500.00');
    });

    it('says when a pharmacy name was too long for its column', () => {
        // A silently cut name is a line somebody has to go and look up.
        const pdf = renderInvoice({
            number: 'IZY-UH-2026-08-0002', status: 'issued', periodFrom: '2026-08-24', periodTo: '2026-08-30',
            lines: [{
                orderId: 1, serviceDate: '2026-08-24', reference: 'RX-1',
                pharmacy: 'University Health Medical Center Pavilion Pharmacy',
                deliveryZip: '78229', zone: 1, serviceType: 'scheduled', dryRun: false, items: 1,
                baseCents: 1250, statCents: 0, afterHoursCents: 0, dryRunCents: 0,
                outOfAreaMiles: null, outOfAreaCents: 0, amountCents: 1250, note: '',
            }],
            adjustments: [], byZone: [], byServiceType: [],
            dryRuns: { count: 0, items: 0, cents: 0 },
            subtotalCents: 1250, totalCents: 1250, excludedCount: 0, excludedNote: '', notes: '',
            issuedAt: '2026-09-01T12:00:00.000Z',
        });
        expect(pdfText(pdf.toString('latin1'))).toMatch(/University Health Medical Center\.\.\./);
    });

    it('marks a draft as a draft on the document itself', async () => {
        const stillDraft = await draft({ from: '2026-08-31', to: '2026-09-06' });
        const res = await admin.get(`${INVOICES}/${stillDraft.id}/invoice.pdf`);
        const text = pdfText(Buffer.from(res.body).toString('latin1'));
        expect(text).toContain('DRAFT');
        expect(text).toMatch(/draft, not issued/);
    });

    it('is never cached', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf`);
        expect(res.headers['cache-control']).toMatch(/no-store/);
    });
});
