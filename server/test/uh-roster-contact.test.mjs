/* How to reach a driver.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING.
 *
 * Forty-three drivers on one contract and no telephone number for any of
 * them anywhere in the system. Not on the roster import, not on the
 * onboarding rows, not on the user. When a run went quiet at four in the
 * afternoon the answer was a number in whichever dispatcher's own phone,
 * which is to say the answer depended on who was on.
 *
 * `users.phone` is the column (drizzle/0059_user_phone.sql) and this is the
 * route that fills it: PUT /uh/roster/:username/contact, beside the roster
 * screen, because the moment to record forty-three numbers is while looking
 * at the list of forty-three drivers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CASES THAT MATTER.
 *
 * It is a project route writing a PLATFORM field, so the interesting tests
 * are the edges of that: it must reach a driver on this project, it must
 * not reach anybody else, and clearing must leave one spelling of "no
 * number" rather than two.
 *
 * The audit entry is checked for what it does NOT say. A telephone number
 * in a log that gets exported is the thing the roster screen itself is
 * careful about, so the trail records whether a number is on file and not
 * which number it is.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const ROSTER = `${UH}/roster`;

let srv;
let admin;
let siteId;

/** A driver on UH, created the way an administrator would. */
async function makeDriver(username, name, role = 'courier') {
    await admin.post('/api/users').send({ username, name, password: `${username}-pass-1`, role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
}

const rosterRow = async (username) =>
    (await admin.get(ROSTER)).body.drivers.find((d) => d.username === username);

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    await makeDriver('phone.one', 'Driver One');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('a driver telephone number', () => {
    it('is empty rather than absent before anybody has typed one', async () => {
        /* The screen tests one thing for "nothing recorded", the same way
           it does for an address. A field that is sometimes missing and
           sometimes null is two tests and one of them gets forgotten. */
        const row = await rosterRow('phone.one');
        expect(row).toBeDefined();
        expect(row.phone).toBe('');
    });

    it('is recorded, and comes back on the roster the screen reads', async () => {
        const res = await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '(210) 555 0142' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.phone).toBe('(210) 555 0142');
        expect((await rosterRow('phone.one')).phone).toBe('(210) 555 0142');
    });

    it('keeps the punctuation it was typed with', async () => {
        /* Not normalised to digits on the way in. The screen strips for the
           `tel:` link and shows what was typed, because a dispatcher
           reading a number back down a radio needs the spaces. */
        await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '+1 210-555-0142 ext 4' });
        expect((await rosterRow('phone.one')).phone).toBe('+1 210-555-0142 ext 4');
    });

    it('trims, so a stray space is not a different number', async () => {
        await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '  210 555 0188  ' });
        expect((await rosterRow('phone.one')).phone).toBe('210 555 0188');
    });

    it('clears to one spelling of nothing, not to an empty string in the column', async () => {
        /* Two spellings of "no number" in one column is how a report comes
           to read "0 drivers without a phone" while half the rows are
           blank. The API answer stays '' either way; the column is NULL. */
        const res = await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.phone).toBe('');
        expect((await rosterRow('phone.one')).phone).toBe('');

        const rs = await srv.core.client.execute({
            sql: 'SELECT phone FROM users WHERE username = ?',
            args: ['phone.one'],
        });
        expect(rs.rows[0].phone).toBeNull();
    });

    it('refuses a number longer than anybody dials', async () => {
        const res = await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '2'.repeat(41) });
        expect(res.status, res.text).toBe(400);
    });

    it('is refused for somebody who is not on this project at all', async () => {
        const res = await admin.put(`${ROSTER}/nobody.here/contact`).send({ phone: '210 555 0101' });
        expect(res.status, res.text).toBe(404);
    });

    it('is refused for a membership that is not a driver, and says which it is', async () => {
        /* The usual cause is a membership created with the wrong role, and
           the person reading this is the person who can fix it. Not a flat
           403: "not allowed" sends somebody to the wrong place. */
        await admin.post('/api/users').send({ username: 'phone.desk', name: 'A Pharmacy Desk', password: 'phone-desk-pass-1', role: 'staff' });
        await admin.put('/api/users/phone.desk/memberships/uh').send({ role: 'pharmacy', settings: {} });

        const res = await admin.put(`${ROSTER}/phone.desk/contact`).send({ phone: '210 555 0101' });
        expect(res.status, res.text).toBe(409);
        expect(res.body.code).toBe('roster.notADriver');
        expect(res.body.error).toMatch(/not as a driver/);
    });

    it('is open to a site manager, who is the person who knows the number', async () => {
        /* Same rule as the home pharmacy: a lead runs a counter and knows
           who drives from it. Making them ring an administrator is how the
           record stops matching the car park. */
        await makeDriver('phone.lead', 'A Site Manager', 'lead');
        const lead = srv.agent();
        expect((await lead.post('/api/login').send({ username: 'phone.lead', password: 'phone.lead-pass-1' })).status).toBe(200);

        const res = await lead.put(`${ROSTER}/phone.one/contact`).send({ phone: '210 555 0177' });
        expect(res.status, res.text).toBe(200);
    });

    it('does not put the number in the audit trail, only whether there is one', async () => {
        /* The trail answers "who changed this and when" and is read far
           more widely than the roster screen is. */
        await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '210 555 0166' });
        const rs = await srv.core.client.execute({
            sql: "SELECT detail FROM audit_events WHERE action = 'roster.phone' ORDER BY id DESC LIMIT 1",
            args: [],
        });
        const details = String(rs.rows[0].detail ?? '');
        expect(details).toMatch(/hasPhone/);
        expect(details).not.toMatch(/0166/);
    });

    it('leaves the home pharmacy alone, because they are two different facts', async () => {
        /* Two routes rather than one with a flag: a dispatcher typing a
           number must not be able to clear a counter by omitting a field. */
        await admin.put(`${ROSTER}/phone.one`).send({ homeSiteId: siteId });
        await admin.put(`${ROSTER}/phone.one/contact`).send({ phone: '210 555 0155' });

        const row = await rosterRow('phone.one');
        expect(row.homeSiteId).toBe(siteId);
        expect(row.phone).toBe('210 555 0155');
    });
});
