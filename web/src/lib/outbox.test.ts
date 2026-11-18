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
    pendingFor, subscribe, newEventId, resetOutboxForTests, setOutboxUser,
    signOutPrompt, confirmSignOut, uploadPhotoNow, settledAlready,
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
    setOutboxUser('ada.courier');
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

/** The JSON the first request carried. `calls` is a list and its bodies are
 *  `unknown`, which is right -- they are whatever was sent -- and says so
 *  once here rather than at every assertion. */
const sentBody = (calls: Array<{ url: string; body: unknown }>): Record<string, unknown> =>
    (calls[0]?.body ?? {}) as Record<string, unknown>;

describe('how long the phone held it', () => {
    /* ─────────────────────────────────────────────────────────────────────
     * A courier standing in a loading dock records a delivery at six. The
     * phone holds it until it finds a signal at half past eight. The server
     * stamps its own clock, so the record said half past eight -- the time
     * the NETWORK allowed the work, not the time the courier did it. It
     * moved the on-time figure, and until the rule changed on 17 November it
     * put an $18 after-hours surcharge on a delivery made in daylight.
     */

    it('tells the server how long it waited, so the stamp is when the work happened', async () => {
        /* Two and a half hours in a basement. The CLOCK is pinned at both
           ends, not the timers: fake timers stall fake-indexeddb, and this
           queue is all IndexedDB. */
        const recorded = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(recorded);
        try {
            setOnline(false);
            await enqueue({ url: url(1), body: { signedName: 'A Recipient' }, label: 'Delivery', orderId: 1 });

            clock.mockReturnValue(recorded + 150 * 60 * 1000);
            setOnline(true);
            const { calls } = fetchReturning({ status: 201 });
            await flush();

            const sent = sentBody(calls);
            expect(sent['recordedAgoMs']).toBe(150 * 60 * 1000);
            // Nothing absolute: a phone's clock may be hours out, the gap is not.
            expect(sent['at']).toBeUndefined();
        } finally {
            clock.mockRestore();
        }
    });

    it('is about zero when the queue drains straight away', async () => {
        setOnline(false);
        await enqueue({ url: url(2), body: {}, label: 'Arrival', orderId: 2 });
        setOnline(true);
        const { calls } = fetchReturning({ status: 201 });
        await flush();
        expect(sentBody(calls)['recordedAgoMs']).toBeLessThan(60 * 1000);
    });

    it('leaves a deliberate backdate alone', async () => {
        /* `at` in the body is a courier saying when it happened. Theirs, and
           not something for the queue to correct. */
        setOnline(false);
        const at = '2026-11-17T18:00:00.000Z';
        await enqueue({ url: url(3), body: { at, signedName: 'A Recipient' }, label: 'Delivery', orderId: 3 });
        setOnline(true);
        const { calls } = fetchReturning({ status: 201 });
        await flush();
        expect(sentBody(calls)['at']).toBe(at);
        expect(sentBody(calls)['recordedAgoMs']).toBeUndefined();
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

describe('the photograph is made smaller on the way out', () => {
    /* lib/downscale.ts holds the why. What matters HERE is that it happens
       before the file row is created, because that call declares the
       content type and the length, and the signed PUT is signed over the
       type it declared. A shrink applied after the create would be an
       upload S3 refuses. */

    /** Just enough browser to decode and re-encode. jsdom has neither. */
    function installCanvas(opts: { width: number; height: number; bytes: number }) {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: opts.width, height: opts.height, close: () => undefined,
        })));
        vi.stubGlobal('OffscreenCanvas', class {
            constructor(public width: number, public height: number) {}
            getContext() { return { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }; }
            convertToBlob(o: { type: string }) {
                return Promise.resolve(new Blob([new Uint8Array(opts.bytes)], { type: o.type }));
            }
        });
    }

    const camera = (bytes: number, type = 'image/jpeg') => new Blob([new Uint8Array(bytes)], { type });

    /** Queue it, then drain. A photograph ALWAYS goes through the queue --
     *  see sendOrQueue -- and it flushes in the background, so asserting
     *  straight after it would be racing a drain that has not run. */
    async function upload(orderId: number, blob: Blob, contentType: string, fileId: number) {
        setOnline(false);
        await enqueue({
            url: `/api/projects/uh/uh/orders/${orderId}/doorstep`,
            body: {}, label: 'Doorstep', orderId,
            photo: { blob, contentType, kind: 'doorstep', bodyKey: 'fileId' },
        });
        setOnline(true);
        const { calls } = fetchReturning(
            { status: 201, body: { id: fileId, upload: { url: 'https://bucket.example/put', method: 'PUT', headers: {} } } },
            { status: 200 },
            { status: 200, body: { id: fileId, status: 'stored' } },
            { status: 201, body: { status: 'delivered' } },
        );
        await flush();
        return calls;
    }

    it('declares and uploads the smaller one, not the one the camera made', async () => {
        installCanvas({ width: 4032, height: 3024, bytes: 380_000 });

        const calls = await upload(11, camera(1_900_000), 'image/jpeg', 51);

        /* The length the file service is told, which is the figure the
           bundle's size estimate adds up later. */
        expect(calls[0]!.body).toMatchObject({ bytes: 380_000, contentType: 'image/jpeg' });
        expect(calls[1]!.url).toBe('https://bucket.example/put');
        expect((calls[1]!.body as Blob).size).toBe(380_000);
        /* And the confirmation agrees, so nothing in `files` is left
           describing bytes that were never sent. */
        expect(calls[2]!.body).toMatchObject({ bytes: 380_000 });
    });

    it('declares a converted HEIC as the JPEG it now is', async () => {
        /* The type in the create is the type the PUT is signed over. If
           this said image/heic while the body was a JPEG, S3 would refuse
           the upload and the courier would see a retry that never ends. */
        installCanvas({ width: 4032, height: 3024, bytes: 410_000 });

        const calls = await upload(12, camera(2_400_000, 'image/heic'), 'image/heic', 52);

        expect(calls[0]!.body).toMatchObject({ contentType: 'image/jpeg' });
        expect((calls[1]!.body as Blob).type).toBe('image/jpeg');
    });

    it('sends what the camera gave us when the browser cannot shrink it', async () => {
        /* No stubs: this is jsdom, and it is also a phone too old for
           OffscreenCanvas. The handover still gets its proof, at full size.
           Through uploadPhotoNow rather than the queue because a blob that
           has been through fake-indexeddb comes back without its size, and
           the size is the whole assertion. */
        const { calls } = fetchReturning(
            { status: 201, body: { id: 53, upload: { url: 'https://bucket.example/put', method: 'PUT', headers: {} } } },
            { status: 200 },
            { status: 200, body: { id: 53, status: 'stored' } },
        );

        const fileId = await uploadPhotoNow({
            module: '/api/projects/uh/uh', orderId: 13,
            blob: camera(1_900_000), contentType: 'image/jpeg',
            kind: 'courier_form', idemKey: 'k-13',
        });

        expect(fileId).toBe(53);
        expect(calls[0]!.body).toMatchObject({ bytes: 1_900_000, contentType: 'image/jpeg' });
        expect((calls[1]!.body as Blob).size).toBe(1_900_000);
    });

    it('shrinks the handover proof too, not only the queued doorstep', async () => {
        /* uploadPhotoNow is the other way in: the signed collection form
           and the identification go straight up, before the delivery is
           queued. Both land in putPhoto, which is why the rule lives
           there and not at the pickers. */
        installCanvas({ width: 4032, height: 3024, bytes: 365_000 });
        const { calls } = fetchReturning(
            { status: 201, body: { id: 54, upload: { url: 'https://bucket.example/put', method: 'PUT', headers: {} } } },
            { status: 200 },
            { status: 200, body: { id: 54, status: 'stored' } },
        );

        await uploadPhotoNow({
            module: '/api/projects/uh/uh', orderId: null,
            blob: camera(2_100_000), contentType: 'image/jpeg',
            kind: 'courier_form', idemKey: 'k-14',
        });

        expect(calls[0]!.body).toMatchObject({ bytes: 365_000, orderId: null });
        expect((calls[1]!.body as Blob).size).toBe(365_000);
    });
});

describe('a phone with no room for the photograph', () => {
    /* THE CASE THAT WAS LOSING DELIVERIES, reported 3 November: a courier at
       a door photographed the signed form and got "That did not save. Try
       again." Trying again did the same thing.

       storageUsable() asks whether IndexedDB OPENS. It does not ask whether
       it will accept a three-megabyte photograph, and on a phone near its
       quota it will not: the open succeeds, the write throws, and the
       exception came straight out of sendOrQueue with the delivery in it. */
    it('sends it live rather than losing it', async () => {
        setOnline(true);
        const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError');
        });
        try {
            const { calls } = fetchReturning(
                { status: 201, body: { id: 77, upload: { url: 'https://bucket.example/put', method: 'PUT', headers: {} } } },
                { status: 200 },
                { status: 200, body: { id: 77, status: 'stored' } },
                { status: 201, body: { status: 'delivered' } },
            );

            const result = await sendOrQueue({
                url: '/api/projects/uh/uh/orders/9/doorstep',
                body: { noSignatureReason: 'Nobody answered' },
                label: 'Doorstep for order 9',
                orderId: 9,
                photo: { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), contentType: 'image/jpeg', kind: 'doorstep', bodyKey: 'fileId' },
            });

            expect(result.sent).toBe(true);
            /* Bucket first, then the event naming it -- the same order the
               queue uses, because a record pointing at a photograph that is
               not there is worse than no record. */
            expect(calls.map((c) => c.url)).toEqual([
                '/api/projects/uh/uh/files',
                'https://bucket.example/put',
                '/api/projects/uh/uh/files/77/stored',
                '/api/projects/uh/uh/orders/9/doorstep',
            ]);
            expect(calls[3]!.body).toMatchObject({ fileId: 77 });
        } finally {
            put.mockRestore();
        }
    });

    it('says so plainly when there is no signal to fall back on', async () => {
        /* Offline AND unable to store it. There is genuinely nothing left to
           try, and the courier needs to hear that rather than a generic
           failure they will read as "tap it again". */
        setOnline(false);
        const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError');
        });
        try {
            await expect(sendOrQueue({
                url: '/api/projects/uh/uh/orders/10/doorstep',
                body: {}, label: 'Doorstep', orderId: 10,
                photo: { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), contentType: 'image/jpeg', kind: 'doorstep', bodyKey: 'fileId' },
            })).rejects.toThrow(/no room to store the delivery/);
        } finally {
            put.mockRestore();
        }
    });
});

describe('a refusal that means the work is already recorded', () => {
    /* 17 November. A driver was shown "Delivery for <patient>: Cannot record
       "delivered" while the order is delivered: the order must be picked_up"
       over a delivery that WAS on the record, with "Tell dispatch what
       happened at these stops" underneath it. Two tabs, one stop, nothing
       wrong and nothing for anybody to do. */

    const deliver = (n: number) => `/api/projects/uh/uh/orders/${n}/deliver`;

    it('drops it rather than telling the courier their delivery failed', async () => {
        setOnline(false);
        await enqueue({ url: deliver(7), body: { signedName: 'Someone' }, label: 'Delivery for A Patient', orderId: 7 });
        setOnline(true);
        fetchReturning({
            status: 409,
            body: { error: '"delivered" is already recorded on this order.', code: 'transition.alreadyDone' },
        });

        await flush();
        expect(await queued()).toHaveLength(0);
        // The half that matters: nothing to dismiss, because nothing is wrong.
        expect(await rejections()).toHaveLength(0);
    });

    it('still shouts when the transition is genuinely illegal', async () => {
        setOnline(false);
        await enqueue({ url: deliver(8), body: { signedName: 'Someone' }, label: 'Delivery for B Patient', orderId: 8 });
        setOnline(true);
        fetchReturning({
            status: 409,
            body: {
                error: 'Cannot record "delivered" while the order is assigned: the order must be picked_up.',
                code: 'transition.illegal',
                status: 'assigned',
            },
        });

        await flush();
        const shown = await rejections();
        expect(shown).toHaveLength(1);
        expect(shown[0]!.label).toBe('Delivery for B Patient');
    });

    it('reads an older server, which has no word for it', () => {
        /* A phone runs the build it last cached, so it may be talking to a
           server newer than itself or older. Before `transition.alreadyDone`
           existed the refusal said `transition.illegal` and named the status,
           which is enough on its own. */
        expect(settledAlready(deliver(9), { code: 'transition.illegal', status: 'delivered' })).toBe(true);
        expect(settledAlready(deliver(9), { code: 'transition.illegal', status: 'assigned' })).toBe(false);
    });

    it('knows what each action was going for', () => {
        const attempt = '/api/projects/uh/uh/orders/9/attempt';
        expect(settledAlready(attempt, { code: 'transition.illegal', status: 'failed' })).toBe(true);
        // An attempt is going for `failed`. A delivered order is not that.
        expect(settledAlready(attempt, { code: 'transition.illegal', status: 'delivered' })).toBe(false);
    });

    it('does not swallow a refusal that is about something else', () => {
        expect(settledAlready(deliver(9), { error: 'That order is not assigned to you' })).toBe(false);
        expect(settledAlready(deliver(9), { code: 'transition.missingField' })).toBe(false);
        expect(settledAlready(deliver(9), null)).toBe(false);
    });

    it('lets a stale screen with a signal through without an error', async () => {
        /* sendOrQueue goes straight at the network when online, so this
           refusal would land on the stop screen rather than in the banner. */
        setOnline(true);
        fetchReturning({
            status: 409,
            body: { error: '"delivered" is already recorded on this order.', code: 'transition.alreadyDone' },
        });

        const result = await sendOrQueue({
            url: deliver(10), body: { signedName: 'Someone' }, label: 'Delivery for C Patient', orderId: 10,
        });
        expect(result.sent).toBe(true);
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

describe('a phone that changed hands', () => {
    it("will not send one courier's work under another courier's session", async () => {
        /* The queue lives on the phone, not on the person. The server records
           the actor from the session, so sending Ada's queued delivery while
           Ben is signed in would name Ben on an append-only custody row, with
           Ada's signature attached to it. */
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Delivery for Ines Vargas', orderId: 1 });
        setOnline(true);
        setOutboxUser('ben.courier');
        const { fn } = fetchReturning({ status: 201 });

        await flush();
        expect(fn).not.toHaveBeenCalled();
        expect(await queued()).toHaveLength(0);
        const [rejected] = await rejections();
        expect(rejected?.error).toMatch(/ada\.courier, who is no longer signed in/);
    });

    it('sends it normally once that courier signs back in', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Delivery', orderId: 1 });
        setOnline(true);
        const { fn } = fetchReturning({ status: 201 });
        await flush();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(await queued()).toHaveLength(0);
    });
});

describe('asking before a sign-out throws the queue away', () => {
    /* The guard exists because clearOutbox runs on every sign-out, AFTER
       /api/logout -- so by the time the queue is emptied nothing in it could
       have been sent anyway. Before the click is the only moment. */

    it('goes straight through when nothing is queued', async () => {
        /* Sign-out is also the shared-phone safety action. A prompt in front
           of every one of them teaches couriers to click through it, and
           that habit is what would carry them through the one below. */
        const asked = vi.spyOn(window, 'confirm').mockReturnValue(true);
        expect(await confirmSignOut()).toBe(true);
        expect(asked).not.toHaveBeenCalled();
    });

    it('asks once something is only on this device, and obeys a refusal', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Delivery for Ines Vargas', orderId: 1 });
        const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);

        expect(await confirmSignOut()).toBe(false);
        expect(asked).toHaveBeenCalledTimes(1);
        /* And the refusal must not have been destructive on its own. */
        expect(await queued()).toHaveLength(1);
    });

    it('lets the sign-out through when the courier accepts the loss', async () => {
        setOnline(false);
        await enqueue({ url: url(1), body: {}, label: 'Delivery', orderId: 1 });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        expect(await confirmSignOut()).toBe(true);
    });

    it('puts the count in the question', async () => {
        /* "Sign out?" and "sign out and lose 3 records?" are different
           questions and only the second can be answered honestly. Same
           reasoning as the device count in Users.tsx. */
        setOnline(false);
        for (const n of [1, 2, 3]) await enqueue({ url: url(n), body: {}, label: `Event ${n}`, orderId: n });
        const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);

        await confirmSignOut();
        expect(asked.mock.calls[0]![0]).toContain('3 records are');
        expect(asked.mock.calls[0]![0]).toContain('cannot be recovered');
    });

    it('does not let an unreadable queue trap somebody in a session', async () => {
        /* A courier handing the phone back must be able to sign out. Refusing
           to release a session because IndexedDB is unavailable is the worse
           failure, so an unreadable queue reads as empty. */
        vi.stubGlobal('indexedDB', undefined);
        resetOutboxForTests();
        const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);
        expect(await confirmSignOut()).toBe(true);
        expect(asked).not.toHaveBeenCalled();
    });
});

describe('the sign-out question itself', () => {
    it('says nothing when there is nothing to lose', () => {
        expect(signOutPrompt(0)).toBeNull();
        expect(signOutPrompt(-1)).toBeNull();
    });

    it('never reads "1 records" or "delete them" for a single one', () => {
        const one = signOutPrompt(1)!;
        expect(one).toContain('1 record is');
        expect(one).not.toMatch(/1 records/);
        expect(one).toContain('deletes it');
        expect(one).toContain('it cannot be recovered');
    });

    it('is plural from two upwards', () => {
        const two = signOutPrompt(2)!;
        expect(two).toContain('2 records are');
        expect(two).toContain('deletes them');
        expect(two).toContain('they cannot be recovered');
    });
});
