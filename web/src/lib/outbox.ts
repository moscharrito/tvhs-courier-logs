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

/** A photograph waiting to reach the bucket, and where its id belongs. */
export interface QueuedPhoto {
    blob: Blob;
    contentType: string;
    kind: string;
    /** Where to put the resulting file id in the body. */
    bodyKey: string;
}

export interface OutboxEntry {
    /** Also the clientEventId sent to the server. */
    id: string;
    url: string;
    body: Record<string, unknown>;
    /** What to call this on screen: "Delivery for Ines Vargas". */
    label: string;
    /** The order this is about, so a screen can say "waiting to send". */
    orderId: number | null;
    /* Whose work this is. The queue lives per phone, not per person, and a
       phone is handed over, borrowed, and signed into by the next shift. An
       entry sent under somebody else's session would be recorded against the
       wrong courier, in an append-only table, with a signature attached. */
    username: string;
    createdAt: number;
    /* Ordering is by this, not by createdAt. Date.now() has millisecond
       resolution, and two events recorded in the same millisecond would come
       back in whatever order their random ids happened to sort in: a delivery
       ahead of its own arrival. This is allocated one higher than anything
       already queued. */
    sequence: number;
    tries: number;
    lastError: string;
    /** A photo that has to reach the bucket before the event is sent.
     *  Singular, and kept: entries written before `photos` existed are still
     *  in somebody's IndexedDB and must still drain. */
    photo?: QueuedPhoto;
    /** MORE THAN ONE, BECAUSE A DELIVERY CAN NEED TWO.
     *
     *  The signed courier form is required on every delivery and a
     *  photograph of identification on the ones a pharmacy stamped. One
     *  field could carry the form and left the ID to be uploaded eagerly,
     *  which is exactly the thing that cannot be done without a signal --
     *  so an ID Required delivery in a stairwell would still have been
     *  impossible while an ordinary one queued fine. Both ride together. */
    photos?: QueuedPhoto[];
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
    photo?: QueuedPhoto;
    photos?: QueuedPhoto[];
    id?: string;
    /** Defaults to whoever is signed in now (see setOutboxUser). */
    username?: string;
}

/* Who the queue belongs to. Set when a session is established, cleared on
 * sign-out. Entries stamped with anybody else are not sent. */
let currentUser = '';
export function setOutboxUser(username: string): void { currentUser = username; }

export async function enqueue(input: EnqueueInput): Promise<OutboxEntry> {
    const existing = await queued();
    const entry: OutboxEntry = {
        id: input.id ?? newEventId(),
        url: input.url,
        body: input.body,
        label: input.label,
        orderId: input.orderId ?? null,
        username: input.username ?? currentUser,
        createdAt: Date.now(),
        sequence: (existing[existing.length - 1]?.sequence ?? 0) + 1,
        tries: 0,
        lastError: '',
        ...(input.photo ? { photo: input.photo } : {}),
        ...(input.photos?.length ? { photos: input.photos } : {}),
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

/** What to say before a sign-out discards the queue, or null to go straight through. */
export function signOutPrompt(queuedCount: number): string | null {
    if (queuedCount <= 0) return null;
    const one = queuedCount === 1;
    return `${one ? '1 record is' : `${queuedCount} records are`} still on this device `
        + 'and have not reached the office.\n\n'
        + 'These are deliveries and collections recorded with no signal. Signing out deletes '
        + `${one ? 'it' : 'them'} and ${one ? 'it cannot' : 'they cannot'} be recovered.\n\n`
        + 'Wait for signal and let them send first if you possibly can.';
}

/**
 * Ask before signing out would throw the queue away. True means go ahead.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIGNING OUT EMPTIES THE QUEUE, AND THE QUEUE IS THE ONLY COPY.
 *
 * clearOutbox above runs on every sign-out, and it runs AFTER /api/logout:
 * by then the session is gone and nothing queued could be sent even if it
 * were kept. So the only moment this can be caught is before the click, and
 * until now nothing caught it. A courier who works a run in a basement car
 * park and signs out at the end of it loses the run.
 *
 * NOTHING QUEUED MEANS NO QUESTION, DELIBERATELY. Sign-out is also what
 * stops one courier filing deliveries under another's name on a shared
 * phone, and a prompt in front of every sign-out teaches people to click
 * through it -- the habit that would then carry them through this one.
 *
 * window.confirm rather than a modal, matching Users.tsx and Sites.tsx: the
 * established pattern here is worth more than a nicer dialog. The count goes
 * in the question for the same reason it does there -- "sign out?" and "sign
 * out and lose 4 records?" are different questions and only the second can
 * be answered honestly.
 *
 * The phone carries the same guard in app/src/lib/outbox.ts. A promise kept
 * in one shell and broken in the other is worse than not making it.
 */
export async function confirmSignOut(): Promise<boolean> {
    /* A queue that cannot be read is not a reason to block a sign-out: the
       courier may be handing the phone over, and refusing to let go of a
       session because IndexedDB is unavailable is the worse failure. */
    const pending = await queued().catch(() => []);
    const prompt = signOutPrompt(pending.length);
    if (prompt === null) return true;
    return window.confirm(prompt);
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

/**
 * Put a photo in the bucket and answer with its file id.
 *
 * EXPORTED, because a handover needs TWO of them -- the signed form and,
 * where the pharmacy stamped it, the identification -- and the queue carries
 * one photo per entry. The phone app settled this first and the web follows
 * it rather than inventing a second answer: both are uploaded BEFORE the
 * delivery is queued, and a failure records nothing.
 *
 * That is deliberately different from the doorstep photo, which goes through
 * the queue. A doorstep drop without its picture is still a delivery; a
 * handover whose proof did not upload is a handover we cannot evidence, and
 * where the form was stamped ID Required it is one the pharmacy forbade
 * outright. So this one is allowed to fail loudly and stop the courier.
 */
export async function uploadPhotoNow(input: {
    /** `/api/projects/:code/uh`, the module the file service hangs off. */
    module: string;
    /** null for a batch photograph: a collection form belongs to the
     *  collection, not to any one order in it. */
    orderId: number | null;
    blob: Blob;
    contentType: string;
    kind: string;
    /** Makes the upload idempotent across a retry. */
    idemKey: string;
}): Promise<number> {
    return putPhoto(input.module, input.orderId, input.blob, input.contentType, input.kind, input.idemKey);
}

/** Put the photo in the bucket, then answer with the file id. */
async function sendPhoto(entry: OutboxEntry, photo: QueuedPhoto, suffix = ''): Promise<number> {
    /* The project and module prefix of the entry's own URL, so the file
       service is found without the caller repeating it. Matched rather than
       split on '/uh/': this contract's project code and module name are both
       "uh", and a split would stop at the first of them. */
    const module = /^(\/api\/projects\/[^/]+\/[^/]+)\//.exec(entry.url)?.[1];
    if (!module) throw Object.assign(new Error('That upload has nowhere to go'), { status: 400 });
    /* The idempotency key is per PHOTOGRAPH, not per entry. Two pictures on
       one delivery sharing a key meant the second upload was answered with
       the first one's file, so an ID Required delivery carried the signed
       form twice and no identification. */
    return putPhoto(module, entry.orderId, photo.blob, photo.contentType, photo.kind, `${entry.id}${suffix}`);
}

/** The three steps, in one place: create, PUT, confirm. */
async function putPhoto(
    module: string, orderId: number | null | undefined, blob: Blob,
    contentType: string, kind: string, idemKey: string,
): Promise<number> {
    const photo = { blob, contentType, kind };
    const entry = { id: idemKey };
    const created = await postJson(`${module}/files`, {
        kind: photo.kind,
        contentType: photo.contentType,
        bytes: photo.blob.size,
        orderId,
        // Its own id, derived from the entry so a retry of the upload is
        // itself idempotent rather than leaving a trail of pending files.
        clientEventId: `${entry.id}-f`,
    });
    if (created.status >= 500 || created.status === 429 || created.status === 408) throw new RetryLater('file service');
    if (created.status >= 400) {
        /* THE DETAIL COMES WITH IT, and that is not a style choice.
         *
         * On 31 October a driver at a counter saw "Invalid request" and
         * nothing else. The server had said exactly what was wrong --
         * "orderId: Expected number, received null" -- in `details`, and
         * this line dropped it on the floor. A round trip to a phone, a
         * pharmacy and back went into finding out what one discarded string
         * already knew.
         *
         * It is developer wording on a driver's screen, which is the cost.
         * The alternative is a driver who can only report that it said
         * "Invalid request", which is the thing that happened. */
        const refusal = String(created.body?.['error'] ?? 'The photo was refused');
        const details = created.body?.['details'];
        const why = Array.isArray(details) && details.length > 0 ? ` (${details.join('; ')})` : '';
        throw Object.assign(new Error(refusal + why), { status: created.status });
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

            /* Somebody else's work, left on this phone. It cannot be sent:
               the server records the actor from the session, so this would
               name the wrong courier on a custody row that can never be
               corrected. Set it aside for a person to deal with. */
            if (entry.username && currentUser && entry.username !== currentUser) {
                await reject(entry, 0, `Recorded by ${entry.username}, who is no longer signed in on this phone. Tell dispatch.`);
                continue;
            }

            try {
                const body: Record<string, unknown> = { ...entry.body, clientEventId: entry.id };
                /* Normalised, because `photo` predates `photos` and an
                   entry queued by an older build is still somebody's
                   undelivered round. */
                const pending = entry.photos ?? (entry.photo ? [entry.photo] : []);
                for (const [i, shot] of pending.entries()) {
                    body[shot.bodyKey] = await sendPhoto(entry, shot, i === 0 ? '' : `-${shot.kind}`);
                }

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
    if (offline || waiting > 0 || input.photo || input.photos?.length) {
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
