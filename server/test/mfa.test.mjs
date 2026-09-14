/* Setting up a second factor, and signing in with one.
 *
 * Ticket 4.3. The arithmetic is proved against the RFC in totp.test.mjs; this
 * is about the flow around it: that a password alone stops being a session,
 * that a code cannot be used twice, that a recovery code works exactly once,
 * and that losing a phone has an answer that is not "rebuild the database".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { totpAt, stepAt } from '../src/core/auth/totp.ts';
import { requiredForRoles, generateRecoveryCode, normaliseRecoveryCode, RECOVERY_CODE_COUNT } from '../src/core/auth/mfa.ts';

const PASS = 'mfa-pass-4417';

let srv;
let admin;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

/** A staff account with a uh membership, signed in, with nothing set up yet. */
async function person(username, role = 'dispatcher') {
    const created = await admin.post('/api/users').send({ username, name: username, password: PASS, role: 'staff' });
    expect(created.status, created.text).toBe(201);
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const agent = srv.agent();
    expect((await agent.post('/api/login').send({ username, password: PASS })).status).toBe(200);
    return agent;
}

/* Confirming an enrolment spends the code for the step it happened in, and a
 * spent code is never accepted again (that is the point of `lastStep`). So a
 * test that signs in afterwards has to use the NEXT code, which the verifier
 * accepts because its window is one step either side. */
const nextCode = (secret) => totpAt(secret, stepAt() + 1);

/** Enrol and confirm, returning the agent, the secret and the codes. */
async function enrolled(username, role = 'dispatcher') {
    const agent = await person(username, role);
    const start = await agent.post('/api/me/mfa/enrol').send({ password: PASS });
    expect(start.status, start.text).toBe(201);
    const secret = start.body.secret;
    const confirm = await agent.post('/api/me/mfa/confirm').send({ code: totpAt(secret, stepAt()) });
    expect(confirm.status, confirm.text).toBe(201);
    return { agent, secret, recoveryCodes: confirm.body.recoveryCodes };
}

/* ------------------------------------------------------------- the policy */

describe('who needs one', () => {
    it('is decided by role, and couriers are deliberately outside it', () => {
        expect(requiredForRoles('admin', [])).toBe(true);
        expect(requiredForRoles('staff', ['dispatcher'])).toBe(true);
        expect(requiredForRoles('staff', ['ops_manager'])).toBe(true);
        expect(requiredForRoles('staff', ['admin'])).toBe(true);
        /* A courier's second factor is the enrolled phone (ticket 2.3). A
           rotating code read off a second device at a pharmacy counter is a
           control people work around, which is worse than none. */
        expect(requiredForRoles('driver', ['courier'])).toBe(false);
        // An outside pharmacy contact, who sees only their own deliveries.
        expect(requiredForRoles('staff', ['client_viewer'])).toBe(false);
    });

    it('reports itself honestly before anything is set up', async () => {
        const agent = await person('mfa.fresh');
        const res = await agent.get('/api/me/mfa');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ required: true, enrolled: false, confirmed: false, recoveryCodesRemaining: 0 });
    });

    it('does not ask a courier for one', async () => {
        const agent = await person('mfa.courier', 'courier');
        expect((await agent.get('/api/me/mfa')).body.required).toBe(false);
    });
});

/* ---------------------------------------------------------------- enrolling */

describe('setting one up', () => {
    it('asks for the password again, because an unlocked screen is not proof', async () => {
        const agent = await person('mfa.needs.password');
        const res = await agent.post('/api/me/mfa/enrol').send({ password: 'not-the-password' });
        expect(res.status).toBe(401);
        expect((await agent.get('/api/me/mfa')).body.enrolled).toBe(false);
    });

    it('hands back a secret and a URI the authenticator app can read', async () => {
        const agent = await person('mfa.starts');
        const res = await agent.post('/api/me/mfa/enrol').send({ password: PASS });
        expect(res.status).toBe(201);
        expect(res.body.secret).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4})+$/);
        expect(res.body.uri).toContain('otpauth://totp/TAG:mfa.starts');
        // Started, but granting nothing until a code proves the app has it.
        expect((await agent.get('/api/me/mfa')).body).toMatchObject({ enrolled: true, confirmed: false });
    });

    it('refuses to confirm with the wrong code', async () => {
        const agent = await person('mfa.wrong.code');
        await agent.post('/api/me/mfa/enrol').send({ password: PASS });
        const res = await agent.post('/api/me/mfa/confirm').send({ code: '000000' });
        expect(res.status).toBe(401);
        expect((await agent.get('/api/me/mfa')).body.confirmed).toBe(false);
    });

    it('confirms with a real code and hands over ten recovery codes, once', async () => {
        const { agent, recoveryCodes } = await enrolled('mfa.confirms');
        expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
        expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
        for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

        const status = await agent.get('/api/me/mfa');
        expect(status.body).toMatchObject({ confirmed: true, recoveryCodesRemaining: RECOVERY_CODE_COUNT });
        // The codes are never readable again: the database holds hashes.
        expect(JSON.stringify(status.body)).not.toContain(recoveryCodes[0]);
    });

    it('will not let a second enrolment quietly replace the first', async () => {
        /* Otherwise an unlocked screen is enough to point the factor at
           somebody else's phone, which turns the control upside down. */
        const { agent } = await enrolled('mfa.no.swap');
        const res = await agent.post('/api/me/mfa/enrol').send({ password: PASS });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('mfa.already_enrolled');
    });

    it('keeps the secret out of every later response', async () => {
        const { agent } = await enrolled('mfa.secret.hidden');
        const status = await agent.get('/api/me/mfa');
        expect(JSON.stringify(status.body)).not.toMatch(/[A-Z2-7]{16}/);
    });
});

/* ----------------------------------------------------------------- signing in */

describe('signing in with one', () => {
    it('stops handing out a session for a password alone', async () => {
        const { secret } = await enrolled('mfa.two.step');
        const agent = srv.agent();

        const first = await agent.post('/api/login').send({ username: 'mfa.two.step', password: PASS });
        expect(first.status).toBe(200);
        expect(first.body.mfaRequired).toBe(true);
        expect(first.body.challengeToken).toBeTruthy();
        // No session yet: the password was right and that is not enough.
        expect((await agent.get('/api/session')).status).toBe(401);

        const second = await agent.post('/api/login/mfa')
            .send({ challengeToken: first.body.challengeToken, code: nextCode(secret) });
        expect(second.status, second.text).toBe(200);
        expect(second.body.username).toBe('mfa.two.step');
        expect((await agent.get('/api/session')).status).toBe(200);
    });

    it('never returns the challenge token to somebody with the wrong password', async () => {
        await enrolled('mfa.bad.password');
        const res = await srv.agent().post('/api/login').send({ username: 'mfa.bad.password', password: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.body.challengeToken).toBeUndefined();
    });

    it('refuses a wrong code and gives no session', async () => {
        const { secret } = await enrolled('mfa.wrong.at.login');
        const agent = srv.agent();
        const first = await agent.post('/api/login').send({ username: 'mfa.wrong.at.login', password: PASS });
        const res = await agent.post('/api/login/mfa').send({ challengeToken: first.body.challengeToken, code: '000000' });
        expect(res.status).toBe(401);
        expect((await agent.get('/api/session')).status).toBe(401);
        // The challenge is still good: a typo should not mean starting over.
        const ok = await agent.post('/api/login/mfa')
            .send({ challengeToken: first.body.challengeToken, code: nextCode(secret) });
        expect(ok.status).toBe(200);
    });

    it('tears up a challenge after five wrong codes', async () => {
        const { secret } = await enrolled('mfa.exhausted');
        const agent = srv.agent();
        const first = await agent.post('/api/login').send({ username: 'mfa.exhausted', password: PASS });
        const token = first.body.challengeToken;
        for (let i = 0; i < 5; i += 1) {
            const res = await agent.post('/api/login/mfa').send({ challengeToken: token, code: String(100000 + i) });
            expect(res.status, `attempt ${i}`).toBe(401);
        }
        /* Six digits is a million possibilities and a whole window to try
           them in, so the challenge itself counts attempts: five wrong ones
           and it is torn up, even for a caller who then produces the right
           code. Opening another one costs a password, which is throttled. */
        const dead = await agent.post('/api/login/mfa').send({ challengeToken: token, code: nextCode(secret) });
        expect(dead.status).toBe(401);
        expect(dead.body.code).toBe('mfa.challenge_expired');
    });

    it('will not answer the same challenge twice', async () => {
        const { secret } = await enrolled('mfa.one.shot');
        const agent = srv.agent();
        const first = await agent.post('/api/login').send({ username: 'mfa.one.shot', password: PASS });
        const token = first.body.challengeToken;
        const code = nextCode(secret);
        expect((await agent.post('/api/login/mfa').send({ challengeToken: token, code })).status).toBe(200);

        const replay = await srv.agent().post('/api/login/mfa').send({ challengeToken: token, code });
        expect(replay.status).toBe(401);
    });

    it('refuses a code that has already been used, inside its own window', async () => {
        /* A code lives thirty seconds and is accepted one step either side.
           Without this, a code read over a shoulder or out of a screen share
           is good for up to a minute and a half. */
        const { secret } = await enrolled('mfa.no.replay');
        const code = nextCode(secret);

        const one = srv.agent();
        const a = await one.post('/api/login').send({ username: 'mfa.no.replay', password: PASS });
        expect((await one.post('/api/login/mfa').send({ challengeToken: a.body.challengeToken, code })).status).toBe(200);

        const two = srv.agent();
        const b = await two.post('/api/login').send({ username: 'mfa.no.replay', password: PASS });
        const replay = await two.post('/api/login/mfa').send({ challengeToken: b.body.challengeToken, code });
        expect(replay.status).toBe(401);
        expect((await two.get('/api/session')).status).toBe(401);
    });

    it('lets a courier sign in with a password as before', async () => {
        await person('mfa.courier.login', 'courier');
        const res = await srv.agent().post('/api/login').send({ username: 'mfa.courier.login', password: PASS });
        expect(res.status).toBe(200);
        expect(res.body.mfaRequired).toBeUndefined();
        expect(res.body.username).toBe('mfa.courier.login');
    });
});

/* ------------------------------------------------------------ recovery codes */

describe('the phone is in a taxi', () => {
    it('accepts a recovery code in the same field as a real one', async () => {
        const { recoveryCodes } = await enrolled('mfa.recovers');
        const agent = srv.agent();
        const first = await agent.post('/api/login').send({ username: 'mfa.recovers', password: PASS });
        const res = await agent.post('/api/login/mfa')
            .send({ challengeToken: first.body.challengeToken, code: recoveryCodes[0] });
        expect(res.status, res.text).toBe(200);
        expect(res.body.usedRecoveryCode).toBe(true);
        expect(res.body.recoveryCodesRemaining).toBe(RECOVERY_CODE_COUNT - 1);
    });

    it('spends it: the same code does not work twice', async () => {
        const { recoveryCodes } = await enrolled('mfa.spends');
        const use = async (code) => {
            const agent = srv.agent();
            const first = await agent.post('/api/login').send({ username: 'mfa.spends', password: PASS });
            return agent.post('/api/login/mfa').send({ challengeToken: first.body.challengeToken, code });
        };
        expect((await use(recoveryCodes[0])).status).toBe(200);
        expect((await use(recoveryCodes[0])).status).toBe(401);
        // A different one still works.
        expect((await use(recoveryCodes[1])).status).toBe(200);
    });

    it('reads a code back the way a person would type it', async () => {
        const { recoveryCodes } = await enrolled('mfa.typing');
        const agent = srv.agent();
        const first = await agent.post('/api/login').send({ username: 'mfa.typing', password: PASS });
        const typed = recoveryCodes[0].replace('-', ' ').toLowerCase();
        const res = await agent.post('/api/login/mfa').send({ challengeToken: first.body.challengeToken, code: typed });
        expect(res.status).toBe(200);
    });

    it('reissues codes, and the old ones die', async () => {
        const { agent, secret, recoveryCodes } = await enrolled('mfa.reissues');
        const res = await agent.post('/api/me/mfa/recovery-codes')
            .send({ password: PASS, code: nextCode(secret) });
        expect(res.status, res.text).toBe(200);
        expect(res.body.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
        expect(res.body.recoveryCodes).not.toContain(recoveryCodes[0]);

        const fresh = srv.agent();
        const first = await fresh.post('/api/login').send({ username: 'mfa.reissues', password: PASS });
        const dead = await fresh.post('/api/login/mfa').send({ challengeToken: first.body.challengeToken, code: recoveryCodes[0] });
        expect(dead.status).toBe(401);
    });

    it('generates codes without the letters people misread', () => {
        for (let i = 0; i < 200; i += 1) {
            const code = generateRecoveryCode();
            // No 0/O, 1/I/L or 5/S: these get printed and read down a phone.
            expect(code).not.toMatch(/[01ILOS5]/);
            expect(normaliseRecoveryCode(code)).toHaveLength(10);
        }
    });
});

/* -------------------------------------------------------- turning it off */

describe('turning it off', () => {
    it('needs the password and a current code', async () => {
        /* Not enforced in the test environment, so a dispatcher may. In
           production the policy refuses, which mfa-enforcement covers. */
        const { agent, secret } = await enrolled('mfa.turns.off');
        const wrong = await agent.delete('/api/me/mfa').send({ password: 'no', code: nextCode(secret) });
        expect(wrong.status).toBe(401);

        const res = await agent.delete('/api/me/mfa').send({ password: PASS, code: nextCode(secret) });
        expect(res.status, res.text).toBe(200);
        expect((await agent.get('/api/me/mfa')).body).toMatchObject({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0 });

        // And the password alone is a session again.
        const fresh = await srv.agent().post('/api/login').send({ username: 'mfa.turns.off', password: PASS });
        expect(fresh.body.mfaRequired).toBeUndefined();
    });
});

/* ------------------------------------------------------------ a lost phone */

describe('a lost phone, and no recovery codes either', () => {
    it('an administrator resets it, and every live session goes with it', async () => {
        const { agent } = await enrolled('mfa.lost.phone');
        expect((await agent.get('/api/me/mfa')).body.confirmed).toBe(true);

        const res = await admin.post('/api/users/mfa.lost.phone/mfa/reset').send({});
        expect(res.status, res.text).toBe(200);

        /* The lost phone may be holding a live session of theirs, so the
           reset takes those too. */
        expect((await agent.get('/api/session')).status).toBe(401);

        const back = srv.agent();
        const login = await back.post('/api/login').send({ username: 'mfa.lost.phone', password: PASS });
        expect(login.body.mfaRequired).toBeUndefined();
        expect((await back.get('/api/me/mfa')).body).toMatchObject({ enrolled: false, required: true });
    });

    it('is for administrators, and for nobody else', async () => {
        await enrolled('mfa.not.yours');
        const other = await person('mfa.meddler');
        expect((await other.post('/api/users/mfa.not.yours/mfa/reset').send({})).status).toBe(403);
        expect((await srv.agent().post('/api/users/mfa.not.yours/mfa/reset').send({})).status).toBe(401);
    });

    it('writes every one of these to the audit trail', async () => {
        const rows = await srv.core.client.execute(
            "SELECT DISTINCT action FROM audit_events WHERE action LIKE 'mfa.%' OR action = 'auth.mfa_challenged' ORDER BY action",
        );
        const actions = rows.rows.map((r) => r.action);
        expect(actions).toContain('mfa.enrolled');
        expect(actions).toContain('mfa.reset');
        expect(actions).toContain('mfa.recovery_code_used');
        expect(actions).toContain('auth.mfa_challenged');
    });
});
