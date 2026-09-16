/* Tickets 6.1 and 6.2, end to end.
 *
 * Twenty drivers signing themselves up is a compliance problem before it is a
 * feature. University Health will ask what stands between a stranger filling
 * in a form and that stranger holding a patient's medication and knowing
 * where they live, and this file is the answer being demonstrated rather than
 * asserted.
 *
 * The DoorDash model: signup creates an account with the password the
 * applicant chose, and that account can sign in immediately and see nothing.
 * So the property under test is not "there is no account". It is:
 *
 *   NO MEMBERSHIP, NO DATA. An unvetted applicant holds a real login that
 *   reaches exactly one thing, their own application status.
 *   APPROVAL IS THE ONLY DOOR, locked by five verified and current checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const APPLY = '/api/driver-applications';
const QUEUE = '/api/projects/uh/driver-applications';
const KINDS = ['hipaa_training', 'confidentiality', 'background_check', 'drivers_licence', 'insurance'];

let srv;
let admin;

const PASSWORD = 'the-one-they-chose';

const apply = (over = {}) => srv.agent().post(APPLY).send({
    projectCode: 'uh',
    name: 'Wendell Ofori',
    email: `wendell.${Math.random().toString(36).slice(2, 8)}@example.com`,
    phone: '210-555-0300',
    password: PASSWORD,
    ...over,
});

/** Sign in as an applicant, the way they would from the app. */
async function signIn(email, password = PASSWORD) {
    const agent = srv.agent();
    const res = await agent.post('/api/login').send({ username: email, password });
    return { agent, status: res.status };
}

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

    it('creates an account that can sign in and belongs to no project', async () => {
        const email = `signsin.${Date.now()}@example.com`;
        await apply({ email, name: 'Nora Bishop' });

        const row = (await admin.get(QUEUE)).body.applications.find((a) => a.email === email);
        expect(row.status).toBe('submitted');
        expect(row.hasAccount).toBe(true);

        const { status } = await signIn(email);
        expect(status, 'an applicant can sign in from the moment they apply').toBe(200);

        const made = (await admin.get('/api/users')).body.find((u) => u.username === email);
        expect(made.role).toBe('driver');
        expect(made.memberships, 'and belongs to nothing').toEqual([]);
    });

    it('gives that account no way to reach a patient, which is the whole property', async () => {
        /* The DoorDash trade: there are credentialed accounts for people
           nobody has vetted. This is the assertion that makes that safe. */
        const email = `nothing.${Date.now()}@example.com`;
        await apply({ email });
        const { agent } = await signIn(email);

        for (const path of [
            '/api/projects/uh/uh/orders',
            '/api/projects/uh/uh/board',
            '/api/projects/uh/uh/runs/mine',
            '/api/projects/uh/uh/sites',
            '/api/projects/uh/driver-applications',
            '/api/users',
            '/api/audit',
        ]) {
            const res = await agent.get(path);
            expect([401, 403, 404], `${path} answered ${res.status}`).toContain(res.status);
        }

        // Their own projects list is empty, so the shell shows them nothing.
        expect((await agent.get('/api/me/projects')).body).toEqual([]);
    });

    it('shows an applicant their own status and not our paperwork', async () => {
        const email = `status.${Date.now()}@example.com`;
        await apply({ email });
        const id = (await admin.get(QUEUE)).body.applications.find((a) => a.email === email).id;
        await admin.put(`${QUEUE}/${id}/checks/hipaa_training`).send({
            status: 'verified', reference: 'CERT-SECRET-12345', expiresAt: null, note: 'internal note',
        });

        const { agent } = await signIn(email);
        const mine = await agent.get('/api/me/application');
        expect(mine.status).toBe(200);
        expect(mine.body.status).toBe('submitted');
        expect(mine.body.clearance.ready).toBe(false);
        expect(mine.body.checks.find((c) => c.kind === 'hipaa_training').status).toBe('verified');

        /* Not the reference, not the verifier, not the note. A background
           check reference is our record of somebody else's report. */
        const text = JSON.stringify(mine.body);
        expect(text).not.toMatch(/CERT-SECRET-12345/);
        expect(text).not.toMatch(/internal note/);
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

    it('refuses an application that is not one', async () => {
        const res = await srv.agent().post(APPLY).send({ projectCode: 'uh', name: 'x', email: 'nope', phone: '1' });
        expect(res.status).toBe(400);
    });

    it('refuses a password too short to be one', async () => {
        expect((await apply({ password: 'short' })).status).toBe(400);
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
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('onboarding.incomplete');
        expect(res.body.clearance.missing).toHaveLength(5);
    });

    it('refuses while ANY single gate is short, one at a time', async () => {
        for (const kind of KINDS) {
            const id = await freshApplication();
            await verifyAll(id, { except: [kind] });
            const res = await admin.post(`${QUEUE}/${id}/approve`).send({});
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
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({});
        expect(res.status).toBe(409);
        expect(res.body.clearance.expired).toEqual(['hipaa_training']);
    });

    it('records the refusal, so a pattern of them is visible', async () => {
        const id = await freshApplication();
        await admin.post(`${QUEUE}/${id}/approve`).send({});
        const audit = await admin.get('/api/audit?action=application.approve_refused');
        expect(audit.body.events.length).toBeGreaterThan(0);
    });

    it('opens the door once, and only once, when all five are green', async () => {
        const id = await freshApplication();
        await verifyAll(id);

        const detail = await admin.get(`${QUEUE}/${id}`);
        expect(detail.body.clearance.ready).toBe(true);

        const email = detail.body.email;
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({});
        expect(res.status).toBe(201);

        /* The account existed all along. What it lacked, until this moment,
           was a membership, and the membership is the whole of the access. */
        const made = (await admin.get('/api/users')).body.find((u) => u.username === email);
        expect(made.memberships.some((m) => m.code === 'uh' && m.role === 'courier')).toBe(true);

        // The same login that could see nothing an hour ago now sees a run.
        const { agent } = await signIn(email);
        expect((await agent.get('/api/projects/uh/uh/runs/mine')).status).toBe(200);

        // Approving twice is refused rather than repeated.
        expect((await admin.post(`${QUEUE}/${id}/approve`).send({})).status).toBe(409);
    });

    it('will not approve a row from before this flow, which has no account', async () => {
        /* user_id stays nullable because the first cut of 6.1 wrote rows with
           no account behind them. Approving one would grant a membership to
           nobody, so it says so instead of half-working. */
        const id = await freshApplication();
        await verifyAll(id);
        await srv.core.client.execute({ sql: 'UPDATE driver_applications SET user_id = NULL WHERE id = ?', args: [id] });
        const res = await admin.post(`${QUEUE}/${id}/approve`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('application.noAccount');
    });

    it('disables the account when an application is rejected', async () => {
        /* The cost of the DoorDash model, paid rather than left lying about:
           a live credential for somebody who failed a background check. */
        const email = `turneddown.${Date.now()}@example.com`;
        await apply({ email });
        const id = (await admin.get(QUEUE)).body.applications.find((a) => a.email === email).id;
        expect((await signIn(email)).status).toBe(200);

        await admin.post(`${QUEUE}/${id}/reject`).send({ reason: 'Did not pass the background check.' });
        expect((await signIn(email)).status).not.toBe(200);
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
        await admin.post(`${QUEUE}/${id}/approve`).send({});

        const res = await admin.post(`${QUEUE}/${id}/reject`).send({ reason: 'Changed our minds about this one.' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('application.alreadyApproved');
    });
});
