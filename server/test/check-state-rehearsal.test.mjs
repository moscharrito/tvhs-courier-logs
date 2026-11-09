/* 5 and 6 November, rehearsed: what the live report will say before it is run.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A REHEARSAL AND NOT JUST A RUN.
 *
 * The live run needs an administrator password against production, which is
 * not something this repository can hold or this process can type. So the
 * situation is built here instead, on a real server, with PRODUCTION'S OWN
 * RATE CARD as check.ps1 read it on 9 November:
 *
 *     basis        zone
 *     zones 1-5    USD 5.00, 7.25, 12.00, 22.00, 28.00
 *     no zone      USD 28.00
 *     the day      USD 150.00, from 2026-11-05
 *
 * Those five numbers are the whole reason this case is confusing. The bonus
 * is thirty times the zone 1 rate, so whether a day qualifies matters more
 * than everything delivered on it -- and a day qualifies only when every
 * assigned stop was finished.
 *
 * THE TWO DATES ARE SEEDED AS THEMSELVES, not as "today". A zone is resolved
 * against the map effective on the SERVICE DATE and then frozen on the
 * order, and migration 0063 added 78234 effective 2026-11-07 on purpose. So
 * a stop to 78234 dated 5 or 6 November is unzoned here exactly as it is on
 * production, and the same stop dated today is zone 1. That is the fact that
 * made two named days look singled out, and it is reproduced rather than
 * described.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE IDENTIFIERS ARE INVENTED, AND THE SHAPE IS NOT.
 *
 * This repository is public, so no real courier's name or address goes in a
 * file. What is copied is the SHAPE that broke the old --driver: a username
 * that is a bare first name, a display name of two words, and a webmail
 * address, three different strings for one person. The live run is given the
 * real ones on the command line, where they stay.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, SERVER_DIR, CREDS } from './helpers/server.mjs';

const SCRIPT = path.join(SERVER_DIR, 'scripts', 'check-state.mjs');
const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;
const RUNS = `${UH}/runs`;

/* The two days in the complaint. */
const NOV5 = '2026-11-05';
const NOV6 = '2026-11-06';

/* Central San Antonio, zone 1 in Bid Table BT-89AO since the table landed. */
const ZONE1_ZIP = '78215';
/* Fort Sam Houston: absent from the bid table, added by 0063 effective
   2026-11-07, so unzoned on both of these dates and zone 1 after them. */
const OFF_MAP_ZIP = '78234';

/* One person, three strings -- the shape the report has to cope with. */
const USERNAME = 'rowan';
const FULL_NAME = 'Rowan Rehearsal';
const EMAIL = 'rowan.rehearsal@example.test';

let srv;
let admin;
let tdi;
let seq = 0;
let report = '';

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

/** A stop on a given day, carried as far as the caller says. */
async function stop(serviceDate, { zip = ZONE1_ZIP, outcome = 'delivered' } = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: tdi.id, serviceType: 'stat', recipientName: `Rehearsal Patient ${seq}`,
        addressLine: `${seq} Invented Way`, zip, serviceDate,
        externalRef: `REH-${9000 + seq}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({
        courierUsername: USERNAME, label: `Rehearsal ${seq}`, orderIds: [order.id],
    });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    if (outcome === 'picked_up') return order;
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    await admin.post(`${ORDERS}/${order.id}/events`).send(outcome === 'failed'
        ? { type: 'attempted', reason: 'nobody_home' }
        : { type: 'delivered', signedName: 'A Patient' });
    return order;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    tdi = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'tdi');

    await admin.post('/api/users').send({
        username: USERNAME, name: FULL_NAME, email: EMAIL,
        password: 'rehearsal-pass-11', role: 'driver',
    });
    await admin.put(`/api/users/${USERNAME}/memberships/uh`).send({ role: 'courier', settings: {} });

    /* PRODUCTION'S RATE CARD, as check.ps1 read it on 9 November. */
    const rates = await admin.patch('/api/projects/uh/settings').send({
        driverPay: {
            basis: 'zone',
            perZoneCents: { 1: 500, 2: 725, 3: 1200, 4: 2200, 5: 2800 },
            outOfZoneCents: 2800,
            completionBonusCents: 15000,
            completionBonusFrom: NOV5,
        },
    });
    expect(rates.status, JSON.stringify(rates.body).slice(0, 300)).toBe(200);

    /* 5 NOVEMBER: four stops, three finished, ONE LEFT ON picked_up.
       Everything is priced and nothing is unzoned -- the only thing wrong
       with this day is the stop that was never closed. */
    await stop(NOV5);
    await stop(NOV5);
    await stop(NOV5);
    await stop(NOV5, { outcome: 'picked_up' });

    /* 6 NOVEMBER: four stops, all finished, one of them to the ZIP that
       was not on the map yet. The day qualifies; the unzoned stop is paid
       on the out-of-zone rate and keeps its own line. */
    await stop(NOV6);
    await stop(NOV6);
    await stop(NOV6, { outcome: 'failed' });
    await stop(NOV6, { zip: OFF_MAP_ZIP });

    const res = await run(['--driver', EMAIL, '--from', NOV5, '--to', NOV6]);
    expect(res.code, res.out).toBe(0);
    report = res.out;
});
afterAll(async () => { await srv.stop(); });

/** The report, from a heading to the next heading.
 *
 *  MATCHED ON THE WHOLE LINE, not a substring. "See UNZONED DELIVERIES
 *  below" is a sentence inside the rate card, and a substring match found
 *  that instead of the section and then asserted against the wrong text. */
function section(title) {
    const lines = report.split('\n');
    const at = lines.findIndex((l) => l.trim() === title);
    expect(at, report).toBeGreaterThan(-1);
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => /^ {2}[A-Z][A-Z ,'-]+$/.test(l));
    return [lines[at], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

describe('the 5-6 November rehearsal', () => {
    /* PRINTED ON PURPOSE. The question this file answers is "what will the
       live run say", and the answer is the text. */
    it('reads the account from the email address alone', () => {
        console.log(
            '\n================ THE REPORT, AS THE LIVE RUN WILL PRINT IT ================\n'
            + section('WHO WAS ASKED ABOUT')
            + '\n' + section("WHAT THAT DRIVER'S OWN SCREEN SAYS")
            + '\n' + section('THE RANGE, DRIVER BY DRIVER')
            + '\n==========================================================================\n',
        );

        const who = section('WHO WAS ASKED ABOUT');
        expect(who).toContain(FULL_NAME);
        expect(who).toContain(`username ${USERNAME}`);
        expect(who).toContain(EMAIL);
    });

    /* ── THE ANSWER. Two days, the same driver, the same complete rate card,
     * and one of them pays USD 178 less than the other. Nothing is withheld
     * on either. */
    it('pays 6 November and not 5 November, and the difference is the bonus', () => {
        const mine = section("WHAT THAT DRIVER'S OWN SCREEN SAYS");

        /* 5 Nov: three stops at zone 1, no bonus.                 3 x 5.00 */
        expect(mine).toMatch(new RegExp(`${NOV5}\\s+3 delivered, 0 not\\s+USD 15\\.00`));
        /* 6 Nov: two delivered and one failed at zone 1, one unzoned at the
           out-of-zone rate, and the day finished.   3 x 5.00 + 28.00 + 150 */
        expect(mine).toMatch(new RegExp(`${NOV6}\\s+3 delivered, 1 not\\s+USD 193\\.00`));
        expect(mine).toMatch(/Range total\s+USD 208\.00/);
        /* The bonus is named as its own figure, because a driver comparing
           their pay to "USD 150 a day" has to be able to see it. */
        expect(mine).toMatch(/Days finished\s+1\s+USD 150\.00/);

        /* NOT A WITHHELD FIGURE ANYWHERE. This is the whole point: every
           section that could blame the rate card comes back clean, and the
           day is still short. */
        expect(mine).not.toContain('RATE NOT SET');
        expect(report).toContain('Every rate on the basis in use is set');
    });

    /* ── AND IT NAMES THE DAY THAT LOST IT, WITH THE MONEY AND THE REASON. */
    it('flags 5 November as the day that lost the bonus, and says what is still open', () => {
        const all = section('THE RANGE, DRIVER BY DRIVER');
        expect(all).toContain('1 DRIVER-DAYS LOST THE BONUS: USD 150.00');
        expect(all).toMatch(new RegExp(`${NOV5}\\s+${USERNAME}\\s+3 of 4 finished\\s+still 1 picked_up`));
        /* 6 November finished, so it must NOT be on that list. A flag that
           fires on a good day is one nobody reads on a bad one.
           Asserted on the LIST, not the section: the section opens with the
           range line, which names both dates. */
        const listed = all.slice(all.indexOf('DRIVER-DAYS LOST THE BONUS'));
        expect(listed).not.toContain(NOV6);
        /* And nothing is being lost to an unassigned stop. */
        expect(all).toContain('Finished stops assigned to nobody:  0');
    });

    /* ── THE UNZONED STOP IS PAID, AND STILL VISIBLE. Both halves matter:
     * the money is not withheld, and the gap in the map has not gone quiet. */
    it('pays the 78234 stop on the out-of-zone rate and keeps its line', () => {
        const mine = section("WHAT THAT DRIVER'S OWN SCREEN SAYS");
        expect(mine).toMatch(/No zone\s+1 delivered, 0 not\s+at USD 28\.00\s+USD 28\.00/);

        const unzoned = section('UNZONED DELIVERIES');
        expect(unzoned).toContain(OFF_MAP_ZIP);
        expect(unzoned).toContain('1 of them');
    });

    /* ── AND NOW THE DISTINCTION THAT COSTS AN HOUR IF YOU MISS IT.
     *
     * A STALE SHIFT IS NOT EVIDENCE OF A LOST BONUS. Two stops are still
     * held here and they are not the same kind of thing:
     *
     *   5 Nov, picked_up  -- never finished. Takes the day's USD 150.
     *   6 Nov, failed     -- attempted and never handed back. Counts as
     *                        FINISHED, so the day still qualifies, and the
     *                        stop is paid at the full rate.
     *
     * Both keep a shift open, because carrying() in shifts.ts refuses to
     * close one while either is outstanding. So "their shift has been open
     * since the 6th" says a stop is outstanding and says NOTHING about
     * whether any money is missing -- and I had read it as though it did.
     * The report has to show both and distinguish them, which is what this
     * asserts.
     */
    it('holds both an unfinished stop and an unreturned failure, and they differ', () => {
        const carrying = section(`WHAT ${USERNAME} IS CARRYING`);
        expect(carrying).toContain(`${NOV5}`);
        expect(carrying).toContain('picked_up');
        /* The failed one is held too -- it has not been handed back. */
        expect(carrying).toContain(`${NOV6}`);
        expect(carrying).toContain('failed');
        expect(carrying).toContain('TOTAL 2');

        /* AND YET only one of the two days lost its bonus. This is the pair
           of facts that has to be read together: two stops outstanding, one
           day short. */
        const all = section('THE RANGE, DRIVER BY DRIVER');
        const listed = all.slice(all.indexOf('DRIVER-DAYS LOST THE BONUS'));
        expect(listed).toContain(NOV5);
        expect(listed).not.toContain(NOV6);
    });

    /* ── NO PATIENT, ANYWHERE. check.txt is written to disk and pasted into
     * conversations about money. */
    it('names pharmacies and no patients', () => {
        expect(report).not.toContain('Rehearsal Patient');
        expect(report).not.toContain('Invented Way');
    });
});
