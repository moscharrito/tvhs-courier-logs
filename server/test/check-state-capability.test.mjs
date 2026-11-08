/* What check-state.mjs says about who may reset a pharmacy portal.
 *
 * -------------------------------------------------------------------------
 * WHY THIS IS WORTH A TEST FILE OF ITS OWN.
 *
 * On 8 November uh.manager was found holding nine pharmacies and no
 * mayResetPortalPasswords -- a week after going live, by accident, because
 * a different script happened to print "keeping (nothing else in
 * settings)". Nothing had ever failed. Nothing would have: the capability
 * is only read when somebody tries to reset a portal, and nobody had.
 *
 * That is the shape of fault this script exists to find, and it was not
 * looking. It printed each portal account's site count and said nothing
 * about the one verb that decides whether a locked-out pharmacist can be
 * helped at all -- which matters more than usual while SES is in sandbox,
 * because the self-service reset generates a code and delivers it nowhere.
 *
 * So it now reports the capability per account AND says outright when
 * nobody has it. The second half is the part that would have caught this:
 * an absence is not noticeable as a missing line on eight accounts.
 *
 * Driven as the operator drives it -- the real script, spawned against a
 * real server, password in SEED_ADMIN_PASS the way check.ps1 hands it over.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, SERVER_DIR, CREDS } from './helpers/server.mjs';

const SCRIPT = path.join(SERVER_DIR, 'scripts', 'check-state.mjs');

let srv;
let admin;
let siteIds;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteIds = (await admin.get('/api/projects/uh/uh/sites?status=active')).body.map((s) => s.id);
    expect(siteIds.length).toBeGreaterThan(1);
});
afterAll(async () => { await srv.stop(); });

function run() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, '--base', srv.url, '--project', 'uh'], {
            cwd: SERVER_DIR,
            env: { ...process.env, SEED_ADMIN_PASS: CREDS.admin.password, SEED_ADMIN_USER: CREDS.admin.username },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        child.on('close', (code) => resolve({ code, out }));
    });
}

/** A pharmacy portal, with or without the verb. */
async function portal(username, { mayReset = false, sites = 1, status } = {}) {
    await admin.post('/api/users').send({
        username, name: `Portal ${username}`, password: 'portal-pass-9', role: 'staff',
    });
    await admin.put(`/api/users/${username}/memberships/uh`).send({
        role: 'pharmacy',
        settings: {
            siteIds: siteIds.slice(0, sites),
            ...(mayReset ? { mayResetPortalPasswords: true } : {}),
        },
    });
    if (status) await admin.patch(`/api/users/${username}`).send({ status });
}

describe('check-state.mjs on the reset capability', () => {
    it('says outright when nobody may reset a portal', async () => {
        await portal('cap.one', { mayReset: false });

        const res = await run();
        expect(res.code, res.out).toBe(0);
        /* THE LINE THAT WOULD HAVE CAUGHT IT. Not a missing annotation on
           one account among eight -- a sentence saying the capability is
           held by nobody. */
        expect(res.out).toContain('NOBODY MAY RESET A PORTAL PASSWORD');
        /* And why it matters right now rather than in the abstract. */
        expect(res.out).toContain('sandbox');
        expect(res.out).toContain('create-pharmacy-portals.mjs');
    });

    it('marks the account that holds it, and stops warning', async () => {
        await portal('cap.two', { mayReset: true });

        const res = await run();
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('may reset the other portals');
        expect(res.out).not.toContain('NOBODY MAY RESET');
    });

    it('warns when more than one account can take over any counter portal', async () => {
        await portal('cap.three', { mayReset: true });

        const res = await run();
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('2 accounts may reset the portals');
        expect(res.out).toContain('cap.two');
        expect(res.out).toContain('cap.three');
        expect(res.out).toContain('Expected one');
    });

    /* A LITERAL true AND NOTHING ELSE, the way the server reads it.
       portal-capability.ts: a settings blob is JSON somebody may have
       hand-edited, and the string "false" is truthy. A check that disagreed
       with the server about who holds a capability is worse than no check,
       because it is the thing people would trust instead of looking. */
    it('does not credit a capability the server would not honour', async () => {
        await admin.post('/api/users').send({
            username: 'cap.stringy', name: 'Stringy', password: 'portal-pass-9', role: 'staff',
        });
        await admin.put('/api/users/cap.stringy/memberships/uh').send({
            role: 'pharmacy',
            settings: { siteIds: siteIds.slice(0, 1), mayResetPortalPasswords: 'false' },
        });

        const res = await run();
        expect(res.code, res.out).toBe(0);
        /* Still two, not three: the string is not the capability. */
        expect(res.out).toContain('2 accounts may reset the portals');

        /* ASSERTED ON THE LIST, NOT ON THE WHOLE OUTPUT. cap.stringy is a
           pharmacy portal and belongs in the viewers above with its site
           count -- that part is right. What must not happen is it being
           named as a holder. An earlier version of this test looked for the
           username anywhere in the report and failed on the line that was
           correct. */
        const named = res.out.split('\n').find((l) => l.includes('accounts may reset the portals')) ?? '';
        expect(named).toContain('cap.two');
        expect(named).toContain('cap.three');
        expect(named).not.toContain('cap.stringy');

        /* And it carries no per-account annotation either. */
        const its = res.out.split('\n');
        const at = its.findIndex((l) => l.includes('cap.stringy'));
        expect(at).toBeGreaterThan(-1);
        expect(its.slice(at, at + 3).join(' ')).not.toContain('may reset the other portals');
    });
});
