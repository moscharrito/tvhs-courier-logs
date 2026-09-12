/* Run web/public/sw.js in a sandbox so its behaviour can be tested.
 *
 * The alternative is asserting on the file's text, which passes happily
 * while the code does the opposite of what the text says. What matters about
 * this worker is what it does with a request for /api, so the test has to
 * actually hand it one.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SERVER_DIR } from './server.mjs';

export const SW_PATH = path.resolve(SERVER_DIR, '..', 'web', 'public', 'sw.js');

/**
 * Load the worker. Returns its event handlers plus a record of every cache
 * operation it performed, so a test can assert what was stored.
 */
export function loadServiceWorker() {
    const source = fs.readFileSync(SW_PATH, 'utf8');

    const stored = new Map();          // cacheName -> Map(url -> 'response')
    const operations = [];             // every put/match/delete, in order
    const fetched = [];                // every request that reached the network

    const makeCache = (name) => {
        if (!stored.has(name)) stored.set(name, new Map());
        const entries = stored.get(name);
        return {
            addAll: async (urls) => { for (const u of urls) { entries.set(String(u), 'response'); operations.push({ op: 'put', cache: name, url: String(u) }); } },
            put: async (request, _res) => {
                const url = typeof request === 'string' ? request : request.url;
                entries.set(url, 'response');
                operations.push({ op: 'put', cache: name, url });
            },
            match: async (request) => {
                const url = typeof request === 'string' ? request : request.url;
                operations.push({ op: 'match', cache: name, url });
                return entries.get(url) ?? undefined;
            },
        };
    };

    const caches = {
        open: async (name) => makeCache(name),
        match: async (request) => {
            const url = typeof request === 'string' ? request : request.url;
            operations.push({ op: 'match', cache: '*', url });
            for (const entries of stored.values()) if (entries.has(url)) return entries.get(url);
            return undefined;
        },
        keys: async () => [...stored.keys()],
        delete: async (name) => { operations.push({ op: 'delete', cache: name }); return stored.delete(name); },
    };

    const handlers = {};
    const self = {
        addEventListener: (type, fn) => { handlers[type] = fn; },
        skipWaiting: async () => {},
        clients: { claim: async () => {} },
        location: { origin: 'https://tag.example.com' },
        caches,
    };

    const sandbox = {
        self,
        caches,
        URL,
        Response: { error: () => 'network-error' },
        fetch: async (request) => {
            fetched.push(typeof request === 'string' ? request : request.url);
            return { ok: true, clone: () => 'copy' };
        },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'sw.js' });

    /** Dispatch a fetch event and report what the worker did with it. */
    async function dispatchFetch({ url, method = 'GET', mode = 'no-cors' }) {
        const request = { url, method, mode };
        let responded = false;
        const waits = [];
        const event = {
            request,
            respondWith: (p) => { responded = true; waits.push(Promise.resolve(p).catch(() => undefined)); },
            waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => undefined)); },
        };
        handlers['fetch']?.(event);
        await Promise.all(waits);
        // Let any cache writes started inside a .then settle.
        await new Promise((r) => setImmediate(r));
        return { responded };
    }

    async function dispatchMessage(data) {
        const waits = [];
        handlers['message']?.({ data, waitUntil: (p) => waits.push(Promise.resolve(p)) });
        await Promise.all(waits);
    }

    async function install() {
        const waits = [];
        handlers['install']?.({ waitUntil: (p) => waits.push(Promise.resolve(p)) });
        await Promise.all(waits);
    }

    return {
        handlers,
        operations,
        fetched,
        stored,
        install,
        dispatchFetch,
        dispatchMessage,
        /** Every URL the worker wrote into any cache. */
        cachedUrls: () => operations.filter((o) => o.op === 'put').map((o) => o.url),
    };
}
