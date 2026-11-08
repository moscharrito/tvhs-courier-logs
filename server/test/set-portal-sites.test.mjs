/* Widening one portal account's view of the pharmacies.
 *
 * Driven as the operator drives it: the real script, spawned against a real
 * server, with the admin password handed over in SEED_ADMIN_PASS the way the
 * PowerShell wrappers do it. A unit test of the merge would have proved the
 * arithmetic and missed the whole reason this exists.
 *
 * -------------------------------------------------------------------------
 * THE ASSERTION THAT MATTERS IS THE ONE ABOUT WHAT IT DID NOT TOUCH.
 *
 * The contract manager's membership carries `mayResetPortalPasswords` -- the
 * one account allowed to reset the eight counters. A PUT built from a fresh
 * `{ siteIds }` would widen the view and silently take that verb away, and
 * nothing would fail at the time: the next pharmacist locked out would just
 * find that the person who used to be able to help them cannot, weeks later,
 * with nothing to connect it to. So the script reads the membership before it
 * writes one, and this proves it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, SERVER_DIR, CREDS } from './helpers/server.mjs';

const SCRIPT = path.join(SERVER_DIR, 'scripts', 'set-portal-sites.mjs');

let srv;
let admin;
let siteCodes;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteCodes = (await admin.get('/api/projects/uh/uh/sites?status=active')).body.map((s) => s.code);
    expect(siteCodes.length).toBeGreaterThan(2);

    /* A contract-manager-shaped portal: a scope narrower than every counter,
       and a capability beside it. */
    await admin.post('/api/users').send({
        username: 'uh.testmanager', name: 'Test Contract Manager',
        password: 'portal-pass-1', role: 'staff',
    });
    const firstTwo = (await admin.get('/api/projects/uh/uh/sites?status=active')).body.slice(0, 2);
    await admin.put('/api/users/uh.testmanager/memberships/uh').send({
        role: 'pharmacy',
        settings: { siteIds: firstTwo.map((s) => s.id), mayResetPortalPasswords: true },
    });

    /* And an account with no membership on this contract at all. */
    await admin.post('/api/users').send({
        username: 'uh.nomember', name: 'No Membership', password: 'portal-pass-2', role: 'staff',
    });
});
afterAll(async () => { await srv.stop(); });

/** The script, run the way a wrapper runs it. */
function run(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, '--base', srv.url, ...args], {
            cwd: SERVER_DIR,
            env: { ...process.env, SEED_ADMIN_PASS: CREDS.admin.password, SEED_ADMIN_USER: CREDS.admin.username },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { out += String(d); });
        child.on('close', (code) => resolve({ code, out }));
    });
}

const membership = async () => {
    const users = (await admin.get('/api/users')).body;
    const u = users.find((x) => x.username === 'uh.testmanager');
    return (u.memberships ?? []).find((m) => m.code === 'uh');
};

describe('set-portal-sites.mjs', () => {
    it('says what it would change and writes nothing', async () => {
        const before = await membership();
        const res = await run(['--user', 'uh.testmanager', '--sites', 'all']);

        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('Dry run');
        expect(res.out).toContain(`after     ${siteCodes.length} of ${siteCodes.length}`);

        const after = await membership();
        expect(after.settings.siteIds).toEqual(before.settings.siteIds);
    });

    it('widens the scope to every active pharmacy, and keeps the reset capability', async () => {
        const res = await run(['--user', 'uh.testmanager', '--sites', 'all', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('WROTE:');

        const after = await membership();
        expect(after.settings.siteIds.length).toBe(siteCodes.length);
        /* THE POINT OF THE WHOLE FILE. */
        expect(after.settings.mayResetPortalPasswords).toBe(true);
        /* And it did not quietly decide what anybody is. */
        expect(after.role).toBe('pharmacy');
    });

    it('is a no-op the second time, and says so rather than writing again', async () => {
        const res = await run(['--user', 'uh.testmanager', '--sites', 'all', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('already the scope');
        expect(res.out).not.toContain('WROTE:');
    });

    it('refuses a site code the contract does not have', async () => {
        const res = await run(['--user', 'uh.testmanager', '--sites', 'notapharmacy', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('REFUSING');
        /* The known list comes with the refusal: a typo should not need a
           second run to find out what the options were. */
        expect(res.out).toContain(siteCodes[0]);
    });

    it('refuses to invent a membership for an account that has none', async () => {
        const res = await run(['--user', 'uh.nomember', '--sites', 'all', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('no membership on uh');

        const users = (await admin.get('/api/users')).body;
        const u = users.find((x) => x.username === 'uh.nomember');
        expect((u.memberships ?? []).some((m) => m.code === 'uh')).toBe(false);
    });

    it('refuses an account that does not exist', async () => {
        const res = await run(['--user', 'uh.ghost', '--sites', 'all', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('no account called uh.ghost');
    });

    it('can narrow to a named set, and reports what it removed', async () => {
        const res = await run(['--user', 'uh.testmanager', '--sites', siteCodes[0], '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('- ');

        const after = await membership();
        expect(after.settings.siteIds.length).toBe(1);
        expect(after.settings.mayResetPortalPasswords).toBe(true);
    });

    it('refuses production without being told it is production', async () => {
        const res = await new Promise((resolve) => {
            const child = spawn(process.execPath, [
                SCRIPT, '--base', 'https://logs.example.com', '--user', 'uh.testmanager', '--sites', 'all',
            ], { cwd: SERVER_DIR, env: { ...process.env, SEED_ADMIN_PASS: 'x' } });
            let out = '';
            child.stdout.on('data', (d) => { out += String(d); });
            child.stderr.on('data', (d) => { out += String(d); });
            child.on('close', (code) => resolve({ code, out }));
        });
        expect(res.code).toBe(1);
        expect(res.out).toContain('--i-mean-production');
    });
});
