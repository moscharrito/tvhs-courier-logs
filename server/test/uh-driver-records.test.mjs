/* The drivers' record: what each of them delivered, and what it comes to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE FIRST SCREEN IN THE SYSTEM SOMEBODY GETS PAID FROM.
 *
 * So the tests are about the two ways that goes wrong, and neither of them is
 * a crash. One is a figure that is confidently wrong, which somebody pays.
 * The other is a courier reading where every other courier went, which is a
 * list of patient addresses wearing a payslip.
 *
 * Every name and address here is invented. No University Health data enters
 * any environment until the business associate agreements are filed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const DRIVERS = `${UH}/drivers`;
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

let srv;
let admin;
let discharge;
let green;
let day;

const agentFor = async (username, password) => {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password })).status).toBe(200);
    return a;
};

let seq = 0;
/** A delivery, carried all the way to a handover by the named courier. */
async function deliveredBy(courier, over = {}) {
    seq += 1;
    /* stat, not scheduled. The create endpoint accepts only stat and adhoc:
       a one-off order typed in by dispatch is by nature not scheduled, and
       `scheduled` reaches the table through the daily list import, which is
       where the bulk of the contract's orders come from. All three are real
       service levels and all three have a rate. */
    const { siteId = discharge.id, serviceType = 'stat', fail = false, ...rest } = over;
    const created = await admin.post(ORDERS).send({
        siteId, serviceType, recipientName: `Pay Patient ${seq}`,
        addressLine: `${seq} Invented Way`, zip: '78215', serviceDate: day,
        externalRef: `PAY-${7000 + seq}`, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: courier, label: `Run ${seq}`, orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    if (fail) {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'nobody_home' });
    } else {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'A Patient' });
    }
    return order;
}

const setRates = async (perDeliveryCents) => {
    const res = await admin.patch('/api/projects/uh/settings').send({ driverPay: { perDeliveryCents } });
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    day = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    for (const [username, name] of [['pay.ada', 'Ada Pay'], ['pay.bo', 'Bo Pay']]) {
        await admin.post('/api/users').send({ username, name, password: 'pay-pass-11', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }

    /* Ada: two stat to Discharge, one adhoc to Green, one failed. */
    await deliveredBy('pay.ada');
    await deliveredBy('pay.ada');
    await deliveredBy('pay.ada', { siteId: green.id, serviceType: 'adhoc' });
    await deliveredBy('pay.ada', { fail: true });
    /* Bo: one stat. */
    await deliveredBy('pay.bo');
});
afterAll(async () => { await srv.stop(); });

describe('what each driver delivered', () => {
    it('counts the completed deliveries and the failures apart', async () => {
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.delivered).toBe(3);
        expect(ada.failed).toBe(1);
    });

    it('names every driver on the contract, including one who did nothing', async () => {
        /* A payment run that silently omitted somebody who did no work is a
           run nobody can check against the roster. */
        await admin.post('/api/users').send({
            username: 'pay.idle', name: 'Idle Pay', password: 'pay-pass-11', role: 'driver',
        });
        await admin.put('/api/users/pay.idle/memberships/uh').send({ role: 'courier', settings: {} });
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const idle = res.body.drivers.find((d) => d.username === 'pay.idle');
        expect(idle, 'a driver with no deliveries should still be listed').toBeTruthy();
        expect(idle.delivered).toBe(0);
    });

    it('says which pharmacy the work was for, which is what the question asked', async () => {
        const res = await admin.get(`${DRIVERS}/pay.ada?from=${day}&to=${day}`);
        expect(res.status).toBe(200);
        /* Against the seeded names rather than strings typed here: a fixture
           rename should not look like the feature breaking. */
        const names = res.body.periods.flatMap((p) => p.pharmacies.map((x) => x.name));
        expect(names).toContain(discharge.name);
        expect(names).toContain(green.name);
    });

    it('names no patient and no address anywhere in it', async () => {
        /* THE PROPERTY THAT MAKES A PAY RECORD EXPORTABLE. This is the screen
           most likely to be sent to a bookkeeper and opened on a laptop that
           has nothing to do with University Health. */
        const all = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const one = await admin.get(`${DRIVERS}/pay.ada?from=${day}&to=${day}`);
        for (const res of [all, one]) {
            const blob = JSON.stringify(res.body);
            expect(blob).not.toMatch(/Pay Patient/);
            expect(blob).not.toMatch(/Invented Way/);
            expect(blob).not.toMatch(/78215/);
        }
    });
});

describe('what it comes to', () => {
    it('gives no figure at all while the rates are unset', async () => {
        /* THE ONE THAT COSTS MONEY. Nought beside three deliveries reads as
           an answer and somebody quotes it. */
        await setRates({ scheduled: 0, stat: 0, adhoc: 0 });
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.delivered).toBe(3);
        expect(ada.payCents).toBeNull();
        expect(ada.rateSet).toBe(false);
    });

    it('pays per completed delivery once they are set', async () => {
        await setRates({ scheduled: 450, stat: 700, adhoc: 500 });
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        /* Two stat and one adhoc. The failed attempt pays nothing. */
        expect(ada.payCents).toBe(700 + 700 + 500);
    });

    it('refuses a partial total when a level that was worked has no rate', async () => {
        /* Ada worked stat and adhoc. Pricing only stat leaves a figure that
           is plausible, smaller than the truth, and silent about why. */
        await setRates({ scheduled: 450, stat: 700, adhoc: 0 });
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.payCents, 'a plausible short figure is the dangerous answer').toBeNull();
        await setRates({ scheduled: 450, stat: 700, adhoc: 500 });
    });

    it('refuses a rate that is not whole cents, rather than rounding somebody short', async () => {
        const res = await admin.patch('/api/projects/uh/settings')
            .send({ driverPay: { perDeliveryCents: { scheduled: 4.5 } } });
        expect(res.status).toBe(400);
    });

    it('refuses a negative rate', async () => {
        const res = await admin.patch('/api/projects/uh/settings')
            .send({ driverPay: { perDeliveryCents: { scheduled: -100 } } });
        expect(res.status).toBe(400);
    });
});

describe('a courier reading their own record', () => {
    it('gets it from /me, with the username off the session', async () => {
        const ada = await agentFor('pay.ada', 'pay-pass-11');
        const res = await ada.get(`${DRIVERS}/me?from=${day}&to=${day}`);
        expect(res.status).toBe(200);
        expect(res.body.username).toBe('pay.ada');
        expect(res.body.totals.delivered).toBe(3);
    });

    it('cannot read another driver, by any route', async () => {
        /* THE PROPERTY. A payslip that can name somebody else is a way to
           read where every other courier went. There is no parameter on /me
           and the route that takes a name is dispatch's. */
        const ada = await agentFor('pay.ada', 'pay-pass-11');
        expect((await ada.get(`${DRIVERS}/pay.bo?from=${day}&to=${day}`)).status).toBe(403);
        expect((await ada.get(`${DRIVERS}?from=${day}&to=${day}`)).status).toBe(403);
    });

    it('cannot change whose record /me returns by asking', async () => {
        const ada = await agentFor('pay.ada', 'pay-pass-11');
        const res = await ada.get(`${DRIVERS}/me?from=${day}&to=${day}&username=pay.bo&courierUsername=pay.bo`);
        expect(res.status).toBe(200);
        expect(res.body.username).toBe('pay.ada');
        expect(res.body.totals.delivered).toBe(3);
    });

    it('is refused to a pharmacy account naming a driver', async () => {
        await admin.post('/api/users').send({
            username: 'pay.counter', name: 'Counter', password: 'pay-pass-11',
            role: 'staff',
        });
        await admin.put('/api/users/pay.counter/memberships/uh').send({
            role: 'pharmacy', settings: { siteIds: [discharge.id] },
        });
        const them = await agentFor('pay.counter', 'pay-pass-11');
        expect((await them.get(`${DRIVERS}/pay.ada`)).status).toBe(403);
        expect((await them.get(DRIVERS)).status).toBe(403);
    });
});

describe('daily, monthly and yearly', () => {
    it('groups by the period asked for', async () => {
        for (const [groupBy, shape] of [['day', /^\d{4}-\d{2}-\d{2}$/], ['month', /^\d{4}-\d{2}$/], ['year', /^\d{4}$/]]) {
            const res = await admin.get(`${DRIVERS}/pay.ada?from=${day}&to=${day}&groupBy=${groupBy}`);
            expect(res.status, `groupBy=${groupBy}`).toBe(200);
            expect(res.body.grouping).toBe(groupBy);
            for (const p of res.body.periods) expect(p.period, `groupBy=${groupBy}`).toMatch(shape);
        }
    });

    it('totals the periods rather than reporting one of them', async () => {
        const res = await admin.get(`${DRIVERS}/pay.ada?from=${day}&to=${day}&groupBy=month`);
        const summed = res.body.periods.reduce((n, p) => n + p.delivered, 0);
        expect(res.body.totals.delivered).toBe(summed);
    });

    it('refuses a window longer than a year rather than quietly shortening it', async () => {
        const res = await admin.get(`${DRIVERS}?from=2020-01-01&to=${day}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('drivers.rangeTooLong');
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE PAYMENT RUN AS A FILE.
 *
 * Every export in this system is a disclosure, so the shared helper carries
 * the five things the first one had to get right: a cap that refuses rather
 * than truncates, an About sheet saying what the file is, an audit row
 * written before the bytes, headers that stop a copy being kept, and a
 * findable filename. These tests are about the two that would be got wrong
 * silently.
 */
describe('the drivers record as a spreadsheet', () => {
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
        const rows = [];
        sheet.eachRow((row) => {
            rows.push(row.values.slice(1).map((v) => (v === undefined || v === null ? '' : String(v))));
        });
        return rows;
    };

    const download = () => admin
        .get(`${DRIVERS}/export.xlsx?from=${day}&to=${day}`)
        .buffer()
        .parse(binary);

    it('comes back as a spreadsheet nobody caches', async () => {
        const res = await download();
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/spreadsheetml/);
        expect(res.headers['content-disposition']).toContain(`drivers-${day}-to-${day}.xlsx`);
        /* A file of counts is still this contract's business. */
        expect(String(res.headers['cache-control'])).toMatch(/no-store/);
        expect(String(res.headers['cache-control'])).toMatch(/private/);
    });

    it('carries the drivers and what they delivered', async () => {
        await setRates({ scheduled: 450, stat: 700, adhoc: 500 });
        const res = await download();
        const rows = await sheetOf(res, 'Drivers');
        const flat = rows.flat().join(' | ');
        expect(flat).toContain('Ada Pay');
        expect(flat).toContain('Bo Pay');
    });

    it('names no patient and no address, which is what makes it postable', async () => {
        /* THE PROPERTY. This is the file that goes to a bookkeeper. */
        const res = await download();
        const rows = await sheetOf(res, 'Drivers');
        const flat = rows.flat().join(' | ');
        expect(flat).not.toMatch(/Pay Patient/);
        expect(flat).not.toMatch(/Invented Way/);
        expect(flat).not.toMatch(/78215/);
    });

    it('says on the file that it holds no patient data, rather than leaving it assumed', async () => {
        const res = await download();
        const about = (await sheetOf(res, 'About')).flat().join(' | ');
        expect(about).toContain('No patient data');
        expect(about).toContain('America/Chicago');
        expect(about).toContain(day);
    });

    it('leaves the pay column blank rather than zero when a rate is missing', async () => {
        /* The same rule as the screen, in the one place somebody will sum a
           column: a nought in a pay cell is an answer and it would be paid. */
        await setRates({ scheduled: 0, stat: 0, adhoc: 0 });
        const res = await download();
        const rows = await sheetOf(res, 'Drivers');
        const header = rows[0];
        const payAt = header.findIndex((h) => h.startsWith('Pay'));
        expect(payAt).toBeGreaterThan(-1);
        const ada = rows.find((r) => r[0] === 'Ada Pay');
        expect(ada[payAt]).toBe('');
        /* And it says why, in its own column, so a blank is not a mystery. */
        expect(ada.join(' | ')).toMatch(/rate is missing/i);
        await setRates({ scheduled: 450, stat: 700, adhoc: 500 });
    });

    it('records that a copy was taken, with how many rows', async () => {
        /* Written before the bytes, so a download interrupted half way still
           appears: a copy that was started is a copy that may exist. */
        await download();
        const { events } = (await admin.get('/api/audit?action=drivers.export')).body;
        expect(events.length).toBeGreaterThan(0);
        const detail = typeof events[0].detail === 'string' ? JSON.parse(events[0].detail) : events[0].detail;
        expect(detail.rows).toBeGreaterThan(0);
        expect(detail.containedPatientData).toBe(false);
    });

    it('is not something a courier may take', async () => {
        const ada = await agentFor('pay.ada', 'pay-pass-11');
        expect((await ada.get(`${DRIVERS}/export.xlsx`)).status).toBe(403);
    });
});
