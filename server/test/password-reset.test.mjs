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
    /* A courier, because couriers are the only role allowed a phone PIN and
       so the only people the device half of this can go wrong for. */
    await admin.post('/api/users').send({
        username: 'pin.courier', name: 'Pin Courier', email: 'pin@example.invalid',
        password: 'pin-pass-12345', role: 'driver',
    });
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

describe('the phone PIN, which is a second credential and was being left behind', () => {
    /* THE HOLE THIS CLOSES, IN THE ORDER IT HAPPENED.
     *
     *   a courier's login is shared, or a phone goes missing
     *   they reset their password, believing the other phone is locked out
     *   the other phone taps its old PIN and is straight back in
     *
     * Revoking sessions was all the confirm route did. A courier's phone
     * signs in against a PIN held on the DEVICE row, and POST
     * /api/login/device never reads users.password -- so the revoked session
     * was simply replaced by a new one. Couriers are the only role allowed a
     * PIN, which put all of this on exactly the people the reset protects.
     *
     * Both shells were already promising "signs out every device, including
     * this phone. You will sign in again with the new password." These tests
     * are that sentence, made true.
     */
    const PIN = '4821';
    const PASSWORD = 'pin-pass-12345';

    /* EACH TEST STARTS FROM THE SAME PHONE AND THE SAME PASSWORD. Every case
       in here resets that courier's password, which is the whole point, so
       without this the second test tries to enrol with a password the first
       one changed and the failures read as bugs in the thing under test. */
    beforeEach(async () => {
        const admin = await srv.login('admin');
        const back = await admin.post('/api/users/pin.courier/password').send({ password: PASSWORD });
        expect(back.status, back.text).toBe(200);
        await sql('DELETE FROM devices WHERE user_id = (SELECT id FROM users WHERE username = ?)', ['pin.courier']);
    });

    /** A phone enrolled the way a courier's phone really is. */
    async function enrolPhone() {
        const phone = srv.agent();
        const enrolled = await phone.post('/api/devices/enrol').send({
            username: 'pin.courier', password: PASSWORD, pin: PIN, label: 'Test phone',
        });
        expect(enrolled.status, enrolled.text).toBe(201);
        return phone;
    }

    /** Drive a whole reset for that courier, start to finish. */
    async function resetTheirPassword(app, newPassword = 'a-brand-new-password') {
        await request(app).post('/api/password-reset/request').send({ email: 'pin@example.invalid' });
        const code = codeFromMail();
        const done = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'pin@example.invalid', code, password: newPassword });
        expect(done.status, done.text).toBe(200);
        return done;
    }

    it('refuses the PIN that worked a moment earlier', async () => {
        /* THE LOAD-BEARING TEST. Everything else here is detail. */
        const phone = await enrolPhone();
        expect((await phone.post('/api/login/device').send({ pin: PIN })).status,
            'the PIN should work before the reset').toBe(200);

        await resetTheirPassword(appWith());

        const after = await phone.post('/api/login/device').send({ pin: PIN });
        expect(after.status, 'the same PIN, after the reset').toBe(401);
    });

    it('tells the phone it is not enrolled, so it shows the password box', async () => {
        /* Not a PIN pad that can never open. liveDevice ignores revoked rows,
           which is what sends the courier to the place they can actually get
           in -- the password box, exactly as the reset screen promised. */
        const phone = await enrolPhone();
        expect((await phone.get('/api/login/device')).body.enrolled).toBe(true);

        await resetTheirPassword(appWith());

        expect((await phone.get('/api/login/device')).body.enrolled).toBe(false);
    });

    it('lets them back on with the new password and a new PIN', async () => {
        /* The courier is not locked out of their own phone -- they re-enrol,
           which needs the password they just chose. That is the whole point:
           the PIN stops being a way in for anyone who does not have it. */
        const phone = await enrolPhone();
        await resetTheirPassword(appWith(), 'the-newest-password');

        const again = await phone.post('/api/devices/enrol').send({
            username: 'pin.courier', password: 'the-newest-password', pin: '9930', label: 'Test phone',
        });
        expect(again.status, again.text).toBe(201);
        expect((await phone.post('/api/login/device').send({ pin: '9930' })).status).toBe(200);
    });

    it('will not take the old password to enrol a phone again', async () => {
        const phone = await enrolPhone();
        await resetTheirPassword(appWith(), 'the-newest-password');

        const stale = await phone.post('/api/devices/enrol').send({
            username: 'pin.courier', password: PASSWORD, pin: '1111', label: 'Test phone',
        });
        expect(stale.status).toBe(401);
    });

    it('counts the phones it signed out, and says so to the person', async () => {
        /* Counted separately from sessions because they are separate
           credentials, and a courier who is about to find their PIN pad gone
           should be told why before they ring dispatch about it.
        
           The audit trail carries the same figure, and that is NOT asserted
           here: these tests mount the router on a bare app with no audit
           middleware (see the header), so req.audit is absent and no row is
           written. A test that queried for one would be asserting against
           this harness rather than against the route. */
        await enrolPhone();
        const done = await resetTheirPassword(appWith());

        expect(done.body.revokedDevices).toBe(1);
        expect(done.body.message).toMatch(/PIN on your phone removed/i);
    });

    it('does not mention a PIN to somebody who has never had one', async () => {
        /* A pharmacist has no phone PIN and should not be told to set one up.
           The sentence is earned by the rows that were actually revoked. */
        const app = appWith();
        await request(app).post('/api/password-reset/request').send({ email: 'counter@example.invalid' });
        const code = codeFromMail();
        const done = await request(app).post('/api/password-reset/confirm')
            .send({ email: 'counter@example.invalid', code, password: 'counter-pass-2' });

        expect(done.status).toBe(200);
        expect(done.body.revokedDevices).toBe(0);
        expect(done.body.message).not.toMatch(/PIN/i);
    });
});
