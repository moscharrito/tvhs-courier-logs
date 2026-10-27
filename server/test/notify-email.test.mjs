/* Email to the pharmacy: what may be in it, who gets it, and what happens
 * when SES will not take it.
 *
 * The rule under test is the one the whole feature is built around: an
 * order number, a pharmacy, a time and a link leave the building, and a
 * patient never does. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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

    it('records WHY a row stopped being pending, not only that it did', async () => {
        /* ────────────────────────────────────────────────────────────────
         * THE SAME BUG, THREE TIMES, AND THIS IS THE THIRD.
         *
         * sent_at is set in three situations -- SES accepted it, the account
         * had no address, the address was suppressed -- because all three
         * mean "stop retrying this every two minutes". That is a good reason
         * to write the column and a terrible reason to read it as proof
         * anybody was told anything.
         *
         * A production rehearsal did exactly that and reported "the sweep
         * actually sent it" for a test account with no email address at all.
         * /health said `files: "configured"` for weeks against a bucket that
         * refused every write. Each time, a green light that meant the form
         * had been filled in.
         *
         * So the row says which ending it had, and this is the test that
         * stops the three collapsing back into one.
         * ──────────────────────────────────────────────────────────────── */
        await closeOne('delivered');
        await dispatch(fakeMailer());

        const sent = await rows(
            "SELECT dispatch_result FROM notifications WHERE sent_at IS NOT NULL AND kind LIKE 'delivery.%'",
        );
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((r) => r.dispatch_result === 'sent')).toBe(true);
    });

    it('does not call an account with no address "sent"', async () => {
        /* The exact shape the rehearsal passed on. Nobody was emailed; the
           row is finished so the sweep leaves it alone; and it must not read
           as a delivery that happened. */
        /* Saved and put back: every test after this one needs an address to
           send to, and a test that quietly empties a column the rest of the
           file depends on is a worse bug than the one it is checking. */
        const before = await rows('SELECT username, email FROM users WHERE email IS NOT NULL');
        expect(before.length, 'nothing to blank, so this proves nothing').toBeGreaterThan(0);
        try {
            await srv.core.client.execute('UPDATE users SET email = NULL');
            await closeOne('delivered');
            const mailer = fakeMailer();
            const result = await dispatch(mailer);

            expect(mailer.sent).toHaveLength(0);
            expect(result.skipped).toBeGreaterThan(0);
            const finished = await rows(
                "SELECT dispatch_result FROM notifications WHERE dispatch_result = 'no_address'",
            );
            expect(finished.length).toBeGreaterThan(0);
        } finally {
            for (const u of before) {
                await srv.core.client.execute({
                    sql: 'UPDATE users SET email = ? WHERE username = ?',
                    args: [u.email, u.username],
                });
            }
        }
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
        expect(result).toEqual({ considered: 0, sent: 0, failed: 0, skipped: 0, suppressed: 0 });
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

describe('what a refusal from SES is allowed to say, and what it must say', () => {
    /* A REAL 403 IN PRODUCTION READ AS "SES refused the message: 403".
     *
     * That is three different faults wearing one number -- a key that does
     * not exist, a secret that does not match, and a key with no
     * ses:SendEmail -- and the status alone cannot tell them apart. The one
     * person able to fix it was left guessing, which is the whole reason
     * these four tests exist.
     *
     * SES v2 is REST-JSON: the error name lives in the x-amzn-errortype
     * HEADER and is only sometimes repeated in the body as __type. Reading
     * the body alone is what lost it. */
    const cfg = {
        enabled: true,
        portalUrl: 'https://logs.example.invalid',
        ses: {
            region: 'us-east-2',
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
            from: 'no-reply@example.invalid',
        },
    };
    const letter = { to: 'counter@example.invalid', subject: 'Delivery completed', text: 'Order 41 is done.' };
    const refuse = (status, headers, body) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(body === undefined ? '' : JSON.stringify(body), { status, headers }),
    );

    afterEach(() => { vi.restoreAllMocks(); });

    it('names the AWS error type from the header, because that is the fault', async () => {
        refuse(403, { 'x-amzn-errortype': 'AccessDeniedException' });
        await expect(createMailer({ mail: cfg }).send(letter))
            .rejects.toThrow('SES refused the message: 403 AccessDeniedException');
    });

    it('keeps the name and drops the URL AWS staples to it', async () => {
        /* The header arrives as "SignatureDoesNotMatch:http://internal..."
           often enough that leaving it whole puts an AWS hostname in a log
           line, and the part after the colon says nothing anybody needs. */
        refuse(403, { 'x-amzn-errortype': 'SignatureDoesNotMatch:http://internal.amazon.com/coral/' });
        await expect(createMailer({ mail: cfg }).send(letter))
            .rejects.toThrow('SES refused the message: 403 SignatureDoesNotMatch');
    });

    it('falls back to __type in the body when there is no header', async () => {
        refuse(400, {}, { __type: 'MessageRejected', message: 'Email address is not verified.' });
        await expect(createMailer({ mail: cfg }).send(letter))
            .rejects.toThrow('SES refused the message: 400 MessageRejected');
    });

    it('says the status alone rather than guessing, when neither is there', async () => {
        refuse(502, {}, undefined);
        await expect(createMailer({ mail: cfg }).send(letter))
            .rejects.toThrow('SES refused the message: 502');
    });

    it('never repeats the message text, which names the recipient', async () => {
        /* The rule at the top of ses.ts: an address is not patient data but
           it has no business in a log line either. An error TYPE is a fixed
           string from a published list; the message is prose about who we
           tried to email. */
        refuse(400, { 'x-amzn-errortype': 'MessageRejected' }, {
            __type: 'MessageRejected',
            message: 'Email address is not verified. The following identities failed: counter@example.invalid',
        });
        const err = await createMailer({ mail: cfg }).send(letter).catch((e) => e);
        expect(err.message).not.toContain('counter@example.invalid');
        expect(err.message).not.toMatch(/not verified/i);
    });
});

describe('what the mailer remembers about its own sends', () => {
    /* FOR /health, AND BECAUSE `available` IS A WEAK FACT. It means the five
     * configuration values are present -- the same thing files: "configured"
     * meant for weeks over a bucket that refused every upload. Production
     * then ran a day with SES answering 403 to everything while /health said
     * "configured, nothing sent yet", because that line counts notification
     * rows and a password reset code is not one.
     *
     * Counted in the mailer because that is the only place every send passes
     * through: the sweep, the daily report, and the reset codes. */
    const cfg = {
        enabled: true,
        portalUrl: 'https://logs.example.invalid',
        ses: {
            region: 'us-east-2',
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
            from: 'no-reply@example.invalid',
        },
    };
    const letter = { to: 'counter@example.invalid', subject: 'Delivery completed', text: 'Order 41 is done.' };

    afterEach(() => { vi.restoreAllMocks(); });

    it('starts with nothing attempted, which is the honest answer after a boot', () => {
        expect(createMailer({ mail: cfg }).attempts()).toEqual({ attempted: 0, failing: 0, lastError: null, lastAttemptAt: null });
    });

    it('counts a refusal and keeps the status and type, so /health can name it', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('', { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException' } }),
        );
        const mailer = createMailer({ mail: cfg });
        await mailer.send(letter).catch(() => undefined);
        await mailer.send(letter).catch(() => undefined);
        expect(mailer.attempts()).toMatchObject({ attempted: 2, failing: 2, lastError: '403 AccessDeniedException' });
        /* Stamped on every attempt, failed or not. /health reads it to tell
           a refusal happening now from one that happened an hour ago with
           nothing tried since -- without it a frozen count reads as a
           mailer still failing. */
        expect(mailer.attempts().lastAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('forgets the run of failures as soon as one send works', async () => {
        /* A mailer that sent something a moment ago is not broken, whatever
           it did before, and /health must not keep calling it broken. */
        const fetching = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException' } }))
            .mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const mailer = createMailer({ mail: cfg });
        await mailer.send(letter).catch(() => undefined);
        expect(mailer.attempts().failing).toBe(1);
        await mailer.send(letter);
        expect(mailer.attempts()).toMatchObject({ attempted: 2, failing: 0, lastError: null });
        expect(mailer.attempts().lastAttemptAt, 'a success is still an attempt').toMatch(/^\d{4}/);
        expect(fetching).toHaveBeenCalledTimes(2);
    });

    it('records a network failure without naming the SES endpoint', async () => {
        /* The error's own words carry the hostname, and a hostname is on the
           list at the top of core/http/health.ts of things that never appear
           on a public endpoint. The caller and the log still get the real
           message; /health gets a fixed string. */
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND email.us-east-2.amazonaws.com'));
        const mailer = createMailer({ mail: cfg });
        await expect(mailer.send(letter)).rejects.toThrow(/ENOTFOUND/);
        expect(mailer.attempts()).toMatchObject({ attempted: 1, failing: 1, lastError: 'could not reach SES' });
        expect(mailer.attempts().lastAttemptAt).toMatch(/^\d{4}/);
    });

    it('does not count a refused template as SES refusing us', async () => {
        /* assertNoPatientData throws before anything reaches AWS. Counting it
           would have /health announce that SES is rejecting our credentials
           when SES has not been asked -- a template bug wearing a
           configuration bug's clothes. */
        const fetching = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
        const mailer = createMailer({ mail: cfg });
        await expect(mailer.send({ ...letter, text: 'Deliver to 420 Rosewood Street' })).rejects.toThrow(/street address/i);
        expect(mailer.attempts()).toEqual({ attempted: 0, failing: 0, lastError: null, lastAttemptAt: null });
        expect(fetching).not.toHaveBeenCalled();
    });

    it('reports nothing attempted when it is not configured, rather than throwing', async () => {
        const off = createMailer({ mail: { enabled: false, ses: undefined, portalUrl: '' } });
        expect(off.attempts()).toEqual({ attempted: 0, failing: 0, lastError: null, lastAttemptAt: null });
    });
});

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
