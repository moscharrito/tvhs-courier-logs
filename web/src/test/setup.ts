import '@testing-library/jest-dom/vitest';
/* jsdom has no IndexedDB, and the courier screens write through the offline
   queue. Without this they would exercise the no-database fallback rather than
   the path a phone actually takes. */
import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

/** Stub fetch with a route table: { 'GET /api/x': body | { status, body } }. */
export function mockFetch(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
        calls.push(key);
        const hit = Object.entries(routes).find(([k]) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
        if (!hit) return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        const value = hit[1] as { status?: number; body?: unknown } | unknown[] | Record<string, unknown>;
        const isEnvelope = value && typeof value === 'object' && !Array.isArray(value) && 'status' in value && 'body' in value;
        const status = isEnvelope ? Number((value as { status: number }).status) : 200;
        const body = isEnvelope ? (value as { body: unknown }).body : value;
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fn);
    return { fn, calls };
}
