/* Tickets 6.1 and 6.2, end to end.
 *
 * Twenty drivers signing themselves up is a compliance problem before it is a
 * feature. University Health will ask what stands between a stranger filling
 * in a form and that stranger holding a patient's medication and knowing
 * where they live, and this file is the answer being demonstrated rather than
 * asserted.
 *
 * Two properties carry the whole thing:
 *
 *   An application is not an account. Submitting creates a row, and nothing
 *   that row can do amounts to signing in.
 *   Approval is the only door, and it is locked by five verified checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const APPLY = '/api/driver-applications';
const QUEUE = '/api/projects/uh/driver-applications';
const KINDS = ['hipaa_training', 'confidentiality', 'background_check', 'drivers_licence', 'insurance'];

let srv;
let admin;

const apply = (over = {}) => srv.agent().post(APPLY).send({
    projectCode: 'uh',
    name: 'Wendell Ofori',
    email: `wendell.${Math.random().toString(36).slice(2, 8)}@example.com`,
    phone: '210-555-0300',
    ...over,
});

/** Verify every gate but the ones named. */
async function verifyAll(id, { except = [], expiresAt = null } = {}) {
    for (const kind of KINDS) {
        if (except.includes(kind)) continue;
        const res = await admin.put(`${QUEUE}/${id}/checks/${kind}`).send({
            status: 'verified', reference: `REF-${kind}`, expiresAt, note: '',
        });
        expect(res.status, `verifying ${kind}`).toBe(200);
    }
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('applying to drive', () => {
    it('takes an application from a stranger with no session at all', async () => {
        const res = await apply();
        expect(res.status).toBe(202);
        expect(res.body.ok).toBe(true);
    });

    it('creates an application and NOT an account', async () => {
        /* The whole of ticket 6.1. The row exists; nothing about it can sign
           in, and the applicant has no membership, no password and no way to
           reach a single patient address. */
        const email = `noaccount.${Date.now()}@example.com`;
        await apply({ email, name: 'Nora Bishop' });

        const queue = await admin.get(QUEUE);
        const row = queue.body.applications.find((a) => a.email === email);
        expect(row).toBeDefined();
        expect(row.status).toBe('submitted');
        expect(row.hasAccount).toBe(false);

        // And no user by that name exists to be signed in as.
        const users = await admin.get('/api/users');
        expect(users.body.some((u) => u.email === email)).toBe(false);
    });

    it('opens all five gates pending, so the work is visible immediately', async () => {
        const email = `gates.${Date.now()}@example.com`;
        await apply({ email });
        const id = (await admin.get(QUEUE)).body.applications.find((a) => a.email === email).id;

        const detail = await admin.get(`${QUEUE}/${id}`);
        expect(detail.body.checks.map((c) => c.kind).sort()).toEqual([...KINDS].sort());
        expect(detail.body.checks.every((c) => c.status === 'pending')).toBe(true);
        expect(detail.body.clearance.ready).toBe(false);
    });

    it('answers a duplicate and an unknown project exactly like a good one', async () => {
        /* A public form that says "you have already applied" tells a stranger
           who drives for us. A public form that says "no such project"
           enumerates our contracts. Both get the same 202. */
        const email = `dupe.${Date.now()}@example.com`;
        const first = await apply({ email });
        const second = await apply({ email });
        const nowhere = await apply({ projectCode: 'not-a-project' });

        expect(second.status).toBe(first.status);
        expect(second.body).toEqual(first.body);
        expect(nowhere.status).toBe(first.status);
        expect(nowhere.body).toEqual(first.body);

        // But only one row was actually written.
        const rows = (await admin.get(QUEUE)).body.applications.filter((a) => a.email === email);
        expect(rows).toHaveLength(1);
    });

    it('refuses a application that is not one', async () => {
        const res = await srv.agent().post(APPLY).send({ projectCode: 'uh', name: 'x', email: 'nope', phone: '1' });
        expect(res.status).toBe(400);
    });
});

describe('the gate in front of a patient address', () => {
    async function freshApplication() {
        const email = `gate.${Math.random().toString(36).slice(2, 8)}@example.com`;
        await apply({ email });
        return (await admin.get(QUEUE)).body.applications.find((a) => a.email === email).id;
    }

    it('refuses to approve an application with nothing verified', async () => {
        const id = await freshApplication();
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({
            username: `never.${id}`, temporaryPassword: 'a-temporary-one',
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('onboarding.incomplete');
        expect(res.body.clearance.missing).toHaveLength(5);
    });

    it('refuses while ANY single gate is short, one at a time', async () => {
        for (const kind of KINDS) {
            const id = await freshApplication();
            await verifyAll(id, { except: [kind] });
            const res = await admin.post(`${QUEUE}/${id}/approve`).send({
                username: `short.${id}`, temporaryPassword: 'a-temporary-one',
            });
            expect(res.status, `approving with ${kind} missing`).toBe(409);
            expect(res.body.clearance.missing).toEqual([kind]);
        }
    });

    it('refuses on expired training even though every check says verified', async () => {
        const id = await freshApplication();
        await verifyAll(id);
        await admin.put(`${QUEUE}/${id}/checks/hipaa_training`).send({
            status: 'verified', reference: 'OLD', expiresAt: '2020-01-01', note: '',
        });
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({
            username: `stale.${id}`, temporaryPassword: 'a-temporary-one',
        });
        expect(res.status).toBe(409);
        expect(res.body.clearance.expired).toEqual(['hipaa_training']);
    });

    it('records the refusal, so a pattern of them is visible', async () => {
        const id = await freshApplication();
        await admin.post(`${QUEUE}/${id}/approve`).send({ username: `a.${id}`, temporaryPassword: 'a-temporary-one' });
        const audit = await admin.get('/api/audit?action=application.approve_refused');
        expect(audit.body.events.length).toBeGreaterThan(0);
    });

    it('opens the door once, and only once, when all five are green', async () => {
        const id = await freshApplication();
        await verifyAll(id);

        const detail = await admin.get(`${QUEUE}/${id}`);
        expect(detail.body.clearance.ready).toBe(true);

        const username = `cleared.${id}`;
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({ username, temporaryPassword: 'a-temporary-one' });
        expect(res.status).toBe(201);

        // Now, and only now, there is an account with a courier membership.
        const users = await admin.get('/api/users');
        const made = users.body.find((u) => u.username === username);
        expect(made).toBeDefined();
        expect(made.role).toBe('driver');
        expect(made.memberships.some((m) => m.code === 'uh' && m.role === 'courier')).toBe(true);

        // Approving twice does not make a second account.
        const again = await admin.post(`${QUEUE}/${id}/approve`).send({ username: `${username}.2`, temporaryPassword: 'a-temporary-one' });
        expect(again.status).toBe(409);
    });

    it('will not take a username somebody already has', async () => {
        const id = await freshApplication();
        await verifyAll(id);
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({
            username: 'admin', temporaryPassword: 'a-temporary-one',
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already in use/);
    });
});

describe('deciding against somebody', () => {
    it('will not reject without a reason somebody could defend later', async () => {
        const email = `rej.${Date.now()}@example.com`;
        await apply({ email });
        const id = (await admin.get(QUEUE)).body.applications.find((a) => a.email === email).id;

        expect((await admin.post(`${QUEUE}/${id}/reject`).send({ reason: 'no' })).status).toBe(400);
        expect((await admin.post(`${QUEUE}/${id}/reject`).send({ reason: 'Did not pass the background check.' })).status).toBe(200);

        const after = (await admin.get(QUEUE)).body.applications.find((a) => a.id === id);
        expect(after.status).toBe('rejected');
        expect(after.decisionReason).toMatch(/background check/);
    });

    it('will not quietly reject an application that already made an account', async () => {
        /* Flipping the status here would leave the user alive and nobody
           looking at it. Disabling the person is a different screen with
           different consequences, and it says so. */
        const email = `made.${Date.now()}@example.com`;
        await apply({ email });
        const id = (await admin.get(QUEUE)).body.applications.find((a) => a.email === email).id;
        await verifyAll(id);
        await admin.post(`${QUEUE}/${id}/approve`).send({ username: `made.${id}`, temporaryPassword: 'a-temporary-one' });

        const res = await admin.post(`${QUEUE}/${id}/reject`).send({ reason: 'Changed our minds about this one.' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('application.alreadyApproved');
    });
});
