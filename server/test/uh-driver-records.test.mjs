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

describe('the completion bonus', () => {
    /* A flat amount for finishing a day's assigned work, on top of the
       per-delivery rate. Asked for on 4 November.

       EVERY TEST HERE IS ABOUT A NUMBER SOMEBODY IS PAID, so the ones that
       matter most are the refusals: a bonus awarded to a driver who left
       stops standing, or applied to a day that was already disbursed, is
       money out of the door. */

    const setBonus = async (cents, from = null) => {
        const res = await admin.patch('/api/projects/uh/settings')
            .send({ driverPay: { completionBonusCents: cents, completionBonusFrom: from } });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    };

    /** A driver with their own stops, so one test cannot disturb another. */
    let n = 0;
    async function freshDriver() {
        n += 1;
        const username = `bonus.${n}`;
        await admin.post('/api/users').send({
            username, name: `Bonus Driver ${n}`, password: 'pay-pass-11', role: 'driver',
        });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
        return username;
    }

    const payOf = async (username) => {
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        expect(res.status).toBe(200);
        return res.body.drivers.find((d) => d.username === username);
    };

    afterAll(async () => { await setBonus(0, null); });

    it('is off until somebody sets it, so shipping it changed nobody\'s pay', async () => {
        await setBonus(0);
        const who = await freshDriver();
        await deliveredBy(who);
        const d = await payOf(who);
        expect(d.bonusDays).toBe(0);
        expect(d.bonusCents).toBe(0);
    });

    it('pays once for a day where every assigned stop was finished', async () => {
        await setRates({ scheduled: 700, stat: 700, adhoc: 700 });
        await setBonus(15000);
        const who = await freshDriver();
        await deliveredBy(who);
        await deliveredBy(who);
        const d = await payOf(who);
        expect(d.bonusDays, 'one day, not one per delivery').toBe(1);
        expect(d.bonusCents).toBe(15000);
        /* Two stat deliveries at $7 plus the $150 bonus. */
        expect(d.payCents).toBe(1400 + 15000);
    });

    it('withholds it while a stop is still open', async () => {
        /* THE CASE THE OLD QUERY COULD NOT SEE. stopsIn selects delivered
           and failed only, so a driver with work still out looked exactly
           like one who had finished. */
        await setBonus(15000);
        const who = await freshDriver();
        await deliveredBy(who);
        const open = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'stat', recipientName: 'Still Out',
            addressLine: '9 Invented Way', zip: '78215', serviceDate: day,
            externalRef: `OPEN-${Date.now()}`,
        });
        expect(open.status).toBe(201);
        await admin.post(RUNS).send({ courierUsername: who, label: 'Run', orderIds: [open.body.id] });

        const d = await payOf(who);
        expect(d.bonusDays, 'one stop is still out').toBe(0);
        expect(d.bonusCents).toBe(0);
    });

    it('counts a failed attempt as finished', async () => {
        /* A courier who drove to the door and found nobody did the work.
           Stated out loud because the consequence is that a driver whose
           every stop failed still earns the bonus. */
        await setBonus(15000);
        const who = await freshDriver();
        await deliveredBy(who, { fail: true });
        const d = await payOf(who);
        expect(d.bonusDays).toBe(1);
        expect(d.delivered).toBe(0);
        expect(d.bonusCents).toBe(15000);
    });

    it('gives nothing to a driver who was assigned nothing', async () => {
        /* Vacuously finishing an empty list is not a day's work. */
        await setBonus(15000);
        const who = await freshDriver();
        const d = await payOf(who);
        expect(d.bonusDays).toBe(0);
        expect(d.bonusCents).toBe(0);
    });

    it('does not reach back before the date it was switched on from', async () => {
        /* The expensive way to be wrong: turning on a rate and silently
           rewriting what was owed for days already paid. */
        await setBonus(15000, '2099-01-01');
        const who = await freshDriver();
        await deliveredBy(who);
        const d = await payOf(who);
        expect(d.bonusDays, 'today is before the start date').toBe(0);
        expect(d.bonusCents).toBe(0);

        await setBonus(15000, '2000-01-01');
        const after = await payOf(who);
        expect(after.bonusDays).toBe(1);
    });

    it('keeps the total null when a worked rate is missing, bonus or not', async () => {
        /* payCents null means "we cannot tell you what this is worth".
           Adding a known bonus to an unknown delivery total would turn that
           into a confident figure smaller than the truth. The bonus is
           still reported in its own field. */
        await setRates({ scheduled: 0, stat: 0, adhoc: 0 });
        await setBonus(15000, '2000-01-01');
        const who = await freshDriver();
        await deliveredBy(who);
        const d = await payOf(who);
        expect(d.payCents, 'still unknown').toBeNull();
        expect(d.bonusCents, 'but the bonus was earned and is visible').toBe(15000);
        await setRates({ scheduled: 700, stat: 700, adhoc: 700 });
    });

    it('shows the courier their own bonus, not just the office', async () => {
        /* THE GAP THIS CLOSES. The bonus went on the admin summary list
           first and nowhere else, so a driver reading their own record saw
           a figure $150 a day short of what the office was about to pay
           them -- and the smaller number is the one somebody believes.
           Found by asking where a driver would actually see it. */
        await setRates({ scheduled: 700, stat: 700, adhoc: 700 });
        await setBonus(15000, '2000-01-01');
        const who = await freshDriver();
        await deliveredBy(who);

        const theirs = await agentFor(who, 'pay-pass-11');
        const mine = await theirs.get(`${DRIVERS}/me?from=${day}&to=${day}`);
        expect(mine.status, JSON.stringify(mine.body).slice(0, 200)).toBe(200);
        expect(mine.body.totals.bonusDays).toBe(1);
        expect(mine.body.totals.bonusCents).toBe(15000);
        expect(mine.body.totals.payCents).toBe(700 + 15000);
    });

    it('agrees with itself across the summary, the one-driver view and the file', async () => {
        /* Two screens in one portal disagreeing about what somebody is
           owed is worse than neither showing it. */
        await setRates({ scheduled: 700, stat: 700, adhoc: 700 });
        await setBonus(15000, '2000-01-01');
        const who = await freshDriver();
        await deliveredBy(who);

        const list = (await admin.get(`${DRIVERS}?from=${day}&to=${day}`))
            .body.drivers.find((d) => d.username === who);
        const one = await admin.get(`${DRIVERS}/${who}?from=${day}&to=${day}`);
        expect(one.status).toBe(200);
        expect(one.body.totals.bonusCents, 'the one-driver view').toBe(list.bonusCents);
        expect(one.body.totals.payCents, 'and the total with it').toBe(list.payCents);
    });

    it('is not withheld by a pharmacy filter', async () => {
        /* "Finished everything" is a fact about the whole day. Asking it of
           one counter would award a bonus to somebody who cleared Wheatley
           and left four stops at Vida -- or withhold one from somebody who
           finished everywhere. */
        await setRates({ scheduled: 700, stat: 700, adhoc: 700 });
        await setBonus(15000, '2000-01-01');
        const who = await freshDriver();
        await deliveredBy(who);
        await deliveredBy(who, { siteId: green.id, serviceType: 'adhoc' });
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${green.id}`);
        const d = res.body.drivers.find((x) => x.username === who);
        expect(d.delivered, 'only the Green delivery is counted').toBe(1);
        expect(d.bonusDays, 'but the day was still completed').toBe(1);
    });
});

describe('narrowed to one pharmacy', () => {
    /* Every other screen on the portal answers "that counter, that day".
       This one is the payment run, so it answers it with a warning attached,
       and these tests are about the warning being impossible to lose as much
       as about the filter being right.

       The fixture is already the right shape: Ada delivered twice to
       Discharge, once to Green, and failed once at Discharge. Bo delivered
       once, to Discharge only. */

    it('counts only that pharmacy\'s deliveries', async () => {
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${green.id}`);
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.delivered, 'Ada made one delivery to Green').toBe(1);
    });

    it('leaves out a failure that happened at another pharmacy', async () => {
        /* Ada's failed attempt was at Discharge. Counting it under Green
           would put a courier's bad day against a counter they did not
           visit, which is the kind of number a site manager escalates. */
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${green.id}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.failed).toBe(0);
    });

    it('still lists a driver who worked a different pharmacy, at nought', async () => {
        /* THE FILTER NARROWS THE DELIVERIES, NEVER THE ROSTER. Bo worked
           Discharge only. Dropping Bo from the Green list would make a total
           that cannot be checked against the roster -- the same reason the
           unfiltered list keeps the drivers who delivered nothing. */
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${green.id}`);
        const bo = res.body.drivers.find((d) => d.username === 'pay.bo');
        expect(bo, 'Bo should still be on the list').toBeTruthy();
        expect(bo.delivered).toBe(0);
    });

    it('tells the screen which pharmacy it answered, so a slice cannot read as a payment run', async () => {
        /* The banner and the "to disburse" label are driven by this field
           rather than by the URL. A response that came back unmarked would
           let filtered pay render under a heading that says what somebody is
           owed. */
        const one = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${green.id}`);
        expect(one.body.siteId).toBe(green.id);
        const all = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        expect(all.body.siteId, 'no filter is null, not absent').toBeNull();
    });

    it('counts every pharmacy when none is asked for', async () => {
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.delivered, 'two to Discharge and one to Green').toBe(3);
        expect(ada.failed).toBe(1);
    });

    it('treats a pharmacy it cannot read as every pharmacy, rather than refusing', async () => {
        /* This URL gets bookmarked and mailed around. A stray query string
           should show the whole contract, which is the safe answer here, not
           a 400 in front of somebody trying to run payroll. */
        for (const bad of ['', 'all', '-3', '0', '2.5']) {
            const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${bad}`);
            expect(res.status, `siteId=${bad}`).toBe(200);
            expect(res.body.siteId, `siteId=${bad}`).toBeNull();
            const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
            expect(ada.delivered, `siteId=${bad}`).toBe(3);
        }
    });

    it('gives a pharmacy with no deliveries an empty record rather than an error', async () => {
        const sites = (await admin.get(`${UH}/sites`)).body;
        const quiet = sites.find((x) => x.id !== discharge.id && x.id !== green.id);
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}&siteId=${quiet.id}`);
        expect(res.status).toBe(200);
        expect(res.body.totals.delivered).toBe(0);
        expect(res.body.drivers.length, 'the roster is still there').toBeGreaterThan(0);
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
        /* Two stat delivered, one adhoc delivered, and one stat that came
           back. From 5 November the return pays the stat rate too. */
        expect(ada.payCents).toBe(700 + 700 + 500 + 700);
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

/* ───────────────────────── the site manager sees the work, not the money
 *
 * Ticket 7.20 replaced eight per-counter leads with ONE site manager who
 * dispatches the whole contract, handles what comes back and talks to
 * drivers on site. They need to know who is carrying what and who is
 * running late. What each driver is PAID is commercial and is not theirs.
 *
 * Stripped on the way out of the server rather than hidden by the screen,
 * because a field a client is trusted not to render is a field that leaks
 * the first time somebody opens devtools. These tests read the JSON.
 */
describe('what the site manager may see of the drivers record', () => {
    let manager;

    beforeAll(async () => {
        await admin.post('/api/users').send({
            username: 'uh.sitemanager', name: 'Site Manager', password: 'manager-pass-1', role: 'staff',
        });
        const sites = (await admin.get(`${UH}/sites`)).body;
        await admin.put('/api/users/uh.sitemanager/memberships/uh').send({
            role: 'lead', settings: { siteIds: sites.map((x) => x.id) },
        });
        manager = srv.agent();
        expect((await manager.post('/api/login').send({
            username: 'uh.sitemanager', password: 'manager-pass-1',
        })).status).toBe(200);
        await setRates({ scheduled: 450, stat: 700, adhoc: 500 });
    });

    it('can read the record at all, which the old lead could not', async () => {
        const res = await manager.get(`${DRIVERS}?from=${day}&to=${day}`);
        expect(res.status).toBe(200);
        expect(res.body.drivers.length).toBeGreaterThan(0);
    });

    it('sees who delivered what', async () => {
        const res = await manager.get(`${DRIVERS}?from=${day}&to=${day}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.delivered).toBeGreaterThan(0);
        expect(ada.failed).toBeDefined();
        expect(ada.daysWorked).toBeDefined();
    });

    it('sees no money anywhere in it', async () => {
        const res = await manager.get(`${DRIVERS}?from=${day}&to=${day}`);
        /* The whole body, not a field at a time: the pay numbers live in
           three shapes -- the totals, each driver, and the lines inside
           them -- and a strip applied to two of the three is a leak in the
           third. */
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/payCents/);
        expect(body).not.toMatch(/rateCents/);
        expect(body).not.toMatch(/"lines"/);
        expect(res.body.currency).toBeUndefined();
    });

    it('sees no money on one named driver either', async () => {
        const res = await manager.get(`${DRIVERS}/pay.ada?from=${day}&to=${day}`);
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/payCents/);
        expect(body).not.toMatch(/rateCents/);
    });

    it('cannot export the payment run as a spreadsheet', async () => {
        /* The workbook is built from the same rows and carries the rate and
           pay columns. Rather than keep a second shape of it in step, the
           export stays where the money is allowed. */
        expect((await manager.get(`${DRIVERS}/export.xlsx?from=${day}&to=${day}`)).status).toBe(403);
    });

    it('still shows an admin the money', async () => {
        /* The strip is about the role, not about the endpoint. */
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        expect(JSON.stringify(res.body)).toMatch(/payCents/);
        expect(res.body.currency).toBe('USD');
    });
});

/* ──────────────────────────────────────────── paying by zone (7.10)
 *
 * The courier offer letter pays per completed delivery by ZONE rather than
 * by service level. Switching a project onto it is a settings change, and
 * what matters here is that the whole chain follows: the stored basis, the
 * rate used, and the column the record is reported under.
 */
describe('a project that pays by zone', () => {
    afterAll(async () => {
        /* Put it back, so a test added after this one gets the basis every
           other test in this file assumes. */
        await admin.patch('/api/projects/uh/settings').send({ driverPay: { basis: 'serviceType' } });
    });

    it('stores the basis and the zone rates', async () => {
        const res = await admin.patch('/api/projects/uh/settings').send({
            driverPay: { basis: 'zone', perZoneCents: { 1: 500, 2: 725, 3: 1200, 4: 2200, 5: 2800 } },
        });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);

        const settings = (await admin.get('/api/projects/uh/settings')).body;
        const pay = (settings.settings ?? settings).driverPay;
        expect(pay.basis).toBe('zone');
        expect(pay.perZoneCents['2']).toBe(725);
        /* Zones 4 and 5 are their own numbers: the offer letter prints them
           as a range, and a range is not a rate. */
        expect(pay.perZoneCents['4']).toBe(2200);
        expect(pay.perZoneCents['5']).toBe(2800);
    });

    it('reports the record under Zone rather than under Service level', async () => {
        const res = await admin.get(`${DRIVERS}?from=${day}&to=${day}`);
        const ada = res.body.drivers.find((d) => d.username === 'pay.ada');
        expect(ada.basis).toBe('zone');
        /* Every line is a zone line, and each carries its own label so the
           screen does not have to guess what it is rendering. */
        for (const [key, line] of Object.entries(ada.lines)) {
            expect(key === 'unzoned' || key.startsWith('zone-'), key).toBe(true);
            expect(line.label).toBeTruthy();
        }
    });

    it('refuses a zone rate that is not whole cents', async () => {
        const res = await admin.patch('/api/projects/uh/settings')
            .send({ driverPay: { perZoneCents: { 1: 5.5 } } });
        expect(res.status).toBe(400);
    });

    it('refuses a basis nobody recognises rather than inventing one', async () => {
        const res = await admin.patch('/api/projects/uh/settings')
            .send({ driverPay: { basis: 'mileage' } });
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
