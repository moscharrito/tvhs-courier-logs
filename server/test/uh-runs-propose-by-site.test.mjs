/* Planning one pharmacy's list with that pharmacy's drivers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * University Health does not drop one list a day. Each counter sends its
 * own, and the wave that answers it is driven by the people hired to drive
 * from there -- the 30 October assignment list puts every driver at the
 * pharmacy closest to home, and that is the whole point of it. Planning the
 * whole day in one go and picking names out of twenty-eight was the morning
 * this replaces.
 *
 * So `?site=green` means: this counter's unassigned orders, staffed from
 * this counter's drivers who are on shift. Three rules fall out of it and
 * all three are tested here.
 *
 *   SOMEBODY ELSE'S DRIVER IS NOT OFFERED. Not hidden from the board, not
 *   ranked lower -- not offered. A dispatcher planning Southeast should not
 *   have to recognise which of twenty-eight names drives from Southeast.
 *
 *   A DRIVER WITH NO PHARMACY IS NOT OFFERED ANYWHERE. Seven of the
 *   thirty-five have no counter yet and are HELD: active, able to sign in,
 *   and never proposed. The count comes back so the screen can say so,
 *   because an unassigned driver is a gap in the roster rather than a
 *   sensible default for somebody else's run.
 *
 *   NOBODY ON SHIFT MEANS NOBODY, not a list of people who are not here.
 *   The unscoped whole-day plan falls back to the full roster and says so,
 *   which is the honest answer to "what does today look like" at 11:55.
 *   Scoped to a counter at one o'clock the question is different -- who can
 *   take this NOW -- and the same fallback would answer it wrongly. So the
 *   plan comes back empty and offers the widening instead of performing it.
 *
 * Every name here is invented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const RUNS = `${UH}/runs`;
const ORDERS = `${UH}/orders`;

let srv;
let admin;
let sites;

const siteId = (code) => sites.find((s) => s.code === code).id;
const propose = (query = '') => admin.get(`${RUNS}/propose${query}`);
const suggestedNames = (body) => body.suggested.filter(Boolean).map((s) => s.username).sort();

/** A courier at a pharmacy. `onShift` decides whether they tap Go on shift. */
async function driver(username, homeSite, { onShift }) {
    await admin.post('/api/users').send({
        username, name: `Driver ${username}`, password: `${username}-pass-1`, role: 'driver',
    });
    await admin.put(`/api/users/${username}/memberships/uh`).send({
        role: 'courier',
        settings: homeSite === null ? {} : { homeSiteId: siteId(homeSite) },
    });
    if (!onShift) return null;
    const agent = srv.agent();
    const login = await agent.post('/api/login').send({ username, password: `${username}-pass-1` });
    expect(login.status, login.text).toBe(200);
    const started = await agent.post(`${UH}/shifts/start`).send({});
    expect(started.status, started.text).toBe(201);
    return agent;
}

let seq = 0;
async function order(code) {
    seq += 1;
    const res = await admin.post(ORDERS).send({
        siteId: siteId(code), serviceType: 'adhoc',
        recipientName: `Recipient ${seq}`, addressLine: `${seq} Test Street`, zip: '78215',
        description: 'Oral solids', quantity: 1, externalRef: `RX-${7000 + seq}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    sites = (await admin.get(`${UH}/sites`)).body;

    /* Green has one on shift and one at home; southeast has one on shift.
       `nowhere.driver` is the held case: an account, no counter. */
    await driver('green.on', 'green', { onShift: true });
    await driver('green.off', 'green', { onShift: false });
    await driver('southeast.on', 'southeast', { onShift: true });
    await driver('nowhere.driver', null, { onShift: true });

    for (let i = 0; i < 3; i += 1) await order('green');
    for (let i = 0; i < 3; i += 1) await order('southeast');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('planning one pharmacy', () => {
    it('plans only that pharmacy\'s orders', async () => {
        const res = await propose('?site=green');
        expect(res.status, res.text).toBe(200);
        expect(res.body.site.code).toBe('green');
        expect(res.body.scope).toBe('site');

        const planned = res.body.runs.flatMap((r) => r.siteIds);
        expect(new Set(planned)).toEqual(new Set([siteId('green')]));
    });

    it('offers that pharmacy\'s driver and nobody else\'s', async () => {
        const res = await propose('?site=green');
        const names = suggestedNames(res.body);
        expect(names).toContain('green.on');
        /* The driver on shift at the other counter. Offering them here is
           the behaviour this whole change exists to stop. */
        expect(names).not.toContain('southeast.on');
        /* On shift, no pharmacy: held. */
        expect(names).not.toContain('nowhere.driver');
        /* At this pharmacy and not on shift. */
        expect(names).not.toContain('green.off');
    });

    it('counts who it left out, so the screen can say why the list is short', async () => {
        const { excluded, fleet } = (await propose('?site=green')).body;
        expect(fleet.onShift).toBe(1);          // green.on
        expect(fleet.roster).toBe(2);           // green.on + green.off
        expect(excluded.held).toBeGreaterThanOrEqual(1);
        expect(excluded.otherSite).toBeGreaterThanOrEqual(1);
        expect(excluded.offShift).toBe(1);
    });

    it('says a driver with no pharmacy is not offered anywhere', async () => {
        /* Not scoped to a site at all: the held driver is still not used. */
        const res = await propose();
        expect(suggestedNames(res.body)).not.toContain('nowhere.driver');
        expect(res.body.excluded.held).toBeGreaterThanOrEqual(1);
        expect(res.body.notes.join(' ')).toMatch(/no pharmacy assigned/i);
    });

    it('refuses a pharmacy code this contract does not have', async () => {
        /* Rather than ignoring it and planning the whole day, which looks
           exactly like a plan that worked. */
        const res = await propose('?site=not-a-pharmacy');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not-a-pharmacy/);
    });
});

describe('when nobody from the pharmacy is on shift', () => {
    it('staffs nothing and offers the widening instead of performing it', async () => {
        const res = await propose('?site=pavilion');
        expect(res.status).toBe(200);
        expect(res.body.fleet.onShift).toBe(0);
        expect(res.body.suggested.filter(Boolean)).toHaveLength(0);
        expect(res.body.notes.join(' ')).toMatch(/Widen to everyone on shift/i);
        /* NOT the whole-day fallback. A list of people who are not here
           reads as an answer to "who can take this now". */
        expect(res.body.notes.join(' ')).not.toMatch(/planned for all/i);
    });

    it('widens to everyone on shift when the dispatcher asks', async () => {
        for (let i = 0; i < 2; i += 1) await order('pavilion');
        const res = await propose('?site=pavilion&anyDriver=1');
        expect(res.body.scope).toBe('anyDriver');

        const names = suggestedNames(res.body);
        expect(names.length).toBeGreaterThan(0);
        /* Somebody from another counter, marked cover by staffProposal. */
        expect(names.some((n) => n === 'green.on' || n === 'southeast.on')).toBe(true);
        /* Widening crosses counters. It does not reach into the held pool:
           they have no counter to be covering FROM. */
        expect(names).not.toContain('nowhere.driver');
        expect(res.body.notes.join(' ')).toMatch(/not only this pharmacy's drivers/i);
    });
});
