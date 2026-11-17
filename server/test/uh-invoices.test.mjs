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


/* What the renderer now needs beyond the money: who the document is
   addressed to, the references University Health quote back, and the rate
   card the attachment states. Held on the project in real life -- this
   repository is public -- so the test supplies its own. */
const DOC = {
    billing: {
        billToName: 'Test Hospital',
        billToLines: ['Attn: Accounts Payable', '1 Test Plaza', 'San Antonio, TX 78229'],
        contractNo: 'TEST-CONTRACT-1',
        poNo: 'TEST-PO-1',
        rfp: 'TEST-RFP-1',
        terms: 'Per contract TEST-CONTRACT-1',
        taxNote: 'Tax exempt - no tax charged',
        remitToName: 'Izy Global Services LLC',
        remitToLines: ['12411 King Olaf Dr', 'Houston, TX 77044'],
        letterhead: ['12411 King Olaf Dr, Houston, TX 77044', 'contracts@izyglobalservices.com'],
    },
    rates: {
        zone: { 1: 12.5, 2: 14.5, 3: 22, 4: 36, 5: 52 },
        stat: 22,
        afterHours: 18,
        dryRun: 9,
        outOfAreaPerMile: 1.95,
    },
};

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
    await admin.put('/api/users/dee.dispatcher/memberships/uh').send({ role: 'admin', settings: {} });
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
        const far = await billable('delivered', { serviceDate: '2026-07-06', zip: '78006' });
        /* Authorised first, because Addendum 2 clause 9 makes that a
           precondition and an unauthorised line is held back whatever its
           mileage. This test is about the missing distance, so the earlier
           gate has to be satisfied for it to be reached at all. */
        await admin.post(`${ORDERS}/${far.id}/out-of-area`).send({
            authorisedBy: 'Jason Wong', reference: 'Email 6 Jul',
        });
        await billable('delivered', { serviceDate: '2026-07-06' });
        invoice = await draft({ from: '2026-07-06', to: '2026-07-12' });
    });

    it('is listed as an exception, not billed at zero', async () => {
        /* Billing it at zero would quietly under-charge us while looking
           settled, which is the worst of both. */
        const res = await admin.get(`${INVOICES}/${invoice.id}`);
        expect(res.body.exceptions).toHaveLength(1);
        expect(res.body.exceptions[0].reason).toMatch(/no distance was recorded at the door/);
        /* No automatic road distance is coming: a patient address may not be
           sent to the geocoder this system has. So the message names the
           person who resolves it and what they can do, rather than a ticket
           they are not waiting on. */
        expect(res.body.exceptions[0].reason).toMatch(/Add the miles as an adjustment/);
        expect(res.body.exceptions[0].reason).not.toMatch(/ticket|1\.9/i);
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
    it('lets an admin create and issue, which a dispatcher could not do before', async () => {
        /* Billing used to be an ops manager's: a dispatcher could read an
           invoice and was refused creating or issuing one. Ticket 5.12 merged
           the two roles, so whoever works the board can now also open a
           billing period and issue it. That widening is the price of the
           consolidation and this is the test that says so out loud. */
        const dee = srv.agent();
        await dee.post('/api/login').send({ username: 'dee.dispatcher', password: 'dispatch-pass-1' });
        expect((await dee.get(INVOICES)).status).toBe(200);
        /* 201 for a new period, 409 for one this file already drafted. What
           matters is that it is no longer 403: the refusal is now about the
           billing period, not about who is asking. */
        const opened = await dee.post(INVOICES).send({ from: FROM, to: TO });
        expect(opened.status).not.toBe(403);
        expect([201, 409]).toContain(opened.status);
    });

    it('keeps couriers and the client out entirely', async () => {
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.get(INVOICES)).status).toBe(403);

        await admin.post('/api/users').send({ username: 'uh.finance', name: 'Finance Person', password: 'client-pass-1', role: 'staff' });
        await admin.put('/api/users/uh.finance/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });
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

    it('paginates the detailed document rather than running off the page', () => {
        /* A month of a nine-pharmacy contract is thousands of lines. Fifty is
           enough to prove the break happens and the totals still land.
           `detail: 'lines'` because the STANDARD invoice is the summary and
           has no per-delivery table to break. */
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
            issuedAt: '2026-09-01T12:00:00.000Z', timezone: 'America/Chicago', ...DOC,
        }, new Date(), { detail: 'lines' });
        const body = pdf.toString('latin1');
        expect(body).toMatch(/\/Count [2-9]/);
        const text = pdfText(body);
        /* Every page is numbered in the footer now; "(continued)" went
           with the old running header. Page 3 because the detailed
           document is the invoice, Attachment 1, then the deliveries. */
        expect(text).toContain('Page 1 of');
        expect(text).toMatch(/Page 3 of \d/);
        expect(text).toContain('$1,500.00');
    });

    it('dates the issue in the contract timezone, not in UTC', () => {
        /* An invoice issued at 8:05 PM in Chicago used to print the following
           day's date in its footer, because the renderer sliced the first ten
           characters off a UTC ISO string. It is a date on a document sent to
           University Health. Found by walking docs/day-rehearsal.md. */
        const pdf = renderInvoice({
            number: 'IZY-UH-2026-09-0001', status: 'issued', periodFrom: '2026-09-01', periodTo: '2026-09-13',
            lines: [], adjustments: [], byZone: [], byServiceType: [],
            dryRuns: { count: 0, items: 0, cents: 0 },
            subtotalCents: 0, totalCents: 0, excludedCount: 0, excludedNote: '', notes: '',
            issuedAt: '2026-09-15T01:05:00.000Z',
            timezone: 'America/Chicago', ...DOC,
        });
        const text = pdfText(pdf.toString('latin1'));
        /* 01:05 UTC on the 15th is 8:05pm on the 14th in Chicago, and the
           date on a document sent to a hospital is their date. Written out
           in full now, under "Invoice Date", rather than as an ISO string
           in the footer. */
        expect(text).toContain('September 14, 2026');
        expect(text).not.toContain('September 15, 2026');
    });

    it('says when a pharmacy name was too long for its column', () => {
        // A silently cut name is a line somebody has to go and look up.
        // Only the detailed document has a column to be too long for.
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
            issuedAt: '2026-09-01T12:00:00.000Z', timezone: 'America/Chicago', ...DOC,
        }, new Date(), { detail: 'lines' });
        expect(pdfText(pdf.toString('latin1'))).toMatch(/University Health Medical Center\.\.\./);
    });

    it('marks a draft as a draft on the document itself', async () => {
        const stillDraft = await draft({ from: '2026-08-31', to: '2026-09-06' });
        const res = await admin.get(`${INVOICES}/${stillDraft.id}/invoice.pdf`);
        const text = pdfText(Buffer.from(res.body).toString('latin1'));
        /* Top right, where the status sits on the new template. The
           footer now carries the invoice and contract references, which a
           hospital's accounts payable quote back, rather than our own note
           about what stage it is at. */
        expect(text).toContain('DRAFT');
    });

    it('is never cached', async () => {
        const res = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf`);
        expect(res.headers['cache-control']).toMatch(/no-store/);
    });
});

/* ───────────────────────────── pricing a range without billing for it
 *
 * Asked for on 16 November: "allow Admin export Invoice for any Date range
 * at will. currently it is a little bit gated."
 *
 * The gates are real and both of them earn their place -- a period that
 * includes today bills a day still being worked, and two invoices across one
 * delivery is how a hospital is charged twice. But they were gating the
 * wrong verb. Until now the only way to SEE what a range came to was to open
 * an invoice for it, so "what is Wheatley at so far this month" was refused
 * as though somebody had tried to bill for it.
 *
 * So this prices anything and bills nothing. The tests that matter are the
 * last two: that no invoice appears behind it, and that the file says on its
 * face it is not one.
 */
describe('exporting a range that is not an invoice', () => {
    const EXPORT = `${INVOICES}/export.xlsx`;

    const sheetsOf = async (res) => {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        return wb;
    };

    it('prices a range that an existing invoice already covers', async () => {
        /* POST would answer 409 here. The whole point: asking what a period
           came to is not an attempt to bill it a second time. */
        const clash = await admin.post(INVOICES).send({ from: FROM, to: TO });
        expect(clash.status, 'the period really is already invoiced').toBe(409);

        const res = await admin.get(`${EXPORT}?from=${FROM}&to=${TO}`).buffer().parse(asBuffer);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    });

    it('prices a period that is not over, including today', async () => {
        const today = (await admin.get('/api/projects/uh/uh/board')).body.serviceDate;
        const res = await admin.get(`${EXPORT}?from=${today}&to=${today}`).buffer().parse(asBuffer);
        expect(res.status, 'periodNotClosed must not apply to a question').toBe(200);
    });

    it('raises no invoice and reserves no number', async () => {
        /* THE ONE THAT WOULD COST MONEY IF IT WERE WRONG. An export that
           quietly opened a draft would consume an invoice number and start
           overlapping every real invoice after it. */
        const before = (await admin.get(INVOICES)).body;
        await admin.get(`${EXPORT}?from=2026-07-01&to=2026-07-31`).buffer().parse(asBuffer);
        const after = (await admin.get(INVOICES)).body;
        expect(after.invoices.length).toBe(before.invoices.length);
    });

    it('says on the file that it is not a bill', async () => {
        /* A spreadsheet of priced deliveries is one forward away from being
           read as an invoice by somebody in a finance team. */
        const res = await admin.get(`${EXPORT}?from=${FROM}&to=${TO}`).buffer().parse(asBuffer);
        const wb = await sheetsOf(res);
        const summary = wb.getWorksheet('Summary');
        const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ');
        expect(text).toMatch(/NOT AN INVOICE/);
        expect(text).toMatch(/no invoice number is reserved/);
        /* And it carries no invoice number anywhere, because it has none. */
        expect(text).not.toMatch(/Invoice UH-/);
    });

    it('carries the same priced lines an invoice would', async () => {
        const res = await admin.get(`${EXPORT}?from=${FROM}&to=${TO}`).buffer().parse(asBuffer);
        const wb = await sheetsOf(res);
        const deliveries = wb.getWorksheet('Deliveries');
        expect(deliveries.rowCount, 'a header and at least one delivery').toBeGreaterThan(1);
        expect(deliveries.getRow(1).values).toContain('Service date');
        expect(deliveries.getRow(1).values).toContain('Amount');
    });

    it('narrows to one pharmacy', async () => {
        const res = await admin
            .get(`${EXPORT}?from=${FROM}&to=${TO}&siteId=${discharge.id}`)
            .buffer().parse(asBuffer);
        expect(res.status).toBe(200);
    });

    it('refuses a range longer than a year, naming the limit', async () => {
        /* Not a policy gate: buildDraft prices every delivery one by one and
           past a year it outlives the connection. A refusal that says so
           beats a 522 that says nothing. */
        const res = await admin.get(`${EXPORT}?from=2026-01-01&to=2027-12-31`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('export.rangeTooLong');
        expect(res.body.maxDays).toBe(366);
    });

    it('refuses a backwards range and a missing one', async () => {
        expect((await admin.get(`${EXPORT}?from=2026-06-07&to=2026-06-01`)).status).toBe(400);
        expect((await admin.get(`${EXPORT}?from=2026-06-01`)).body.code).toBe('export.datesMissing');
        expect((await admin.get(`${EXPORT}?from=nope&to=2026-06-01`)).body.code).toBe('export.datesMissing');
    });

    it('is behind the same door as the invoices themselves', async () => {
        /* Every priced line for a range, which is the commercial position in
           one file. A courier is refused the invoice list and must be
           refused this for the same reason -- otherwise the new route is a
           way around the old permission. */
        const ada = srv.agent();
        await ada.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        expect((await ada.get(INVOICES)).status, 'the invoice list refuses a courier').toBe(403);
        expect((await ada.get(`${EXPORT}?from=${FROM}&to=${TO}`)).status).toBe(403);

        /* And the client, who receives a checked document from us rather
           than an endpoint that prices their own deliveries on demand. */
        const uh = srv.agent();
        await uh.post('/api/login').send({ username: 'uh.finance', password: 'client-pass-1' });
        expect((await uh.get(`${EXPORT}?from=${FROM}&to=${TO}`)).status).toBe(403);
    });

    it('is never cached', async () => {
        const res = await admin.get(`${EXPORT}?from=${FROM}&to=${TO}`).buffer().parse(asBuffer);
        expect(res.headers['cache-control']).toMatch(/no-store/);
    });
});

describe('deleting an invoice', () => {
    /* Void stays the answer for anything University Health has seen. What
       this is for is the invoice opened on the wrong dates and noticed a
       minute later: nobody has seen it, no figure was sent, and voiding it
       leaves a permanent row whose only content is that somebody mistyped. */

    it('removes a draft nobody ever saw, with no reason needed', async () => {
        await billable('delivered', { serviceDate: '2026-10-01' });
        const invoice = await draft({ from: '2026-10-01', to: '2026-10-04' });

        const res = await admin.delete(`${INVOICES}/${invoice.id}`).send({});
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.number).toBe(invoice.number);

        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(404);
    });

    it('frees the period, so the month can be billed properly afterwards', async () => {
        /* The whole point. An overlapping draft blocks a correct invoice
           for the same dates, and until now the only way past it was to
           void it and leave it in the list for ever. */
        await billable('delivered', { serviceDate: '2026-10-05' });
        const wrong = await draft({ from: '2026-10-05', to: '2026-10-11' });

        const blocked = await admin.post(INVOICES).send({ from: '2026-10-05', to: '2026-10-11' });
        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('invoice.overlaps');

        await admin.delete(`${INVOICES}/${wrong.id}`).send({});

        const again = await admin.post(INVOICES).send({ from: '2026-10-05', to: '2026-10-11' });
        expect(again.status, JSON.stringify(again.body)).toBe(201);
    });

    it('refuses once it has been issued, and says to void it instead', async () => {
        /* A figure that has been sent has to stay answerable. This is the
           line the whole route is drawn around. */
        await billable('delivered', { serviceDate: '2026-10-12' });
        const invoice = await draft({ from: '2026-10-12', to: '2026-10-18' });
        const issued = await admin.post(`${INVOICES}/${invoice.id}/issue`).send({ excludeUnpriceable: true });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);

        const res = await admin.delete(`${INVOICES}/${invoice.id}`).send({ reason: 'opened on the wrong dates entirely' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.issued');
        expect(res.body.error).toMatch(/[Vv]oid it instead/);

        // And it is still there.
        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(200);
    });

    it('refuses an invoice that was issued and then voided', async () => {
        /* Void does not make it deletable again: the number went out. The
           test is issued_at, not the status word. */
        await billable('delivered', { serviceDate: '2026-10-19' });
        const invoice = await draft({ from: '2026-10-19', to: '2026-10-25' });
        await admin.post(`${INVOICES}/${invoice.id}/issue`).send({ excludeUnpriceable: true });
        const voided = await admin.post(`${INVOICES}/${invoice.id}/void`).send({ reason: 'Billed to the wrong pharmacy' });
        expect(voided.status, JSON.stringify(voided.body)).toBe(200);

        const res = await admin.delete(`${INVOICES}/${invoice.id}`).send({ reason: 'tidying the list up for the quarter' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.issued');
    });

    it('makes a draft carrying adjustments say why, because that money is nowhere else', async () => {
        await billable('delivered', { serviceDate: '2026-10-26' });
        const invoice = await draft({ from: '2026-10-26', to: '2026-10-31' });
        await admin.post(`${INVOICES}/${invoice.id}/adjustments`).send({
            description: 'Goodwill credit', amount: -25, reason: 'Late delivery agreed on the telephone',
        });

        const bare = await admin.delete(`${INVOICES}/${invoice.id}`).send({});
        expect(bare.status).toBe(409);
        expect(bare.body.code).toBe('invoice.hasAdjustments');
        expect(bare.body.adjustments).toBe(1);

        const said = await admin.delete(`${INVOICES}/${invoice.id}`)
            .send({ reason: 'Opened against the wrong pharmacy, reissuing against Wheatley' });
        expect(said.status, JSON.stringify(said.body)).toBe(200);
        expect(said.body.deleted.adjustments).toBe(1);
    });

    it('takes the adjustments and lines with it, leaving nothing pointing at it', async () => {
        await billable('delivered', { serviceDate: '2026-05-18' });
        const invoice = await draft({ from: '2026-05-18', to: '2026-05-24' });
        await admin.post(`${INVOICES}/${invoice.id}/adjustments`).send({
            description: 'Credit', amount: -10, reason: 'Agreed with the contract manager',
        });

        await admin.delete(`${INVOICES}/${invoice.id}`).send({ reason: 'Duplicate of the invoice already open' });

        const adj = await sql('SELECT COUNT(*) AS n FROM invoice_adjustments WHERE invoice_id = ?', [invoice.id]);
        const lines = await sql('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?', [invoice.id]);
        expect(Number(adj.rows[0].n)).toBe(0);
        expect(Number(lines.rows[0].n)).toBe(0);
    });

    it('leaves the number answerable in the audit trail', async () => {
        /* The row is gone and its number shows as a gap in the month's
           sequence. This line is the only thing that can answer it. */
        await billable('delivered', { serviceDate: '2026-05-25' });
        const invoice = await draft({ from: '2026-05-25', to: '2026-05-31' });

        await admin.delete(`${INVOICES}/${invoice.id}`).send({ reason: 'Wrong period, reopening for June' });

        const trail = await sql(
            "SELECT * FROM audit_events WHERE action = 'invoice.delete' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [invoice.number],
        );
        const row = trail.rows[0];
        expect(row, 'no audit row for the deleted invoice').toBeTruthy();
        const meta = JSON.parse(String(row.detail ?? "{}"));
        expect(meta.permanent).toBe(true);
        expect(meta.wasIssued).toBe(false);
        expect(meta.periodFrom).toBe('2026-05-25');
        expect(meta.reason).toMatch(/Wrong period/);
    });

    it('is not a dispatcher’s to do', async () => {
        await billable('delivered', { serviceDate: '2026-11-02' });
        const invoice = await draft({ from: '2026-11-02', to: '2026-11-08' });

        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'ada.courier', password: 'courier-pass-1' });
        const res = await courier.delete(`${INVOICES}/${invoice.id}`).send({});
        expect(res.status).toBe(403);

        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(200);
    });
});

describe('deleting an invoice that has been issued', () => {
    /* Opened on 17 November. The refusal it replaced did not protect an
       invoice that had been SENT -- nothing here can tell that from one
       issued by somebody checking the screen worked -- it only stranded the
       mistake in the list that is meant to be the record of what we billed.
       The protection is now the number typed back and a reason. */

    const issuedOne = async (from, to, serviceDate) => {
        await billable('delivered', { serviceDate });
        const invoice = await draft({ from, to });
        const issued = await admin.post(`${INVOICES}/${invoice.id}/issue`).send({ excludeUnpriceable: true });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
        return invoice;
    };

    it('refuses without the number typed back, and says what it would destroy', async () => {
        const invoice = await issuedOne('2026-06-15', '2026-06-21', '2026-06-16');

        const res = await admin.delete(`${INVOICES}/${invoice.id}`)
            .send({ reason: 'Opened against the wrong pharmacy entirely' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invoice.issued');
        expect(res.body.confirmWith).toBe(invoice.number);
        /* The total is in the refusal because it is the figure that makes a
           person stop and check they have the right row. */
        expect(res.body.totalCents).toBeGreaterThan(0);
        expect(res.body.error).toMatch(/void it instead/i);
        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(200);
    });

    it('refuses the wrong number, which is the point of typing it', async () => {
        const invoice = await issuedOne('2026-06-22', '2026-06-28', '2026-06-23');

        const res = await admin.delete(`${INVOICES}/${invoice.id}`)
            .send({ confirm: 'IZY-UH-2026-10-9999', reason: 'Opened against the wrong pharmacy entirely' });

        expect(res.status).toBe(409);
        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(200);
    });

    it('refuses the right number with no reason', async () => {
        const invoice = await issuedOne('2026-06-29', '2026-07-05', '2026-06-30');

        const res = await admin.delete(`${INVOICES}/${invoice.id}`).send({ confirm: invoice.number });

        expect(res.status).toBe(409);
        expect(res.body.reasonMin).toBe(10);
        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(200);
    });

    it('deletes it when both are given', async () => {
        const invoice = await issuedOne('2026-07-13', '2026-07-19', '2026-07-14');

        const res = await admin.delete(`${INVOICES}/${invoice.id}`)
            .send({ confirm: invoice.number, reason: 'Issued by mistake while checking the screen' });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await admin.get(`${INVOICES}/${invoice.id}`)).status).toBe(404);
    });

    it('frees the period it covered', async () => {
        const invoice = await issuedOne('2026-07-20', '2026-07-26', '2026-07-21');
        const blocked = await admin.post(INVOICES).send({ from: '2026-07-20', to: '2026-07-26' });
        expect(blocked.status).toBe(409);

        await admin.delete(`${INVOICES}/${invoice.id}`)
            .send({ confirm: invoice.number, reason: 'Wrong dates, reopening for the right week' });

        const again = await admin.post(INVOICES).send({ from: '2026-07-20', to: '2026-07-26' });
        expect(again.status, JSON.stringify(again.body)).toBe(201);
    });

    it('records what it was worth, because that is all that survives', async () => {
        const invoice = await issuedOne('2026-07-27', '2026-08-02', '2026-07-28');
        const before = (await admin.get(`${INVOICES}/${invoice.id}`)).body.totalCents;

        await admin.delete(`${INVOICES}/${invoice.id}`)
            .send({ confirm: invoice.number, reason: 'Issued twice for the same week' });

        const trail = await sql(
            "SELECT * FROM audit_events WHERE action = 'invoice.delete' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [invoice.number],
        );
        const meta = JSON.parse(String(trail.rows[0].detail ?? '{}'));
        expect(meta.wasIssued).toBe(true);
        expect(meta.totalCents).toBe(before);
        expect(meta.issuedAt).not.toBe('');
        expect(meta.reason).toMatch(/Issued twice/);
        expect(meta.permanent).toBe(true);
    });

    it('still takes a never-issued draft with no number typed at all', async () => {
        /* The easy path must not have got harder on the way. */
        await billable('delivered', { serviceDate: '2026-09-08' });
        const invoice = await draft({ from: '2026-09-07', to: '2026-09-13' });

        const res = await admin.delete(`${INVOICES}/${invoice.id}`).send({});

        expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
});

describe('the standard invoice document', () => {
    /* It listed every delivery, always. A fortnight of this contract is
       3,321 lines over about ninety pages, which is not an invoice. */

    it('is the summary, and says where the detail is', async () => {
        await billable('delivered', { serviceDate: '2026-09-15' });
        const invoice = await draft({ from: '2026-09-14', to: '2026-09-20' });

        const res = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf`);
        const text = pdfText(Buffer.from(res.body).toString('latin1'));

        /* The zone table is the body of the invoice now, under
           "Description", and the service-level breakdown sits under it. */
        expect(text).toContain('INVOICE');
        expect(text).toContain('Description');
        expect(text).toContain('By service level');
        expect(text).toContain('TOTAL DUE');
        /* And the attachment that states what each zone was charged at. */
        expect(text).toContain('Attachment 1 - Rates Applied and Summary');
        /* A summary with no word about its backing is the thing a hospital
           telephones about, so it says where the per-delivery list lives.
           Matched against the text with its line breaks collapsed: the
           note is wrapped to the page, so any phrase in it can be split
           across two lines and an assertion that forgets this fails on
           the margin rather than on the meaning. */
        const flat = text.replace(/\s+/g, ' ');
        expect(flat).toMatch(/every delivery listed with date, pharmacy, destination ZIP/);
        expect(flat).toMatch(/spreadsheet/);
    });

    it('leaves the per-delivery table out of it', async () => {
        await billable('delivered', { serviceDate: '2026-09-22', externalRef: 'RX-SUMMARY-1' });
        const invoice = await draft({ from: '2026-09-21', to: '2026-09-27' });

        const summary = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf`);
        const detailed = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf?detail=lines`);

        expect(pdfText(Buffer.from(summary.body).toString('latin1'))).not.toContain('RX-SUMMARY-1');
        expect(pdfText(Buffer.from(detailed.body).toString('latin1'))).toContain('RX-SUMMARY-1');
    });

    it('still carries the totals a hospital has to pay against', async () => {
        await billable('delivered', { serviceDate: '2026-11-16' });
        const invoice = await draft({ from: '2026-11-16', to: '2026-11-16' });
        const view = (await admin.get(`${INVOICES}/${invoice.id}`)).body;

        const res = await admin.get(`${INVOICES}/${invoice.id}/invoice.pdf`);
        const text = pdfText(Buffer.from(res.body).toString('latin1'));

        expect(text).toContain('Total');
        expect(text).toContain(invoice.number);
        expect(text).toContain(`$${view.total.toFixed(2)}`);
    });
});

describe('the invoice template', () => {
    /* Agreed 17 November 2026 from a PDF University Health were shown. The
       document is the invoice on page 1 and the rates behind it on page 2,
       so the arithmetic can be checked without asking us for anything. */

    const render = (over = {}) => renderInvoice({
        number: 'IZY-UH-2026-11-0001', status: 'issued',
        periodFrom: '2026-11-02', periodTo: '2026-11-14',
        lines: [], adjustments: [],
        byZone: [
            { zone: 'zone 1', count: 2280, cents: 3701650 },
            { zone: 'zone 5', count: 4, cents: 21900 },
        ],
        byServiceType: [
            { serviceType: 'scheduled', count: 3312, cents: 6028350 },
            { serviceType: 'stat', count: 7, cents: 27950 },
            { serviceType: 'adhoc', count: 2, cents: 2700 },
        ],
        dryRuns: { count: 308, items: 654, cents: 588600 },
        subtotalCents: 6059000, totalCents: 6059000,
        excludedCount: 0, excludedNote: '', notes: '',
        issuedAt: '2026-11-16T18:00:00.000Z', timezone: 'America/Chicago',
        ...DOC, ...over,
    }, new Date('2026-11-17T12:00:00Z'));

    const textOf = (pdf) => pdfText(pdf.toString('latin1'));

    it('carries the references a hospital quotes back', async () => {
        /* An invoice missing the PO sits in somebody's queue unpaid. */
        const text = textOf(render());
        expect(text).toContain('TEST-PO-1');
        expect(text).toContain('TEST-CONTRACT-1');
        expect(text).toContain('TEST-RFP-1');
        /* And on the foot of every page, which is where a filing clerk
           looks when the first page has been separated from the second. */
        expect(text.match(/TEST-PO-1/g).length).toBeGreaterThan(1);
    });

    it('addresses it to them and remits to us', async () => {
        const text = textOf(render());
        expect(text).toContain('BILL TO');
        expect(text).toContain('Test Hospital');
        expect(text).toContain('FROM / REMIT TO');
        expect(text).toContain('Izy Global Services LLC');
    });

    it('leaves a block out rather than printing an empty reference', async () => {
        /* The defaults are empty because this repository is public, and
           "PO No.:" with nothing after it reads as an omission on our part
           rather than a field nobody has set. */
        const bare = { ...DOC.billing, billToName: '', billToLines: [], poNo: '', contractNo: '', rfp: '' };
        const text = textOf(render({ billing: bare }));

        expect(text).not.toContain('BILL TO');
        expect(text).not.toContain('PO No.');
        expect(text).not.toContain('Contract No.');
        /* Ours still prints: an invoice with no sender on it is useless. */
        expect(text).toContain('FROM / REMIT TO');
        expect(text).toContain('IZY-UH-2026-11-0001');
    });

    it('shows the zero tax line rather than leaving tax unmentioned', async () => {
        /* A reader has to see the exemption was applied on purpose. */
        const text = textOf(render());
        expect(text).toContain('Sales / use tax (exempt)');
        expect(text).toContain('Tax exempt - no tax charged');
        expect(text).toContain('TOTAL DUE');
    });

    it('writes the zones and service levels the way the contract does', async () => {
        /* The rows come back as `zone 1` and `adhoc`, which is right for a
           column name and wrong on a document going to a hospital. */
        const text = textOf(render());
        expect(text).toContain('Zone 1 delivery');
        expect(text).toContain('Scheduled');
        expect(text).toContain('STAT');
        expect(text).toContain('Ad hoc');
        expect(text).not.toContain('adhoc');
    });

    it('states every contract rate on the attachment', async () => {
        /* So page 1 can be checked without asking us for the bid table. */
        const text = textOf(render());
        expect(text).toContain('Attachment 1 - Rates Applied and Summary');
        expect(text).toContain('$12.50');
        expect(text).toContain('$52.00');
        expect(text).toContain('Surcharge (contract, flat per delivery)');
        expect(text).toContain('$22.00');
        expect(text).toContain('$18.00');
        expect(text).toContain('$1.95 / mile');
    });

    it('leaves the rate column off when no schedule covers the period', async () => {
        /* Rather than printing zeroes that look like agreed rates. */
        const text = textOf(render({ rates: null }));
        expect(text).not.toContain('Contract rate per delivery*');
        expect(text).not.toContain('Surcharge (contract, flat per delivery)');
        /* The amounts are still real and still stated. */
        expect(text).toContain('$60,590.00');
    });

    it('collapses a period inside one month, and spells out one that is not', async () => {
        expect(textOf(render())).toContain('November 2 - 14, 2026');
        const across = textOf(render({ periodFrom: '2026-10-28', periodTo: '2026-11-03' }));
        expect(across).toContain('October 28, 2026 - November 3, 2026');
    });

    it('says the undelivered figure is already inside the zone amounts', async () => {
        /* Otherwise it reads as a charge on top and the total looks wrong. */
        const flat = textOf(render()).replace(/\s+/g, ' ');
        expect(flat).toMatch(/Included above: undelivered deliveries priced at the dry run rate/);
        expect(flat).toMatch(/308 deliveries, 654 items, \$5,886\.00/);
        expect(flat).toMatch(/included in the zone amounts above/);
    });

    it('puts no patient on the document, and says so', async () => {
        const flat = textOf(render()).replace(/\s+/g, ' ');
        expect(flat).toMatch(/Patient names and addresses are not shown on invoices or attachments/);
    });
});
