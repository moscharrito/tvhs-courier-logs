/* What happens when a session ends underneath somebody.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCREENSHOT THIS WAS WRITTEN AGAINST.
 *
 * A pharmacist left the portal open over lunch. The session idled out after
 * thirty minutes, the next poll came back 401, and the page rendered it the
 * way it renders any failure: a red "Not authenticated" across the top of a
 * screen still saying "Live · updated just now" with four zeros under it.
 *
 * The banner was the small half of that. The zeros were the dangerous half.
 * A counter reading SENT TO US 0 and DELIVERED 0 does not conclude that
 * their session expired; they conclude their deliveries are missing, and
 * they ring somebody about it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, why, whenSessionEnds } from './api';

const answer = (status: number, body: unknown = {}) => vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
})) as unknown as typeof fetch;

afterEach(() => {
    /* Leave no handler behind for the next test in the file. */
    whenSessionEnds(() => {});
    vi.unstubAllGlobals();
});

describe('a 401 while somebody is working', () => {
    it('ends the session rather than handing the page an error to render', async () => {
        const ended = vi.fn();
        whenSessionEnds(ended);
        vi.stubGlobal('fetch', answer(401, { error: 'Not authenticated', code: 'auth.sessionEnded' }));

        await expect(api('/api/projects/uh/uh/client/summary')).rejects.toBeInstanceOf(ApiError);
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it('ends it BEFORE throwing, so the page is already unmounting', async () => {
        /* Order matters. The caller's catch sets a message; if the shell has
           not started moving to the sign-in page by then, that message gets
           rendered and the banner is back. */
        const order: string[] = [];
        whenSessionEnds(() => order.push('ended'));
        vi.stubGlobal('fetch', answer(401, { code: 'auth.sessionEnded' }));

        await api('/api/anything').catch(() => order.push('threw'));
        expect(order).toEqual(['ended', 'threw']);
    });

    it('still throws, so no caller carries on as though the call worked', async () => {
        whenSessionEnds(() => {});
        vi.stubGlobal('fetch', answer(401, { code: 'auth.sessionEnded' }));
        await expect(api('/api/anything')).rejects.toMatchObject({ status: 401 });
    });
});

describe('a 401 that is about a password, not about a session', () => {
    it('leaves a wrong password on the sign-in form', async () => {
        const ended = vi.fn();
        whenSessionEnds(ended);
        vi.stubGlobal('fetch', answer(401, { error: 'Invalid username or password' }));

        const err = (await api('/api/login', { method: 'POST' }).catch((e: unknown) => e)) as ApiError;
        expect(ended).not.toHaveBeenCalled();
        expect(err.message).toBe('Invalid username or password');
    });

    it('does not sign out somebody retyping their password to set up a PIN', async () => {
        /* THE ONE AN EXISTING TEST CAUGHT. POST /api/devices/enrol answers
           401 for a wrong password to a person who is perfectly well signed
           in. A first version of this keyed off the URL, so it signed them
           out and showed them a login form, and they never learned that
           they had simply mistyped. */
        const ended = vi.fn();
        whenSessionEnds(ended);
        vi.stubGlobal('fetch', answer(401, { error: 'Incorrect username or password' }));

        const err = (await api('/api/devices/enrol', { method: 'POST' }).catch((e: unknown) => e)) as ApiError;
        expect(ended).not.toHaveBeenCalled();
        expect(err.message).toBe('Incorrect username or password');
    });

    it('leaves an untagged 401 to the page, which is the safe direction', async () => {
        /* The worst case here is the old banner. The worst case the other
           way is signing somebody out mid-task for a reason that was never
           about their session. */
        const ended = vi.fn();
        whenSessionEnds(ended);
        vi.stubGlobal('fetch', answer(401, { error: 'something else entirely' }));
        await api('/api/anything').catch(() => {});
        expect(ended).not.toHaveBeenCalled();
    });
});

describe('every other failure', () => {
    it('is left to the page, because it is about what was asked, not who asked', async () => {
        const ended = vi.fn();
        whenSessionEnds(ended);

        for (const status of [400, 403, 404, 409, 500]) {
            vi.stubGlobal('fetch', answer(status, { error: 'nope' }));
            await api('/api/anything').catch(() => {});
        }
        expect(ended).not.toHaveBeenCalled();
    });

    it('keeps the server message and code for the page to use', async () => {
        vi.stubGlobal('fetch', answer(400, { error: 'Say why first', code: 'deliver.countersignatureRequired', details: ['x'] }));
        const err = (await api('/api/anything').catch((e: unknown) => e)) as ApiError;
        expect(err.message).toBe('Say why first');
        expect(err.code).toBe('deliver.countersignatureRequired');
        expect(err.details).toEqual(['x']);
    });
});

describe('what a failed call says on the screen', () => {
    /* GO-LIVE MORNING, 1 NOVEMBER. A courier pressed File it and got the
       words "Invalid request" and nothing else. The server had already said
       which box was wrong -- `details: ["expected: String must contain at
       least 3 character(s)"]` -- and ApiError had carried it all along.
       The screen read `err.message` and dropped the rest on the floor.

       Two characters of a field name beat any sentence we could write,
       because they say WHICH control to go and fix. */
    it('adds the field the server named', () => {
        const err = new ApiError(400, 'Invalid request', ['expected: String must contain at least 3 character(s)']);
        expect(why(err, 'Could not file it')).toBe('Invalid request (expected: String must contain at least 3 character(s))');
    });

    it('joins several, because a form can be wrong in more than one place', () => {
        const err = new ApiError(400, 'Invalid request', ['kind: Invalid enum value', 'expected: too short']);
        expect(why(err, 'nope')).toBe('Invalid request (kind: Invalid enum value; expected: too short)');
    });

    it('leaves a message with no details alone, rather than printing empty brackets', () => {
        expect(why(new ApiError(403, 'That order is not assigned to you'), 'nope'))
            .toBe('That order is not assigned to you');
    });

    it('falls back for anything that is not an ApiError', () => {
        /* A network drop throws a TypeError whose message is "Failed to
           fetch", which tells a courier nothing. The caller's own words are
           better than the browser's. */
        expect(why(new TypeError('Failed to fetch'), 'Could not reach dispatch')).toBe('Could not reach dispatch');
        expect(why(null, 'Could not reach dispatch')).toBe('Could not reach dispatch');
    });
});
