/* Which counter a driver is based at, told to the driver.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING.
 *
 * University Health assigns each driver to one pharmacy. The assignment
 * has existed on the membership since the roster was loaded -- it is
 * `settings.homeSiteId`, it drives the planner, and the dispatcher's
 * roster screen shows it in a column. The person it describes could not
 * see it anywhere.
 *
 * On 1 November thirty-five drivers start at once on a contract where
 * being at the right counter at noon is most of the job, and the only way
 * to find out which counter was to ring a supervisor.
 *
 * It goes on /api/me/projects rather than a new endpoint because that is
 * the call that returns memberships, which is where the assignment lives,
 * and a courier makes it at sign-in anyway -- so the answer costs a phone
 * no extra request.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE STATES ARE DIFFERENT AND THE SCREEN TREATS THEM DIFFERENTLY,
 * so the endpoint has to keep them apart:
 *
 *   a site   this is your counter
 *   null     you have none: a floater, which is a real assignment
 *
 * and, on the client only, a field that is absent because the phone is
 * holding a bundle from across a deploy. The web side has its own tests
 * for that third one; what matters here is that the server never blurs the
 * first two.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ADDRESS CAME WITH IT ON 1 NOVEMBER.
 *
 * A counter's NAME is which pharmacy and not where it is. Pavilion and
 * Discharge are both on Medical Drive a few hundred yards apart, and Vida
 * and Wheatley mean nothing at all to somebody hired last week, so the name
 * on its own is a thing to go and ask a supervisor about. `fullAddress`
 * comes back on the same object, assembled from the site's own columns and
 * punctuated the way the sites endpoint punctuates it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

let srv;
let admin;
let wheatley;
let uhSiteIds;

/** A driver on UH with the given membership settings, signed in. */
async function driver(username, settings) {
    await admin.post('/api/users').send({ username, name: `Test ${username}`, password: `${username}-pass-1`, role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings });
    const agent = srv.agent();
    const login = await agent.post('/api/login').send({ username, password: `${username}-pass-1` });
    expect(login.status, login.text).toBe(200);
    return agent;
}

const uhRow = async (agent) => (await agent.get('/api/me/projects')).body.find((p) => p.code === 'uh');

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    wheatley = sites.find((s) => s.code === 'wheatley') ?? sites[0];
    uhSiteIds = new Set(sites.map((s) => s.id));
    expect(wheatley, 'the UH seed must have pharmacies').toBeTruthy();
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('a driver asking where they are based', () => {
    it('is told the counter, by name, on the membership they already fetch', async () => {
        const agent = await driver('home.based', { homeSiteId: wheatley.id });

        const row = await uhRow(agent);
        expect(row.homeSite).toEqual({
            code: wheatley.code,
            name: wheatley.name,
            fullAddress: wheatley.fullAddress,
        });
        /* Asserted against the SITES ENDPOINT'S OWN STRING rather than one
           spelled out here. A literal would pass while the two drifted
           apart, which is the only failure this field has: a driver reading
           one address on the phone and a dispatcher reading another on the
           sites screen, both correct-looking. */
        expect(row.homeSite.fullAddress).toMatch(/, San Antonio, TX \d{5}$/);
        /* And nothing else about the membership changed shape, because the
           picker and the timezone helper both read this same row. */
        expect(row.role).toBe('courier');
        expect(row.code).toBe('uh');
        expect(typeof row.timezone).toBe('string');
    });

    it('gives the address of THEIR counter, not of some pharmacy', async () => {
        /* Two drivers at two different counters, because a join that
           resolves the name correctly and the address off the wrong row
           would pass the test above: wheatley.fullAddress is whatever the
           query returned. Here the two must differ, and each must match
           its own site. */
        const sites = (await admin.get(`${UH}/sites`)).body;
        const [one, two] = [sites[0], sites.find((s) => s.id !== sites[0].id)];
        expect(two, 'the UH seed must have more than one pharmacy').toBeTruthy();
        expect(one.fullAddress).not.toBe(two.fullAddress);

        const first = await uhRow(await driver('home.addr.one', { homeSiteId: one.id }));
        const second = await uhRow(await driver('home.addr.two', { homeSiteId: two.id }));

        expect(first.homeSite.fullAddress).toBe(one.fullAddress);
        expect(second.homeSite.fullAddress).toBe(two.fullAddress);
    });

    it('gets null, not a guess, when they are a floater', async () => {
        /* Some drivers cover wherever the day needs them. That is an
           assignment and the screen says so in words; what it must not do
           is invent a counter. */
        const agent = await driver('home.floater', {});

        expect((await uhRow(agent)).homeSite).toBeNull();
    });

    it('gets null when the assignment points at a site that is gone', async () => {
        /* A LEFT JOIN, deliberately. An inner join here would drop the
           whole project out of somebody's list because a pharmacy was
           retired -- which is to say it would sign them out of a contract
           they work on. */
        const agent = await driver('home.dangling', { homeSiteId: 999999 });

        expect((await uhRow(agent)).homeSite).toBeNull();
    });

    it('never names a site belonging to a different contract', async () => {
        /* Site ids are global and the join is scoped to the project the
           membership is on. Without that scope an id that happens to match
           a pharmacy on somebody else's contract would be printed on this
           driver's account as the place to drive to in the morning.

           Proved against a real foreign id rather than a made-up one: a
           missing row and a wrongly-scoped row both come back null, so a
           number nobody owns would pass this test while the bug was
           present. */
        const username = 'home.scoped';
        await admin.post('/api/users').send({ username, name: 'Two Contracts', password: `${username}-pass-1`, role: 'driver' });
        /* The SAME id on two memberships: a real UH pharmacy, named as the
           home site of a membership on a different project. One row must
           resolve it and the other must not. */
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: { homeSiteId: wheatley.id } });
        /* TVHS couriers must name a van; the home site rides alongside it
           and is the part under test. */
        const second = await admin.put(`/api/users/${username}/memberships/tvhs`).send({ role: 'courier', settings: { route: 'northbound', homeSiteId: wheatley.id } });
        expect(second.status, second.text).toBe(200);

        const agent = srv.agent();
        expect((await agent.post('/api/login').send({ username, password: `${username}-pass-1` })).status).toBe(200);
        const rows = (await agent.get('/api/me/projects')).body;

        expect(rows.find((p) => p.code === 'uh').homeSite)
            .toEqual({ code: wheatley.code, name: wheatley.name, fullAddress: wheatley.fullAddress });
        expect(rows.find((p) => p.code === 'tvhs').homeSite).toBeNull();
        expect(uhSiteIds.has(wheatley.id)).toBe(true);
    });
});
