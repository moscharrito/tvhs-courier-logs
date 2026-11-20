/* What a notification body is allowed to say, now that something renders it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SURFACE CHANGED UNDER THESE SENTENCES.
 *
 * Twelve kinds of notification were written to the database for weeks and
 * nothing in either app rendered one of them. A body was a row somebody
 * might read in a query one day.
 *
 * It is now the bell on every screen and -- for anybody who allows it -- a
 * banner drawn by the operating system over whatever is in front of them.
 * Dispatch runs on laptops, and those laptops are often on a pharmacy
 * counter with members of the public on the other side. A notification body
 * is the least private surface this application has, and nothing warned the
 * person writing one.
 *
 * Most of the composers had already worked this out. modules/uh/
 * order-messages.ts says "the reference, never the patient and never the
 * body. This is read on a lock screen", written before any lock screen
 * existed to read it on. dispatch-notices.ts says "A driver" rather than a
 * username, and says why.
 *
 * TWO HAD NOT, because nothing rendered what they wrote. The first row in
 * the bell, the first time anybody opened one, was a driver's own email
 * address and how long they had been off shift.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SO THIS IS A RULE, NOT A REGRESSION TEST.
 *
 * It drives the real sweeps and reads what they actually wrote -- a test
 * that composed its own sentence would pass while the real one leaked. The
 * next person to add a kind gets a failure here rather than a question from
 * University Health, and the failure says which sentence and why.
 *
 * Every row below is invented. No University Health data, sampled or
 * otherwise, goes anywhere near this.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepCheckIn } from '../src/modules/uh/check-in.ts';
import { sweepStaleShifts } from '../src/modules/uh/shift-sweep.ts';

const UH = '/api/projects/uh/uh';
const TZ = 'America/Chicago';

/* A Tuesday, and 15:30Z is 10:30 in Chicago -- half an hour past a ten
   o'clock deadline. Copied from uh-check-in.test.mjs, which explains it. */
const SERVICE_DATE = '2026-10-27';
const PAST_DEADLINE = new Date('2026-10-27T15:30:00.000Z');

/* ON THIS CONTRACT A DRIVER'S USERNAME IS THEIR EMAIL ADDRESS. That is the
   fact the leak rested on, so the fixtures have to carry it. example.invalid
   is reserved by RFC 2606 and can never belong to anybody. */
const NAMED = 'rehearsal.one@example.invalid';
const NAMELESS = 'rehearsal.two@example.invalid';

/** An email address anywhere in a sentence a stranger may read over a counter. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

let srv;
let admin;
let projectId;
let siteId;

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

const bodiesOf = async (kind) => (await sql(
    'SELECT DISTINCT body FROM notifications WHERE kind = ?', [kind],
)).rows.map((r) => String(r['body']));

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;

    /* One courier with a name on the account and one without. The second is
       the fallback path, and it is the one that was leaking. */
    for (const [username, name] of [[NAMED, 'Rehearsal Driver'], [NAMELESS, 'Placeholder']]) {
        const made = await admin.post('/api/users')
            .send({ username, name, password: 'notice-pass-1', role: 'driver' });
        expect(made.status, made.text).toBeLessThan(300);
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
    /* AND THEN THE NAME IS TAKEN OFF ONE OF THEM, which the API will not do
       -- it requires one, and rightly. The nameless account is nonetheless a
       real state: migration 0045 backfilled names onto accounts created
       before the column was required, and anything it could not match was
       left blank. That row is the fallback path, and the fallback path is
       the one that was leaking an address. */
    await sql('UPDATE users SET name = ? WHERE username = ?', ['', NAMELESS]);
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('a driver who had work and never came on shift', () => {
    let bodies;

    beforeAll(async () => {
        await sql('DELETE FROM notifications');
        for (const username of [NAMED, NAMELESS]) {
            await sql(
                `INSERT INTO runs (project_id, courier_username, label, service_date, status, created_at)
                 VALUES (?, ?, 'Rehearsal run', ?, 'planned', ?)`,
                [projectId, username, SERVICE_DATE, new Date().toISOString()],
            );
        }
        await sql("UPDATE projects SET settings = ? WHERE id = ?",
            [JSON.stringify({ checkIn: { watch: true, by: '10:00' } }), projectId]);

        const swept = await sweepCheckIn({
            client: srv.core.client, projectId, timezone: TZ, now: PAST_DEADLINE,
        });
        expect(swept.told, 'the sweep said nothing, so this file proves nothing').toBeGreaterThan(0);
        bodies = await bodiesOf('shift.missed');
    }, 60_000);

    it('does not put an email address on a pharmacy counter', () => {
        /* The defect this file was written for. */
        const leaked = bodies.filter((b) => EMAIL.test(b));
        expect(leaked, `a notification body carries an email address: ${leaked[0] ?? ''}`).toEqual([]);
    });

    it('still says WHICH driver, because that is the entire message', () => {
        /* The fix must not go the other way. "A driver has a run and had not
           come on shift" is a sentence nobody can act on, and an anonymous
           version of this notification would be worse than none at all. */
        expect(bodies.some((b) => b.includes('Rehearsal Driver'))).toBe(true);
    });

    it('falls back to the handle, never the address, when the account has no name', () => {
        /* Every driver on this roster has a name, so this is the rare path
           -- which is exactly why it needs a test rather than a reader's
           attention. `rehearsal.two` identifies somebody to a dispatcher who
           knows their drivers; `rehearsal.two@example.invalid` is a
           deliverable address on a screen in a corridor. */
        expect(bodies.some((b) => b.includes('rehearsal.two'))).toBe(true);
    });
});

describe('a shift left open with packages still in the van', () => {
    let bodies;

    beforeAll(async () => {
        await sql('DELETE FROM notifications');
        await sql('DELETE FROM shifts WHERE courier_username = ?', [NAMED]);
        await sql(
            'INSERT INTO shifts (project_id, courier_username, started_at) VALUES (?, ?, ?)',
            [projectId, NAMED, new Date(Date.now() - 20 * 3600_000).toISOString()],
        );

        /* Something they are still carrying, or the sweep closes the shift
           quietly and writes nothing -- which is the correct behaviour and
           would leave this test asserting about an empty table. */
        const made = await admin.post(`${UH}/orders`).send({
            siteId, serviceType: 'adhoc', recipientName: 'Rehearsal Patient',
            addressLine: '9 Rehearsal Way', zip: '78215', description: 'Cold pack', quantity: 1,
        });
        expect(made.status, made.text).toBe(201);
        await sql(
            "UPDATE orders SET assigned_to_username = ?, status = 'picked_up' WHERE id = ?",
            [NAMED, made.body.id],
        );

        const swept = await sweepStaleShifts({ client: srv.core.client, projectId });
        expect(swept.told, 'the sweep said nothing, so this file proves nothing').toBeGreaterThan(0);
        bodies = await bodiesOf('shift.carryingOvernight');
    }, 60_000);

    it('does not put an email address on a pharmacy counter either', () => {
        const leaked = bodies.filter((b) => EMAIL.test(b));
        expect(leaked, `a notification body carries an email address: ${leaked[0] ?? ''}`).toEqual([]);
    });

    it('names the driver, because somebody has to ring them', () => {
        expect(bodies.some((b) => b.includes('Rehearsal Driver'))).toBe(true);
    });
});

describe('every body this run produced', () => {
    it('names no patient, no address and no telephone number', async () => {
        /* A broad net on purpose. These three are what the contract is about
           and none of them has any business in a sentence the operating
           system draws over a counter.

           They do not reach a notification today -- the composers use a
           delivery number and the pharmacy's own reference, which is what
           the pharmacy says on the telephone anyway. This is what says so
           when somebody adds the sixteenth kind in a hurry.

           NOTE the order above: the carrying sweep deliberately created an
           order with a recipient and a street, so if any composer reached
           for either of them this catches it. */
        const rs = await sql('SELECT kind, body FROM notifications');
        expect(rs.rows.length).toBeGreaterThan(0);

        const bad = [];
        for (const r of rs.rows) {
            const kind = String(r['kind']);
            const body = String(r['body']);
            if (EMAIL.test(body)) bad.push(`${kind}: an email address -- ${body}`);
            if (/\b(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(body)) {
                bad.push(`${kind}: a telephone number -- ${body}`);
            }
            if (/\b\d{1,6}\s+[A-Za-z][A-Za-z.]*(\s+[A-Za-z][A-Za-z.]*)*\s+(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pkwy|Parkway)\b/i.test(body)) {
                bad.push(`${kind}: a street address -- ${body}`);
            }
            if (body.includes('Rehearsal Patient')) bad.push(`${kind}: a recipient's name -- ${body}`);
        }
        expect(bad).toEqual([]);
    });
});
