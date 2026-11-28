/* Texting a patient that a delivery is coming.
 *
 * The property most of these defend is what is NOT in the message. A text is
 * read on a lock screen by whoever is holding the phone, and the difference
 * between "a courier is coming" and "your pharmacy is sending your
 * prescription" is the difference between a delivery notice and telling
 * somebody's flatmate they are ill. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, storedForm } from './helpers/server.mjs';
import { STAGE_NAMES } from '../src/core/notify/sms-template.ts';
import { assertMinimal, toE164, createTexter, OPTED_OUT } from '../src/core/notify/twilio.ts';
import {
    DELIVERY_TODAY, inMorningWindow, queueRoundNotices,
    recentSmsState, sendQueued, BATCH,
} from '../src/modules/uh/patient-sms.ts';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;

let srv, admin, client, dischargeId, projectId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
    projectId = Number((await client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    dischargeId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;

    await admin.post('/api/users').send({
        username: DRIVER, name: DRIVER_NAME, password: 'sms-pass-1', role: 'driver',
    });
    await admin.put(`/api/users/${DRIVER}/memberships/uh`).send({ role: 'courier', settings: {} });
    /* A NUMBER ON THE ROSTER, so this file exercises the primary path. The
       dispatch fallback has tests of its own below; without this line it
       would be the only path covered and the driver's own number would go
       out untested. */
    await admin.put(`${UH}/roster/${DRIVER}/contact`).send({ phone: DRIVER_PHONE });
    /* UNPAUSED FOR THE FILE. queueMorningNotices ignored the pause when it
       was handed no settings, which is how the blocks below ever queued
       anything -- the project ships paused and nothing here switched it on.
       queueRoundNotices refuses without settings and obeys the pause in
       them, correctly, so it has to be said out loud. The `paused` describe
       sets and restores it for itself. */
    /* AND A DISPATCH NUMBER WITH IT. Unpausing is refused without one now:
       the switched-on stages ask the patient to ring a number, and a
       project that cannot name one would send them a blank. */
    await admin.patch('/api/projects/uh/settings')
        .send({ patientSms: { paused: false, dispatchPhone: DISPATCH } });
});
afterAll(async () => { await srv.stop(); });

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let seq = 0;
async function order(over = {}) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId: dischargeId, serviceType: 'adhoc', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Rehearsal Way`, zip: '78215', recipientPhone: '2105550100',
        description: 'Oral solids', quantity: 1, externalRef: `SMS-${seq}`, ...over,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
}

const today = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const rows = async (sql, args = []) => (await client.execute({ sql, args })).rows;

/** The project's settings as the scheduler would resolve them. */
async function settingsNow() {
    const { resolveSettings } = await import('../src/core/projects/settings.ts');
    const row = (await client.execute("SELECT settings FROM projects WHERE code = 'uh'")).rows[0];
    return resolveSettings(JSON.parse(String(row.settings ?? '{}')));
}
const clear = async () => {
    await client.execute('DELETE FROM patient_messages');
    await client.execute('DELETE FROM patient_optouts');
};

/* ═══════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS WERE REPOINTED, ON 23 NOVEMBER 2026
 *
 * Until this morning twenty tests in this file drove queueMorningNotices.
 * They passed. NOTHING IN src CALLED IT.
 *
 * On 22 November the trigger moved from a morning clock to the moment a
 * round is built -- a list released after noon was getting no notice at all
 * -- and queueRoundNotices was written and wired into the scheduler and the
 * assignment hook. The old function was left standing, and this file went
 * on proving it worked.
 *
 * So the first real test of patient texting sent nothing to anybody while
 * the suite was green, because the suite was green about a function with no
 * callers. That is a worse fault than the silence it hid.
 *
 * The two functions do not ask the same question, which is the whole of the
 * work below. queueRoundNotices additionally requires:
 *
 *   - settings, always, because a caller that cannot supply them cannot have
 *     checked whether the project is PAUSED;
 *   - a courier on the order, with a name this project can resolve, because
 *     the text names them;
 *   - a due_at, because the text quotes it.
 *
 * Hence `textable()` and `roundNotices()`. Everything else each test
 * asserted is unchanged -- the unique index, the cancelled and delivered
 * exclusions, the facility rule, the opt-out, the pause. They assert it
 * about the code that actually runs now.
 * ═══════════════════════════════════════════════════════════════════════ */

/** A courier on THIS contract. driverFirstNames joins memberships for this
 *  project, so a driver seeded for TVHS resolves to no name here and every
 *  order would be skipped -- which would make the assertions below pass for
 *  a reason that has nothing to do with what they claim.
 *
 *  THE NAME IS INVENTED AND WAS CHECKED FOR IT. The first draft used a
 *  plausible San Antonio surname which turned out to appear four times in
 *  the production backups in this working copy -- so it belonged to a real
 *  person, and this repository is public. Grep before inventing a name. */
const DRIVER = 'sms.courier';
const DRIVER_NAME = 'Nerissa Quillane';
/* ── THE TWO NUMBERS EVERY MESSAGE NOW CARRIES ONE OF.
 *
 * Since 26 November 2026 every stage but `returned` quotes a phone number,
 * resolved as the driver's own first and the project's dispatch line
 * second. Both are fixtures here because both are real paths: on the day
 * this shipped, none of the 41 couriers on the contract had a number, so
 * the fallback is what production actually used. */
const DRIVER_PHONE = '(210) 555-0188';
const DISPATCH = '(210) 555-0100';

/** An order the round path will actually text about. */
async function textable(over = {}) {
    const o = await order(over);
    await client.execute({
        sql: `UPDATE orders SET status = 'assigned', service_date = ?,
                 assigned_to_username = ?, due_at = COALESCE(due_at, ?)
               WHERE id = ?`,
        args: [today(), DRIVER, new Date(Date.now() + 3600000).toISOString(), Number(o.id)],
    });
    return o;
}

/** What the scheduler sweep calls, with the arguments it calls it with. */
const roundNotices = async (over = {}) => queueRoundNotices(client, {
    projectId, serviceDate: today(), now: new Date(),
    timezone: 'America/Chicago', settings: await settingsNow(), ...over,
});

/** A texter that records instead of calling Twilio. */
const fakeTexter = (outcome = () => ({ kind: 'sent', providerId: 'SM123' })) => {
    const sent = [];
    return {
        sent,
        available: true,
        reason: null,
        async send(text) {
            /* The real one checks before the wire; so does this, or a test
               would pass on a body the real texter would refuse. */
            assertMinimal(text.body);
            sent.push(text);
            return outcome(text);
        },
    };
};

/* ------------------------------------------------ what may be in a text */

describe('what a patient is told', () => {
    it('names a courier and nothing else', () => {
        /* University Health asked for the check-in call to be in it and for
           the wording to be editable. sms-template.test.mjs covers what an
           edit may and may not turn it into.

           RENDERED WITH SAMPLE VALUES, and the constant is only a sample
           since 22 November 2026: the wording carries a driver and a
           deadline now, both of which exist per delivery, so there is no
           such thing as THE default message any more -- only the default
           wording. The constant exists so that an edit to that wording
           which names a pharmacy stops the server booting.

           AND IT IS ONE SEGMENT. Anything over 160 characters is charged
           twice, for every patient, every day -- the previous wording was
           172 and had been paying that since September with nothing on any
           screen saying so. */
        expect(DELIVERY_TODAY).toBe(
            'Izy Global Services has a delivery for you today, arriving by 2:00 PM. '
            + 'Alex is bringing it: (210) 555-0143.',
        );
        expect(DELIVERY_TODAY.length).toBeLessThanOrEqual(160);
    });

    it('carries no word that would disclose why on a lock screen', () => {
        for (const word of ['pharmacy', 'prescription', 'medication', 'medicine', 'patient', 'hospital', 'refill', 'Rx']) {
            expect(DELIVERY_TODAY.toLowerCase()).not.toContain(word.toLowerCase());
        }
    });

    it('no longer carries an opt-out line, and STOP still works anyway', () => {
        /* ── THE LINE WENT ON 22 NOVEMBER 2026. THE MECHANISM DID NOT.
         *
         * This test used to read "tells them how to stop, because that is
         * the only control they have", and the reasoning was sound. What
         * made it removable is that it was never the mechanism: a patient
         * texting STOP is handled by Twilio before anything reaches this
         * application, the number is suppressed at their end, and every
         * later send to it comes back as error 21610 whatever our wording
         * says. sendQueued reads that and writes the opt-out permanently --
         * see 'stops sending to a number that has opted out' below, which
         * is unchanged and is where the control actually lives.
         *
         * So the control is still theirs; it is no longer advertised. US
         * carriers and the A2P 10DLC registration this traffic needs both
         * expect the disclosure, and whether to carry it belongs to
         * whoever runs the campaign rather than to this file. */
        expect(DELIVERY_TODAY).not.toContain('STOP');
    });

    it('refuses a body somebody edited into a disclosure', () => {
        for (const bad of [
            'Your prescription is out for delivery',
            'Your pharmacy has sent your medication',
            'Delivery from the hospital today',
            'Your refill is on the way',
        ]) {
            expect(() => assertMinimal(bad), bad).toThrow();
        }
    });

    it('throws rather than trimming, so a bad edit fails loudly', () => {
        /* A shortened version of the same mistake is still the mistake. */
        expect(() => assertMinimal('Your medication is coming')).toThrow(/may not contain/i);
    });
});

/* ------------------------------------------------------- who gets one */

describe('who is queued', () => {
    it('writes one notice per delivery on the round', async () => {
        await clear();
        const one = await textable();
        const two = await textable();

        const res = await roundNotices();
        expect(res.queued).toBeGreaterThanOrEqual(2);

        const queued = await rows('SELECT order_id FROM patient_messages');
        const ids = queued.map((r) => Number(r.order_id));
        expect(ids).toContain(one.id);
        expect(ids).toContain(two.id);
    });

    it('never writes a second notice for the same delivery', async () => {
        /* The unique index, not the caller, is what stops a scheduler that
           ticks every two minutes texting somebody all morning. */
        await clear();
        const o = await textable();
        await roundNotices();
        await roundNotices();
        await roundNotices();

        const mine = await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id]);
        expect(mine).toHaveLength(1);
    });

    it('does not announce a delivery that was cancelled', async () => {
        await clear();
        const o = await textable();
        await client.execute({ sql: "UPDATE orders SET status = 'cancelled' WHERE id = ?", args: [o.id] });
        await roundNotices();
        expect(await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id])).toHaveLength(0);
    });

    it('does not announce one that already arrived', async () => {
        /* A text at 8am about a parcel that came at 7.40 is worse than none. */
        await clear();
        const o = await textable();
        await client.execute({ sql: "UPDATE orders SET status = 'delivered' WHERE id = ?", args: [o.id] });
        await roundNotices();
        expect(await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id])).toHaveLength(0);
    });

    it('counts orders with no phone rather than swallowing them', async () => {
        /* The pharmacy's data quality. An order with no number is a patient
           who will not be told, and somebody should see how many there are. */
        await clear();
        await textable({ recipientPhone: '' });
        const res = await roundNotices();
        expect(res.noPhone).toBeGreaterThanOrEqual(1);
    });

    it('only calls it morning between seven and noon, in the project timezone', () => {
        const at = (iso) => inMorningWindow(new Date(iso), 'America/Chicago');
        expect(at('2026-09-30T13:00:00.000Z')).toBe(true);   // 08:00 Chicago
        expect(at('2026-09-30T16:30:00.000Z')).toBe(true);   // 11:30
        expect(at('2026-09-30T10:00:00.000Z')).toBe(false);  // 05:00, nobody wants it
        expect(at('2026-09-30T18:00:00.000Z')).toBe(false);  // 13:00, the courier is outside
    });
});

/* ----------------------------------------------------------- sending */

describe('sending', () => {
    it('sends what is queued and records the provider id', async () => {
        await clear();
        await textable();
        await roundNotices();

        const texter = fakeTexter();
        const res = await sendQueued(client, texter, quiet);

        expect(res.sent).toBeGreaterThan(0);
        expect(texter.sent[0].to).toBe('+12105550100');
        const sent = await rows('SELECT sent_at, provider_id FROM patient_messages WHERE sent_at IS NOT NULL LIMIT 1');
        expect(String(sent[0].provider_id)).toBe('SM123');
    });

    it('does not send twice', async () => {
        await clear();
        await textable();
        await roundNotices();
        await sendQueued(client, fakeTexter(), quiet);

        const second = fakeTexter();
        const res = await sendQueued(client, second, quiet);
        expect(res.considered).toBe(0);
        expect(second.sent).toHaveLength(0);
    });

    it('leaves a failure unsent so the next tick retries it', async () => {
        await clear();
        await textable();
        await roundNotices();

        const angry = fakeTexter(() => ({ kind: 'failed', message: 'Twilio refused it: 500' }));
        expect((await sendQueued(client, angry, quiet)).failed).toBeGreaterThan(0);
        expect(await rows('SELECT id FROM patient_messages WHERE sent_at IS NULL')).not.toHaveLength(0);

        const calm = fakeTexter();
        expect((await sendQueued(client, calm, quiet)).sent).toBeGreaterThan(0);
    });

    it('records an opt-out permanently and never texts that number again', async () => {
        /* Somebody who replies STOP said it to us, not to one parcel.
           Relying on the carrier alone would mean rediscovering their
           decision once per order, forever. */
        await clear();
        await textable();
        await roundNotices();

        const refuser = fakeTexter(() => ({ kind: 'opted_out' }));
        expect((await sendQueued(client, refuser, quiet)).optedOut).toBeGreaterThan(0);

        const opts = await rows('SELECT phone, reason FROM patient_optouts');
        expect(opts).toHaveLength(1);
        expect(String(opts[0].phone)).toBe('2105550100');

        /* A later order to the same number is queued but never sent. */
        await textable();
        await roundNotices();
        const after = fakeTexter();
        await sendQueued(client, after, quiet);
        expect(after.sent).toHaveLength(0);
    });

    it('does nothing at all when texting is not configured', async () => {
        await clear();
        await textable();
        await roundNotices();
        const off = { available: false, reason: 'not configured', async send() { throw new Error('should not be called'); } };
        expect(await sendQueued(client, off, quiet)).toEqual({ considered: 0, sent: 0, failed: 0, optedOut: 0 });
    });

    it('takes a bounded batch', () => {
        expect(BATCH).toBeGreaterThan(0);
        expect(BATCH).toBeLessThanOrEqual(200);
    });
});

/* ---------------------------------------------------------- the client */

describe('the Twilio client', () => {
    it('turns the digits we store into what Twilio wants', () => {
        expect(toE164('2105550100')).toBe('+12105550100');
        expect(toE164('12105550100')).toBe('+12105550100');
        expect(toE164('(210) 555-0100')).toBe('+12105550100');
    });

    it('does not invent a country code for a number it does not understand', () => {
        /* Guessing one is how a text reaches a stranger. Twilio refuses it
           instead, which is the correct place for that to fail. */
        expect(toE164('+442079460958')).toBe('+442079460958');
        expect(toE164('555')).toBe('555');
    });

    it('refuses rather than pretending when it is not configured', async () => {
        const t = createTexter({ sms: { enabled: false, twilio: undefined } });
        expect(t.available).toBe(false);
        expect((await t.send({ to: '+12105550100', body: 'x' })).kind).toBe('failed');
    });

    it('knows the code that means somebody opted out', () => {
        expect(OPTED_OUT).toBe(21610);
    });
});

/* ------------------------------------------- the stages after the morning
 *
 * The morning notice is queued by the sweep. The rest are queued by the
 * custody event that causes them, from inside recordOrderEvent, which is the
 * one place every status change in the system goes through.
 *
 * These go through the real endpoints a courier's app calls, because the
 * claim being tested is that completing a delivery texts somebody, not that
 * a function inserts a row when called directly. */
describe('a text at each stage', () => {
    let ada;

    beforeAll(async () => {
        /* Texting is paused by default: proving the campaign works is not the
           same as being ready to send several hundred a day with wording
           nobody has signed off. These tests are about what happens when it
           is running, so they turn it on. */
        await admin.patch('/api/projects/uh/settings').send({ patientSms: { paused: false, dispatchPhone: DISPATCH } });
        await admin.post('/api/users').send({
            username: 'stage.courier', name: 'Stage Courier', password: 'courier-pass-9', role: 'driver',
        });
        await admin.put('/api/users/stage.courier/memberships/uh').send({ role: 'courier', settings: {} });
        ada = srv.agent();
        await ada.post('/api/login').send({ username: 'stage.courier', password: 'courier-pass-9' });
    });

    /** An order collected and standing at the door, ready to be closed. */
    async function atTheDoor(over = {}) {
        const o = await order(over);
        await admin.post(`${UH}/runs`).send({
            courierUsername: 'stage.courier', label: `Run ${o.id}`, orderIds: [o.id],
        });
        /* Through the events endpoint, which is where every status change in
           the system goes and therefore where the hook lives. */
        await ada.post(`${ORDERS}/${o.id}/events`).send({ type: 'picked_up', signedName: 'A Tech' });
        await ada.post(`${ORDERS}/${o.id}/arrive`).send({});
        return o;
    }

    const queued = async (orderId) => rows(
        'SELECT kind, body FROM patient_messages WHERE order_id = ? ORDER BY kind', [orderId],
    );

    /* ── EVERY ORDER HERE NOW CARRIES AN EXTRA MESSAGE, FROM atTheDoor.
     *
     * It puts the order on a run, which records an `assigned` custody event,
     * which since 22 November 2026 is what queues the "a delivery is coming"
     * text -- see the end of recordOrderEvent. The stage tests below are
     * about what each custody event says, so they read their own row by kind
     * rather than by position: ORDER BY kind puts delivery_today first for
     * picked_up and second for delivered, and an index would have been right
     * by luck in one test and wrong in another. */
    const DELIVERY_TODAY_KIND = 'delivery_today';
    const stageRows = async (orderId) => (await queued(orderId))
        .filter((r) => String(r.kind) !== DELIVERY_TODAY_KIND);
    const bodyOf = async (orderId, kind) => String(
        (await queued(orderId)).find((r) => String(r.kind) === kind)?.body ?? '',
    );

    it('texts when a delivery is completed', async () => {
        await clear();
        const o = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', courierFormFileId: await storedForm(srv),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        expect((await stageRows(o.id)).map((r) => String(r.kind))).toEqual(['delivered']);
        const body = await bodyOf(o.id, 'delivered');
        expect(body).toMatch(/your delivery was completed at \d+:\d\d (AM|PM)/);
        /* The time is the project's, not UTC, because that is what a person
           reads off their own clock. */
        expect(body).not.toContain('{time}');
    });

    it('texts when an attempt fails, and says nothing about why', async () => {
        await clear();
        const o = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${o.id}/events`).send({ type: 'attempted', reason: 'no_access' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        expect((await stageRows(o.id)).map((r) => String(r.kind))).toEqual(['attempted']);
        const got = [{ body: await bodyOf(o.id, 'attempted') }];
        /* The failure reason is operational detail and stays on our side. */
        expect(String(got[0].body)).not.toMatch(/no.access/i);
        expect(String(got[0].body)).toMatch(/could not complete it/);
    });

    it('stays quiet at the stages nobody turned on', async () => {
        await clear();
        const o = await atTheDoor();
        /* Collected and arrived both happened above. Neither is switched on,
           so neither may have written anything -- and the morning notice
           that being assigned DOES write is not a stage, so it is filtered
           out rather than quietly making this pass for the wrong reason. */
        expect(await stageRows(o.id)).toEqual([]);
        expect((await queued(o.id)).map((r) => String(r.kind))).toEqual([DELIVERY_TODAY_KIND]);
    });

    it('texts once however many times a courier taps', async () => {
        await clear();
        const o = await atTheDoor();
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', courierFormFileId: await storedForm(srv),
        });
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', courierFormFileId: await storedForm(srv),
        });
        /* The unique index on (order_id, kind), not the caller remembering. */
        expect(await stageRows(o.id)).toHaveLength(1);
    });

    it('writes nothing for an order with no phone number', async () => {
        await clear();
        const o = await atTheDoor({ recipientPhone: '' });
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', courierFormFileId: await storedForm(srv),
        });
        /* Nothing at all, not even the assignment notice: a patient with no
           number is counted as unreachable at every stage rather than at
           some of them. */
        expect(await queued(o.id)).toEqual([]);
    });

    it('goes out through the sender like any other message', async () => {
        await clear();
        const o = await atTheDoor();
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', courierFormFileId: await storedForm(srv),
        });

        const texter = fakeTexter();
        const out = await sendQueued(client, texter, quiet);
        /* TWO, since 22 November: the morning notice written when the order
           was put on a run, and the outcome written when it was delivered.
           Found by what they say rather than by position -- the send order
           is the insert order and that is not a thing this test is about. */
        expect(out.sent).toBe(2);
        const bodies = texter.sent.map((t) => String(t.body));
        expect(bodies.some((b) => /your delivery was completed/.test(b))).toBe(true);
        expect(bodies.some((b) => /has a delivery for you today/.test(b))).toBe(true);
    });
});

/* ------------------------------------------- the constraint and the code
 *
 * 0039 wrote CHECK (kind IN ('delivery_today')) when that was the only kind.
 * The code later grew five more, and because queueStageNotice swallows every
 * error on purpose, each one was refused by the table and counted as "no row
 * written" -- which looks exactly like a stage being switched off.
 *
 * So the two lists are compared directly. A stage added without a migration
 * fails here rather than in a demonstration. */
describe('the kinds the table accepts', () => {
    it('is exactly the stages the code can send', async () => {
        const sql = String((await rows(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'patient_messages'",
        ))[0].sql);

        for (const stage of STAGE_NAMES) {
            expect(sql, `${stage} is missing from the CHECK constraint`).toContain(`'${stage}'`);
        }

        /* And nothing else, so a kind that was removed from the code cannot
           linger in the schema as something that would still insert. */
        const listed = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        expect(listed.sort()).toEqual([...STAGE_NAMES].sort());
    });

    it('actually refuses a kind nobody defined', async () => {
        const o = await order();
        await expect(client.execute({
            sql: `INSERT INTO patient_messages (project_id, order_id, phone, kind, body, created_at)
                  VALUES (?, ?, '2105550100', 'invented', 'x', ?)`,
            args: [projectId, o.id, new Date().toISOString()],
        })).rejects.toThrow();
    });
});

/* ---------------------------------------------- a delivery with no patient
 *
 * University Health's own extract carries 2,312 rows of "Courier to BC3 (6200
 * NW Pkwy)" over six months, about thirteen a day, sent from Discharge and
 * Pavilion. Medication moving between two of their buildings, with nobody on
 * the other end to tell.
 *
 * The phone on such a row is a goods-in desk. A morning notice to it is at
 * best noise and at worst a message about medication to a number nobody
 * vetted for that. */
describe('a facility transfer', () => {
    let transfer;
    let patient;

    beforeAll(async () => {
        await clear();
        /* BOTH ARMED, which is the point. If the transfer were simply left
           unassigned it would be skipped for want of a driver and this block
           would prove nothing about delivery_kind at all. Give it everything
           a patient delivery has and the only thing left excluding it is the
           rule under test. */
        transfer = await textable({
            deliveryKind: 'facility', recipientName: 'Business Center III', idRequired: true,
        });
        patient = await textable();
    });

    it('is never queued a notice when the round is built', async () => {
        const out = await roundNotices();
        expect(out.queued).toBeGreaterThan(0);
        const queued = await rows('SELECT order_id FROM patient_messages');
        const ids = queued.map((r) => Number(r.order_id));
        expect(ids).toContain(patient.id);
        expect(ids).not.toContain(transfer.id);
    });

    it('is not counted as a missing phone number either', async () => {
        /* noPhone is the pharmacy's data quality, surfaced so somebody can
           act on it. A loading bay with no phone is not a data problem, and
           counting it would send somebody looking for a patient's number that
           was never meant to exist.
           Measured as a difference rather than against zero: other tests in
           this file leave orders behind, and an absolute assertion here would
           be testing their state rather than this one's. */
        await clear();
        const before = await roundNotices();
        await textable({ deliveryKind: 'facility', recipientPhone: '' });
        await clear();
        const after = await roundNotices();
        expect(after.noPhone).toBe(before.noPhone);
    });

    it('cannot require identification, whatever the list says', async () => {
        /* Nobody at a goods-in desk can produce a patient's identity
           document. Forced off rather than refused, because the flag comes
           from a pharmacy's own file and rejecting their list over it would
           stop the day. */
        const detail = await admin.get(`${ORDERS}/${transfer.id}`);
        expect(detail.body.idRequired).toBe(false);
        expect(detail.body.deliveryKind).toBe('facility');
    });

    it('still says patient for everything else, including the default', async () => {
        /* 98.6 per cent of the contract, and all of the history. */
        const detail = await admin.get(`${ORDERS}/${patient.id}`);
        expect(detail.body.deliveryKind).toBe('patient');
    });
});

/* ------------------------------------------------------------- the pause
 *
 * Every message costs a Twilio segment. Between proving the 10DLC campaign
 * works and the pharmacy team agreeing the wording, the system is entirely
 * capable of texting several hundred patients a day with a sentence nobody
 * has signed off. One switch stops it, and it starts on. */
describe('paused', () => {
    beforeAll(async () => {
        await admin.patch('/api/projects/uh/settings').send({ patientSms: { paused: true } });
        await clear();
    });
    afterAll(async () => {
        await admin.patch('/api/projects/uh/settings').send({ patientSms: { paused: false, dispatchPhone: DISPATCH } });
    });

    it('is the default for a project nobody has configured', async () => {
        /* The behaviour that matters most, because the failure of texting too
           early is a message in a patient's hand that cannot be taken back. */
        const { resolveSettings } = await import('../src/core/projects/settings.ts');
        expect(resolveSettings({}).patientSms.paused).toBe(true);
        expect(resolveSettings(null).patientSms.paused).toBe(true);
    });

    it('queues no notice at all when a round is built', async () => {
        await textable();
        const out = await roundNotices();
        expect(out.queued).toBe(0);
        expect(await rows('SELECT id FROM patient_messages')).toEqual([]);
    });

    it('writes nothing when a delivery is recorded either', async () => {
        /* order(), not textable(): this one posts its OWN assigned event,
           and the transition table refuses assigned -> assigned. */
        const o = await order();
        await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'assigned', courierUsername: 'stage.courier' });
        await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'picked_up', signedName: 'Tech' });
        await admin.post(`${ORDERS}/${o.id}/events`).send({ type: 'delivered', signedName: 'Recipient' });
        expect(await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id])).toEqual([]);
    });

    it('leaves a queue made before the pause where it is, unsent', async () => {
        /* Not sent and not deleted. Pausing is usually temporary: somebody is
           waiting on wording or on a campaign, and throwing the queue away
           would mean that morning's patients are never told at all once it
           resumes. */
        await admin.patch('/api/projects/uh/settings').send({ patientSms: { paused: false, dispatchPhone: DISPATCH } });
        await textable();
        const before = await roundNotices();
        expect(before.queued).toBeGreaterThan(0);

        await admin.patch('/api/projects/uh/settings').send({ patientSms: { paused: true } });
        const texter = fakeTexter();
        const out = await sendQueued(client, texter, quiet, [projectId]);
        expect(out.sent).toBe(0);
        expect(texter.sent).toEqual([]);

        const still = await rows('SELECT sent_at FROM patient_messages');
        expect(still.length).toBeGreaterThan(0);
        for (const r of still) expect(r.sent_at).toBeNull();
    });

    it('sends that same queue once it resumes', async () => {
        const texter = fakeTexter();
        const out = await sendQueued(client, texter, quiet, []);
        expect(out.sent).toBeGreaterThan(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════
 * WHY NOTHING ARRIVED, WHICH NOTHING IN THIS SYSTEM COULD ANSWER
 *
 * Written on 23 November 2026, the morning after the first real test of
 * patient texting sent nothing to anybody. Every one of these pins a
 * sentence that did not exist that morning.
 *
 * The chain has six links -- Twilio credentials, the project pause, the
 * stage switch, a phone number, a driver with a name, a deadline to quote
 * -- and five of them failed SILENTLY. /health said `sms: "configured"`,
 * which was true and meant only that three environment variables were
 * present. There was no log line, no field and no screen that distinguished
 * "switched off" from "working, nothing to do".
 *
 * This is the mail fault of 20 November with the nouns changed, and it is in
 * the file twice now, so the tests are here rather than the lesson being
 * learned a third time.
 * ═══════════════════════════════════════════════════════════════════════ */
describe('whether anybody can tell that texting is off', () => {
    /* Three projects exist from the migrations: tvhs, uh and demo. That is
       the whole point of the aside -- see below. */
    async function setPause(code, value) {
        const row = (await client.execute({
            sql: 'SELECT id, settings FROM projects WHERE code = ?', args: [code],
        })).rows[0];
        const stored = JSON.parse(String(row.settings ?? '{}'));
        stored.patientSms = { ...(stored.patientSms ?? {}), paused: value };
        await client.execute({
            sql: 'UPDATE projects SET settings = ? WHERE id = ?',
            args: [JSON.stringify(stored), row.id],
        });
    }
    const allCodes = async () => (await rows('SELECT code FROM projects ORDER BY id'))
        .map((r) => String(r.code));

    async function pauseEverything(value) {
        for (const code of await allCodes()) await setPause(code, value);
    }

    /** A queued row without going through any of the queueing paths: this
     *  block is about the sentence, not about who wrote the row. */
    async function waitingRow(phone = '2105550199') {
        const order_ = await order({ recipientPhone: phone });
        await client.execute({
            sql: `INSERT INTO patient_messages
                    (project_id, order_id, phone, kind, body, created_at)
                  VALUES (?, ?, ?, 'delivery_today', ?, ?)`,
            args: [projectId, Number(order_.id), phone,
                   'Izy Global Services has a delivery for you today.',
                   new Date().toISOString()],
        });
        return order_;
    }

    it('leads with the pause when no project can send at all', async () => {
        /* THE STATE PRODUCTION WAS IN, and the one the old field reported as
           "configured". paused defaults to TRUE, lives in the database and
           is moved by no deploy, so this is what a freshly shipped feature
           looks like until somebody deliberately switches it on. */
        await clear();
        await pauseEverything(true);
        const said = await recentSmsState(client);
        expect(said, said).toMatch(/^PAUSED for every project/);
        expect(said, said).toContain('nothing is queued and nothing will send');
    });

    it('does not let a contract that never texts speak for one that does', async () => {
        /* TVHS does not text patients and never will, so a line leading with
           "PAUSED for tvhs" would read as an outage every day of the year
           and would bury the only project anybody is asking about. The first
           draft of recentSmsState did exactly that. */
        await clear();
        await pauseEverything(true);
        await setPause('uh', false);
        const said = await recentSmsState(client);
        expect(said, said).not.toMatch(/^PAUSED/);
        /* Still said, because a pause somebody forgot is worth seeing -- as
           a parenthesis rather than a headline. */
        expect(said, said).toContain('paused for');
        expect(said, said).toContain('tvhs');
    });

    it('distinguishes a quiet day from a queue that is going nowhere', async () => {
        /* The distinction the old field could not draw, and the reason the
           first live test produced no diagnosis: zero sent reads identically
           whether nothing was due or everything is stuck. */
        await clear();
        await pauseEverything(true);
        await setPause('uh', false);
        expect(await recentSmsState(client)).toContain('nothing queued yet');

        await waitingRow();
        const said = await recentSmsState(client);
        expect(said, said).toContain('NOTHING SENT YET');
        expect(said, said).toContain('1 waiting');
    });

    it('says it is sending once something actually went', async () => {
        await clear();
        await pauseEverything(true);
        await setPause('uh', false);
        await waitingRow();

        const texter = fakeTexter();
        expect((await sendQueued(client, texter, quiet)).sent).toBe(1);
        const said = await recentSmsState(client);
        expect(said, said).toMatch(/^sending:/);
        expect(said, said).toContain('1 sent');
    });

    it('names the reason a send failed, and never the patient', async () => {
        /* The reason is the half that decides the fix -- the same argument as
           redact() in notify/ses.ts, which was added when "400
           MessageRejected" turned out to be three different faults.

           AND THE NUMBER IS NOT IN IT. /health is unauthenticated. A phone
           number on it is a disclosure, and a phone number next to the words
           "delivery" and "patient" is a worse one. */
        await clear();
        await pauseEverything(true);
        await setPause('uh', false);
        const phone = '2105550177';
        await waitingRow(phone);

        const refuser = fakeTexter(() => ({ kind: 'opted_out' }));
        expect((await sendQueued(client, refuser, quiet)).optedOut).toBe(1);

        const said = await recentSmsState(client);
        expect(said, said).toContain('1 failed');
        expect(said, said).toContain('last failure: recipient has opted out');
        expect(said, said).not.toContain(phone);
        expect(said, said).not.toContain('5550177');
    });
});

/* ───────────────── THE TWO SKIPS THAT LEFT NO TRACE AT ALL
 *
 * queueRoundNotices refuses to send a text with a hole in it: no driver name
 * means no "{driver} will call", and no due_at means no "arriving by {by}".
 * Both are the right call -- "  will call about 20 min before" is worse than
 * silence.
 *
 * Until 23 November both were bare `continue` statements. No row, no count,
 * no log line. An order that met every other condition produced nothing and
 * nothing anywhere said so, which is indistinguishable from a feature that
 * is switched off. The skip is unchanged; what is new is that it is visible.
 */
describe('the skips that used to be invisible', () => {
    /* A COURIER ON THIS CONTRACT, created here rather than borrowed from
       CREDS. south.driver is seeded for TVHS, and driverFirstNames joins
       memberships for THIS project -- so borrowing it would have made every
       order in this block a noDriver, and the two tests below would have
       passed for a reason that had nothing to do with what they assert.
       That is exactly what the first run of them did.

       THE NAME IS INVENTED AND WAS CHECKED FOR IT. The first draft used a
       plausible San Antonio surname, which turned out to appear four times
       in the production backups in this working copy -- so it belonged to a
       real person, and writing it into a test fixture on a PUBLIC
       repository would have published it. Grep before inventing a name. */
    const DRIVER = 'sms.rosa';

    async function readyToText(over = {}) {
        const o = await order();
        await client.execute({
            sql: `UPDATE orders SET status = 'assigned', service_date = ?,
                     assigned_to_username = ?, due_at = ?
                   WHERE id = ?`,
            args: [over.serviceDate ?? today(),
                   over.driver === undefined ? DRIVER : over.driver,
                   over.dueAt === undefined ? new Date(Date.now() + 3600000).toISOString() : over.dueAt,
                   Number(o.id)],
        });
        return o;
    }

    /* BY ORDER ID, NOT BY DAY, and for two reasons. It is the shape the
       assignment hook in order-events.ts calls with -- one order, no day --
       so this covers the path that actually runs in production. And it
       isolates: asking for "today" would sweep up every order the rest of
       this file has left assigned, which is how the first draft of these
       three tests counted three drivers it had never set up. */
    const run = async (id) => queueRoundNotices(client, {
        projectId, orderIds: [Number(id)], now: new Date(),
        timezone: 'America/Chicago', settings: await settingsNow(),
    });

    /* Unpaused for this whole block: a pause returns before any of these
       conditions is even looked at, which would make every count zero and
       every assertion below pass for the wrong reason. */
    beforeAll(async () => {
        await admin.post('/api/users').send({
            username: DRIVER, name: 'Nerissa Quillane', password: 'sms-pass-1', role: 'driver',
        });
        await admin.put(`/api/users/${DRIVER}/memberships/uh`).send({ role: 'courier', settings: {} });
        await admin.patch('/api/projects/uh/settings').send({ patientSms: { paused: false, dispatchPhone: DISPATCH } });
    });

    /* ──────────── A NUMBER THE PATIENT CAN RING ────────────────
     *
     * Asked for on 26 November 2026: the assigned driver's number in every
     * message, so patient and driver have a contact point at each stage.
     *
     * THE FALLBACK IS NOT AN EDGE CASE. On the day this was written, none
     * of the 41 active couriers on this contract had a number on their
     * roster row, so the dispatch line is what production actually sent.
     * All three paths are covered because all three are reachable, and the
     * third one -- neither number -- is the one that would put a sentence
     * ending in a bare full stop in front of several hundred people.
     */
    it('quotes the driver\'s own number when the roster has one', async () => {
        await clear();
        /* Set here rather than relied on from the outer fixture: this
           describe re-creates the driver in its own beforeAll, which
           clears the roster number. A test about the number puts it there. */
        await admin.put(`${UH}/roster/${DRIVER}/contact`).send({ phone: DRIVER_PHONE });
        const o = await readyToText();
        expect((await run(o.id)).queued).toBe(1);
        const [row] = await rows('SELECT body FROM patient_messages WHERE order_id = ?', [o.id]);
        expect(String(row.body)).toContain(DRIVER_PHONE);
        expect(String(row.body)).not.toContain(DISPATCH);
    });

    it('falls back to the dispatch line when the driver has no number', async () => {
        await clear();
        await admin.put(`${UH}/roster/${DRIVER}/contact`).send({ phone: '' });
        try {
            const o = await readyToText();
            expect((await run(o.id)).queued).toBe(1);
            const [row] = await rows('SELECT body FROM patient_messages WHERE order_id = ?', [o.id]);
            expect(String(row.body)).toContain(DISPATCH);
        } finally {
            await admin.put(`${UH}/roster/${DRIVER}/contact`).send({ phone: DRIVER_PHONE });
        }
    });

    it('sends nothing, and says so, when there is no number of either kind', async () => {
        /* A SKIP AND A COUNT, NEVER A BLANK AND NEVER A THROW. The sentence
           is written around a number, so an empty one reads as a broken
           message; and one unreachable driver must not abort the notices
           for everybody else on the round, which is why this is counted
           beside noDriver and noDeadline rather than raised. */
        await clear();
        await admin.put(`${UH}/roster/${DRIVER}/contact`).send({ phone: '' });
        await client.execute({
            sql: `UPDATE projects SET settings = json_set(settings, '$.patientSms.dispatchPhone', '')
                   WHERE code = 'uh'`,
        });
        try {
            const o = await readyToText();
            const out = await run(o.id);
            expect(out.queued).toBe(0);
            expect(out.noContact).toBe(1);
            expect(await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id])).toHaveLength(0);
        } finally {
            await client.execute({
                sql: `UPDATE projects SET settings = json_set(settings, '$.patientSms.dispatchPhone', ?)
                       WHERE code = 'uh'`,
                args: [DISPATCH],
            });
            await admin.put(`${UH}/roster/${DRIVER}/contact`).send({ phone: DRIVER_PHONE });
        }
    });

    it('will not let a project be unpaused with no number to quote', async () => {
        /* THE RULE THAT MAKES "never blank" TRUE RATHER THAN HOPED FOR, and
           it is checked against the MERGED settings: a patch that only says
           `paused: false` says nothing about dispatchPhone, so a refine over
           the patch alone could be walked around in two requests. */
        const res = await admin.patch('/api/projects/uh/settings')
            .send({ patientSms: { paused: false, dispatchPhone: '' } });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/dispatchPhone/);

        /* And the project is untouched by the refusal. */
        const after = await settingsNow();
        expect(after.patientSms.dispatchPhone).toBe(DISPATCH);
    });

    it('counts a driver this project has no name for', async () => {
        await clear();
        const o = await readyToText({ driver: 'nobody.here' });
        const out = await run(o.id);
        expect(out.queued).toBe(0);
        expect(out.noDriver).toBe(1);
        /* Not miscounted as the pharmacy's fault: the phone is fine and the
           deadline is fine, and sending somebody to chase the pharmacy for a
           number they already supplied is how a diagnosis wastes a morning. */
        expect(out.noPhone).toBe(0);
        expect(out.noDeadline).toBe(0);
    });

    it('counts a delivery with no deadline to quote', async () => {
        await clear();
        const o = await readyToText({ dueAt: null });
        const out = await run(o.id);
        expect(out.queued).toBe(0);
        expect(out.noDeadline).toBe(1);
        expect(out.noDriver).toBe(0);
    });

    it('still queues the one that has both, naming the driver and the time', async () => {
        /* The control. Without it the two above would pass against a
           function that queues nothing at all. */
        await clear();
        const o = await readyToText();
        const out = await run(o.id);
        expect(out.queued).toBe(1);
        expect(out.noDriver).toBe(0);
        expect(out.noDeadline).toBe(0);

        const [row] = await rows(
            "SELECT body FROM patient_messages WHERE kind = 'delivery_today'",
        );
        const body = String(row.body);
        /* FIRST NAME ONLY. A patient needs to know who is knocking, not a
           courier's surname -- the same line the client portal draws. */
        expect(body, body).toContain('Nerissa');
        expect(body, body).not.toContain('Quillane');
        expect(body, body).toMatch(/arriving by \d{1,2}:\d{2} (AM|PM)/);
    });
});
