/* Who the dispatch board lists.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THESE WERE WRITTEN FOR.
 *
 * modules/uh/shifts.ts lets `admin`, `lead` and `courier` open a shift.
 * modules/uh/board.ts asked for `courier` and `lead`, inner-joined, and
 * added `u.status = 'active'`. The two rosters disagreed, and the board
 * showed the smaller one.
 *
 * What that produced, on 28 October 2026: a driver tapped Go on shift, got
 * a 201 and a phone that said they were working, and appeared nowhere on
 * the board -- not in the lanes, not in the on-shift count the planner
 * reads, not in the courier picker. There was no way for dispatch to see
 * them and no way to give them work.
 *
 * The rule now: listed if you could be given work, OR IF YOU ARE ON SHIFT.
 * The second half is the one that matters, because somebody on an open
 * shift may be holding packages, and a board that hides them hides the
 * packages too.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

let srv;
let admin;

const board = async () => (await admin.get(`${UH}/board`)).body;
const onBoard = (b, username) => b.couriers.find((c) => c.username === username);

async function driverOnShift(username, name, role) {
    await admin.post('/api/users').send({ username, name, password: `${username}-pass-1`, role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const agent = srv.agent();
    const login = await agent.post('/api/login').send({ username, password: `${username}-pass-1` });
    expect(login.status, login.text).toBe(200);
    const started = await agent.post(`${UH}/shifts/start`).send({});
    expect(started.status, started.text).toBe(201);
    return agent;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('the board roster', () => {
    it('lists a courier on shift, which always worked', async () => {
        await driverOnShift('roster.courier', 'Ordinary Courier', 'courier');
        const c = onBoard(await board(), 'roster.courier');
        expect(c).toBeDefined();
        expect(c.onShift).toBe(true);
        expect(c.offRoster).toBe(false);
    });

    it('lists a courier who is not on shift, so they can be given work', async () => {
        await admin.post('/api/users').send({ username: 'roster.idle', name: 'Idle Courier', password: 'idle-pass-1', role: 'driver' });
        await admin.put('/api/users/roster.idle/memberships/uh').send({ role: 'courier', settings: {} });
        const c = onBoard(await board(), 'roster.idle');
        expect(c).toBeDefined();
        expect(c.onShift).toBe(false);
    });

    it('LISTS A DRIVER ON SHIFT WHOSE MEMBERSHIP SAYS admin', async () => {
        /* The bug. shifts/start accepts this person; the board used not to
           show them. They are standing in a car park either way. */
        await driverOnShift('roster.admin', 'Admin On Shift', 'admin');
        const c = onBoard(await board(), 'roster.admin');
        expect(c).toBeDefined();
        expect(c.onShift).toBe(true);
    });

    it('flags that one, because the membership behind it is probably wrong', async () => {
        /* Showing them is the fix; saying nothing about why would turn a
           visible mistake into an invisible one. */
        const c = onBoard(await board(), 'roster.admin');
        expect(c.offRoster).toBe(true);
        expect(c.projectRole).toBe('admin');
    });

    it('does not list a project admin who is NOT on shift', async () => {
        /* The flip side. Every administrator appearing as a driver would
           make the picker useless on a contract with twenty-three of them. */
        await admin.post('/api/users').send({ username: 'roster.desk', name: 'Desk Admin', password: 'desk-pass-1', role: 'staff' });
        await admin.put('/api/users/roster.desk/memberships/uh').send({ role: 'admin', settings: {} });
        expect(onBoard(await board(), 'roster.desk')).toBeUndefined();
    });

    it('keeps listing somebody disabled while their shift is open', async () => {
        /* Disabling an account mid-shift does not empty the van. The board
           has to keep showing them until the packages are accounted for. */
        await driverOnShift('roster.cut', 'Cut Off', 'courier');
        const patched = await admin.patch('/api/users/roster.cut').send({ status: 'disabled' });
        expect(patched.status, patched.text).toBe(200);

        const c = onBoard(await board(), 'roster.cut');
        expect(c).toBeDefined();
        expect(c.onShift).toBe(true);
        expect(c.inactive).toBe(true);
    });

    it('carries the home pharmacy, so the planner can group by it', async () => {
        const sites = (await admin.get(`${UH}/sites`)).body;
        const southeast = sites.find((s) => s.code === 'southeast');
        const set = await admin.put(`${UH}/roster/roster.courier`).send({ homeSiteId: southeast.id });
        expect(set.status, set.text).toBe(200);

        const c = onBoard(await board(), 'roster.courier');
        expect(c.homeSiteId).toBe(southeast.id);
    });
});

describe('the roster a plan is built from', () => {
    it('plans from the people on shift once anybody is', async () => {
        const res = await admin.get(`${UH}/runs/propose`);
        expect(res.status, res.text).toBe(200);
        expect(res.body.planningFrom).toBe('onShift');
        expect(res.body.fleet.onShift).toBeGreaterThan(0);
        /* The whole point of the fix at the top of this file: somebody on
           shift whose membership says admin is a driver who turned up, and
           the plan is staffed for them. */
        expect(res.body.fleet.onShift).toBeLessThanOrEqual(res.body.fleet.roster + 1);
    });

    it('refuses a home pharmacy for somebody who is not a driver', async () => {
        /* The usual cause is a membership created with the wrong role, and
           silently storing a home site on it would hide that. */
        const res = await admin.put(`${UH}/roster/roster.desk`).send({ homeSiteId: 1 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('roster.notADriver');
    });

    it('refuses a pharmacy from another contract', async () => {
        /* An id from elsewhere stores cleanly and reads back as null, which
           looks like "never assigned" rather than like a mistake. */
        const res = await admin.put(`${UH}/roster/roster.idle`).send({ homeSiteId: 999999 });
        expect(res.status).toBe(400);
    });

    it('clears a home pharmacy without dropping the rest of the settings', async () => {
        const sites = (await admin.get(`${UH}/sites`)).body;
        const green = sites.find((s) => s.code === 'green');
        expect((await admin.put(`${UH}/roster/roster.idle`).send({ homeSiteId: green.id })).status).toBe(200);
        expect((await admin.put(`${UH}/roster/roster.idle`).send({ homeSiteId: null })).status).toBe(200);

        const roster = (await admin.get(`${UH}/roster`)).body;
        const idle = roster.drivers.find((d) => d.username === 'roster.idle');
        expect(idle.homeSiteId).toBeNull();
        expect(idle.homeSiteName).toBeNull();
    });

    it('counts how many drivers each pharmacy has, so gaps are visible', async () => {
        const roster = (await admin.get(`${UH}/roster`)).body;
        expect(roster.sites.length).toBeGreaterThan(0);
        expect(roster.counts.length).toBe(roster.sites.length);
        expect(typeof roster.unassigned).toBe('number');
    });

    it('is refused to a courier, who has no business seeing the roster', async () => {
        const agent = srv.agent();
        await agent.post('/api/login').send({ username: 'roster.courier', password: 'roster.courier-pass-1' });
        expect((await agent.get(`${UH}/roster`)).status).toBe(403);
    });
});
