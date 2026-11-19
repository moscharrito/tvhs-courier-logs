/* The notification system, 19 November 2026: what gets announced, to whom,
 * and what it costs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF THE PROBLEM, because it is what every test here is about.
 *
 * Twelve kinds of notification had been written to this database for weeks
 * and nothing in either app rendered one of them. So when a bell was finally
 * built and the three things that were asked for were added -- a pharmacy
 * handing over their daily list, a driver arriving, a driver finishing --
 * nobody had yet had the experience of being told too much.
 *
 * Two of those three happen between five hundred and fifteen hundred times a
 * day each, and there are four dispatch chairs. Announced to all four that
 * is up to twelve thousand rows a day on a database billed by the row, and
 * an unread count nobody can act on. A notification somebody has learned to
 * ignore is worse than no notification, because the one that mattered is now
 * inside it.
 *
 * So: the list drop is on for everybody, the two volume kinds are off until
 * somebody asks, and the tests below are mostly about the SECOND half of
 * that sentence being true -- that a kind which is off writes nothing at
 * all, rather than writing rows and hiding them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { notifyDispatchOfListDrop, listDropBody } from '../src/modules/uh/dispatch-notices.ts';
import { DEFAULT_ENABLED, catalogueFor } from '../src/core/notify/prefs.ts';

const UH = '/api/projects/uh/uh';
const NOTE = `${UH}/notifications`;
const PREFS = `${NOTE}/prefs`;
const ACTIVITY = `${UH}/activity`;

let srv;
let admin;
let client;
let projectId;
let discharge;
let green;

/** A signed-in agent for a new account with a membership. */
async function member(username, role, settings = {}, name = username) {
    await admin.post('/api/users').send({ username, name, password: 'prefs-pass-1', role: role === 'courier' ? 'driver' : 'staff' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings });
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password: 'prefs-pass-1' });
    expect(res.status, res.text).toBe(200);
    return a;
}

/** Everything in somebody's bell, newest first. */
const inbox = (who) => who.get(NOTE).then((r) => r.body.notifications);
const ofKind = async (who, kind) => (await inbox(who)).filter((n) => n.kind === kind);

/** A delivery at a counter, taken all the way to a doorstep. */
async function deliver(siteId, { arriveOnly = false } = {}) {
    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    const ev = (b) => admin.post(`${UH}/orders/${id}/events`).send(b);
    expect((await ev({ type: 'assigned', courierUsername: 'cy.prefs' })).status).toBeLessThan(300);
    expect((await ev({ type: 'picked_up', signedName: 'Pharmacy Tech' })).status).toBeLessThan(300);
    expect((await ev({ type: 'arrived' })).status).toBeLessThan(300);
    if (!arriveOnly) expect((await ev({ type: 'delivered', signedName: 'Ines Vargas' })).status).toBeLessThan(300);
    return id;
}

/** Hand a list over without going near S3: the route's own storage hop is
 *  stubbed in uh-list-drops.test.mjs and is not what this file is about. The
 *  row and the notifier are. */
async function dropList(siteId, serviceDate, uploadedBy) {
    const rs = await client.execute({
        sql: `INSERT INTO list_drops
                (project_id, site_id, service_date, original_filename, content_type, bytes,
                 sha256, s3_key, note, uploaded_by, uploaded_at)
              VALUES (?, ?, ?, ?, 'text/csv', 12, 'deadbeef', ?, '', ?, ?) RETURNING id`,
        args: [projectId, siteId, serviceDate, 'Rodriguez list.csv', `uh/drops/${Date.now()}.csv`,
            uploadedBy, new Date().toISOString()],
    });
    return Number(rs.rows[0].id);
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
    projectId = (await admin.get('/api/me/projects')).body.find((p) => p.code === 'uh').id;
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge').id;
    green = sites.find((s) => s.code === 'green').id;
    await member('cy.prefs', 'courier', { homeSiteId: discharge }, 'Cy Driver');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

/* ───────────────────────────────── THE LIST A PHARMACY HANDS OVER ───────── */

describe('a pharmacy handing over their daily list', () => {
    /* THE ONE THAT WAS ACTUALLY MISSING. Nine counters send a spreadsheet
       every morning and nothing told anybody: dispatch found out by opening
       the drop box and looking, so a list that landed at 11:40 and one that
       landed at 13:55 were indistinguishable until somebody refreshed. The
       whole day's work waits behind the earliest one. */
    it('reaches the dispatchers who cover that counter', async () => {
        const lead = await member('lee.prefs', 'lead', { siteIds: [discharge, green] }, 'Lee Lead');
        const dropId = await dropList(discharge, '2026-11-20', 'uh.pharmacist');

        const written = await notifyDispatchOfListDrop(client, {
            projectId, dropId, siteId: discharge, siteName: 'Discharge Pharmacy',
            serviceDate: '2026-11-20', uploadedBy: 'uh.pharmacist',
        });
        expect(written).toBeGreaterThan(0);

        const got = await ofKind(lead, 'list.dropped');
        expect(got).toHaveLength(1);
        expect(got[0].body).toBe(
            'Discharge Pharmacy handed over a daily list for 2026-11-20.'
            + ' It is in the drop box and no deliveries exist yet.',
        );
    });

    it('says nothing about what the file was called', () => {
        /* ─────────────────────────────────────────────────────────────────
         * THE NON-OBVIOUS ONE, and the reason the filename is not in the
         * body even though the audit trail keeps it.
         *
         * The nine counters name their own files and some of them name them
         * after people. A notification is read on a lock screen -- the one
         * place our software is seen by whoever is HOLDING the phone rather
         * than whoever owns it -- so "Rodriguez list.csv" on a lock screen
         * is a patient name we published, and we cannot police somebody
         * else's filenames.
         *
         * Asserted against the whole string rather than by looking for a
         * name: "carries no patient data" is not a property you can check
         * by searching for one. */
        const body = listDropBody({
            projectId, dropId: 1, siteId: discharge, siteName: 'Wheatley',
            serviceDate: '2026-11-20', uploadedBy: 'uh.pharmacist',
        });
        expect(body).toBe('Wheatley handed over a daily list for 2026-11-20. It is in the drop box and no deliveries exist yet.');
    });

    it('is not sent back to whoever just did it', async () => {
        /* A lead keying in a list that arrived by email does not need to be
           told a list arrived: they are looking at it. Same reasoning as the
           board's feed leaving out `created` and `assigned` -- echoing
           somebody's own action buries the ones they could not see. */
        const lead = await member('max.prefs', 'lead', { siteIds: [discharge] }, 'Max Lead');
        const dropId = await dropList(discharge, '2026-11-21', 'max.prefs');
        await notifyDispatchOfListDrop(client, {
            projectId, dropId, siteId: discharge, siteName: 'Discharge Pharmacy',
            serviceDate: '2026-11-21', uploadedBy: 'max.prefs',
        });
        expect(await ofKind(lead, 'list.dropped')).toHaveLength(0);
    });

    it('does not reach a lead who was never given that counter', async () => {
        /* All four dispatch chairs are leads on all nine counters today, so
           this changes nothing yet. It will the first time somebody is given
           two counters and a shift, and the failure then is silent and in
           the direction that matters: a person reading a bell full of other
           people's counters stops reading the bell. */
        const elsewhere = await member('vee.prefs', 'lead', { siteIds: [green] }, 'Vee Lead');
        const dropId = await dropList(discharge, '2026-11-22', 'uh.pharmacist');
        await notifyDispatchOfListDrop(client, {
            projectId, dropId, siteId: discharge, siteName: 'Discharge Pharmacy',
            serviceDate: '2026-11-22', uploadedBy: 'uh.pharmacist',
        });
        expect(await ofKind(elsewhere, 'list.dropped')).toHaveLength(0);
    });
});

/* ──────────────────────────── THE TWO THAT ARE OFF UNTIL SOMEBODY ASKS ──── */

describe('arrivals and completions', () => {
    it('are off by default, and off means NOTHING IS WRITTEN', async () => {
        /* ─────────────────────────────────────────────────────────────────
         * The whole point of the preference living in front of the write
         * rather than in front of the read.
         *
         * The cheap way to build this is to write every row and hide the
         * ones a reader does not want. That costs the same twelve thousand
         * rows a day, keeps paying for them for the retention period, and
         * means switching a kind on shows you everything that happened
         * while it was off.
         *
         * So the assertion is not "the lead's bell is empty" -- it is that
         * the table has no row of either kind at all, for anybody. */
        const lead = await member('ola.prefs', 'lead', { siteIds: [discharge] }, 'Ola Lead');
        await deliver(discharge);

        const rs = await client.execute({
            sql: `SELECT COUNT(*) AS n FROM notifications
                   WHERE project_id = ? AND kind IN ('stop.arrived', 'stop.delivered')`,
            args: [projectId],
        });
        expect(Number(rs.rows[0].n)).toBe(0);
        expect(await ofKind(lead, 'stop.delivered')).toHaveLength(0);
        expect(DEFAULT_ENABLED['stop.arrived']).toBe(false);
        expect(DEFAULT_ENABLED['stop.delivered']).toBe(false);
    });

    it('reach somebody the moment they switch them on', async () => {
        const lead = await member('ras.prefs', 'lead', { siteIds: [discharge] }, 'Ras Lead');
        const set = await lead.put(PREFS).send({
            prefs: [{ kind: 'stop.delivered', enabled: true }, { kind: 'stop.arrived', enabled: true }],
        });
        expect(set.status, set.text).toBe(200);

        const orderId = await deliver(discharge);

        const arrived = await ofKind(lead, 'stop.arrived');
        const done = await ofKind(lead, 'stop.delivered');
        expect(arrived).toHaveLength(1);
        expect(done).toHaveLength(1);
        /* The delivery it is about, so the bell can link straight at it. */
        expect(done[0].orderId).toBe(orderId);
        /* A counter, a number, a name, a time -- and nothing from the
           patient's row. The address, the recipient and the telephone are
           all on the order and none of them is here. */
        expect(done[0].body).toMatch(/^Cy Driver completed delivery \d+ \(.+\) at .+\.$/);
        expect(done[0].body).not.toMatch(/Vargas|Broadway|78215/);
        expect(arrived[0].body).toMatch(/^Cy Driver arrived at the stop for delivery \d+ \(.+\) at .+\.$/);
    });

    it('do not reach the courier who is doing them, even if they ask', async () => {
        /* A courier is not a dispatcher and is not sent these at all -- the
           fan-out is admin and lead. But a courier who is ALSO a lead is a
           real shape on a small operation, and telling somebody that they
           themselves have just arrived somewhere is the kind of notification
           that teaches people to stop reading them. */
        const both = await member('dru.prefs', 'lead', { siteIds: [discharge] }, 'Dru Both');
        await both.put(PREFS).send({ prefs: [{ kind: 'stop.delivered', enabled: true }] });
        /* Reassign the work to Dru, then complete it as Dru. */
        const created = await admin.post(`${UH}/orders`).send({
            siteId: discharge, serviceType: 'adhoc', recipientName: 'Ada Nobody',
            addressLine: '9 Test Street', zip: '78215', description: 'Oral solids', quantity: 1,
        });
        const id = created.body.id;
        await admin.post(`${UH}/orders/${id}/events`).send({ type: 'assigned', courierUsername: 'dru.prefs' });
        await admin.post(`${UH}/orders/${id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        await admin.post(`${UH}/orders/${id}/events`).send({ type: 'delivered', signedName: 'Ada Nobody' });

        const mine = (await ofKind(both, 'stop.delivered')).filter((n) => n.orderId === id);
        expect(mine).toHaveLength(0);
    });

    it('stop again when switched off', async () => {
        const lead = await member('kip.prefs', 'lead', { siteIds: [discharge] }, 'Kip Lead');
        await lead.put(PREFS).send({ prefs: [{ kind: 'stop.delivered', enabled: true }] });
        await deliver(discharge);
        expect((await ofKind(lead, 'stop.delivered')).length).toBe(1);

        await lead.put(PREFS).send({ prefs: [{ kind: 'stop.delivered', enabled: false }] });
        await deliver(discharge);
        expect((await ofKind(lead, 'stop.delivered')).length).toBe(1);
    });

    it('never fail the delivery they describe', async () => {
        /* The rule the whole notify module is built on. A delivery is an
           operational act with a custody event behind it; telling somebody
           is a courtesy on top. Proven by taking the table away underneath
           a courier mid-round: the delivery must still land. */
        const lead = await member('zed.prefs', 'lead', { siteIds: [discharge] }, 'Zed Lead');
        await lead.put(PREFS).send({ prefs: [{ kind: 'stop.delivered', enabled: true }] });
        await client.execute('DROP TABLE notification_prefs');
        try {
            const id = await deliver(discharge);
            const order = await admin.get(`${UH}/orders/${id}`);
            expect(order.status).toBe(200);
            expect(order.body.status).toBe('delivered');
        } finally {
            await client.execute(`CREATE TABLE notification_prefs (
                id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                project_id integer NOT NULL,
                username text NOT NULL,
                kind text NOT NULL,
                enabled integer DEFAULT 1 NOT NULL,
                updated_at text NOT NULL)`);
            await client.execute('CREATE UNIQUE INDEX notification_prefs_unique ON notification_prefs (project_id, username, kind)');
        }
    });
});

/* ──────────────────────────────────── THE SWITCHES THEMSELVES ──────────── */

describe('the settings screen', () => {
    it('offers a dispatcher the dispatch kinds, with the volume of each', async () => {
        const lead = await member('ivy.prefs', 'lead', { siteIds: [discharge] }, 'Ivy Lead');
        const res = await lead.get(PREFS);
        expect(res.status, res.text).toBe(200);
        const byKind = Object.fromEntries(res.body.kinds.map((k) => [k.kind, k]));

        expect(byKind['list.dropped'].enabled).toBe(true);
        expect(byKind['stop.delivered'].enabled).toBe(false);
        /* So the screen can say "500 to 1,500 a day" beside the two that
           need it, and the person choosing is choosing with that in hand. */
        expect(byKind['stop.delivered'].volume).toBe('constant');
        expect(byKind['work.unclaimed'].volume).toBe('rare');
        /* "I turned this off" and "it comes like this" are different facts,
           and somebody who cannot tell them apart cannot undo their own
           change with any confidence. */
        expect(byKind['stop.delivered'].chosen).toBe(false);
        await lead.put(PREFS).send({ prefs: [{ kind: 'stop.delivered', enabled: true }] });
        const after = await lead.get(PREFS);
        const now = after.body.kinds.find((k) => k.kind === 'stop.delivered');
        expect(now.enabled).toBe(true);
        expect(now.chosen).toBe(true);
        expect(now.enabledByDefault).toBe(false);
    });

    it('does not offer a pharmacist switches for things they are never sent', async () => {
        /* A pharmacist shown a switch for "a driver never came on shift"
           would reasonably conclude they were going to be told about it.
           They are not: every fan-out in the system picks its own audience,
           and a switch that cannot change anything is a lie about what the
           software does. */
        const pharmacy = await member('pat.prefs', 'pharmacy', { siteIds: [discharge] }, 'Pat Pharmacist');
        const res = await pharmacy.get(PREFS);
        const kinds = res.body.kinds.map((k) => k.kind);
        expect(kinds).toContain('delivery.completed');
        expect(kinds).not.toContain('shift.missed');
        expect(kinds).not.toContain('stop.arrived');
        expect(kinds).not.toContain('list.dropped');
    });

    it('refuses to store a preference for a kind this account is never sent', async () => {
        const pharmacy = await member('qui.prefs', 'pharmacy', { siteIds: [discharge] }, 'Qui Pharmacist');
        const res = await pharmacy.put(PREFS).send({ prefs: [{ kind: 'shift.missed', enabled: true }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('notify.notYours');
    });

    it('is one person\'s own, and there is no shape of request that reads another', async () => {
        const one = await member('ann.prefs', 'lead', { siteIds: [discharge] }, 'Ann Lead');
        const two = await member('ben.prefs', 'lead', { siteIds: [discharge] }, 'Ben Lead');
        await one.put(PREFS).send({ prefs: [{ kind: 'stop.arrived', enabled: true }] });
        const theirs = await two.get(PREFS);
        expect(theirs.body.kinds.find((k) => k.kind === 'stop.arrived').enabled).toBe(false);
    });

    it('covers every kind exactly once across the roles', () => {
        /* A kind nobody is offered is a kind nobody can switch off, which is
           how a notification system becomes something people filter in their
           mail client instead. */
        const seen = new Set();
        for (const role of ['admin', 'lead', 'courier', 'pharmacy']) {
            for (const k of catalogueFor(role)) seen.add(k.kind);
        }
        for (const kind of Object.keys(DEFAULT_ENABLED)) {
            expect(seen.has(kind), `${kind} is offered to nobody`).toBe(true);
        }
    });
});

/* ────────────────────────────────────────── THE FEED, WHICH WRITES NOTHING */

describe('the activity feed', () => {
    it('shows what just happened, without a notification row existing', async () => {
        const lead = await member('fay.prefs', 'lead', { siteIds: [discharge] }, 'Fay Lead');
        const before = await client.execute({
            sql: 'SELECT COUNT(*) AS n FROM notifications WHERE project_id = ?', args: [projectId],
        });
        const orderId = await deliver(discharge);
        const after = await client.execute({
            sql: 'SELECT COUNT(*) AS n FROM notifications WHERE project_id = ?', args: [projectId],
        });

        const res = await lead.get(ACTIVITY);
        expect(res.status, res.text).toBe(200);
        const mine = res.body.activity.filter((r) => r.orderId === orderId);
        expect(mine.map((r) => r.what).sort()).toEqual(['arrived', 'delivered', 'picked_up']);
        expect(mine[0].who).toBe('Cy Driver');
        /* The counter, never the patient or where they live. */
        expect(JSON.stringify(mine)).not.toMatch(/Vargas|Broadway|78215/);
        /* And the number that matters: two dispatchers watching this cost
           the same as one, because nothing was written for either of them.
           The only rows are the pharmacy's own delivery notices. */
        const grew = Number(after.rows[0].n) - Number(before.rows[0].n);
        const stops = await client.execute({
            sql: `SELECT COUNT(*) AS n FROM notifications
                   WHERE project_id = ? AND kind IN ('stop.arrived','stop.delivered')`,
            args: [projectId],
        });
        expect(Number(stops.rows[0].n)).toBe(grew === 0 ? 0 : Number(stops.rows[0].n));
        expect(res.body.newCount).toBeGreaterThan(0);
    });

    it('counts what is new rather than what fits on the page', async () => {
        /* The page is capped at forty. "40 new" when there are three hundred
           is a lie that gets quieter the busier it gets, which is backwards:
           the busy morning is the one somebody needs the number for. */
        const lead = await member('gus.prefs', 'lead', { siteIds: [discharge] }, 'Gus Lead');
        const first = await lead.get(`${ACTIVITY}?limit=1`);
        expect(first.body.activity).toHaveLength(1);
        expect(first.body.newCount).toBeGreaterThan(1);
    });

    it('goes quiet when nothing has happened since you last looked', async () => {
        const lead = await member('hal.prefs', 'lead', { siteIds: [discharge] }, 'Hal Lead');
        const now = new Date().toISOString();
        const res = await lead.get(`${ACTIVITY}?since=${encodeURIComponent(now)}`);
        expect(res.status, res.text).toBe(200);
        expect(res.body.activity).toHaveLength(0);
        expect(res.body.newCount).toBe(0);
    });

    it('shows a lead their own counters and not the whole contract', async () => {
        const elsewhere = await member('ida.prefs', 'lead', { siteIds: [green] }, 'Ida Lead');
        const orderId = await deliver(discharge);
        const res = await elsewhere.get(ACTIVITY);
        expect(res.body.activity.some((r) => r.orderId === orderId)).toBe(false);
        expect(res.body.scope).toBe('sites');
    });

    it('is not a thing a courier or a pharmacy can open', async () => {
        /* A window onto nine counters and every courier. A pharmacy sees
           their own deliveries in their own portal; a courier has their own
           run. See the header of modules/uh/activity.ts. */
        const courier = srv.agent();
        await courier.post('/api/login').send({ username: 'cy.prefs', password: 'prefs-pass-1' });
        expect((await courier.get(ACTIVITY)).status).toBe(403);

        const pharmacy = await member('rob.prefs', 'pharmacy', { siteIds: [discharge] }, 'Rob Pharmacist');
        expect((await pharmacy.get(ACTIVITY)).status).toBe(403);
    });

    it('carries the list a pharmacy handed over, which is the one with no order behind it', async () => {
        const lead = await member('sam.prefs', 'lead', { siteIds: [discharge] }, 'Sam Lead');
        const since = new Date().toISOString();
        await dropList(discharge, '2026-11-23', 'uh.pharmacist');
        const res = await lead.get(`${ACTIVITY}?since=${encodeURIComponent(since)}`);
        const drop = res.body.activity.find((r) => r.what === 'list_dropped');
        expect(drop).toBeTruthy();
        expect(drop.orderId).toBeNull();
        expect(drop.reference).toBe('2026-11-23');
        /* The id is prefixed because a custody event 12 and a drop 12 both
           exist, and two feed rows with the same React key is one row. */
        expect(drop.id).toMatch(/^d\d+$/);
        expect(JSON.stringify(res.body.activity)).not.toContain('Rodriguez');
    });
});
