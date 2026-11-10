/* The script that puts coordinates on the pharmacies.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT IS TESTED RATHER THAN JUST RUN.
 *
 * It is the first step of the pay repair and it is about to be pointed at
 * production. Every courier's band is a distance measured FROM one of these
 * nine points, so this script's output is the thing somebody decides on --
 * and the two ways it can mislead are both silent:
 *
 *   it says nothing about the provider and somebody assumes there is one;
 *   it half-finishes on a quota and the distance table is measured from a
 *   half-located set of counters.
 *
 * Driven as the operator drives it: the real script, spawned against a real
 * server, password in SEED_ADMIN_PASS the way the wrapper hands it over.
 *
 * NO PROVIDER IS CONFIGURED IN A TEST SERVER, which is not a limitation
 * here -- it is the most likely production state and the one the script has
 * to refuse clearly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, SERVER_DIR, CREDS } from './helpers/server.mjs';

const SCRIPT = path.join(SERVER_DIR, 'scripts', 'geocode-sites.mjs');

let srv;

function run(extra = []) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, '--base', srv.url, '--project', 'uh', ...extra], {
            cwd: SERVER_DIR,
            env: { ...process.env, SEED_ADMIN_PASS: CREDS.admin.password, SEED_ADMIN_USER: CREDS.admin.username },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        child.on('close', (code) => resolve({ code, out }));
    });
}

beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

describe('geocode-sites.mjs', () => {
    /* ── THE REFUSAL THAT MATTERS MOST. With no provider there is nothing to
     * look up, and the next step -- measuring every pay band -- is blocked
     * behind it. Saying "0 located" and exiting 0 would read as "done". */
    it('refuses, and says which environment variable is missing', async () => {
        const res = await run();

        expect(res.out).toContain('NOT AVAILABLE');
        expect(res.out).toContain('NOTHING CAN BE GEOCODED');
        /* Both options, with the HIPAA-eligible one named as such: whoever
           sets this is also deciding what may be looked up later. */
        expect(res.out).toContain('AWS_LOCATION_');
        expect(res.out).toContain('GOOGLE_MAPS_API_KEY');
        /* A non-zero exit, so a wrapper or a CI step cannot read it as done. */
        expect(res.code).toBe(1);
    });

    it('names the pharmacies that have no coordinates', async () => {
        const res = await run();

        /* The nine counters are seeded by the migrations and none of them is
           located in a fresh database, which is exactly the production
           symptom that started this. */
        expect(res.out).toContain('PHARMACIES');
        expect(res.out).toMatch(/0 of \d+ already have coordinates/);
        for (const code of ['discharge', 'green', 'wheatley']) {
            expect(res.out).toContain(code);
        }
    });

    /* ── AND IT SAYS WHAT IT IS, EVERY TIME. The banner has to state which
     * server and whether anything will be written, because this file gets
     * pasted into a conversation and read by somebody who did not type the
     * command. */
    it('says which server and whether it will write', async () => {
        const read = await run();
        expect(read.out).toContain('MODE     read only');
        expect(read.out).toContain(srv.url);

        const write = await run(['--apply']);
        expect(write.out).toContain('APPLY');
    });

    /* ── NO PATIENT, ANYWHERE. The one thing this script must never be
     * confused for is a tool that geocodes deliveries. */
    it('never mentions looking up a delivery address', async () => {
        const res = await run();
        expect(res.out).not.toMatch(/patient address(es)? (is|are) (sent|looked)/i);
        expect(res.out).not.toContain('orders');
    });
});
