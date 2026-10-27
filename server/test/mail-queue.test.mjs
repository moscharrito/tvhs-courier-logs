/* Looking at what is about to be emailed, before it is.
 *
 * The fault this closes: SES refused every send for a day, so the queue
 * filled up, and the only question that mattered next -- who is in it and
 * what is it about -- could not be answered by anything short of the Turso
 * credentials and a SQL prompt. A queue of genuine delivery notifications
 * should be released at once; a queue of notifications about dry-run orders
 * emails a hospital a confirmation for a package that never existed, and an
 * email cannot be recalled.
 *
 * So the property under test is not "the endpoint returns rows". It is that
 * the preview AGREES WITH THE SEND: a row this says `would send` is a row
 * dispatch will send, and the counts are of the whole queue rather than of
 * whatever fitted on a page.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { mailQueue, isReservedDomain } from '../src/core/notify/queue.ts';
import { dispatchPending, BATCH } from '../src/core/notify/dispatch.ts';

let srv, admin, courier;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');

    await admin.post('/api/users').send({ username: 'queue.counter', name: 'Queue Counter', email: 'counter@example.invalid', password: 'client-pass-1', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.noaddr', name: 'No Address', password: 'client-pass-2', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.bounced', name: 'Bounced', email: 'bounced@example.invalid', password: 'client-pass-3', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.real', name: 'Real Domain', email: 'counter@izyglobalservices.test.invalid', password: 'client-pass-4', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.elsewhere', name: 'Elsewhere', email: 'somebody@izyglobalservices.com', password: 'client-pass-5', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.courier', name: 'Queue Courier', password: 'courier-pass-1', role: 'driver' });
    await admin.put('/api/users/queue.courier/memberships/uh').send({ role: 'courier', settings: {} });
    /* By hand rather than srv.login, which only knows the preset accounts. */
    courier = srv.agent();
    const signedIn = await courier.post('/api/login').send({ username: 'queue.courier', password: 'courier-pass-1' });
    if (signedIn.status !== 200) throw new Error(`courier login failed: ${signedIn.status} ${signedIn.text}`);
});
afterAll(async () => { await srv.stop(); });

const run = (sql, args = []) => srv.core.client.execute({ sql, args });
const rows = async (sql, args = []) => (await run(sql, args)).rows;

let seq = 0;
/** A waiting notification of an emailed kind, for a named account. */
async function queued(username, kind = 'delivery.completed', orderId = null) {
    seq += 1;
    await run(
        `INSERT INTO notifications (project_id, username, kind, body, order_id, created_at)
         VALUES ((SELECT id FROM projects WHERE code = 'uh'), ?, ?, ?, ?, ?)`,
        [username, kind, `Order ${1000 + seq} was delivered at 10:0${seq % 10}.`, orderId, `2026-10-2${(seq % 9) + 1}T09:00:00.000Z`],
    );
}

async function clearQueue() {
    await run("DELETE FROM notifications WHERE kind LIKE 'delivery.%'");
    await run('DELETE FROM mail_suppressions');
}

const queue = () => mailQueue(srv.core.client);

describe('what is waiting to go out', () => {
    it('is empty, and says so without pretending otherwise', async () => {
        await clearQueue();
        const q = await queue();
        expect(q).toMatchObject({ total: 0, wouldSend: 0, noAddress: 0, suppressed: 0, oldest: null, partial: false });
        expect(q.rows).toEqual([]);
    });

    it('names the account, the address, the order and what it says', async () => {
        /* All four are what somebody deciding "is this test data?" needs. An
           order number with no body does not answer it and neither does a
           body with no order. */
        await clearQueue();
        await queued('queue.counter', 'delivery.completed', 41);
        const q = await queue();
        expect(q.total).toBe(1);
        expect(q.rows[0]).toMatchObject({
            username: 'queue.counter',
            email: 'counter@example.invalid',
            orderId: 41,
            kind: 'delivery.completed',
            outcome: 'would send',
        });
        expect(q.rows[0].body).toMatch(/Order \d+ was delivered/);
    });

    it('separates what would send from what would not, which is the whole question', async () => {
        await clearQueue();
        await queued('queue.counter');
        await queued('queue.counter', 'delivery.failed');
        await queued('queue.noaddr');
        await run(
            "INSERT INTO mail_suppressions (address, reason, detail, created_at) VALUES (?, 'bounce', 'hard', ?)",
            ['bounced@example.invalid', '2026-10-20T09:00:00.000Z'],
        );
        await queued('queue.bounced');

        const q = await queue();
        expect(q.total).toBe(4);
        expect(q).toMatchObject({ wouldSend: 2, noAddress: 1, suppressed: 1 });
    });

    it('agrees with dispatch, because a preview that does not is worse than none', async () => {
        /* THE LOAD-BEARING TEST. Every row the preview calls `would send` is
           counted `sent` by the real sweep, and every row it calls something
           else is not. If these two ever diverge, somebody opens the valve on
           the strength of a number that was never true. */
        await clearQueue();
        await queued('queue.counter');
        await queued('queue.noaddr');
        await run(
            "INSERT INTO mail_suppressions (address, reason, detail, created_at) VALUES (?, 'complaint', 'spam', ?)",
            ['bounced@example.invalid', '2026-10-20T09:00:00.000Z'],
        );
        await queued('queue.bounced');

        const preview = await queue();
        const sent = [];
        const result = await dispatchPending({
            client: srv.core.client,
            mailer: {
                available: true,
                reason: null,
                attempts: () => ({ attempted: sent.length, failing: 0, lastError: null }),
                async send(mail) { sent.push(mail.to); },
            },
            logger: { info() {}, warn() {}, error() {}, debug() {} },
            portalUrl: 'https://logs.example.invalid',
        });

        expect(result.sent).toBe(preview.wouldSend);
        expect(result.skipped).toBe(preview.noAddress);
        expect(result.suppressed).toBe(preview.suppressed);
        expect(sent).toEqual(
            preview.rows.filter((r) => r.outcome === 'would send').map((r) => r.email),
        );
    });

    it('counts the whole queue even when it only lists a page of it', async () => {
        /* The number somebody acts on is "how many real emails does granting
           that permission send". If that figure were capped by the page size
           it would be a different number every time somebody changed the
           limit, and all of them wrong. */
        await clearQueue();
        for (let i = 0; i < 7; i += 1) await queued('queue.counter');

        const page = await mailQueue(srv.core.client, 3);
        expect(page.rows).toHaveLength(3);
        expect(page.total).toBe(7);
        expect(page.wouldSend).toBe(7);
        expect(page.partial).toBe(true);

        const whole = await mailQueue(srv.core.client, 100);
        expect(whole.rows).toHaveLength(7);
        expect(whole.partial).toBe(false);
    });

    it('marks the rows the next sweep will actually touch', async () => {
        /* dispatch takes `ORDER BY n.id LIMIT 25`, so a queue deeper than the
           batch has a head and a tail, and anything behind a row that keeps
           failing waits for it. A total of 400 against a batch of 25 is a
           fact somebody should be able to see. */
        await clearQueue();
        for (let i = 0; i < BATCH + 4; i += 1) await queued('queue.counter');

        const q = await mailQueue(srv.core.client, 200);
        expect(q.total).toBe(BATCH + 4);
        expect(q.batch).toBe(BATCH);
        expect(q.rows.filter((r) => r.inNextBatch)).toHaveLength(BATCH);
        /* Oldest first, the same order dispatch reads them in. */
        expect(q.rows.slice(0, BATCH).every((r) => r.inNextBatch)).toBe(true);
        expect(q.rows[BATCH].inNextBatch).toBe(false);
    });

    it('ignores the kinds that never leave the company', async () => {
        /* The courier-facing kinds are read in the app by somebody who has it
           open. They are not waiting on email and must not inflate a figure
           that is about what SES is holding. */
        await clearQueue();
        await queued('queue.counter');
        await queued('queue.courier', 'work.assigned');
        await queued('queue.courier', 'work.unclaimed');
        const q = await queue();
        expect(q.total).toBe(1);
        expect(q.rows.map((r) => r.kind)).toEqual(['delivery.completed']);
    });

    it('stops listing a row the moment it has been sent', async () => {
        await clearQueue();
        await queued('queue.counter');
        expect((await queue()).total).toBe(1);
        await run("UPDATE notifications SET sent_at = ?, dispatch_result = 'sent' WHERE kind LIKE 'delivery.%'", ['2026-10-24T10:00:00.000Z']);
        expect((await queue()).total).toBe(0);
    });

    it('survives a row whose account has been removed', async () => {
        /* notify() takes a username and swallows the case where it no longer
           exists, so a row can outlive its account. The LEFT JOIN is what
           stops that row disappearing from a view whose job is to account
           for everything waiting. */
        await clearQueue();
        await queued('somebody.who.left');
        const q = await queue();
        expect(q.total).toBe(1);
        expect(q.rows[0]).toMatchObject({ username: 'somebody.who.left', email: '', outcome: 'no address' });
    });
});

describe('where it would actually go', () => {
    /* THE QUESTION FIVE SAMPLED ROWS CANNOT ANSWER. Production's queue held
     * 302 rows from a rehearsal week, and whether releasing it was safe
     * turned entirely on whether any real address was among them. Reading a
     * page of the table does not tell anybody that; a count per domain does.
     */
    it('groups the sendable mail by domain, commonest first', async () => {
        await clearQueue();
        await queued('queue.counter');
        await queued('queue.counter');
        await queued('queue.real');
        const q = await queue();
        expect(q.recipients).toEqual([
            { domain: 'example.invalid', count: 2, reserved: true },
            { domain: 'izyglobalservices.test.invalid', count: 1, reserved: true },
        ]);
    });

    it('counts how many could never reach anybody', async () => {
        await clearQueue();
        await queued('queue.counter');
        await queued('queue.elsewhere');
        const q = await queue();
        expect(q.wouldSend).toBe(2);
        expect(q.wouldSendReserved).toBe(1);
        /* So the page can say "1 of them to real domains" rather than
           leaving somebody to work it out. */
        expect(q.wouldSend - q.wouldSendReserved).toBe(1);
    });

    it('leaves out the rows that would not be sent', async () => {
        /* An account with no address has no domain worth counting, and a
           suppressed one is not going anywhere either. Counting them would
           inflate the only figure on the page that matters. */
        await clearQueue();
        await queued('queue.noaddr');
        await run(
            "INSERT INTO mail_suppressions (address, reason, detail, created_at) VALUES (?, 'bounce', 'hard', ?)",
            ['bounced@example.invalid', '2026-10-20T09:00:00.000Z'],
        );
        await queued('queue.bounced');
        const q = await queue();
        expect(q.wouldSend).toBe(0);
        expect(q.recipients).toEqual([]);
        expect(q.wouldSendReserved).toBe(0);
    });

    it('knows which domains an RFC set aside, and does not guess about the rest', async () => {
        /* .invalid exists precisely so software can be CERTAIN an address is
           not real. An address outside the list is not therefore real, only
           not provably fake -- which is why the figure is reported as
           reserved against the rest and never as safe against unsafe. */
        for (const d of ['example.invalid', 'EXAMPLE.INVALID', 'a.b.test', 'example.com', 'localhost', 'invalid']) {
            expect(isReservedDomain(d), d).toBe(true);
        }
        for (const d of ['izyglobalservices.com', 'gmail.com', 'uhs-sa.com', 'invalid.com', 'notexample.org']) {
            expect(isReservedDomain(d), d).toBe(false);
        }
    });
});

describe('whether anything can be sent at all', () => {
    /* An administrator in the shell could not find out that SES had refused
     * 19,126 consecutive sends, because the only place that said so was an
     * unauthenticated endpoint reached with curl. The queue page is where
     * somebody asking "why did my reset code never come" ends up. */
    it('reports the mailer beside the queue', async () => {
        await clearQueue();
        const res = await admin.get('/api/mail-queue');
        expect(res.status).toBe(200);
        /* The test server has no SES credentials, so this is the honest
           answer rather than a contrived one. */
        expect(res.body.mailer).toMatchObject({ available: false, attempted: 0, failing: 0, lastError: null });
        expect(String(res.body.mailer.reason)).toMatch(/not enabled|missing/i);
    });

    it('records whether mail was working when somebody read the queue', async () => {
        /* The wouldSend figure means something different depending on it, so
           an audit row that kept one without the other would be a figure
           nobody could later interpret. */
        await clearQueue();
        await queued('queue.counter');
        await admin.get('/api/mail-queue');
        const trail = await rows("SELECT detail FROM audit_events WHERE action = 'mail_queue.read' ORDER BY id DESC LIMIT 1");
        expect(JSON.parse(String(trail[0].detail))).toMatchObject({ total: 1, wouldSend: 1, mailerFailing: 0 });
    });
});

describe('closing one without sending it', () => {
    /* THE TRAP THIS DEFUSES FIRES ON THE GOOD NEWS. The queue holds
     * rehearsal notifications addressed to @example.invalid. In the SES
     * sandbox they are harmlessly refused; the moment production access is
     * granted SES accepts them and every one hard bounces, because
     * `.invalid` resolves to nothing by design. Hundreds of bounces in
     * minutes, on a domain whose sending reputation starts that day, is how
     * an account is put back in the sandbox or suspended.
     *
     * So there has to be a way to say "not this one" that is not a DELETE
     * typed into a database at speed.
     */
    it('stops a row being sent without destroying it', async () => {
        await clearQueue();
        await queued('queue.counter', 'delivery.completed', 311);
        const before = await queue();
        expect(before.wouldSend).toBe(1);

        const id = before.rows[0].id;
        const saidBefore = before.rows[0].body;
        const res = await admin.post('/api/mail-queue/close').send({ ids: [id] });
        expect(res.status, res.text).toBe(200);
        expect(res.body.closed).toBe(1);

        /* Gone from the queue... */
        expect((await queue()).total).toBe(0);
        /* ...and still there, word for word, with a reason beside it. The
           notification stays readable in the app by whoever it was for: a
           courier asking why they saw a notice for an order deserves a row
           that answers, and deleting it would delete the answer. */
        const row = (await rows('SELECT sent_at, dispatch_result, body, order_id FROM notifications WHERE id = ?', [id]))[0];
        expect(row.sent_at).toBeTruthy();
        expect(String(row.dispatch_result)).toBe('cleared');
        expect(String(row.body), 'unchanged').toBe(saidBefore);
        expect(Number(row.order_id), 'still points at the order').toBe(311);
    });

    it('cannot rewrite the history of something that did go out', async () => {
        /* sent_at IS NULL stays in the WHERE clause, so a row that was
           really sent keeps saying so. */
        await clearQueue();
        await queued('queue.counter');
        const id = (await queue()).rows[0].id;
        await run("UPDATE notifications SET sent_at = ?, dispatch_result = 'sent' WHERE id = ?", ['2026-10-20T09:00:00.000Z', id]);

        const res = await admin.post('/api/mail-queue/close').send({ ids: [id] });
        expect(res.body.closed, 'nothing to close').toBe(0);
        const row = (await rows('SELECT sent_at, dispatch_result FROM notifications WHERE id = ?', [id]))[0];
        expect(String(row.dispatch_result), 'still says it was sent').toBe('sent');
        expect(String(row.sent_at)).toBe('2026-10-20T09:00:00.000Z');
    });

    it('is safe to run twice', async () => {
        await clearQueue();
        await queued('queue.counter');
        const id = (await queue()).rows[0].id;
        expect((await admin.post('/api/mail-queue/close').send({ ids: [id] })).body.closed).toBe(1);
        expect((await admin.post('/api/mail-queue/close').send({ ids: [id] })).body.closed).toBe(0);
    });

    it('closes only the ids it was given', async () => {
        /* Ids rather than a filter, so what is closed is what somebody
           looked at: a filter would be evaluated against a queue that may
           have moved since they read it. */
        await clearQueue();
        await queued('queue.counter');
        await queued('queue.counter');
        const all = (await queue()).rows.map((r) => r.id);
        await admin.post('/api/mail-queue/close').send({ ids: [all[0]] });

        const left = await queue();
        expect(left.total).toBe(1);
        expect(left.rows[0].id).toBe(all[1]);
    });

    it('is admin only, because it decides somebody is not told', async () => {
        await clearQueue();
        await queued('queue.counter');
        const id = (await queue()).rows[0].id;
        expect((await srv.agent().post('/api/mail-queue/close').send({ ids: [id] })).status).toBe(401);
        expect((await courier.post('/api/mail-queue/close').send({ ids: [id] })).status).toBe(403);
    });

    it('refuses a request with nothing in it rather than closing everything', async () => {
        expect((await admin.post('/api/mail-queue/close').send({ ids: [] })).status).toBe(400);
        expect((await admin.post('/api/mail-queue/close').send({})).status).toBe(400);
    });

    it('audits it, because it is a decision somebody may have to account for', async () => {
        await clearQueue();
        await queued('queue.counter');
        const id = (await queue()).rows[0].id;
        await admin.post('/api/mail-queue/close').send({ ids: [id] });

        const trail = await rows("SELECT detail FROM audit_events WHERE action = 'mail_queue.close' ORDER BY id DESC LIMIT 1");
        expect(trail).toHaveLength(1);
        expect(JSON.parse(String(trail[0].detail))).toMatchObject({ asked: 1, closed: 1, reason: 'cleared' });
    });
});

describe('GET /api/mail-queue', () => {
    it('is admin only, because it is a list of who is about to be emailed', async () => {
        expect((await srv.agent().get('/api/mail-queue')).status).toBe(401);
        expect((await courier.get('/api/mail-queue')).status).toBe(403);
        expect((await admin.get('/api/mail-queue')).status).toBe(200);
    });

    it('answers with the counts and the rows', async () => {
        await clearQueue();
        await queued('queue.counter', 'delivery.completed', 7);
        await queued('queue.noaddr');
        const res = await admin.get('/api/mail-queue');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 2, wouldSend: 1, noAddress: 1, batch: BATCH });
        expect(res.body.rows).toHaveLength(2);
        expect(res.body.oldest).toMatch(/^2026-/);
    });

    it('refuses a nonsense limit rather than guessing one', async () => {
        expect((await admin.get('/api/mail-queue?limit=0')).status).toBe(400);
        expect((await admin.get('/api/mail-queue?limit=9000')).status).toBe(400);
        expect((await admin.get('/api/mail-queue?limit=abc')).status).toBe(400);
    });

    it('audits the read, because this is who is about to be emailed', async () => {
        await clearQueue();
        await queued('queue.counter');
        await admin.get('/api/mail-queue');
        const trail = await rows("SELECT action, detail FROM audit_events WHERE action = 'mail_queue.read' ORDER BY id DESC LIMIT 1");
        expect(trail).toHaveLength(1);
        expect(JSON.parse(String(trail[0].detail))).toMatchObject({ total: 1, wouldSend: 1 });
    });
});
