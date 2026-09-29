/* Email to the pharmacy: what may be in it, who gets it, and what happens
 * when SES will not take it.
 *
 * The rule under test is the one the whole feature is built around: an
 * order number, a pharmacy, a time and a link leave the building, and a
 * patient never does. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { assertNoPatientData, signRequest, amzDates, createMailer } from '../src/core/notify/ses.ts';
import { dispatchPending, EMAILED_KINDS, BATCH } from '../src/core/notify/dispatch.ts';
import { noticeBody } from '../src/modules/uh/delivery-notices.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';

let srv, admin, discharge, green;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');

    await admin.post('/api/users').send({ username: 'ada.courier', name: 'Ada Fitzgerald', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/ada.courier/memberships/uh').send({ role: 'courier', settings: {} });

    // A pharmacist at Discharge, with an email address.
    await admin.post('/api/users').send({ username: 'uh.pharmacist', name: 'Karthik Pharmacist', email: 'pharmacist@example.invalid', password: 'client-pass-1', role: 'staff' });
    await admin.put('/api/users/uh.pharmacist/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });

    // A pharmacist at a different counter, who must not hear about Discharge.
    await admin.post('/api/users').send({ username: 'uh.other', name: 'Other Counter', email: 'other@example.invalid', password: 'client-pass-2', role: 'staff' });
    await admin.put('/api/users/uh.other/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [green.id] } });
});
afterAll(async () => { await srv.stop(); });

let seq = 0;
async function closeOne(status, siteId = discharge.id) {
    seq += 1;
    const created = await admin.post(ORDERS).send({
        siteId, serviceType: 'stat', recipientName: `Recipient ${seq}`,
        addressLine: `${seq} Rehearsal Way`, zip: '78215', description: 'Oral solids',
        quantity: 1, externalRef: `MAIL-${seq}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body;
    await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
    await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });
    if (status === 'delivered') {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Ines Vargas' });
    } else {
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'attempted', reason: 'no_access' });
    }
    return order;
}

const rows = async (sql, args = []) => (await srv.core.client.execute({ sql, args })).rows;

/* ------------------------------------------------------- what may be in it */

describe('what a notification is allowed to say', () => {
    it('names an order and a pharmacy and never a patient', () => {
        const body = noticeBody({
            projectId: 1, orderId: 418, siteId: 7,
            siteName: 'University Hospital Discharge Pharmacy',
            status: 'delivered', at: '2:22 PM CDT',
        });
        expect(body).toBe(
            'Delivery 418 for University Hospital Discharge Pharmacy was completed at 2:22 PM CDT.'
            + ' Open the tracking portal for the proof of delivery and the full record.',
        );
        // Asserted as a whole string, not by searching for a name: "contains
        // no patient" is not a property you can check by looking for one.
        expect(() => assertNoPatientData(body)).not.toThrow();
    });

    it('says a failure could not be completed rather than describing why', () => {
        const body = noticeBody({
            projectId: 1, orderId: 9, siteId: 7, siteName: 'Green Pharmacy',
            status: 'failed', at: '9:05 AM CDT',
        });
        expect(body).toContain('could not be completed');
        // The reason code is operational detail and belongs in the portal.
        expect(body).not.toContain('no_access');
    });

    it('refuses a body carrying a street address', () => {
        expect(() => assertNoPatientData('Delivered to 41 Rehearsal Way at 2pm')).toThrow(/street address/i);
    });

    it('refuses a body carrying a ZIP code', () => {
        expect(() => assertNoPatientData('Delivery 418 to 78229 completed')).toThrow(/ZIP/i);
    });

    it('lets an ordinary notification through', () => {
        expect(() => assertNoPatientData('Delivery 418 for Green Pharmacy was completed at 2:22 PM CDT.')).not.toThrow();
    });
});

/* ------------------------------------------------------------ who is told */

describe('who is told', () => {
    it('writes a notification to the pharmacy that sent the work', async () => {
        const order = await closeOne('delivered');
        const written = await rows(
            'SELECT username, kind, body FROM notifications WHERE order_id = ? ORDER BY username',
            [order.id],
        );
        expect(written.map((r) => r.username)).toEqual(['uh.pharmacist']);
        expect(written[0].kind).toBe('delivery.completed');
        expect(String(written[0].body)).toContain(`Delivery ${order.id}`);
    });

    it('does not tell a pharmacist about another counter\'s delivery', async () => {
        const order = await closeOne('delivered', green.id);
        const written = await rows('SELECT username FROM notifications WHERE order_id = ?', [order.id]);
        expect(written.map((r) => r.username)).toEqual(['uh.other']);
    });

    it('records a failed delivery as its own kind', async () => {
        const order = await closeOne('failed');
        const written = await rows('SELECT kind FROM notifications WHERE order_id = ?', [order.id]);
        expect(written.map((r) => r.kind)).toEqual(['delivery.failed']);
    });

    it('writes nothing for the steps before an outcome', async () => {
        /* picked_up and arrived are real custody events and are not news to a
           pharmacy that handed the bag over five minutes ago. */
        seq += 1;
        const created = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'adhoc', recipientName: 'Recipient mid',
            addressLine: '99 Rehearsal Way', zip: '78215', description: 'Oral solids',
            quantity: 1, externalRef: `MAIL-mid-${seq}`,
        });
        const order = created.body;
        await admin.post(RUNS).send({ courierUsername: 'ada.courier', label: 'Run', orderIds: [order.id] });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' });
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'arrived' });

        const written = await rows('SELECT id FROM notifications WHERE order_id = ?', [order.id]);
        expect(written).toHaveLength(0);
    });

    it('does not write a second notification when a courier taps delivered twice', async () => {
        const order = await closeOne('delivered');
        await admin.post(`${ORDERS}/${order.id}/events`).send({ type: 'delivered', signedName: 'Ines Vargas' });
        const written = await rows('SELECT id FROM notifications WHERE order_id = ?', [order.id]);
        expect(written).toHaveLength(1);
    });
});

/* --------------------------------------------------------------- sending */

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A mailer that records instead of calling SES. */
const fakeMailer = (behaviour = () => {}) => {
    const sent = [];
    return {
        sent,
        available: true,
        reason: null,
        async send(mail) {
            behaviour(mail);
            /* The real one checks before the wire; so does this, or the test
               would pass on a body the real mailer would refuse. */
            assertNoPatientData(mail.subject);
            assertNoPatientData(mail.text);
            sent.push(mail);
        },
    };
};

describe('turning notifications into email', () => {
    const dispatch = (mailer) => dispatchPending({
        client: srv.core.client, mailer, logger: quietLogger,
        portalUrl: 'https://logs.example.invalid',
    });

    it('sends only the kinds addressed outside the company', () => {
        // The five dispatch kinds are our own couriers being told about their
        // own work in an app they have open. Emailing those is noise.
        expect([...EMAILED_KINDS]).toEqual(['delivery.completed', 'delivery.failed']);
    });

    it('sends to the address on the account and marks the row sent', async () => {
        await closeOne('delivered');
        const mailer = fakeMailer();
        const result = await dispatch(mailer);

        expect(result.sent).toBeGreaterThan(0);
        expect(mailer.sent.every((m) => m.to === 'pharmacist@example.invalid' || m.to === 'other@example.invalid')).toBe(true);
        const unsent = await rows('SELECT id FROM notifications WHERE sent_at IS NULL AND kind LIKE \'delivery.%\'');
        expect(unsent).toHaveLength(0);
    });

    it('puts the portal link in the body and nothing else', async () => {
        await closeOne('delivered');
        const mailer = fakeMailer();
        await dispatch(mailer);
        const last = mailer.sent.at(-1);
        expect(last.text).toContain('https://logs.example.invalid');
        expect(last.subject).toBe('Delivery completed');
    });

    it('leaves a row unsent when SES refuses, so the next tick retries it', async () => {
        await closeOne('delivered');
        const angry = fakeMailer(() => { throw new Error('SES refused the message: 454'); });
        const failed = await dispatch(angry);
        expect(failed.failed).toBeGreaterThan(0);
        expect(failed.sent).toBe(0);

        const stillWaiting = await rows('SELECT id FROM notifications WHERE sent_at IS NULL AND kind LIKE \'delivery.%\'');
        expect(stillWaiting.length).toBeGreaterThan(0);

        // And the retry goes through.
        const calm = fakeMailer();
        const retried = await dispatch(calm);
        expect(retried.sent).toBe(stillWaiting.length);
    });

    it('does nothing at all when no mailer is configured', async () => {
        await closeOne('delivered');
        const off = { available: false, reason: 'not configured', async send() { throw new Error('should not be called'); } };
        const result = await dispatch(off);
        expect(result).toEqual({ considered: 0, sent: 0, failed: 0, skipped: 0 });
    });

    it('does not retry an account with no email address forever', async () => {
        /* Marked done and counted, rather than picked up every two minutes
           until somebody notices the log. The in-app notification is still
           there for them. */
        await admin.post('/api/users').send({ username: 'uh.noemail', name: 'No Email', password: 'client-pass-3', role: 'staff' });
        await admin.put('/api/users/uh.noemail/memberships/uh').send({ role: 'pharmacy', settings: { siteIds: [discharge.id] } });

        await closeOne('delivered');
        const mailer = fakeMailer();
        const result = await dispatch(mailer);
        expect(result.skipped).toBeGreaterThan(0);

        const again = await dispatch(fakeMailer());
        expect(again.considered).toBe(0);
    });

    it('takes a bounded batch rather than opening a connection per row', () => {
        expect(BATCH).toBeGreaterThan(0);
        expect(BATCH).toBeLessThanOrEqual(100);
    });
});

/* ------------------------------------------------------------- the signer */

describe('the SES request signature', () => {
    const cfg = {
        region: 'us-east-2',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        from: 'no-reply@example.invalid',
    };

    it('produces the four headers SES needs, and signs exactly those', () => {
        const at = new Date('2026-09-29T12:00:00.000Z');
        const headers = signRequest(cfg, 'email.us-east-2.amazonaws.com', '/v2/email/outbound-emails', '{"a":1}', at);
        expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-type', 'x-amz-content-sha256', 'x-amz-date']);
        expect(headers.authorization).toContain('AWS4-HMAC-SHA256');
        expect(headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');
        expect(headers.authorization).toContain('/us-east-2/ses/aws4_request');
        expect(headers['x-amz-date']).toBe('20260929T120000Z');
    });

    it('signs the body, so a changed message is a different signature', () => {
        const at = new Date('2026-09-29T12:00:00.000Z');
        const one = signRequest(cfg, 'h', '/p', '{"a":1}', at);
        const two = signRequest(cfg, 'h', '/p', '{"a":2}', at);
        expect(one['x-amz-content-sha256']).not.toBe(two['x-amz-content-sha256']);
        expect(one.authorization).not.toBe(two.authorization);
    });

    it('formats the two date shapes AWS wants', () => {
        expect(amzDates(new Date('2013-05-24T00:00:00.000Z'))).toEqual({ amzDate: '20130524T000000Z', dateStamp: '20130524' });
    });

    it('refuses rather than pretending when it is not configured', async () => {
        const mailer = createMailer({ mail: { enabled: false, ses: undefined, portalUrl: '' } });
        expect(mailer.available).toBe(false);
        expect(mailer.reason).toMatch(/not enabled/i);
        await expect(mailer.send({ to: 'a@b.invalid', subject: 's', text: 't' })).rejects.toThrow();
    });

    it('refuses when it is switched on with nothing behind it', () => {
        const mailer = createMailer({ mail: { enabled: true, ses: undefined, portalUrl: '' } });
        expect(mailer.available).toBe(false);
        expect(mailer.reason).toMatch(/missing/i);
    });
});
