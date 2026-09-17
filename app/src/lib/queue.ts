/* The outbox, bound to this phone (ticket 7.5).
 *
 * Every decision is in outbox.ts and tested there. This is the eight lines
 * that give it somewhere to live and something to send with.
 *
 * WHY ASYNCSTORAGE AND NOT THE KEYCHAIN. The queue holds names, addresses and
 * signatures, so the Keychain is where it belongs and it will not fit: secure
 * storage on Android caps a value at a couple of kilobytes and one signature
 * is larger than that. The web shell has the same problem and the same answer
 * (IndexedDB, unencrypted, in a browser profile), and the mitigations are the
 * same three: an entry is deleted the moment it is accepted, rejections
 * expire and are capped, and signing out empties it. The platform's own
 * encryption, iOS Data Protection and Android file-based encryption, is what
 * stands behind it at rest.
 *
 * That is a real residual risk and it is written down rather than glossed:
 * a courier's phone holding four unsent deliveries is holding four patients'
 * names until it finds a bar of signal.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { baseUrl } from './api';
import { ApiError, request } from './http';
import { loadToken } from './session';
import { EMPTY, drain, type OutboxEntry, type OutboxState, type SendResult, type Store } from './outbox';

const KEY = 'izy.outbox.v1';

export const store: Store = {
    async read(): Promise<OutboxState> {
        try {
            const raw = await AsyncStorage.getItem(KEY);
            if (raw === null) return EMPTY;
            const parsed = JSON.parse(raw) as OutboxState;
            return { queue: parsed.queue ?? [], rejected: parsed.rejected ?? [] };
        } catch {
            /* A corrupt queue is worse than an empty one only if it silently
               stays corrupt. Starting clean loses at most what had not been
               sent, and the alternative is an app that cannot open. */
            return EMPTY;
        }
    },
    async write(state: OutboxState): Promise<void> {
        try {
            await AsyncStorage.setItem(KEY, JSON.stringify(state));
        } catch {
            /* Out of space, or storage refused. The entry is still in memory
               for this session and will be sent if there is any signal at
               all; losing it silently is the risk and there is nothing better
               to do about it here. */
        }
    },
};

/** One attempt, turned into the answer drain() understands. */
async function send(entry: OutboxEntry): Promise<SendResult> {
    const token = await loadToken();
    if (token === null) return { ok: false, refused: true, why: 'You are signed out on this phone.' };
    try {
        await request(fetch, baseUrl(), entry.path, { method: 'POST', token, json: entry.body });
        return { ok: true };
    } catch (err) {
        if (err instanceof ApiError) {
            /* The line that makes the queue safe: 4xx is a decision, 5xx is a
               bad minute. See outbox.ts. */
            if (err.status >= 400 && err.status < 500) return { ok: false, refused: true, why: err.message };
            return { ok: false, refused: false, why: err.message };
        }
        return { ok: false, refused: false, why: 'No signal.' };
    }
}

export async function readQueue(): Promise<OutboxState> {
    return store.read();
}

/** Put one on the queue and try immediately. Returns the state after. */
export async function queueAndSend(entry: Omit<OutboxEntry, 'attempts'>): Promise<OutboxState> {
    const state = await store.read();
    const next: OutboxState = { ...state, queue: [...state.queue, { ...entry, attempts: 0 }] };
    await store.write(next);
    return flush();
}

/** Try everything that is waiting. */
export async function flush(): Promise<OutboxState> {
    const state = await store.read();
    const out = await drain(state, send, Date.now());
    await store.write(out.state);
    return out.state;
}

/** Signing out empties it: see the header. */
export async function clearQueue(): Promise<void> {
    try {
        await AsyncStorage.removeItem(KEY);
    } catch {
        /* Nothing useful to do, and the token is already gone, so nothing in
           it can be sent by this phone again. */
    }
}
