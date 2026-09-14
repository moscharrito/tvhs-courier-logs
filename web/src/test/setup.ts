import '@testing-library/jest-dom/vitest';
/* jsdom has no IndexedDB, and the courier screens write through the offline
   queue. Without this they would exercise the no-database fallback rather than
   the path a phone actually takes. */
import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

/* findBy* and waitFor default to one second, which is generous on an idle
   machine and tight when three vitest forks are sharing one. Two different
   tests have gone red once each on a loaded run and passed on every rerun,
   which is a false red: it reports a bug that is not there and teaches
   whoever sees it to rerun rather than to read. Three seconds does not hide
   anything, because a render that never happens never happens at one second
   or at three; it only stops the machine's load deciding the result. */
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

/** Stub fetch with a route table: { 'GET /api/x': body | { status, body } }. */
export function mockFetch(routes: Record<string, unknown>) {
    const calls: string[] = [];
    /* What was actually sent, keyed the same way as calls. For assertions
       about a request's contents rather than only that it happened: the
       courier picker, for one, has to prove the username it posted came from
       the roster and not from a box somebody typed. Last write wins, which is
       what a test asking about one request wants. */
    const bodies: Record<string, unknown> = {};
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
        calls.push(key);
        if (typeof init?.body === 'string') {
            try { bodies[key] = JSON.parse(init.body); } catch { bodies[key] = init.body; }
        }
        const hit = Object.entries(routes).find(([k]) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
        if (!hit) return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        const value = hit[1] as { status?: number; body?: unknown } | unknown[] | Record<string, unknown>;
        const isEnvelope = value && typeof value === 'object' && !Array.isArray(value) && 'status' in value && 'body' in value;
        const status = isEnvelope ? Number((value as { status: number }).status) : 200;
        const body = isEnvelope ? (value as { body: unknown }).body : value;
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fn);
    return { fn, calls, bodies };
}
