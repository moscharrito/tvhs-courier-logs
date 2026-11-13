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
        expect(res.out).toContain(`->     ${siteCodes.length} of ${siteCodes.length}`);

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
        expect(res.out).toContain('already how this account is set up');
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

/* ───────────────────────────── THE RESET CAPABILITY
 *
 * mayResetPortalPasswords lets one client account reset the eight counter
 * portals, and nothing else: never an Izy login, never a courier, never
 * another manager. It is the only way a locked-out pharmacist is helped
 * without an Izy administrator -- and while SES is in sandbox it is the
 * only way at all, because a self-service reset code is generated and
 * delivered to nobody.
 *
 * It was found missing from uh.manager on 8 November, a week after that
 * account went live, by the scope tool printing "keeping (nothing else in
 * settings)". Nothing had ever failed, because nobody had tried.
 */
describe('set-portal-sites.mjs and the reset capability', () => {
    const settingsOf = async (username) => {
        const users = (await admin.get('/api/users')).body;
        const u = users.find((x) => x.username === username);
        return (u.memberships ?? []).find((m) => m.code === 'uh')?.settings ?? {};
    };

    beforeAll(async () => {
        /* A counter-shaped portal with no capability, standing in for
           uh.manager as it was found. */
        await admin.post('/api/users').send({
            username: 'uh.plain', name: 'Plain Portal', password: 'portal-pass-3', role: 'staff',
        });
        const two = (await admin.get('/api/projects/uh/uh/sites?status=active')).body.slice(0, 2);
        await admin.put('/api/users/uh.plain/memberships/uh').send({
            role: 'pharmacy', settings: { siteIds: two.map((s) => s.id) },
        });
    });

    it('grants it without being given --sites, and leaves the scope alone', async () => {
        const before = await settingsOf('uh.plain');
        expect(before.mayResetPortalPasswords).toBeUndefined();

        const res = await run(['--user', 'uh.plain', '--grant-reset', '--apply', '--also']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('unchanged (no --sites given)');
        expect(res.out).toContain('MAY reset');

        const after = await settingsOf('uh.plain');
        expect(after.mayResetPortalPasswords).toBe(true);
        /* THE SCOPE IS UNTOUCHED. A capability change that silently reset
           somebody's pharmacies to nothing would be the same class of bug
           this file exists to prevent, pointed the other way. */
        expect(after.siteIds).toEqual(before.siteIds);
    });

    it('refuses a second holder unless somebody says so', async () => {
        /* uh.testmanager still carries it from the suite above. */
        expect((await settingsOf('uh.testmanager')).mayResetPortalPasswords).toBe(true);

        await admin.post('/api/users').send({
            username: 'uh.second', name: 'Second Portal', password: 'portal-pass-4', role: 'staff',
        });
        const one = (await admin.get('/api/projects/uh/uh/sites?status=active')).body.slice(0, 1);
        await admin.put('/api/users/uh.second/memberships/uh').send({
            role: 'pharmacy', settings: { siteIds: one.map((s) => s.id) },
        });

        const refused = await run(['--user', 'uh.second', '--grant-reset', '--apply']);
        expect(refused.code).toBe(1);
        expect(refused.out).toContain('already may reset');
        /* AND IT NAMES THEM, so the next decision does not need a hunt. */
        expect(refused.out).toMatch(/uh\.(testmanager|plain)/);
        expect((await settingsOf('uh.second')).mayResetPortalPasswords).toBeUndefined();

        const allowed = await run(['--user', 'uh.second', '--grant-reset', '--apply', '--also']);
        expect(allowed.code, allowed.out).toBe(0);
        expect((await settingsOf('uh.second')).mayResetPortalPasswords).toBe(true);
    });

    it('revokes by deleting the key rather than writing false', async () => {
        const res = await run(['--user', 'uh.second', '--revoke-reset', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('may NOT reset');

        const after = await settingsOf('uh.second');
        /* ABSENT, NOT false. mayReset() tests for a literal true so both
           read the same to the server -- but a blob is read by people too,
           and `false` looks like a considered denial rather than a verb
           nobody was ever given. */
        expect('mayResetPortalPasswords' in after).toBe(false);
        /* The scope survived the revoke as well. */
        expect(after.siteIds.length).toBe(1);
    });

    it('is a no-op when it already holds it, and writes nothing', async () => {
        const res = await run(['--user', 'uh.plain', '--grant-reset', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('already how this account is set up');
        expect(res.out).not.toContain('WROTE:');
    });

    it('refuses both flags at once rather than picking one', async () => {
        const res = await run(['--user', 'uh.plain', '--grant-reset', '--revoke-reset', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('opposites');
    });

    it('needs no --sites, but still needs a user', async () => {
        const res = await run(['--grant-reset', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('Usage:');
    });

    it('changes the scope and grants in one write when asked for both', async () => {
        const res = await run([
            '--user', 'uh.plain', '--sites', 'all', '--grant-reset', '--apply', '--also',
        ]);
        expect(res.code, res.out).toBe(0);

        const after = await settingsOf('uh.plain');
        expect(after.siteIds.length).toBe(siteCodes.length);
        expect(after.mayResetPortalPasswords).toBe(true);
    });
});

/* ──────────────────────────── saying an account has no counter of its own
 *
 * `overseesContract` arrived on 12 November 2026 with the billing accounts.
 * It grants nothing and refuses nothing: it takes the counter panels off a
 * screen -- "Send a list", and the receipt for the lists already handed
 * over -- for somebody who oversees nine pharmacies and dispenses at none.
 *
 * It is here rather than in create-pharmacy-portals.mjs because uh.manager
 * ALREADY EXISTS on production and needs the key added to a membership that
 * must keep everything else it has. That is the merge this script was
 * written for, and the test that matters is still the one about what it did
 * not touch.
 */
describe('set-portal-sites.mjs and the counter panels', () => {
    const settingsOf = async (username) => {
        const users = (await admin.get('/api/users')).body;
        const u = users.find((x) => x.username === username);
        return (u.memberships ?? []).find((m) => m.code === 'uh')?.settings ?? {};
    };

    it('grants it without --sites, and keeps the scope and the reset verb', async () => {
        /* uh.testmanager is the live shape: every counter, and the reset.
           Adding oversight must cost it neither. */
        const before = await settingsOf('uh.testmanager');
        expect(before.mayResetPortalPasswords).toBe(true);
        expect(before.overseesContract).toBeUndefined();

        const res = await run(['--user', 'uh.testmanager', '--grant-oversight', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('unchanged (no --sites given)');
        expect(res.out).toContain('oversees the contract');

        const after = await settingsOf('uh.testmanager');
        expect(after.overseesContract).toBe(true);
        expect(after.mayResetPortalPasswords).toBe(true);
        expect(after.siteIds).toEqual(before.siteIds);
    });

    it('says out loud that it changes who the manager can reset', async () => {
        /* The one consequence beyond a screen. An operator who reads only
           the flag name would not expect it, so the script says it before
           it writes rather than leaving it to be found weeks later by a
           pharmacist who cannot be helped. */
        const res = await run(['--user', 'uh.plain', '--grant-oversight']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toMatch(/OUT of the reset list/i);
        expect(res.out).toContain('Dry run');
    });

    it('is a no-op the second time rather than writing again', async () => {
        const res = await run(['--user', 'uh.testmanager', '--grant-oversight', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('already how this account is set up');
        expect(res.out).not.toContain('WROTE:');
    });

    it('revokes by deleting the key rather than writing false', async () => {
        /* oversees() tests for a literal true, so `false` would read the
           same as absent -- but a settings blob is read by people too, and
           a key saying false looks like a considered denial. */
        const res = await run(['--user', 'uh.testmanager', '--revoke-oversight', '--apply']);
        expect(res.code, res.out).toBe(0);
        const after = await settingsOf('uh.testmanager');
        expect('overseesContract' in after).toBe(false);
        expect(after.mayResetPortalPasswords).toBe(true);
    });

    it('refuses both flags at once rather than picking one', async () => {
        const res = await run(['--user', 'uh.plain', '--grant-oversight', '--revoke-oversight', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('opposites');
    });

    it('needs no --sites, but still needs a user', async () => {
        const res = await run(['--grant-oversight', '--apply']);
        expect(res.code).toBe(1);
        expect(res.out).toContain('Usage:');
    });

    it('asks no permission for a second one, because it is not a verb', async () => {
        /* --also exists for the reset because everybody holding that can
           take over a counter portal. Several accounts overseeing the
           contract is the ordinary case: a manager and two in billing. */
        const res = await run(['--user', 'uh.plain', '--grant-oversight', '--apply']);
        expect(res.code, res.out).toBe(0);
        expect(res.out).toContain('WROTE:');
        expect(res.out).not.toMatch(/Pass --also/);
        expect((await settingsOf('uh.plain')).overseesContract).toBe(true);
    });
});
