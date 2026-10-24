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
import { mailQueue } from '../src/core/notify/queue.ts';
import { dispatchPending, BATCH } from '../src/core/notify/dispatch.ts';

let srv, admin, courier;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');

    await admin.post('/api/users').send({ username: 'queue.counter', name: 'Queue Counter', email: 'counter@example.invalid', password: 'client-pass-1', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.noaddr', name: 'No Address', password: 'client-pass-2', role: 'staff' });
    await admin.post('/api/users').send({ username: 'queue.bounced', name: 'Bounced', email: 'bounced@example.invalid', password: 'client-pass-3', role: 'staff' });
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
