/* Texting a patient that a delivery is coming.
 *
 * The property most of these defend is what is NOT in the message. A text is
 * read on a lock screen by whoever is holding the phone, and the difference
 * between "a courier is coming" and "your pharmacy is sending your
 * prescription" is the difference between a delivery notice and telling
 * somebody's flatmate they are ill. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { STAGE_NAMES } from '../src/core/notify/sms-template.ts';
import { assertMinimal, toE164, createTexter, OPTED_OUT } from '../src/core/notify/twilio.ts';
import {
    DELIVERY_TODAY, inMorningWindow, queueMorningNotices, sendQueued, BATCH,
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
const clear = async () => {
    await client.execute('DELETE FROM patient_messages');
    await client.execute('DELETE FROM patient_optouts');
};

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
        /* University Health asked for the delivery window and the check-in
           call to be in it, and for the wording to be editable. This is the
           rendered default; sms-template.test.mjs covers what an edit may
           and may not turn it into. */
        expect(DELIVERY_TODAY).toBe(
            'Izy Global Services has a delivery scheduled for you today between 9:00 AM and 5:00 PM. '
            + 'Our driver will call you about 20 minutes before arriving. '
            + 'Reply STOP to stop these messages.',
        );
    });

    it('carries no word that would disclose why on a lock screen', () => {
        for (const word of ['pharmacy', 'prescription', 'medication', 'medicine', 'patient', 'hospital', 'refill', 'Rx']) {
            expect(DELIVERY_TODAY.toLowerCase()).not.toContain(word.toLowerCase());
        }
    });

    it('tells them how to stop, because that is the only control they have', () => {
        expect(DELIVERY_TODAY).toContain('Reply STOP');
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
    it('writes one notice per delivery going out today', async () => {
        await clear();
        const one = await order();
        const two = await order();

        const res = await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
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
        const o = await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });

        const mine = await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id]);
        expect(mine).toHaveLength(1);
    });

    it('does not announce a delivery that was cancelled', async () => {
        await clear();
        const o = await order();
        await client.execute({ sql: "UPDATE orders SET status = 'cancelled' WHERE id = ?", args: [o.id] });
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
        expect(await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id])).toHaveLength(0);
    });

    it('does not announce one that already arrived', async () => {
        /* A text at 8am about a parcel that came at 7.40 is worse than none. */
        await clear();
        const o = await order();
        await client.execute({ sql: "UPDATE orders SET status = 'delivered' WHERE id = ?", args: [o.id] });
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
        expect(await rows('SELECT id FROM patient_messages WHERE order_id = ?', [o.id])).toHaveLength(0);
    });

    it('counts orders with no phone rather than swallowing them', async () => {
        /* The pharmacy's data quality. An order with no number is a patient
           who will not be told, and somebody should see how many there are. */
        await clear();
        await order({ recipientPhone: '' });
        const res = await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
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
        await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });

        const texter = fakeTexter();
        const res = await sendQueued(client, texter, quiet);

        expect(res.sent).toBeGreaterThan(0);
        expect(texter.sent[0].to).toBe('+12105550100');
        const sent = await rows('SELECT sent_at, provider_id FROM patient_messages WHERE sent_at IS NOT NULL LIMIT 1');
        expect(String(sent[0].provider_id)).toBe('SM123');
    });

    it('does not send twice', async () => {
        await clear();
        await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
        await sendQueued(client, fakeTexter(), quiet);

        const second = fakeTexter();
        const res = await sendQueued(client, second, quiet);
        expect(res.considered).toBe(0);
        expect(second.sent).toHaveLength(0);
    });

    it('leaves a failure unsent so the next tick retries it', async () => {
        await clear();
        await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });

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
        await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });

        const refuser = fakeTexter(() => ({ kind: 'opted_out' }));
        expect((await sendQueued(client, refuser, quiet)).optedOut).toBeGreaterThan(0);

        const opts = await rows('SELECT phone, reason FROM patient_optouts');
        expect(opts).toHaveLength(1);
        expect(String(opts[0].phone)).toBe('2105550100');

        /* A later order to the same number is queued but never sent. */
        await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
        const after = fakeTexter();
        await sendQueued(client, after, quiet);
        expect(after.sent).toHaveLength(0);
    });

    it('does nothing at all when texting is not configured', async () => {
        await clear();
        await order();
        await queueMorningNotices(client, { projectId, serviceDate: today(), now: new Date() });
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

    it('texts when a delivery is completed', async () => {
        await clear();
        const o = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', noSignatureReason: 'Left with recipient',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const got = await queued(o.id);
        expect(got.map((r) => String(r.kind))).toEqual(['delivered']);
        expect(String(got[0].body)).toMatch(/your delivery was completed at \d+:\d\d (AM|PM)/);
        /* The time is the project's, not UTC, because that is what a person
           reads off their own clock. */
        expect(String(got[0].body)).not.toContain('{time}');
    });

    it('texts when an attempt fails, and says nothing about why', async () => {
        await clear();
        const o = await atTheDoor();
        const res = await ada.post(`${ORDERS}/${o.id}/events`).send({ type: 'attempted', reason: 'no_access' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const got = await queued(o.id);
        expect(got.map((r) => String(r.kind))).toEqual(['attempted']);
        /* The failure reason is operational detail and stays on our side. */
        expect(String(got[0].body)).not.toMatch(/no.access/i);
        expect(String(got[0].body)).toMatch(/could not complete it/);
    });

    it('stays quiet at the stages nobody turned on', async () => {
        await clear();
        const o = await atTheDoor();
        /* Collected and arrived both happened above. Neither is switched on,
           so neither may have written anything. */
        expect(await queued(o.id)).toEqual([]);
    });

    it('texts once however many times a courier taps', async () => {
        await clear();
        const o = await atTheDoor();
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', noSignatureReason: 'Left with recipient',
        });
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', noSignatureReason: 'Left with recipient',
        });
        /* The unique index on (order_id, kind), not the caller remembering. */
        expect(await queued(o.id)).toHaveLength(1);
    });

    it('writes nothing for an order with no phone number', async () => {
        await clear();
        const o = await atTheDoor({ recipientPhone: '' });
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', noSignatureReason: 'Left with recipient',
        });
        expect(await queued(o.id)).toEqual([]);
    });

    it('goes out through the sender like any other message', async () => {
        await clear();
        const o = await atTheDoor();
        await ada.post(`${ORDERS}/${o.id}/deliver`).send({
            signedName: 'Recipient', noSignatureReason: 'Left with recipient',
        });

        const texter = fakeTexter();
        const out = await sendQueued(client, texter, quiet);
        expect(out.sent).toBe(1);
        expect(texter.sent[0].body).toMatch(/your delivery was completed/);
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
