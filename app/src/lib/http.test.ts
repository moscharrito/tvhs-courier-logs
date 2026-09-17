/* The half of the client that can be tested without a phone (ticket 7.1).
 *
 * http.ts imports nothing from expo or react-native precisely so that this
 * file can exist. What it cannot cover is the Keychain and the screens, and
 * the README says so rather than leaving the coverage number to imply
 * otherwise.
 */

import { describe, it, expect } from 'vitest';
import { apiUrl, headersFor, request, ApiError, isUnauthorized, CLIENT_HEADER } from './http';

const ok = (body: unknown, status = 200) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('apiUrl', () => {
    it('joins without doubling or dropping the slash', () => {
        expect(apiUrl('http://x:3100', '/api/session')).toBe('http://x:3100/api/session');
        expect(apiUrl('http://x:3100/', '/api/session')).toBe('http://x:3100/api/session');
        expect(apiUrl('http://x:3100', 'api/session')).toBe('http://x:3100/api/session');
        expect(apiUrl('http://x:3100//', '//api/session')).toBe('http://x:3100//api/session');
    });
});

describe('headers', () => {
    it('sends no Authorization when nobody is signed in', () => {
        expect(headersFor({ token: null })).not.toHaveProperty('Authorization');
        expect(headersFor({})).not.toHaveProperty('Authorization');
        expect(headersFor({ token: '' }), 'an empty token is not a token').not.toHaveProperty('Authorization');
    });

    it('carries the bearer token when there is one', () => {
        expect(headersFor({ token: 'abc' })['Authorization']).toBe('Bearer abc');
    });

    it('asks for a token instead of a cookie only on request', () => {
        expect(headersFor({})).not.toHaveProperty(CLIENT_HEADER);
        expect(headersFor({ asApp: true })[CLIENT_HEADER]).toBe('app');
    });

    it('does not claim to send JSON when it is not sending a body', () => {
        expect(headersFor({})).not.toHaveProperty('Content-Type');
        expect(headersFor({ json: {} })['Content-Type']).toBe('application/json');
    });
});

describe('request', () => {
    it('returns the parsed body', async () => {
        const body = await request<{ username: string }>(ok({ username: 'ana' }) as never, 'http://x', '/api/session');
        expect(body.username).toBe('ana');
    });

    it('turns a refusal into an ApiError carrying the code', async () => {
        const fetcher = ok({ error: 'You are not on shift.', code: 'shift.notOn' }, 409) as never;
        await expect(request(fetcher, 'http://x', '/api/x')).rejects.toMatchObject({
            status: 409, code: 'shift.notOn', message: 'You are not on shift.',
        });
    });

    it('says something a courier can act on when the server breaks', async () => {
        /* A driver reading this is standing at a door with no network tab.
           "Request failed (502)" tells them nothing they can do. */
        const fetcher = (() => Promise.resolve(new Response('<html>502</html>', { status: 502 }))) as never;
        await expect(request(fetcher, 'http://x', '/api/x')).rejects.toThrow(/Dispatch is not answering/);
    });

    it('copes with a body that is not JSON at all', async () => {
        const fetcher = (() => Promise.resolve(new Response('', { status: 200 }))) as never;
        await expect(request(fetcher, 'http://x', '/api/x')).resolves.toBeNull();
    });

    it('recognises the one error that means sign out', () => {
        expect(isUnauthorized(new ApiError(401, 'Not authenticated'))).toBe(true);
        expect(isUnauthorized(new ApiError(403, 'Forbidden')), 'a 403 is not a bad credential').toBe(false);
        expect(isUnauthorized(new Error('network'))).toBe(false);
    });
});
