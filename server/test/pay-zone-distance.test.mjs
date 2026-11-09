/* The courier's band is a distance from the pickup. UH's is a ZIP's band.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE STOP THAT STARTED THIS.
 *
 * 9 November: a courier reported a delivery fourteen road miles from the
 * pharmacy showing as zone 1 and paying 5.00. Both halves were true.
 *
 *   78247 IS zone 1. Bid Table BT-89AO says so -- drizzle/0007 seeds it --
 *   every University Health invoice for that ZIP is priced on it, and
 *   Addendum 2 clause 3 forbids pricing a zone 1 ZIP any other way.
 *
 *   AND THE COURIER IS OWED ZONE 2. Their offer letter, section 3, heads
 *   its column "Distance from pickup" and bands 11-25 miles at 7.25.
 *
 * The system had one zone and used it for both. These tests hold the two
 * apart: one stop, two bands, both right, and neither allowed to drift into
 * the other's job.
 *
 * Every name and address here is invented. The ZIP and its UH zone are real
 * reference data from the bid table, which is the point of using them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

/* Real ZIPs with their real bid-table zones, so a change to the seeded map
   breaks these tests rather than silently re-pricing the contract. */
const FAR_ZIP = '78247';     // UH zone 1. Fourteen road miles from Medical Dr.
const NEAR_ZIP = '78215';    // UH zone 1, and genuinely close.
const UNMAPPED_ZIP = '99999'; // On no zone at all: out of area.
const NO_DISTANCE_ZIP = '78216'; // UH zone 1, deliberately left unmeasured.

const DRIVER = 'band.courier';
const DAY = '2026-11-20';

let srv;
let admin;
let db;
let site;
let seq = 0;

/** Rates as the live card holds them, which came from the offer letter. */
const setRates = async (over = {}) => {
    const res = await admin.patch('/api/projects/uh/settings').send({
        driverPay: {
            basis: 'zone',
            perZoneCents: { 1: 500, 2: 725, 3: 1200, 4: 2200, 5: 2800 },
            outOfZoneCents: 2800,
            completionBonusCents: 0,
            completionBonusFrom: null,
            ...over,
        },
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
};

/** A measured distance from our pharmacy to a ZIP, as the script writes it. */
async function measure(zip, miles, basis = 'road', effectiveFrom = '2026-11-01') {
    await db.execute({
        sql: `INSERT INTO site_zip_miles (project_id, site_id, zip, miles, basis, effective_from)
              VALUES ((SELECT id FROM projects WHERE code = 'uh'), ?, ?, ?, ?, ?)`,
        args: [site.id, zip, miles, basis, effectiveFrom],
    });
}

async function order(zip, { deliver = true, fail = false } = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: site.id, serviceType: 'stat', recipientName: `Band Patient ${seq}`,
        addressLine: `${seq} Invented Way`, zip, serviceDate: DAY,
        externalRef: `BAND-${5000 + seq}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const o = created.body;
    if (!deliver) return o;
    await admin.post(RUNS).send({ courierUsername: DRIVER, label: `Band ${seq}`, orderIds: [o.id] });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${o.id}/events`).send(fail
        ? { type: 'attempted', reason: 'nobody_home' }
        : { type: 'delivered', signedName: 'A Patient' });
    return o;
}

const record = async () => (await admin.get(
    `${UH}/drivers/${DRIVER}?from=${DAY}&to=${DAY}&groupBy=day`,
)).body;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    db = srv.core.client;

    site = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge');
    expect(site, 'the discharge counter should be seeded').toBeTruthy();

    await admin.post('/api/users').send({
        username: DRIVER, name: 'Band Courier', password: 'band-pass-11', role: 'driver',
    });
    await admin.put(`/api/users/${DRIVER}/memberships/uh`).send({ role: 'courier', settings: {} });

    /* The measurement the script produces. 14.0 is what the driver read off
       their phone for the stop that started this. */
    await measure(FAR_ZIP, 14.0);
    await measure(NEAR_ZIP, 3.2);
    /* NO_DISTANCE_ZIP deliberately gets no row. */

    await setRates();
});
afterAll(async () => { await srv.stop(); });

describe('one stop, two bands', () => {
    it('is zone 1 to University Health and zone 2 to the courier', async () => {
        const o = await order(FAR_ZIP, { deliver: false });

        /* THE INVOICE IS UNTOUCHED. If this ever stops being 1, a contract
           term has been broken, not a bug introduced. */
        expect(o.zone).toBe(1);

        const row = (await db.execute({
            sql: 'SELECT zone, pay_zone, pay_miles, pay_basis FROM orders WHERE id = ?',
            args: [o.id],
        })).rows[0];
        expect(Number(row.zone)).toBe(1);
        expect(Number(row.pay_zone)).toBe(2);
        expect(Number(row.pay_miles)).toBe(14);
        expect(String(row.pay_basis)).toBe('road');
    });

    it('pays the fourteen-mile stop 7.25, not 5.00', async () => {
        await order(FAR_ZIP);

        const r = await record();
        expect(r.totals.payCents).toBe(725);
        /* And the payslip says which table it means, so the next driver to
           check does not have to ask. */
        expect(r.totals.lines['zone-2'].label).toBe('Zone 2 (11-25 mi)');
        expect(r.totals.lines['zone-1']).toBeUndefined();
    });

    it('still pays a genuinely close stop at zone 1', async () => {
        await order(NEAR_ZIP);

        const r = await record();
        /* 14 mi at 7.25 from the test above, plus 3.2 mi at 5.00. */
        expect(r.totals.payCents).toBe(725 + 500);
        expect(r.totals.lines['zone-1'].label).toBe('Zone 1 (0-10 mi)');
    });
});

describe('the two kinds of nothing', () => {
    /* ── NOT MEASURED IS NOT OUT OF AREA, and it is not nothing either.
     *
     * An unmeasured stop PAYS, at University Health's band, which is what
     * every stop paid on before 9 November. Withholding was tried first and
     * is wrong: the distance table is empty until somebody runs the
     * measuring script, so withholding would have taken every courier's pay
     * to nothing the moment this deployed. The full server suite said so --
     * eight tests, all of them drivers earning nought.
     *
     * So it pays, and it goes on its own line so it can be counted. These
     * are the stops most likely to be underpaid. */
    it('pays an unmeasured stop at the old band and says that is what it did', async () => {
        await order(NO_DISTANCE_ZIP);

        const r = await record();
        const line = r.totals.lines['zone-1-estimated'];
        expect(line, JSON.stringify(r.totals.lines)).toBeDefined();
        expect(line.label).toBe('Zone 1 (distance not measured)');
        /* Paid, at the zone 1 rate, exactly as it was before any of this. */
        expect(line.rateCents).toBe(500);
        expect(line.payCents).toBe(500);
        /* It must NOT have landed on the out-of-area line at 28.00. */
        expect(r.totals.lines['unzoned']).toBeUndefined();
        /* And nothing is withheld. */
        expect(r.totals.rateSet).toBe(true);
    });

    it('still pays a genuinely out-of-area stop the out-of-zone rate', async () => {
        /* Measured or not: this ZIP is on no zone at all, which is what
           outOfZoneCents exists for and is unchanged by any of this. */
        const o = await order(UNMAPPED_ZIP);
        expect(o.zone).toBeNull();

        const row = (await db.execute({
            sql: 'SELECT zone, pay_zone FROM orders WHERE id = ?', args: [o.id],
        })).rows[0];
        expect(row.zone).toBeNull();
        expect(row.pay_zone).toBeNull();

        const r = await record();
        expect(r.totals.lines['unzoned']).toBeDefined();
        expect(r.totals.lines['unzoned'].label).toBe('No zone');
        expect(r.totals.lines['unzoned'].rateCents).toBe(2800);
    });
});

describe('what the courier is shown', () => {
    /* ── THE CHIP THAT CAUSED THE COMPLAINT. The manifest showed `zone`,
     * which is UH's band, to the person paid on a different one. */
    it('puts the pay band and the miles on the run stop, not the billing band', async () => {
        const o = await order(FAR_ZIP, { deliver: false });
        /* The run carries its OWN service date and defaults to today, so it
           has to be told the day these orders are for or /runs/mine looks
           on the wrong date and finds nothing. */
        await admin.post(RUNS).send({
            courierUsername: DRIVER, label: 'Shown', orderIds: [o.id], serviceDate: DAY,
        });

        const courier = srv.agent();
        expect((await courier.post('/api/login')
            .send({ username: DRIVER, password: 'band-pass-11' })).status).toBe(200);

        const mine = await courier.get(`${UH}/runs/mine?serviceDate=${DAY}`);
        expect(mine.status, JSON.stringify(mine.body).slice(0, 300)).toBe(200);

        const stops = (mine.body.runs ?? []).flatMap((r) => r.stops ?? []);
        const shown = stops.find((s) => Number(s.orderId) === Number(o.id));
        expect(shown, JSON.stringify(mine.body).slice(0, 400)).toBeTruthy();

        /* Both are on the payload and they are different numbers. The
           screen reads payZone; the billing zone stays for dispatch. */
        expect(shown.zone).toBe(1);
        expect(shown.payZone).toBe(2);
        expect(shown.payMiles).toBe(14);
    });
});

describe('a band already on an order does not move', () => {
    /* ── THE RULE 0063 SET, KEPT. A re-measure loads beside the old figures
     * and the order keeps what it was created with, so pay that has been
     * settled cannot change because a table was corrected afterwards. */
    it('keeps the band it was created with when the distance is re-measured', async () => {
        const o = await order(NEAR_ZIP, { deliver: false });
        const before = (await db.execute({
            sql: 'SELECT pay_zone, pay_miles FROM orders WHERE id = ?', args: [o.id],
        })).rows[0];
        expect(Number(before.pay_zone)).toBe(1);

        /* Somebody re-measures and it comes out much further. */
        await measure(NEAR_ZIP, 31.5, 'road', '2026-11-25');

        const after = (await db.execute({
            sql: 'SELECT pay_zone, pay_miles FROM orders WHERE id = ?', args: [o.id],
        })).rows[0];
        expect(Number(after.pay_zone)).toBe(1);
        expect(Number(after.pay_miles)).toBe(3.2);

        /* And a NEW order on a later date picks the new figure up. */
        seq += 1;
        const later = await admin.post(ORDERS).send({
            siteId: site.id, serviceType: 'stat', recipientName: `Band Patient ${seq}`,
            addressLine: `${seq} Invented Way`, zip: NEAR_ZIP, serviceDate: '2026-11-26',
            externalRef: `BAND-${5000 + seq}`,
        });
        expect(later.status).toBe(201);
        const row = (await db.execute({
            sql: 'SELECT pay_zone, pay_miles FROM orders WHERE id = ?', args: [later.body.id],
        })).rows[0];
        expect(Number(row.pay_zone)).toBe(3);
        expect(Number(row.pay_miles)).toBe(31.5);
    });
});
