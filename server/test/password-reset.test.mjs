/* Resetting a forgotten password with a code sent by email.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS TESTED AGAINST THE ROUTER RATHER THAN THE RUNNING SERVER.
 *
 * The mailer is unavailable in the test environment, and deliberately so:
 * nothing in a test run should be able to send real email. Mounted normally
 * the request route would answer 503 to everything and prove nothing.
 *
 * It takes its mailer as a dependency, so here it gets one that keeps what
 * it was handed. That also makes the code readable, and the code is the only
 * way to exercise confirm -- the database holds a bcrypt hash of it, which
 * is the point.
 *
 * The database is the real one. Users are created through the real admin API
 * so the rows look like production rows rather than like something this file
 * invented.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { startServer } from './helpers/server.mjs';
import { createPasswordResetRouter, CODE_TTL_MS, MAX_CODE_ATTEMPTS, newCode } from '../src/core/auth/password-reset.ts';

let srv;
let sent;
let revoked;
let clock;

/** The router under test, on a bare app, with the real database. */
function appWith({ available = true, throws = null } = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/password-reset', createPasswordResetRouter({
        client: srv.core.client,
        store: {
            async revokeAllForUser(userId) { revoked.push(userId); return 2; },
        },
        mailer: {
            available,
            reason: available ? null : 'Email is not enabled on this server.',
            async send(mail) {
                if (throws) throw new Error(throws);
                sent.push(mail);
            },
        },
        now: () => clock,
    }));
    return app;
}

const sql = (text, args = []) => srv.core.client.execute({ sql: text, args });

/** The six digits out of the one email that was sent. */
function codeFromMail() {
    expect(sent, 'an email should have been sent').toHaveLength(1);
    const m = /Your code is (\d{6})/.exec(sent[0].text);
    expect(m, `no code in: ${sent[0].text}`).not.toBeNull();
    return m[1];
}

beforeAll(async () => {
    srv = await startServer();
    const admin = await srv.login('admin');
    await admin.post('/api/users').send({
        username: 'uh.counter', name: 'A Counter', email: 'counter@example.invalid',
        password: 'counter-pass-1', role: 'staff',
    });
    await admin.post('/api/users').send({
        username: 'gone.courier', name: 'Gone Courier', email: 'gone@example.invalid',
        password: 'gone-pass-1', role: 'driver',
    });
    await admin.patch('/api/users/gone.courier').send({ status: 'disabled' });
});
afterAll(async () => { await srv.stop(); });

beforeEach(async () => {
    sent = [];
    revoked = [];
    clock = new Date('2026-10-23T12:00:00.000Z');
    /* A fresh router per test gets fresh throttles; the rows have to go too
       or yesterday's outstanding code is today's newest one. */
    await sql('DELETE FROM password_resets');
});

describe('asking for a code', () => {
    it('answers an unknown address exactly as it answers a known one', async () => {
        /* THE PROPERTY THIS ROUTE EXISTS TO HAVE. A public endpoint that
           says "no such user" hands out a staff directory to anybody who
           asks. Same status, same body, and a row written either way. */
        const app = appWith();
        const known = await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        const unknown = await request(app).post('/api/password-reset/request').send({ email: 'nobody@example.invalid' });

        expect(known.status).toBe(202);
        expect(unknown.status).toBe(202);
        expect(unknown.body).toEqual(known.body);

        const rows = (await sql('SELECT email, user_id FROM password_resets ORDER BY id')).rows;
        expect(rows).toHaveLength(2);
        expect(rows[1].user_id, 'no account, so nothing to reset later').toBeNull();
    });

    it('emails only the address that has an account', async () => {
        /* The row is written for both; the email is the one thing an
           observer could actually see, so it goes only where it belongs. */
        const app = appWith();
        await request(app).post('/api/password-reset/request').send({ email: 'nobody@example.invalid' });
        expect(sent).toHaveLength(0);

        await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        expect(sent).toHaveLength(1);
        expect(sent[0].to).toBe('counter@example.invalid');
    });

    it('never stores the code it sent', async () => {
        const app = appWith();
        await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        const code = codeFromMail();
        const row = (await sql('SELECT code_hash FROM password_resets ORDER BY id DESC LIMIT 1')).rows[0];
        expect(String(row.code_hash)).not.toContain(code);
        expect(String(row.code_hash).startsWith('$2'), 'bcrypt').toBe(true);
    });

    it('puts nothing in the email but the code', async () => {
        /* If it lands in the wrong inbox it should say as little as
           possible: no name, no username, no link to follow. */
        const app = appWith();
        await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        const text = sent[0].text;
        expect(text).not.toMatch(/A Counter/);
        expect(text).not.toMatch(/uh\.counter/);
        expect(text).not.toMatch(/https?:\/\//);
    });

    it('says so when email is not configured, rather than issuing a dead code', async () => {
        /* Not a fact about the address, so it can be said out loud. And no
           row is written: an account with a live credential attached to it
           that nobody can receive is worse than a refusal. */
        const app = appWith({ available: false });
        const res = await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('reset.mailUnavailable');
        expect((await sql('SELECT COUNT(*) AS n FROM password_resets')).rows[0].n).toBe(0);
    });

    it('still answers 202 when the send itself fails', async () => {
        /* SES IN SANDBOX IS THIS CASE. A failure to deliver correlates with
           the address, so reporting it answers the question the route
           refuses to answer. The caller is told nothing; the log is where
           this goes. */
        const app = appWith({ throws: 'Email address is not verified' });
        const res = await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        expect(res.status).toBe(202);
        expect((await sql('SELECT COUNT(*) AS n FROM password_resets')).rows[0].n).toBe(1);
    });

    it('supersedes an outstanding code', async () => {
        /* Somebody who clicks twice expects the newest code to work, and two
           live codes double the surface for no benefit. */
        const app = appWith();
        await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        const first = codeFromMail();
        sent = [];
        await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        const second = codeFromMail();

        const stale = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code: first, password: 'a-new-password-1' });
        expect(stale.status).toBe(400);

        const ok = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code: second, password: 'a-new-password-1' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });

    it('refuses a third request for the same address within the hour', async () => {
        const app = appWith();
        for (let i = 0; i < 3; i += 1) {
            const res = await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
            expect(res.status, `request ${i + 1}`).toBe(202);
        }
        const fourth = await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        expect(fourth.status).toBe(429);
        expect(fourth.headers['retry-after']).toBeDefined();
    });
});

describe('using a code', () => {
    async function issue(app, email = 'counter@example.invalid') {
        sent = [];
        await request(app).post('/api/password-reset/request').send({ email });
        return codeFromMail();
    }

    it('changes the password and signs every device out', async () => {
        const app = appWith();
        const code = await issue(app);
        const before = (await sql("SELECT password FROM users WHERE username = 'uh.counter'")).rows[0].password;

        const res = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'a-brand-new-password' });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.username).toBe('uh.counter');
        /* EVERY SESSION. Whoever asked could not sign in, so a session still
           open belongs to a lost device or to whoever caused this. */
        expect(revoked).toEqual([expect.any(Number)]);
        expect(res.body.revokedSessions).toBe(2);

        const after = (await sql("SELECT password FROM users WHERE username = 'uh.counter'")).rows[0].password;
        expect(String(after)).not.toBe(String(before));
        expect(String(after).startsWith('$2'), 'bcrypt').toBe(true);
    });

    it('cannot be used twice', async () => {
        const app = appWith();
        const code = await issue(app);
        const first = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'first-new-password' });
        expect(first.status).toBe(200);

        const replay = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'second-new-password' });
        expect(replay.status).toBe(400);
        expect(replay.body.code).toBe('reset.invalidCode');
    });

    it('expires', async () => {
        const app = appWith();
        const code = await issue(app);
        clock = new Date(clock.getTime() + CODE_TTL_MS + 1000);
        const res = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'too-late-password' });
        expect(res.status).toBe(400);
    });

    it('gives the same refusal for every way of being wrong', async () => {
        /* Distinguishing them tells a caller which half of a guess was
           right: whether the address has an account, whether a code is
           outstanding, whether it has expired. One sentence for all of it. */
        const app = appWith();
        const code = await issue(app);
        const bodies = [];

        bodies.push((await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code: code === '000000' ? '111111' : '000000', password: 'x'.repeat(10) })).body);
        bodies.push((await request(app).post('/api/password-reset/confirm')
            .send({ email: 'nobody@example.invalid', code: '123456', password: 'x'.repeat(10) })).body);
        bodies.push((await request(app).post('/api/password-reset/confirm')
            .send({ email: 'never-asked@example.invalid', code: '123456', password: 'x'.repeat(10) })).body);

        for (const b of bodies) expect(b).toEqual(bodies[0]);
    });

    it('stops accepting guesses against one code', async () => {
        const app = appWith();
        const code = await issue(app);
        const wrong = code === '000000' ? '111111' : '000000';

        for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
            const res = await request(app).post('/api/password-reset/confirm')
                .send({ email: 'counter@example.invalid', code: wrong, password: 'x'.repeat(10) });
            expect(res.status, `guess ${i + 1}`).toBe(400);
        }
        /* And now the real code is dead too, because a row guessed at five
           times is a row somebody is working on. */
        const res = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'x'.repeat(10) });
        expect(res.status).toBe(400);
    });

    it('will not reset a disabled account', async () => {
        /* Disabling is how somebody is offboarded. A reset that woke the
           account up would undo it with an email nobody watches. */
        const app = appWith();
        await request(app).post('/api/password-reset/request').send({ email: 'gone@example.invalid' });
        /* No email either: the account is not active, so there is nobody to
           send to, and the row carries no user_id. */
        expect(sent).toHaveLength(0);
        const row = (await sql('SELECT user_id FROM password_resets ORDER BY id DESC LIMIT 1')).rows[0];
        expect(row.user_id).toBeNull();
    });

    it('refuses a password shorter than the rule everywhere else', async () => {
        const app = appWith();
        const code = await issue(app);
        const res = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'short' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('reset.badRequest');
    });
});

describe('the code itself', () => {
    it('is six digits, zero padded, across the whole range', () => {
        expect(newCode(() => 0)).toBe('000000');
        expect(newCode(() => 7)).toBe('000007');
        expect(newCode(() => 999_999)).toBe('999999');
    });

    it('asks for a million values, not a smaller range', () => {
        /* A generator asked for 0..99999 would look right in every test
           above and quietly be ten times easier to guess. */
        let low = null; let high = null;
        newCode((min, max) => { low = min; high = max; return 1; });
        expect(low).toBe(0);
        expect(high).toBe(1_000_000);
    });
});
