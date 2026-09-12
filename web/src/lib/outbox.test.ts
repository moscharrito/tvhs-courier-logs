/* The offline queue.
 *
 * Run against a real IndexedDB implementation rather than a hand-written fake:
 * the failures worth catching here are ordering and transaction failures, and
 * a fake I wrote would agree with whatever I assumed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
    enqueue, queued, flush, sendOrQueue, rejections, dismissRejection, clearOutbox,
    pendingFor, subscribe, newEventId, resetOutboxForTests,
} from './outbox';

const url = (n: number) => `/api/projects/uh/uh/orders/${n}/arrive`;

/** Replies in the order given; anything after the last one repeats it. */
function fetchReturning(...replies: Array<{ status: number; body?: unknown } | 'network'>) {
    let i = 0;
    const calls: Array<{ url: string; body: unknown }> = [];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const reply = replies[Math.min(i, replies.length - 1)]!;
        i += 1;
        calls.push({
            url: typeof input === 'string' ? input : String(input),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        });
        if (reply === 'network') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(reply.body ?? {}), {
            status: reply.status, headers: { 'Content-Type': 'application/json' },
        });
    });
    vi.stubGlobal('fetch', fn);
    return { fn, calls };
}

const setOnline = (online: boolean) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
};

beforeEach(() => {
    // A fresh database per test: leftovers would make ordering assertions lie.
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetOutboxForTests();
    setOnline(true);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('event ids', () => {
    it('are unique and shaped the way the server accepts', () => {
        const ids = new Set(Array.from({ length: 200 }, () => newEventId()));
        expect(ids.size).toBe(200);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });

    it('still works without crypto.randomUUID, which needs a secure context', () => {
        const real = globalThis.crypto;
        vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
        expect(newEventId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });
});

describe('queueing', () => {
    it('queues instead of failing when the phone is offline', async () => {
        setOnline(false);
        const { fn } = fetchReturning({ status: 201 });
        const result = await sendOrQueue({ url: url(1), body: { note: 'x' }, label: 'Arrival', orderId: 1 });

        expect(result.sent).toBe(false);
        // Nothing was even attempted: a request with no network is a delay
        // for the courier and nothing else.
        expect(fn).not.toHaveBeenCalled();
        expect(await queued()).toHaveLength(1);
        expect(await pendingFor(1)).toBe(true);
    });

    it('sends straight through when the queue is empty and the phone is online', async () => {
        const { calls } = fetchReturning({ status: 201, body: { status: 'arrived' } });
        const result = await sendOrQueue({ url: url(2), body: {}, label: 'Arrival', orderId: 2 });

        expect(result).toMatchObject({ sent: true, status: 201 });
        expect(await queued()).toHaveLength(0);
        // The id goes with the first attempt, not only with retries.
        expect(calls[0]!.body).toMatchObject({ clientEventId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) });
    });

    it('queues behind anything already waiting, even with a signal', async () => {
        /* Sending this one now would record it before older events, and a
           delivery ahead of its own arrival is a chain that reads backwards. */
        setOnline(false);
        await sendOrQueue({ url: url(3), body: {}, label: 'Arrival', orderId: 3 });
        setOnline(true);
        fetchReturning('network');

        const result = await sendOrQueue({ url: url(4), body: {}, label: 'Delivery', orderId: 4 });
        expect(result.sent).toBe(false);
        expect((await queued()).map((e) => e.orderId)).toEqual([3, 4]);
    });

    it('queues a request that dies mid-flight rather than losing it', async () => {
        fetchReturning('network');
        const result = await sendOrQueue({ url: url(5), body: {}, label: 'Arrival', orderId: 5 });
        expect(result.sent).toBe(false);
        expect(await queued()).toHaveLength(1);
    });
});

describe('draining', () => {
    it('sends in the order the courier did the work, one at a time', async () => {
        setOnline(false);
        for (const n of [1, 2, 3]) await enqueue({ url: url(n), body: { n }, label: `Event ${n}`, orderId: n });
        setOnline(true);
        const { calls } = fetchReturning({ status: 201 });

        await flush();
        expect(calls.map((c) => c.url)).toEqual([url(1), url(2), url(3)]);
        expect(await queued()).toHaveLength(0);
    });

    it('stops at the first entry it cannot send, and keeps the rest behind it', async () => {
        setOnline(false);
        for (const n of [1, 2, 3]) await enqueue({ url: url(n), body: {}, label: `Event ${n}`, orderId: n });
        setOnline(true);
        const { calls } = fetchReturning({ status: 201 }, 'network');

        await flush();
        // One sent, then a failure; the third was never attempted out of turn.
        expect(calls).toHaveLength(2);
        expect((await queued()).map((e) => e.orderId)).toEqual([2, 3]);
        expect((await queued())[0]!.tries).toBe(1);
    });

    it('retries a 500, because that is the server having a bad moment', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Arrival', orderId: 1 });
        setOnline(true);
        fetchReturning({ status: 500, body: { error: 'boom' } });
        await flush();
        expect(await queued()).toHaveLength(1);

        fetchReturning({ status: 201 });
        await flush();
        expect(await queued()).toHaveLength(0);
    });

    it('moves a refusal aside instead of retrying it for ever', async () => {
        /* A 409 means the server understood and said no. Retrying would give
           the same no every thirty seconds with every later event stuck
           behind it. */
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Delivery for Ines Vargas', orderId: 1 });
        await enqueue({ url: url(2), body: {}, label: 'Arrival', orderId: 2 });
        setOnline(true);
        fetchReturning({ status: 409, body: { error: 'Cannot record "delivered" while the order is delivered' } }, { status: 201 });

        await flush();
        expect(await queued()).toHaveLength(0);
        const rejected = await rejections();
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ status: 409, label: 'Delivery for Ines Vargas' });
        expect(rejected[0]!.error).toMatch(/Cannot record/);
    });

    it('treats a replayed answer as success, because it means it was recorded', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Arrival', orderId: 1 });
        setOnline(true);
        fetchReturning({ status: 201, body: { status: 'arrived', replayed: true } });
        await flush();
        expect(await queued()).toHaveLength(0);
    });

    it('does nothing at all while offline', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Arrival', orderId: 1 });
        const { fn } = fetchReturning({ status: 201 });
        await flush();
        expect(fn).not.toHaveBeenCalled();
        expect(await queued()).toHaveLength(1);
    });

    it('will not run two drains at once', async () => {
        setOnline(false);
        for (const n of [1, 2]) await enqueue({ url: url(n), body: {}, label: `Event ${n}`, orderId: n });
        setOnline(true);
        const { calls } = fetchReturning({ status: 201 });

        await Promise.all([flush(), flush(), flush()]);
        // Two entries, two requests: the concurrent drains did not resend.
        expect(calls).toHaveLength(2);
    });
});

describe('a queued photo', () => {
    it('reaches the bucket before the event that depends on it', async () => {
        setOnline(false);
        await enqueue({
            url: '/api/projects/uh/uh/orders/7/doorstep',
            body: { noSignatureReason: 'Nobody answered' },
            label: 'Doorstep for order 7',
            orderId: 7,
            photo: { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), contentType: 'image/jpeg', kind: 'doorstep', bodyKey: 'fileId' },
        });
        setOnline(true);
        const { calls } = fetchReturning(
            { status: 201, body: { id: 42, upload: { url: 'https://bucket.example/put', method: 'PUT', headers: {} } } },
            { status: 200 },
            { status: 200, body: { id: 42, status: 'stored' } },
            { status: 201, body: { status: 'delivered' } },
        );

        await flush();
        expect(calls.map((c) => c.url)).toEqual([
            '/api/projects/uh/uh/files',
            'https://bucket.example/put',
            '/api/projects/uh/uh/files/42/stored',
            '/api/projects/uh/uh/orders/7/doorstep',
        ]);
        // The event carries the id of the photo that is now actually stored.
        expect(calls[3]!.body).toMatchObject({ fileId: 42, noSignatureReason: 'Nobody answered' });
        expect(await queued()).toHaveLength(0);
    });

    it('keeps the whole thing queued when the upload fails', async () => {
        setOnline(false);
        await enqueue({
            url: '/api/projects/uh/uh/orders/8/doorstep',
            body: {}, label: 'Doorstep', orderId: 8,
            photo: { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), contentType: 'image/jpeg', kind: 'doorstep', bodyKey: 'fileId' },
        });
        setOnline(true);
        fetchReturning(
            { status: 201, body: { id: 42, upload: { url: 'https://bucket.example/put', method: 'PUT', headers: {} } } },
            'network',
        );

        await flush();
        // Not sent, and not reported as delivered either.
        expect(await queued()).toHaveLength(1);
        expect(await rejections()).toHaveLength(0);
    });
});

describe('what the courier is shown', () => {
    it('reports what is waiting as it changes', async () => {
        const seen: number[] = [];
        const stop = subscribe((s) => seen.push(s.waiting));
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Arrival', orderId: 1 });
        await enqueue({ url: url(2), body: {}, label: 'Delivery', orderId: 2 });
        setOnline(true);
        fetchReturning({ status: 201 });
        await flush();
        stop();
        expect(Math.max(...seen)).toBe(2);
        expect(seen[seen.length - 1]).toBe(0);
    });

    it('lets a courier dismiss a refusal once they have read it', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Delivery', orderId: 1 });
        setOnline(true);
        fetchReturning({ status: 400, body: { error: 'no' } });
        await flush();

        const [rejected] = await rejections();
        await dismissRejection(rejected!.id);
        expect(await rejections()).toHaveLength(0);
    });
});

describe('signing out', () => {
    it('empties the queue, because it holds names and addresses', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: { recipientName: 'Ines Vargas' }, label: 'Delivery', orderId: 1 });
        setOnline(true);
        fetchReturning({ status: 400, body: { error: 'no' } });
        await flush();
        expect(await rejections()).toHaveLength(1);

        await clearOutbox();
        expect(await queued()).toHaveLength(0);
        expect(await rejections()).toHaveLength(0);
    });
});
