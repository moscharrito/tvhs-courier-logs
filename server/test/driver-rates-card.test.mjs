/* The rate card as somebody reading it sees it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A DISPLAY IS WORTH TESTING.
 *
 * There is no driver-pay screen, so `driver-rates.mjs --show` IS the rate
 * card. It is what somebody opens to check a courier's pay against the
 * offer letter, and until 10 November it said:
 *
 *     paying on: ZONE of the destination ZIP
 *
 * which is the BILLING zone's definition -- the one thing pay stopped using
 * on 9 November, and the precise misreading that underpaid a fourteen-mile
 * stop as zone 1 for a week. The figures on the card were right the whole
 * time. The sentence above them described the wrong document.
 *
 * So the assertions here are about the WORDS, not the arithmetic. The
 * arithmetic has its own tests; nothing had ever read the label.
 *
 * Driven the way the operator drives it: the real script, spawned against a
 * real server, password in SEED_ADMIN_PASS the way the wrapper hands it over.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, SERVER_DIR, CREDS } from './helpers/server.mjs';
import { PAY_BANDS } from '../src/modules/uh/driver-pay.ts';

const SCRIPT = path.join(SERVER_DIR, 'scripts', 'driver-rates.mjs');

let srv;

/* Spawned through tsx, which is how package.json runs it: the script imports
   PAY_BANDS from a TypeScript module and plain node cannot load it. If this
   ever fails to start, the npm script and this test have drifted apart. */
function run(extra = []) {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', SCRIPT, '--base', srv.url, '--project', 'uh', ...extra],
            {
                cwd: SERVER_DIR,
                env: { ...process.env, SEED_ADMIN_PASS: CREDS.admin.password, SEED_ADMIN_USER: CREDS.admin.username },
            },
        );
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        child.on('close', (code) => resolve({ code, out }));
    });
}

/* A FRESH DATABASE PAYS ON SERVICE LEVEL, which is the right default -- zone
   rates are a decision about money and nothing should assume one. So the card
   under test is the one an owner has actually set up, and setting it here with
   the offer letter's own figures means the assertions below check the card
   against the letter rather than against itself. */
beforeAll(async () => {
    srv = await startServer();
    const set = await run([
        '--basis', 'zone',
        '--zone1', '5.00', '--zone2', '7.25', '--zone3', '12.00',
        '--zone4', '22.00', '--zone5', '28.00',
        '--no-zone', '28.00',
    ]);
    expect(set.code).toBe(0);
});
afterAll(async () => { await srv.stop(); });

describe('driver-rates.mjs --show', () => {
    /* ── THE REGRESSION. Not a wording preference: these two sentences name
     * two different documents, and the card has to name the one it pays on. */
    it('says pay is banded on distance from the pickup, not on the ZIP', async () => {
        const res = await run(['--show']);

        expect(res.out).toMatch(/paying on: DISTANCE from the pickup/i);
        expect(res.out).not.toMatch(/ZONE of the destination ZIP/i);
        expect(res.code).toBe(0);
    });

    /* ── AND THE MILE RANGE SITS BESIDE THE MONEY, so the figure can be
     * checked against the signed letter instead of being taken on trust.
     * Read from PAY_BANDS so the card cannot hold a second, stale copy of
     * a contract term. */
    it('prints each band beside its rate, exactly as the letter bands it', async () => {
        const res = await run(['--show']);

        for (const band of PAY_BANDS) {
            expect(res.out).toContain(band.label);
        }
        /* The letter's own boundaries, spelled out, so a silent edit to
           PAY_BANDS cannot pass this test by agreeing with itself. */
        expect(res.out).toContain('0-10 mi');
        expect(res.out).toContain('11-25 mi');
        expect(res.out).toContain('26-50 mi');
        expect(res.out).toContain('51+ mi');

        /* The letter's dollars against the letter's bands, on one line each,
           which is the whole job of this card: 11-25 miles is 7.25, and the
           week this repository paid 5.00 for a fourteen-mile stop is the
           reason that pairing is asserted rather than assumed. */
        expect(res.out).toMatch(/zone 1\s+0-10 mi\s+USD 5\.00/);
        expect(res.out).toMatch(/zone 2\s+11-25 mi\s+USD 7\.25/);
        expect(res.out).toMatch(/zone 3\s+26-50 mi\s+USD 12\.00/);
        expect(res.out).toMatch(/zone 4\s+51\+ mi\s+USD 22\.00/);
    });

    /* ── ZONE 5 IS UNREACHABLE AND THE CARD HAS TO SAY SO. The letter gives
     * 51+ miles two rates and calls the second special-assignment work
     * offered separately, so no distance selects it and nothing in the
     * system can apply it. A rate listed with no caveat reads as live. */
    it('warns that no distance reaches zone 5', async () => {
        const res = await run(['--show']);

        expect(res.out).toMatch(/zone 5 is not reached by any distance/i);
    });

    /* ── A READ MUST NEVER LOOK LIKE A WRITE. --show takes no production
     * flag precisely so that looking is easy; the banner is then the only
     * thing telling the reader nothing moved. */
    it('names the server and changes nothing', async () => {
        const res = await run(['--show']);

        expect(res.out).toContain(srv.url);
        expect(res.out).not.toMatch(/\bwrote\b|\bupdated\b|\bsaved\b/i);
    });
});
