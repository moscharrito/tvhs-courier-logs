/* What the courier did, held on the phone until the network agrees.
 *
 * San Antonio has basements, lift shafts, loading docks and long stretches of
 * the far zones with nothing. A courier standing in one of them has still made
 * the delivery, and the record of it must not depend on a bar of signal that
 * arrives four minutes later. So every write a courier makes goes into this
 * queue first, and the queue drains when it can.
 *
 * Rules, each of which is a way this goes wrong if ignored:
 *
 *   IN ORDER, ONE AT A TIME. A delivery recorded before its own arrival is a
 *   chain of custody that reads backwards. The queue stops at the first entry
 *   it cannot send rather than skipping ahead.
 *
 *   THE PHONE CHOOSES THE ID. Every entry carries a clientEventId generated
 *   here, sent with the first attempt and with every retry. The server answers
 *   a repeat with the first reply instead of recording a second delivery. This
 *   is the whole reason a retry is safe (see core/http/idempotency.ts).
 *
 *   A REFUSAL IS NOT A RETRY. A 4xx means the server understood and said no;
 *   sending it again in thirty seconds will produce the same no, for ever,
 *   with every later event stuck behind it. Those are moved aside and shown to
 *   the courier. Only network failures and 5xx are retried.
 *
 *   THE QUEUE IS PHI. It holds names, addresses and signatures, in IndexedDB
 *   on a phone that may be personal. Entries are deleted the moment they are
 *   accepted, rejections are capped and expire, and signing out empties it.
 */

import { ApiError } from './api';

const DB_NAME = 'izy-outbox';
const DB_VERSION = 1;
const QUEUE = 'queue';
const REJECTED = 'rejected';

/** A rejection is kept only long enough for a courier to read it. */
export const REJECTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface OutboxEntry {
    /** Also the clientEventId sent to the server. */
    id: string;
    url: string;
    body: Record<string, unknown>;
    /** What to call this on screen: "Delivery for Ines Vargas". */
    label: string;
    /** The order this is about, so a screen can say "waiting to send". */
    orderId: number | null;
    createdAt: number;
    /* Ordering is by this, not by createdAt. Date.now() has millisecond
       resolution, and two events recorded in the same millisecond would come
       back in whatever order their random ids happened to sort in: a delivery
       ahead of its own arrival. This is allocated one higher than anything
       already queued. */
    sequence: number;
    tries: number;
    lastError: string;
    /** A photo that has to reach the bucket before the event is sent. */
    photo?: {
        blob: Blob;
        contentType: string;
        kind: string;
        /** Where to put the resulting file id in the body. */
        bodyKey: string;
    };
}

export interface Rejection {
    id: string;
    label: string;
    error: string;
    status: number;
    at: number;
}

export interface OutboxState {
    waiting: number;
    sending: boolean;
    online: boolean;
    rejected: Rejection[];
    oldest: number | null;
}

/* --------------------------------------------------------------- storage */

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(QUEUE)) {
                const store = db.createObjectStore(QUEUE, { keyPath: 'id' });
                // FIFO is the ordering that matters, so it is an index and not
                // a sort done in memory after reading the whole queue.
                store.createIndex('sequence', 'sequence');
            }
            if (!db.objectStoreNames.contains(REJECTED)) {
                db.createObjectStore(REJECTED, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
    });
    return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then((db) => new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = fn(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused the write'));
    }));
}

/** Everything queued, oldest first. Empty when this browser has no usable
 *  IndexedDB, so every caller does not have to ask first. */
export async function queued(): Promise<OutboxEntry[]> {
    if (usable === false) return [];
    const all = await run<OutboxEntry[]>(QUEUE, 'readonly', (s) => s.index('sequence').getAll() as IDBRequest<OutboxEntry[]>);
    return all;
}

export async function rejections(): Promise<Rejection[]> {
    if (usable === false) return [];
    const all = await run<Rejection[]>(REJECTED, 'readonly', (s) => s.getAll() as IDBRequest<Rejection[]>);
    const fresh = all.filter((r) => Date.now() - r.at < REJECTION_TTL_MS);
    for (const stale of all.filter((r) => !fresh.includes(r))) {
        await run(REJECTED, 'readwrite', (s) => s.delete(stale.id));
    }
    return fresh.sort((a, b) => b.at - a.at);
}

/* ----------------------------------------------------------- the queue */

type Listener = (state: OutboxState) => void;
const listeners = new Set<Listener>();
let sending = false;

export function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    void notify();
    return () => { listeners.delete(listener); };
}

export async function state(): Promise<OutboxState> {
    const entries = await queued();
    return {
        waiting: entries.length,
        sending,
        online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
        rejected: await rejections(),
        oldest: entries[0]?.createdAt ?? null,
    };
}

async function notify(): Promise<void> {
    if (listeners.size === 0) return;
    const current = await state();
    for (const listener of listeners) listener(current);
}

/** A random id the server will key on. crypto.randomUUID needs a secure
 *  context, which a phone on http in a van may not have. */
export function newEventId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface EnqueueInput {
    url: string;
    body: Record<string, unknown>;
    label: string;
    orderId?: number | null;
    photo?: OutboxEntry['photo'];
    id?: string;
}

export async function enqueue(input: EnqueueInput): Promise<OutboxEntry> {
    const existing = await queued();
    const entry: OutboxEntry = {
        id: input.id ?? newEventId(),
        url: input.url,
        body: input.body,
        label: input.label,
        orderId: input.orderId ?? null,
        createdAt: Date.now(),
        sequence: (existing[existing.length - 1]?.sequence ?? 0) + 1,
        tries: 0,
        lastError: '',
        ...(input.photo ? { photo: input.photo } : {}),
    };
    await run(QUEUE, 'readwrite', (s) => s.put(entry));
    await notify();
    return entry;
}

async function remove(id: string): Promise<void> {
    await run(QUEUE, 'readwrite', (s) => s.delete(id));
}

async function reject(entry: OutboxEntry, status: number, error: string): Promise<void> {
    await remove(entry.id);
    await run(REJECTED, 'readwrite', (s) => s.put({
        id: entry.id, label: entry.label, error, status, at: Date.now(),
    } satisfies Rejection));
}

export async function dismissRejection(id: string): Promise<void> {
    await run(REJECTED, 'readwrite', (s) => s.delete(id));
    await notify();
}

/** Empties everything. Called on sign-out: this queue is PHI. */
export async function clearOutbox(): Promise<void> {
    await run(QUEUE, 'readwrite', (s) => s.clear());
    await run(REJECTED, 'readwrite', (s) => s.clear());
    await notify();
}

/** Is something queued for this order? Screens use it to stop offering an
 *  action the courier has already taken. */
export async function pendingFor(orderId: number): Promise<boolean> {
    return (await queued()).some((e) => e.orderId === orderId);
}

/* ------------------------------------------------------------- sending */

class RetryLater extends Error { }

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        // No reply at all. Nothing is known about whether it arrived, which is
        // exactly the case the id on the body makes safe to retry.
        throw new RetryLater('offline');
    }
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
}

/** Put the photo in the bucket, then answer with the file id. */
async function sendPhoto(entry: OutboxEntry): Promise<number> {
    const photo = entry.photo!;
    /* The project and module prefix of the entry's own URL, so the file
       service is found without the caller repeating it. Matched rather than
       split on '/uh/': this contract's project code and module name are both
       "uh", and a split would stop at the first of them. */
    const module = /^(\/api\/projects\/[^/]+\/[^/]+)\//.exec(entry.url)?.[1];
    if (!module) throw Object.assign(new Error('That upload has nowhere to go'), { status: 400 });
    const created = await postJson(`${module}/files`, {
        kind: photo.kind,
        contentType: photo.contentType,
        bytes: photo.blob.size,
        orderId: entry.orderId,
        // Its own id, derived from the entry so a retry of the upload is
        // itself idempotent rather than leaving a trail of pending files.
        clientEventId: `${entry.id}-f`,
    });
    if (created.status >= 500 || created.status === 429 || created.status === 408) throw new RetryLater('file service');
    if (created.status >= 400) {
        throw Object.assign(new Error(String(created.body?.['error'] ?? 'The photo was refused')), { status: created.status });
    }
    const upload = created.body?.['upload'] as { url: string; method: string; headers: Record<string, string> } | undefined;
    const fileId = Number(created.body?.['id']);
    if (!upload || !Number.isInteger(fileId)) throw new RetryLater('no upload url');

    let put: Response;
    try {
        put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: photo.blob, credentials: 'omit', mode: 'cors' });
    } catch {
        throw new RetryLater('upload');
    }
    if (!put.ok) throw new RetryLater(`upload ${put.status}`);

    const stored = await postJson(`${module}/files/${fileId}/stored`, {
        bytes: photo.blob.size, clientEventId: `${entry.id}-s`,
    });
    if (stored.status >= 400) throw new RetryLater(`confirm ${stored.status}`);
    return fileId;
}

/**
 * Drain the queue.
 *
 * Returns when the queue is empty or when an entry could not be sent. Safe to
 * call from anywhere: a second call while one is running does nothing, because
 * two drains racing would send the same entry twice and, worse, out of order.
 */
export async function flush(): Promise<void> {
    if (sending) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { await notify(); return; }
    sending = true;
    await notify();
    try {
        for (;;) {
            const entries = await queued();
            const entry = entries[0];
            if (!entry) break;

            try {
                const body: Record<string, unknown> = { ...entry.body, clientEventId: entry.id };
                if (entry.photo) body[entry.photo.bodyKey] = await sendPhoto(entry);

                const res = await postJson(entry.url, body);
                if (res.status >= 500 || res.status === 429 || res.status === 408) {
                    throw new RetryLater(`server ${res.status}`);
                }
                if (res.status >= 400) {
                    await reject(entry, res.status, String(res.body?.['error'] ?? `Refused (${res.status})`));
                    continue;
                }
                await remove(entry.id);
            } catch (err) {
                if (err instanceof RetryLater) {
                    // Stop here rather than skipping: order is the point.
                    await run(QUEUE, 'readwrite', (s) => s.put({
                        ...entry, tries: entry.tries + 1, lastError: err.message,
                    } satisfies OutboxEntry));
                    break;
                }
                const status = Number((err as { status?: number }).status ?? 0);
                if (status >= 400 && status < 500) {
                    await reject(entry, status, (err as Error).message);
                    continue;
                }
                await run(QUEUE, 'readwrite', (s) => s.put({
                    ...entry, tries: entry.tries + 1, lastError: String((err as Error).message ?? err),
                } satisfies OutboxEntry));
                break;
            }
            await notify();
        }
    } finally {
        sending = false;
        await notify();
    }
}

/**
 * Send now if the network allows, and queue instead of failing if it does not.
 *
 * The screens call this rather than fetch. A courier does not get an error
 * because a lift shaft has no signal; they get "saved on this phone".
 */
export async function sendOrQueue(input: EnqueueInput): Promise<
    { sent: true; status: number; body: Record<string, unknown> | null } | { sent: false; entry: OutboxEntry }
> {
    const id = input.id ?? newEventId();
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

    if (!(await storageUsable())) {
        /* No IndexedDB: a private window, an ancient browser, a phone with
           site data switched off. Sending directly is worse than queueing but
           far better than pretending to queue and dropping the event. The
           caller sees a real error when it fails. */
        const res = await postJson(input.url, { ...input.body, clientEventId: id });
        if (res.status >= 400) throw asApiError(res);
        return { sent: true, status: res.status, body: res.body };
    }

    const waiting = (await queued()).length;

    /* Queue first when anything is already waiting, even with a signal:
       jumping the queue would record this event before older ones. */
    if (offline || waiting > 0 || input.photo) {
        const entry = await enqueue({ ...input, id });
        if (!offline) void flush();
        return { sent: false, entry };
    }

    try {
        const res = await postJson(input.url, { ...input.body, clientEventId: id });
        if (res.status >= 500 || res.status === 429 || res.status === 408) throw new RetryLater(`server ${res.status}`);
        /* A refusal is not a queueing problem and must not be dressed up as
           one: the courier has to see what the server said, now, while they
           are still standing there. */
        if (res.status >= 400) throw asApiError(res);
        return { sent: true, status: res.status, body: res.body };
    } catch (err) {
        if (!(err instanceof RetryLater)) throw err;
        const entry = await enqueue({ ...input, id });
        return { sent: false, entry };
    }
}

function asApiError(res: { status: number; body: Record<string, unknown> | null }): ApiError {
    const body = res.body ?? {};
    return new ApiError(
        res.status,
        String(body['error'] ?? `Request failed (${res.status})`),
        Array.isArray(body['details']) ? (body['details'] as string[]) : [],
    );
}

/** Can this browser hold a queue at all? Asked once, then remembered. */
let usable: boolean | null = null;
export async function storageUsable(): Promise<boolean> {
    if (usable !== null) return usable;
    if (typeof indexedDB === 'undefined') { usable = false; return usable; }
    try { await openDb(); usable = true; } catch { usable = false; }
    return usable;
}

let started = false;
/** Wire the queue to the phone: drain on reconnect, and keep checking while
 *  anything is waiting, because `online` lies on flaky mobile data. */
export function startOutbox(intervalMs = 30_000): () => void {
    if (started || typeof window === 'undefined') return () => { };
    started = true;
    const onOnline = () => { void flush(); };
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => { void flush(); }, intervalMs);
    void flush();
    return () => {
        started = false;
        window.removeEventListener('online', onOnline);
        window.clearInterval(timer);
    };
}

/** Test seam: forget the open database between cases. */
export function resetOutboxForTests(): void {
    dbPromise = null;
    usable = null;
    sending = false;
    started = false;
    listeners.clear();
}
