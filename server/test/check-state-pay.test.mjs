/* What check-state.mjs says when a driver cannot see their pay.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS WORTH A TEST FILE OF ITS OWN.
 *
 * "I cannot see my pay for the 5th and the 6th" is one sentence covering
 * three unrelated faults, and the screen the driver is looking at cannot
 * tell them apart -- all three render as no figure:
 *
 *   a rate on the basis in use is zero;
 *   a stop went to a ZIP that is on no zone, and no zone rate is set;
 *   the stops were never finished at all, so the day does not exist.
 *
 * The third is the one that looks least like a pay problem and is the
 * easiest to chase in the wrong place: nothing is withheld, there is simply
 * no day. On 9 November it was the question actually being asked, about two
 * named dates, with the zone map having been corrected on the 7th -- which
 * does NOT reach back, because a zone is frozen onto the order when it is
 * created and zone_zips is effective-dated on purpose.
 *
 * So the script now prints the driver's own record beside the rate card and
 * the unzoned list, and this asserts that each of the three causes produces
 * a DIFFERENT and unmistakable line. A diagnostic that says "rate not set"
 * for all three is the thing that sent somebody to the settings screen for
 * a fault that was on the board.
 *
 * Driven as the operator drives it -- the real script, spawned against a
 * real server, password in SEED_ADMIN_PASS the way check.ps1 hands it over.
 *
 * Every name and address here is invented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, SERVER_DIR, CREDS } from './helpers/server.mjs';

const SCRIPT = path.join(SERVER_DIR, 'scripts', 'check-state.mjs');
const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

/* A ZIP that is in no band of Bid Table BT-89AO. The point of the fixture:
   78234 was the real one, and it was added to the map on 7 November. */
const OFF_MAP_ZIP = '99999';
/* Central San Antonio, zone 1 in the bid table. */
const ON_MAP_ZIP = '78215';

const DRIVER = 'pay.doc';

let srv;
let admin;
let discharge;
let day;
let seq = 0;

function run(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, '--base', srv.url, '--project', 'uh', ...args], {
            cwd: SERVER_DIR,
            env: { ...process.env, SEED_ADMIN_PASS: CREDS.admin.password, SEED_ADMIN_USER: CREDS.admin.username },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        child.on('close', (code) => resolve({ code, out }));
    });
}

/** The driver's section of the report, so an assertion cannot pass on a
 *  line from the rate card or the unzoned list above it. */
function theirSection(out) {
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.includes("WHAT THAT DRIVER'S OWN SCREEN SAYS"));
    expect(at, out).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > at && l.includes('Nothing was changed'));
    return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

/** An order on the day, assigned and picked up but never finished. */
async function openStop(over = {}) {
    seq += 1;
    const { zip = ON_MAP_ZIP, ...rest } = over;
    const created = await admin.post(ORDERS).send({
        siteId: discharge.id, serviceType: 'stat', recipientName: `Doc Patient ${seq}`,
        addressLine: `${seq} Invented Way`, zip, serviceDate: day,
        externalRef: `DOC-${8000 + seq}`, ...rest,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: DRIVER, label: `Doc run ${seq}`, orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    return order;
}

async function finish(order, { fail = false } = {}) {
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${order.id}/events`).send(fail
        ? { type: 'attempted', reason: 'nobody_home' }
        : { type: 'delivered', signedName: 'A Patient' });
}

const patchPay = async (driverPay) => {
    const res = await admin.patch('/api/projects/uh/settings').send({ driverPay });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');
    day = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    await admin.post('/api/users').send({
        username: DRIVER, name: 'Doc Driver', password: 'doc-pass-11', role: 'driver',
    });
    await admin.put(`/api/users/${DRIVER}/memberships/uh`).send({ role: 'courier', settings: {} });

    /* The contract this is about pays by zone, with the bands set and the
       out-of-zone rate NOT set -- which is the production shape on
       6 November, before anybody priced the gap. */
    await patchPay({
        basis: 'zone',
        perZoneCents: { 1: 1200, 2: 1500, 3: 1800, 4: 2200, 5: 2800 },
        outOfZoneCents: 0,
    });
});
afterAll(async () => { await srv.stop(); });

describe('check-state.mjs on a driver who cannot see their pay', () => {
    /* ── CAUSE THREE, FIRST, because it is the one that is not a pay fault.
     *
     * Nothing is finished. There is no day on the record at all, and the
     * honest report of that is "no days", not "rate not set" -- the rate
     * card is irrelevant and the settings screen is the wrong place to go. */
    it('says there is no day at all when the stops were never finished', async () => {
        const open = await openStop();

        const res = await run(['--driver', DRIVER, '--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);
        const mine = theirSection(res.out);

        expect(mine).toContain('NO DAYS AT ALL');
        /* And what they WERE given, which is the half the pay endpoint
           cannot see. One stop, picked up, unfinished. */
        expect(mine).toContain('WHAT WAS ASSIGNED TO THEM');
        expect(mine).toMatch(new RegExp(`${day}\\s+1 picked_up`));
        /* Not a withheld figure: nothing claims a rate is missing here. */
        expect(mine).not.toContain('RATE NOT SET');

        await finish(open);
    });

    /* ── CAUSE TWO. One stop to a ZIP off the map, with every band priced. */
    it('shows the withheld day, the No zone line, and that it takes the range', async () => {
        const offMap = await openStop({ zip: OFF_MAP_ZIP });
        await finish(offMap);
        /* Two good ones beside it, so the point is visible: the money is
           there and is still not shown. */
        await finish(await openStop());
        await finish(await openStop(), { fail: true });

        const res = await run(['--driver', DRIVER, '--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);
        const mine = theirSection(res.out);

        /* The day exists now -- that is the difference from the test above. */
        expect(mine).toContain(day);
        expect(mine).toContain('RATE NOT SET');
        /* The line, named as the breakdown names it, at no rate. */
        expect(mine).toMatch(/No zone\s+1 delivered.*NOT SET/);
        /* The priced lines are printed with their money, so a reader can see
           the total is not short, it is absent. */
        expect(mine).toMatch(/Zone 1\s+2 delivered/);
        expect(mine).toContain('USD 12.00');
        /* And the sentence that stops somebody hunting for a missing band. */
        expect(mine).toContain('WITHHOLDS THE WHOLE RANGE');
        /* The failed attempt is reported as paid work, not dropped: the
           5 November rule. */
        expect(mine).toContain('paid at the same rate since 5 November');
    });

    /* ── AND THE REPAIR, which is a rate rather than a migration. */
    it('shows a figure once the out-of-zone rate is priced', async () => {
        await patchPay({ outOfZoneCents: 2800 });

        const res = await run(['--driver', DRIVER, '--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);
        const mine = theirSection(res.out);

        expect(mine).not.toContain('RATE NOT SET');
        expect(mine).not.toContain('WITHHOLDS THE WHOLE RANGE');
        /* 2 x zone 1 at 12.00, 1 delivered + 1 failed... the arithmetic is
           driver-pay.ts's and is tested there. What matters here is that a
           range total is now a number at all. */
        expect(mine).toMatch(/Range total\s+USD \d+\.\d\d/);
        /* The No zone line stays, priced. A gap that is being paid over has
           to remain visible or nobody closes it. */
        expect(mine).toMatch(/No zone\s+1 delivered.*USD 28\.00/);
    });

    /* ── CAUSE ONE, for completeness: a band at zero, nothing unzoned. */
    it('names the unset band on the basis in use', async () => {
        await patchPay({ perZoneCents: { 1: 0, 2: 1500, 3: 1800, 4: 2200, 5: 2800 } });

        const res = await run(['--driver', DRIVER, '--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);

        /* This one IS answerable from the rate card, and the rate card says
           so in those words. */
        expect(res.out).toContain('UNSET ON THE BASIS IN USE: zone 1');
        const mine = theirSection(res.out);
        expect(mine).toMatch(/Zone 1\s+2 delivered.*NOT SET/);
        expect(mine).toContain('RATE NOT SET');

        await patchPay({ perZoneCents: { 1: 1200, 2: 1500, 3: 1800, 4: 2200, 5: 2800 } });
    });

    /* ── AND IT DOES NOT GUESS. A username nobody holds is not "they earned
     * nothing": the commonest version of this on the UH contract is an email
     * address typed with the wrong domain. */
    it('says so plainly when the username is not one the project holds', async () => {
        const res = await run(['--driver', 'nobody@example.test', '--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);
        const mine = theirSection(res.out);
        expect(mine).toContain('NO RECORD FOR THAT USERNAME');
        expect(mine).not.toContain('RATE NOT SET');
    });

    /* ── THE FOURTH CAUSE, WHICH IS NOT A WITHHELD FIGURE AT ALL.
     *
     * The rate card can be complete, nothing unzoned, every stop assigned
     * -- and a driver still reads a number a third of what they expected,
     * because one unfinished stop took the day's USD 150. That is the
     * production shape on 9 November and the reason this section exists:
     * every other section in the file would have said "nothing is wrong".
     */
    it('flags the day that lost its bonus, with the money', async () => {
        await patchPay({ completionBonusCents: 15000, completionBonusFrom: day });

        /* One stop left standing against the four finished above it:
           assigned 5, finished 4. One is enough -- that is the point. */
        const standing = await openStop();

        const res = await run(['--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);

        expect(res.out).toContain('DRIVER-DAYS LOST THE BONUS');
        expect(res.out).toContain('USD 150.00 a day');
        expect(res.out).toMatch(new RegExp(`${day}\\s+${DRIVER}\\s+4 of 5 finished\\s+still 1 picked_up`));
        /* And it is explicit that this is not a missing rate, because the
           rate card above will say every rate is set. */
        expect(res.out).toContain('Every rate on the basis in use is set');

        /* Finish it and the day qualifies: the flag has to clear, or it is
           noise that gets ignored. */
        await finish(standing);
        const after = await run(['--from', day, '--to', day]);
        expect(after.code, after.out).toBe(0);
        expect(after.out).toContain('No bonus is missing');
        expect(after.out).not.toContain('DRIVER-DAYS LOST THE BONUS');

        await patchPay({ completionBonusCents: 0, completionBonusFrom: null });
    });

    /* ── A FINISHED STOP THAT BELONGS TO NOBODY PAYS NOBODY, and the count
     * is printed even when it is nought: a zero is the answer to the
     * question, and an absent line is not. */
    it('counts the finished stops that are on no driver record', async () => {
        const res = await run(['--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('Finished stops assigned to nobody:  0');
        expect(res.out).not.toContain('These pay NOBODY');
    });

    /* ── AND IT NEVER PRINTS A PATIENT. check.txt is written to disk and
     * pasted around; the endpoint behind this section returns pharmacies
     * and counts, and this is the assertion that keeps it that way. */
    it('names pharmacies and no patients', async () => {
        const res = await run(['--driver', DRIVER, '--from', day, '--to', day]);
        expect(res.code, res.out).toBe(0);
        expect(res.out).not.toContain('Doc Patient');
        expect(res.out).not.toContain('Invented Way');
    });
});
