/* Registered devices and the PIN sign-in they make safe.
 *
 * A four-digit PIN is only acceptable on a screen showing PHI because it is
 * the second half of "this phone, plus a PIN". Most of what is tested here is
 * therefore what the system REFUSES: a PIN from an unknown phone, a PIN after
 * the phone was revoked, a PIN guessed more than a handful of times.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { describeUserAgent, resetPinThrottle } from '../src/core/auth/devices.ts';

let srv;
let admin;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    for (const [username, name] of [['ada.courier', 'Ada Courier'], ['bo.courier', 'Bo Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'courier-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
});
afterAll(async () => { await srv.stop(); });
beforeEach(() => { resetPinThrottle(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/** A fresh browser, i.e. a phone that has never been enrolled. */
const phone = () => srv.agent();

async function enrol(agent, username = 'ada.courier', pin = '1234', over = {}) {
    return agent.post('/api/devices/enrol').send({ username, password: 'courier-pass-1', pin, ...over });
}

describe('describeUserAgent', () => {
    it('says what a courier would recognise, not a version string', () => {
        expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Safari/604')).toBe('iPhone, Safari');
        expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537')).toBe('Android, Chrome');
        expect(describeUserAgent('')).toBe('Device');
    });
});

describe('enrolling a phone', () => {
    it('registers it, sets the PIN, and signs the courier in', async () => {
        const p = phone();
        const res = await enrol(p);
        expect(res.status).toBe(201);
        expect(res.body.enrolled).toBe(true);
        expect(res.body.user).toMatchObject({ username: 'ada.courier', role: 'driver' });

        // Signed in straight away, so enrolment is one step not two.
        expect((await p.get('/api/session')).status).toBe(200);
        // And the device cookie is set for next time.
        const who = await p.get('/api/login/device');
        expect(who.body).toMatchObject({ enrolled: true, name: 'Ada Courier', hasPin: true });
    });

    it('needs the real password, and says the same thing whatever is wrong', async () => {
        // A different message for "no such user" would make this an easy way
        // to find out who works here.
        const bad = await phone().post('/api/devices/enrol').send({ username: 'ada.courier', password: 'wrong', pin: '1234' });
        const missing = await phone().post('/api/devices/enrol').send({ username: 'nobody.here', password: 'wrong', pin: '1234' });
        expect(bad.status).toBe(401);
        expect(missing.status).toBe(401);
        expect(bad.body.error).toBe(missing.body.error);
    });

    it('insists on a PIN of the right shape', async () => {
        for (const pin of ['12', '1234567', 'abcd', '']) {
            const res = await phone().post('/api/devices/enrol').send({ username: 'ada.courier', password: 'courier-pass-1', pin });
            expect(res.status, pin).toBe(400);
        }
    });

    it('labels the phone so its owner can pick it out of a list', async () => {
        const p = phone();
        await p.post('/api/devices/enrol')
            .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Safari/604')
            .send({ username: 'bo.courier', password: 'courier-pass-1', pin: '4321', label: "Bo's work phone" });
        const list = await p.get('/api/devices');
        expect(list.body[0]).toMatchObject({ label: "Bo's work phone", userAgent: 'iPhone, Safari', current: true });
    });

    it('never returns the device token, only a short handle', async () => {
        const p = phone();
        await enrol(p);
        const list = await p.get('/api/devices');
        // Twelve characters of a hash is enough to address it and useless as
        // a credential.
        expect(list.body[0].id).toHaveLength(12);
        expect(JSON.stringify(list.body)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('stores the hash of the token, not the token', async () => {
        const p = phone();
        await enrol(p);
        const rows = (await sql('SELECT id FROM devices')).rows;
        expect(rows.every((r) => /^[0-9a-f]{64}$/.test(String(r.id)))).toBe(true);
    });
});

describe('signing in with a PIN', () => {
    it('works from the enrolled phone', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        await p.post('/api/logout');
        expect((await p.get('/api/session')).status).toBe(401);

        const res = await p.post('/api/login/device').send({ pin: '1234' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ username: 'ada.courier' });
        expect((await p.get('/api/session')).status).toBe(200);
    });

    it('is refused from a phone that was never enrolled', async () => {
        // The whole point: a stolen PIN is worth nothing without the phone.
        const stranger = phone();
        const res = await stranger.post('/api/login/device').send({ pin: '1234' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('device.unknown');
        expect(res.body.error).toMatch(/not registered/);
    });

    it('is refused with the wrong PIN', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        await p.post('/api/logout');
        const res = await p.post('/api/login/device').send({ pin: '9999' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Incorrect PIN');
    });

    it('stops a PIN being guessed, and blocks the phone rather than the person', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        await p.post('/api/logout');

        for (let i = 0; i < 5; i += 1) {
            expect((await p.post('/api/login/device').send({ pin: '0000' })).status).toBe(401);
        }
        const blocked = await p.post('/api/login/device').send({ pin: '1234' });
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toMatch(/password/);

        // A colleague's phone is unaffected: the throttle is per device, so
        // one courier fumbling their PIN cannot lock out another.
        const other = phone();
        await enrol(other, 'bo.courier', '4321');
        await other.post('/api/logout');
        expect((await other.post('/api/login/device').send({ pin: '4321' })).status).toBe(200);
    });

    it('records the attempt without ever writing the PIN down', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        await p.post('/api/logout');
        await p.post('/api/login/device').send({ pin: '8888' });

        const audit = await admin.get('/api/audit?action=auth.login_failed&limit=5');
        const event = audit.body.events.find((e) => e.detail.method === 'device_pin');
        expect(event).toBeTruthy();
        expect(JSON.stringify(audit.body)).not.toContain('8888');
    });

    it('refuses a disabled account even from a good phone', async () => {
        const p = phone();
        await enrol(p, 'bo.courier', '4321');
        await p.post('/api/logout');
        await admin.patch('/api/users/bo.courier').send({ status: 'disabled' });

        const res = await p.post('/api/login/device').send({ pin: '4321' });
        expect(res.status).toBe(401);
        await admin.patch('/api/users/bo.courier').send({ status: 'active' });
    });
});

describe('revoking a phone', () => {
    it('ends the sign-in and the live session together', async () => {
        // A lost phone that stays signed in is the entire risk. Revoking the
        // enrolment but leaving the session alive would look like it had been
        // dealt with when it had not.
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        expect((await p.get('/api/session')).status).toBe(200);

        const id = (await p.get('/api/devices')).body.find((d) => d.current).id;
        expect((await p.delete(`/api/devices/${id}`)).status).toBe(200);

        expect((await p.get('/api/session')).status).toBe(401);
        const again = await p.post('/api/login/device').send({ pin: '1234' });
        expect(again.status).toBe(401);
        expect(again.body.code).toBe('device.unknown');
    });

    it('keeps the row so the history stays readable', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        const id = (await p.get('/api/devices')).body.find((d) => d.current).id;
        await p.delete(`/api/devices/${id}`);

        const staff = await srv.login('admin');
        const list = await staff.get('/api/users/ada.courier/devices');
        const revoked = list.body.find((d) => d.id === id);
        expect(revoked.revokedAt).toBeTruthy();
    });

    it('lets an admin revoke someone else\'s, and nobody else', async () => {
        const ada = phone();
        await enrol(ada, 'ada.courier', '1234');
        const id = (await ada.get('/api/devices')).body.find((d) => d.current).id;

        const bo = phone();
        await enrol(bo, 'bo.courier', '4321');
        expect((await bo.delete(`/api/devices/${id}`)).status).toBe(403);

        expect((await admin.delete(`/api/devices/${id}`)).status).toBe(200);
        expect((await ada.get('/api/session')).status).toBe(401);
    });

    it('404s an unknown device and needs a session at all', async () => {
        expect((await admin.delete('/api/devices/deadbeefdead')).status).toBe(404);
        expect((await srv.agent().get('/api/devices')).status).toBe(401);
        expect((await srv.agent().delete('/api/devices/deadbeefdead')).status).toBe(401);
    });

    it('is admin only when reading someone else\'s list', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        expect((await p.get('/api/users/bo.courier/devices')).status).toBe(403);
        expect((await admin.get('/api/users/ada.courier/devices')).status).toBe(200);
    });
});

describe('the session knows which phone it came from', () => {
    it('links them, so a revoked phone can be found', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        const rows = (await sql(`SELECT device_id FROM sessions WHERE revoked_at IS NULL AND device_id IS NOT NULL`)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => /^[0-9a-f]{64}$/.test(String(r.device_id)))).toBe(true);
    });

    it('leaves it null for an ordinary staff sign-in', async () => {
        const staff = await srv.login('admin');
        expect((await staff.get('/api/session')).status).toBe(200);
        const rows = (await sql(`SELECT s.device_id FROM sessions s JOIN users u ON u.id = s.user_id
                                 WHERE u.username = 'admin' AND s.revoked_at IS NULL`)).rows;
        expect(rows.some((r) => r.device_id === null)).toBe(true);
    });
});

/* ------------------------------------------------------- ticket 5.8
 *
 * The PIN a phone signs in with used to live on users.pin, the same column
 * the legacy TVHS route quick-login is keyed on. The route PIN is accepted
 * from ANY device, so the shared column quietly undid the one property that
 * makes four digits acceptable in front of PHI: that they only work on the
 * phone they were set on.
 *
 * Four separate consequences, one per test. Each of them is the behaviour
 * before the split, written as the assertion that it does not happen.
 */

describe('a phone PIN belongs to the phone', () => {
    it('is stored on the device row and never on the user', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');

        const device = (await sql(
            `SELECT d.pin FROM devices d JOIN users u ON u.id = d.user_id
             WHERE u.username = 'ada.courier' AND d.revoked_at IS NULL`,
        )).rows[0];
        expect(device.pin).toMatch(/^\$2[aby]\$/); // bcrypt, not the PIN itself
        const user = (await sql(`SELECT pin FROM users WHERE username = 'ada.courier'`)).rows[0];
        expect(user.pin).toBeNull();
    });

    it('does not become a route PIN that works from anywhere', async () => {
        /* The serious one. A driver with a route who enrols a phone used to
           have their route PIN rewritten to the phone's, and /api/login/pin
           takes a route PIN from any browser on earth. */
        const p = phone();
        await enrol(p, 'north.driver', '4821', { password: srv.creds.north.password });

        // Somebody else's browser, holding no device cookie at all.
        const anywhere = srv.agent();
        const res = await anywhere.post('/api/login/pin').send({ route: 'northbound', pin: '4821' });
        expect(res.status).toBe(401);
        expect((await anywhere.get('/api/session')).status).toBe(401);
    });

    it('is not changed by enrolling a second phone', async () => {
        const first = phone();
        await enrol(first, 'bo.courier', '1111');
        const second = phone();
        await enrol(second, 'bo.courier', '2222');

        // Each phone still answers to the PIN it was set up with.
        await first.post('/api/logout');
        expect((await first.post('/api/login/device').send({ pin: '1111' })).status).toBe(200);
        resetPinThrottle();
        await second.post('/api/logout');
        expect((await second.post('/api/login/device').send({ pin: '2222' })).status).toBe(200);
        // And not to the other one's.
        resetPinThrottle();
        await first.post('/api/logout');
        expect((await first.post('/api/login/device').send({ pin: '2222' })).status).toBe(401);
    });

    it('is really removed when the phone is signed out, which is what the screen says', async () => {
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        const id = String((await sql(
            `SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id
             WHERE u.username = 'ada.courier' AND d.revoked_at IS NULL`,
        )).rows[0].id);

        expect((await p.delete(`/api/devices/${id.slice(0, 12)}`)).status).toBe(200);
        const row = (await sql('SELECT pin, revoked_at FROM devices WHERE id = ?', [id])).rows[0];
        expect(row.pin).toBeNull();          // the credential is gone
        expect(row.revoked_at).not.toBeNull(); // the row is kept, so the history reads
    });
});

describe('an administrator resetting a PIN', () => {
    it('cannot hand themselves the four digits that unlock somebody\'s phone', async () => {
        /* Before the split, PUT /api/users/:username/pin wrote the column the
           phone authenticated against. */
        const p = phone();
        await enrol(p, 'ada.courier', '1234');
        await p.post('/api/logout');

        const res = await admin.put('/api/users/ada.courier/pin').send({ pin: '9999' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('pin.noRoute');

        resetPinThrottle();
        expect((await p.post('/api/login/device').send({ pin: '9999' })).status).toBe(401);
        resetPinThrottle();
        expect((await p.post('/api/login/device').send({ pin: '1234' })).status).toBe(200);
    });

    it('says what to do instead, rather than reporting a reset that reset nothing', async () => {
        const res = await admin.put('/api/users/bo.courier/pin').send({ pin: '9999' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/that PIN belongs to the phone/);
        expect(res.body.error).toMatch(/sign the phone out/i);
    });

    it('still sets the route PIN for a driver who has a route', async () => {
        const res = await admin.put('/api/users/north.driver/pin').send({ pin: '5150' });
        expect(res.status).toBe(200);
        expect(res.body.hasPin).toBe(true);
        resetPinThrottle();
        const anywhere = srv.agent();
        expect((await anywhere.post('/api/login/pin').send({ route: 'northbound', pin: '5150' })).status).toBe(200);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * WHO MAY REDUCE THEIR SIGN-IN TO FOUR DIGITS.
 *
 * Enrolment had no role check. Any active account that knew its own password
 * could register a browser and sign in with a PIN afterwards, University
 * Health's pharmacy staff among them, and a pharmacy account reaches patient
 * names, addresses and proof-of-delivery photographs.
 *
 * The case for four digits is in devices.ts and all of it rests on a phone one
 * person keeps: a hospital workstation a dispensary shares is not that phone,
 * so the second factor is not a factor. This is the first thing a hospital
 * security questionnaire asks about, and the answer has to be that it cannot
 * be done rather than that it is not offered on screen.
 *
 * Hence tests at both ends. Hiding the form while the endpoint still worked
 * would be the decoration rather than the fix, and signing in has to refuse
 * too, or a row enrolled before the rule outlives it.
 */
describe('a PIN is for courier phones only', () => {
    beforeAll(async () => {
        /* A University Health pharmacist: platform role staff, which is what
           every portal account Karthik's people get will be. */
        await admin.post('/api/users').send({
            username: 'uh.counter', name: 'Counter Staff', password: 'counter-pass-1',
            role: 'staff', mustChangePassword: false,
        });
        await admin.put('/api/users/uh.counter/memberships/uh').send({ role: 'pharmacy', settings: {} });
    });

    it('refuses to enrol a pharmacy account', async () => {
        /* THE FINDING. This returned 201 and set a four-digit credential to
           an account that can read a patient's address. */
        const res = await phone().post('/api/devices/enrol')
            .send({ username: 'uh.counter', password: 'counter-pass-1', pin: '4321' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('device.notAllowed');
    });

    it('refuses an administrator too, not only clients', async () => {
        /* The rule is about the credential, not about who we trust. Our own
           account reaching every project is the worst one to put behind four
           digits, and an exception for ourselves is the exception a reviewer
           asks about. */
        const res = await phone().post('/api/devices/enrol')
            .send({ username: srv.creds.admin.username, password: srv.creds.admin.password, pin: '4321' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('device.notAllowed');
    });

    it('writes nothing when it refuses', async () => {
        /* A half-enrolled row would be a PIN that exists and cannot be seen
           on the page that lists phones. */
        await phone().post('/api/devices/enrol')
            .send({ username: 'uh.counter', password: 'counter-pass-1', pin: '4321' });
        const rs = await sql(
            'SELECT COUNT(*) AS n FROM devices d JOIN users u ON u.id = d.user_id WHERE u.username = ?',
            ['uh.counter'],
        );
        expect(Number(rs.rows[0].n)).toBe(0);
    });

    it('does not sign them in as a side effect', async () => {
        const agent = phone();
        await agent.post('/api/devices/enrol')
            .send({ username: 'uh.counter', password: 'counter-pass-1', pin: '4321' });
        expect((await agent.get('/api/session')).status).toBe(401);
    });

    it('checks the password first, so it cannot be used to find the couriers', async () => {
        /* A refusal that arrived before the password would answer "is this
           username a courier" to anybody who asked, which is the enumeration
           this endpoint already avoids by giving one message for every
           credential failure. */
        const res = await phone().post('/api/devices/enrol')
            .send({ username: 'uh.counter', password: 'not-the-password', pin: '4321' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBeUndefined();
    });

    it('still lets a courier enrol, which is the case it was built for', async () => {
        const res = await enrol(phone(), 'bo.courier', '5678');
        expect(res.status).toBe(201);
    });

    it('records the refusal, because somebody trying it is worth seeing', async () => {
        await phone().post('/api/devices/enrol')
            .send({ username: 'uh.counter', password: 'counter-pass-1', pin: '4321' });
        const { events } = (await admin.get('/api/audit?action=device.enrol_refused')).body;
        expect(events.some((e) => e.entity_id === 'uh.counter')).toBe(true);
    });
});

describe('a phone enrolled before the rule existed', () => {
    it('cannot sign in with its PIN any more', async () => {
        /* THE REASON THE CHECK IS AT BOTH ENDS. Enrolment refusing does
           nothing about rows already in the table, and a four-digit
           credential to patient data that outlives the rule forbidding it is
           the rule not having happened. Written straight to the table,
           because the endpoint now refuses to create one. */
        await admin.post('/api/users').send({
            username: 'uh.legacy', name: 'Legacy Counter', password: 'counter-pass-2',
            role: 'staff', mustChangePassword: false,
        });
        const user = (await sql('SELECT id FROM users WHERE username = ?', ['uh.legacy'])).rows[0];

        const agent = phone();
        /* The cookie carries a random token and the row id is its SHA-256,
           so the two have to be made together. */
        const token = 'a'.repeat(64);
        const crypto = await import('node:crypto');
        const id = crypto.createHash('sha256').update(token).digest('hex');
        const bcrypt = (await import('bcryptjs')).default;
        const now = new Date().toISOString();
        await sql(
            `INSERT INTO devices (id, user_id, label, user_agent, pin, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, Number(user.id), 'Old workstation', 'Device', bcrypt.hashSync('4321', 10), now, now],
        );

        const res = await agent
            .post('/api/login/device')
            .set('Cookie', `izy_did=${token}`)
            .send({ pin: '4321' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('device.notAllowed');

        /* And the lock screen does not greet them by name either: it says
           not enrolled, which sends them to the password box they now have
           to use rather than to a PIN pad that would refuse them. */
        const who = await agent.get('/api/login/device').set('Cookie', `izy_did=${token}`);
        expect(who.body.enrolled).toBe(false);
        expect(JSON.stringify(who.body)).not.toContain('Legacy Counter');
    });
});
