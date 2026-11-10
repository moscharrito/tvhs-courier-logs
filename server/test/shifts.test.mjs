/* On shift and off shift (ticket 6.3).
 *
 * Three later tickets are the same question in different clothes: who may be
 * handed an unclaimed STAT, whose phone is being tracked, who the board draws
 * as available. So the tests that matter are the ones about when a shift is
 * open and when it may close.
 *
 * The one worth reading is the end. A shift that closes with three cold packs
 * still in the boot is three patients who do not get their medication and
 * nobody knowing until the pharmacy rings tomorrow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const SHIFTS = `${UH}/shifts`;

let srv;
let admin;
let ana;
let siteId;

/** A delivered-ready order, assigned to ana and collected. */
async function orderInTheVan({ pickUp = true } = {}) {
    /* Ad hoc, because POST /orders is the phone-call route and takes only
       stat or adhoc: a scheduled delivery arrives on a pharmacy's list. */
    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    const ev = (body) => admin.post(`${UH}/orders/${id}/events`).send(body);
    expect((await ev({ type: 'assigned', courierUsername: 'ana.shift' })).status).toBe(201);
    if (pickUp) {
        const r = await ev({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        expect(r.status, r.text).toBe(201);
    }
    return id;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;

    await admin.post('/api/users').send({ username: 'ana.shift', name: 'Ana Shift', password: 'shift-pass-1', role: 'driver' });
    /* WITH A HOME PHARMACY, which stopped being optional on 2 November 2026:
       going on shift is refused without one. Every test in this file used to
       create a courier with `settings: {}` and all twelve of them failed the
       moment the gate went in -- which is the gate working, and a useful
       measure of how much of this suite assumed a courier with no counter
       could work a day. */
    await admin.put('/api/users/ana.shift/memberships/uh').send({ role: 'courier', settings: { homeSiteId: siteId } });
    ana = srv.agent();
    const login = await ana.post('/api/login').send({ username: 'ana.shift', password: 'shift-pass-1' });
    expect(login.status, login.text).toBe(200);
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('going on shift', () => {
    it('opens a shift and says so', async () => {
        const res = await ana.post(`${SHIFTS}/start`).send({});
        expect(res.status).toBe(201);
        expect(res.body.open).toBe(true);
        expect(res.body.alreadyOn).toBe(false);
        expect(res.body.courierUsername).toBe('ana.shift');
    });

    it('refuses a courier with no pharmacy, and says who to ring', async () => {
        /* Until 2 November the only test was "is a courier on this project",
           which on University Health is thirty-nine accounts including the
           eight who are not on the confirmed roster. All of them could tap
           Go on shift, and while the unclaimed sweep was handing work to
           whoever was on shift and least loaded, several of them got real
           deliveries. */
        await admin.post('/api/users').send({ username: 'nohome.shift', name: 'No Home', password: 'shift-pass-1', role: 'driver' });
        await admin.put('/api/users/nohome.shift/memberships/uh').send({ role: 'courier', settings: {} });
        const them = srv.agent();
        expect((await them.post('/api/login').send({ username: 'nohome.shift', password: 'shift-pass-1' })).status).toBe(200);

        const res = await them.post(`${UH}/shifts/start`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.noHomeSite');
        /* Told what to do, not told they are not a courier -- which would be
           both wrong and no help to somebody standing at a counter. */
        expect(res.body.error).toMatch(/ring dispatch/i);

        /* And no shift was opened, which the status alone does not prove. */
        expect((await them.get(`${UH}/shifts/mine`)).body.shift).toBeNull();
    });

    it('still answers a courier who is already on shift when their pharmacy is taken away', async () => {
        /* THE ORDERING BUG THIS PINS. The gate was written above the
           idempotent answer, so a courier already on shift who tapped again
           on one bar was refused -- told they cannot go on shift while
           standing at a counter on one. The second tap is the phone, not the
           person. */
        await admin.post('/api/users').send({ username: 'lost.shift', name: 'Lost Counter', password: 'shift-pass-1', role: 'driver' });
        await admin.put('/api/users/lost.shift/memberships/uh').send({ role: 'courier', settings: { homeSiteId: siteId } });
        const them = srv.agent();
        expect((await them.post('/api/login').send({ username: 'lost.shift', password: 'shift-pass-1' })).status).toBe(200);
        expect((await them.post(`${UH}/shifts/start`)).status).toBe(201);

        /* Taken off the roster while out on a round. */
        await admin.put(`${UH}/roster/lost.shift`).send({ homeSiteId: null });

        const again = await them.post(`${UH}/shifts/start`);
        expect(again.status).toBe(200);
        expect(again.body.alreadyOn).toBe(true);
    });

    it('answers a second tap with the shift they are already on', async () => {
        /* A phone with one bar, nothing visibly happening, a second tap. That
           is the ordinary case, and answering it with an error tells somebody
           who IS on shift that they are not. */
        const first = (await ana.get(`${SHIFTS}/mine`)).body.shift;
        const again = await ana.post(`${SHIFTS}/start`).send({});
        expect(again.status).toBe(200);
        expect(again.body.alreadyOn).toBe(true);
        expect(again.body.id).toBe(first.id);
    });

    it('will not let the database hold two open shifts for one courier', async () => {
        /* The partial unique index, not the handler's read-then-write. Two
           requests that arrive together both see no open shift. */
        const rows = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM shifts WHERE courier_username = ? AND ended_at IS NULL',
            args: ['ana.shift'],
        });
        expect(Number(rows.rows[0].n)).toBe(1);

        await expect(srv.core.client.execute({
            sql: 'INSERT INTO shifts (project_id, courier_username, started_at) VALUES (2, ?, ?)',
            args: ['ana.shift', new Date().toISOString()],
        })).rejects.toThrow();
    });

    it('shows dispatch who is out there', async () => {
        const res = await admin.get(SHIFTS);
        expect(res.status).toBe(200);
        expect(res.body.shifts.some((s) => s.courierUsername === 'ana.shift' && s.open)).toBe(true);
    });
});

describe('going off shift', () => {
    it('closes cleanly when the van is empty', async () => {
        expect((await ana.post(`${SHIFTS}/end`).send({})).status).toBe(200);
        expect((await ana.get(`${SHIFTS}/mine`)).body.shift).toBeNull();
        // And it can be opened again the same day: a shift is not a check-in.
        expect((await ana.post(`${SHIFTS}/start`).send({})).status).toBe(201);
    });

    it('closes even with a package still in the van, and says how many', async () => {
        /* IT USED TO REFUSE, with a 409 and a sentence about section 9 of
           the offer letter. Two things emptied that out. Drivers stopped
           recording collections on 3 November, so "still with you" no
           longer means a counter handed them something -- it means a
           delivery they opened and did not finish, which the stops list on
           Today already shows them. And refusing did not get anything back
           to a pharmacy; what it got was three accounts stuck on shift for
           weeks, offered to dispatch every day as available.

           THE COUNT IS STILL REPORTED AND STILL AUDITED. Finishing a day
           over a loaded van is a thing that happened and the record should
           say how loaded it was. It is simply not this endpoint’s job to
           stop it. */
        const id = await orderInTheVan();
        const res = await ana.post(`${SHIFTS}/end`).send({});
        expect(res.status).toBe(200);
        expect(res.body.carrying).toBeGreaterThan(0);

        expect((await ana.get(`${SHIFTS}/mine`)).body.shift).toBeNull();

        /* And the delivery is untouched: ending a shift is not a way to
           make outstanding work disappear. */
        const after = await admin.get(`${UH}/orders/${id}`);
        expect(after.body.status).toBe('picked_up');
    });

    /** Attempted, not delivered, still in the boot: the shape returns.ts
     *  named first. Its own setup, because these two used to run in
     *  sequence -- the second read the shift the first had left open, and
     *  once the first stopped refusing it also stopped leaving one. */
    async function failedInTheVan() {
        await ana.post(`${SHIFTS}/start`).send({});
        const id = await orderInTheVan();
        const pkgs = (await ana.get(`${UH}/orders/${id}`)).body.packages;
        await ana.post(`${UH}/orders/${id}/attempt`).send({
            packages: pkgs.map((p) => ({ packageId: p.id, reasonCode: 'recipient_not_located', note: '' })),
        });
        return id;
    }

    it('still reports a failed delivery as carried, and still does not hold the shift open', async () => {
        /* THE INFORMATION SURVIVED THE BLOCK. /mine says what is in the van
           and the audit row says how much was in it when the day ended --
           what went on 3 November is the refusal, not the record. */
        const id = await failedInTheVan();

        const mine = await ana.get(`${SHIFTS}/mine`);
        expect(mine.body.carrying.map((c) => c.id)).toContain(id);
        expect(mine.body.carrying.find((c) => c.id === id).status).toBe('failed');

        const res = await ana.post(`${SHIFTS}/end`).send({});
        expect(res.status).toBe(200);
        expect(res.body.carrying).toBeGreaterThan(0);
        expect((await ana.get(`${SHIFTS}/mine`)).body.shift).toBeNull();
    });

    it('clears it from the van when it is handed back, which is still the way', async () => {
        /* Section 9 has not changed: every undelivered package goes back to
           the pharmacy it came from the same day. Take back undelivered is
           still how that is recorded, and it is still what empties the
           van -- it is no longer what unlocks the button. */
        const id = await failedInTheVan();

        const strokes = [[{ x: 0.1, y: 0.6, t: 0 }, { x: 0.9, y: 0.4, t: 80 }]];
        const back = await ana.post(`${UH}/returns`).send({
            siteId, orderIds: [id], countedPackages: 1,
            signedName: 'L. Ortiz, RPh', strokes,
        });
        expect(back.status, back.text).toBe(201);

        /* That one specifically, not the van emptied: these tests share a
           courier and earlier ones leave their own orders in it. */
        expect((await ana.get(`${SHIFTS}/mine`)).body.carrying.map((c) => c.id)).not.toContain(id);
        expect((await ana.post(`${SHIFTS}/end`).send({})).status).toBe(200);
    });

    it('says plainly when somebody is not on shift at all', async () => {
        const res = await ana.post(`${SHIFTS}/end`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.notOn');
    });
});

describe('the escape hatch', () => {
    it('lets dispatch end a loaded shift, with a reason, under their own name', async () => {
        /* NOT AN ESCAPE HATCH ANY MORE, and still worth having. It existed
           because a self-end was refused over a loaded van, which stopped
           on 3 November; what remains is the only way to end SOMEBODY
           ELSE’S shift -- a driver who went home without tapping the
           button -- and it still demands a reason and signs it with the
           dispatcher’s name. */
        await ana.post(`${SHIFTS}/start`).send({});
        const id = await orderInTheVan();

        const shift = (await ana.get(`${SHIFTS}/mine`)).body.shift;
        const forced = await admin.post(`${SHIFTS}/${shift.id}/end`).send({
            reason: 'Green pharmacy closed; packages stay in the van overnight.',
        });
        expect(forced.status).toBe(200);
        expect(forced.body.carrying.map((c) => c.id)).toContain(id);

        // The packages are still recorded as out. Ending a shift moved nothing.
        const after = await admin.get(`${UH}/orders/${id}`);
        expect(after.body.status).toBe('picked_up');
    });

    it('will not take a reason that is not one', async () => {
        await ana.post(`${SHIFTS}/start`).send({});
        const shift = (await ana.get(`${SHIFTS}/mine`)).body.shift;
        expect((await admin.post(`${SHIFTS}/${shift.id}/end`).send({ reason: '' })).status).toBe(400);
        expect((await admin.post(`${SHIFTS}/${shift.id}/end`).send({ reason: 'Ended it. Packages to be returned tomorrow.' })).status).toBe(200);
    });

    it('records how loaded the van was when somebody decided the day was over', async () => {
        const audit = await admin.get('/api/audit?action=shift.ended');
        const detail = (e) => (typeof e.detail === 'string' ? JSON.parse(e.detail || '{}') : (e.detail ?? {}));
        const forced = audit.body.events.filter((e) => detail(e).endedBy === 'dispatch');
        expect(forced.length).toBeGreaterThan(0);
        expect(forced.some((e) => Number(detail(e).carrying) > 0)).toBe(true);
    });

    it('refuses to end a shift that is already over', async () => {
        const rows = await srv.core.client.execute({
            sql: 'SELECT id FROM shifts WHERE courier_username = ? AND ended_at IS NOT NULL ORDER BY id LIMIT 1',
            args: ['ana.shift'],
        });
        const res = await admin.post(`${SHIFTS}/${Number(rows.rows[0].id)}/end`).send({ reason: 'Trying it twice.' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.alreadyEnded');
    });
});

/* ── THE ROSTER SCREEN'S SWITCH (10 November 2026) ─────────────────────────
 *
 * Dispatch could end somebody else's shift and could not start one, which
 * is an asymmetry nobody chose and which cost real mornings: a flat battery,
 * a driver who pulled out of the counter without tapping, an afternoon of
 * backlog worked through from a desk. Being on shift is what decides who may
 * be handed a delivery, so a driver nobody could switch on was a driver
 * nobody could give work to.
 *
 * The tests worth reading are the two refusals. The gate is deliberately NOT
 * softer because an administrator is asking.
 */
describe('dispatch putting a driver on shift', () => {
    const FOR = (u) => `${SHIFTS}/for/${u}`;

    /** A driver of this block's own, so the ordering of the file's other
     *  tests -- which share one courier and leave shifts open on purpose --
     *  cannot decide what these ones see. */
    async function makeDriver(username, { home = true, active = true } = {}) {
        await admin.post('/api/users').send({ username, name: `Test ${username}`, password: 'shift-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({
            role: 'courier', settings: home ? { homeSiteId: siteId } : {},
        });
        if (!active) await admin.patch(`/api/users/${username}`).send({ status: 'disabled' });
        return username;
    }

    it('opens a shift for somebody who never touched a phone, and signs the row', async () => {
        const u = await makeDriver('bo.shift');
        const res = await admin.post(`${FOR(u)}/start`).send({});
        expect(res.status, res.text).toBe(201);
        expect(res.body.open).toBe(true);
        expect(res.body.alreadyOn).toBe(false);
        expect(res.body.courierUsername).toBe(u);

        /* THE PART THAT MATTERS LATER. Hours are reconciled from the export,
           and an hour somebody at a desk opened is a different kind of hour
           from one a driver opened at a counter. `ended_by` has always taken
           this care at the other end of the day. */
        expect(res.body.startedBy).toBe('admin');

        // And the driver's own phone agrees, because it is one row.
        expect((await admin.get(SHIFTS)).body.shifts.some((s) => s.courierUsername === u && s.open)).toBe(true);
    });

    it('leaves a courier who started their own unsigned, which is how they are told apart', async () => {
        const mine = (await ana.get(`${SHIFTS}/mine`)).body.shift
            ?? (await ana.post(`${SHIFTS}/start`).send({})).body;
        expect(mine.startedBy).toBe('');
    });

    it('answers a second click with the shift that is already open', async () => {
        /* The same reasoning as the courier's own route: a dispatcher who
           clicks twice on a slow page has not done anything wrong, and the
           partial unique index would not allow a second row anyway. */
        const first = (await admin.get(SHIFTS)).body.shifts.find((s) => s.courierUsername === 'bo.shift');
        const again = await admin.post(`${FOR('bo.shift')}/start`).send({});
        expect(again.status).toBe(200);
        expect(again.body.alreadyOn).toBe(true);
        expect(again.body.id).toBe(first.id);
    });

    it('refuses a driver with no pharmacy, and names the screen that fixes it', async () => {
        /* NOT SOFTER BECAUSE AN ADMINISTRATOR IS ASKING. Being on shift
           means "may be handed a delivery" and a driver with no counter
           cannot be given one sensibly -- which is the whole reason the
           courier's own route has this gate. */
        const u = await makeDriver('nohome.roster', { home: false });
        const res = await admin.post(`${FOR(u)}/start`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.noHomeSite');
        expect(res.body.error).toMatch(/home pharmacy/i);

        // And nothing was opened, which the status alone does not prove.
        expect((await admin.get(SHIFTS)).body.shifts.some((s) => s.courierUsername === u)).toBe(false);
    });

    it('refuses a disabled account, because they cannot record a stop either', async () => {
        /* An open shift offers them to the board as somebody who could take
           the work, and they cannot sign in to do it. */
        const u = await makeDriver('gone.roster', { active: false });
        const res = await admin.post(`${FOR(u)}/start`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.accountDisabled');
    });

    it('refuses somebody who is not on the project at all', async () => {
        const res = await admin.post(`${FOR('nobody.here')}/start`).send({});
        expect(res.status).toBe(404);
    });

    it('is not open to a courier, who has their own route for their own shift', async () => {
        const res = await ana.post(`${FOR('bo.shift')}/start`).send({});
        expect(res.status).toBe(403);
    });
});

describe('dispatch taking a driver off shift', () => {
    const FOR = (u) => `${SHIFTS}/for/${u}`;

    it('closes it under the dispatcher name, with the reason they gave', async () => {
        const res = await admin.post(`${FOR('bo.shift')}/end`).send({
            reason: 'Went home without tapping off; confirmed by telephone.',
        });
        expect(res.status, res.text).toBe(200);

        const rows = await srv.core.client.execute({
            sql: 'SELECT ended_by, ended_reason FROM shifts WHERE courier_username = ? ORDER BY id DESC LIMIT 1',
            args: ['bo.shift'],
        });
        expect(String(rows.rows[0].ended_by)).toBe('admin');
        expect(String(rows.rows[0].ended_reason)).toMatch(/confirmed by telephone/);

        expect((await admin.get(SHIFTS)).body.shifts.some((s) => s.courierUsername === 'bo.shift' && s.open)).toBe(false);
    });

    it('will not take a reason that is not one', async () => {
        await admin.post(`${FOR('bo.shift')}/start`).send({});
        expect((await admin.post(`${FOR('bo.shift')}/end`).send({ reason: '' })).status).toBe(400);
        /* Still on shift. A rejected reason must not half-close a day. */
        expect((await admin.get(SHIFTS)).body.shifts.some((s) => s.courierUsername === 'bo.shift' && s.open)).toBe(true);
    });

    it('says plainly when they are not on shift, rather than reporting them missing', async () => {
        /* 409 and not 404: the person exists, the shift does not, and a
           screen saying "not found" would send a dispatcher looking for a
           spelling mistake in a name they picked off a list. */
        await admin.post(`${FOR('bo.shift')}/end`).send({ reason: 'Clearing the board for the day.' });
        const res = await admin.post(`${FOR('bo.shift')}/end`).send({ reason: 'Clearing the board again.' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('shift.notOn');
    });
});
