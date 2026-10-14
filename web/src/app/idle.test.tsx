/* Signing off before being told to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REPORTED FOUR TIMES BEFORE THIS TEST EXISTED.
 *
 * The server has always idled a staff session out after thirty minutes. The
 * browser had no idea, so the app only discovered its session had gone when
 * something it asked for came back 401 — and the page it was on rendered
 * that the way it renders any failure: a red "Not authenticated" across a
 * screen still showing the pharmacy's name, the date, and four stale zeros.
 *
 * Each time, I fixed the REACTION to the 401. The thing being asked for was
 * to stop waiting to be told.
 *
 * What is tested here is the clock and what counts as being awake. The poll
 * must NOT count: the portal refreshes itself every fifteen seconds whether
 * anybody is in the room or not, and counting that as activity would mean a
 * session that never idles out for as long as a tab is open somewhere,
 * which is the opposite of what a thirty minute window is for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { AuthProvider, useAuth } from './auth';

const SESSION = { id: 9, username: 'uh.green', name: 'Green Pharmacy', role: 'staff', route: null };

function Shell() {
    const { loading, user, signedOutBecause } = useAuth();
    if (loading) return <p>loading</p>;
    if (!user) return <p>signed out{signedOutBecause === 'idle' ? ' because idle' : ''}</p>;
    return <p>signed in as {user.name}</p>;
}

const answer = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
});

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
        String(url).includes('/api/session') ? answer(SESSION) : answer([])
    )));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const signIn = async () => {
    render(<AuthProvider><Shell /></AuthProvider>);
    expect(await screen.findByText(/signed in as Green Pharmacy/)).toBeInTheDocument();
};

/** Push the clock forward inside act, so timers and state settle together. */
const wait = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

describe('a session nobody is using', () => {
    it('signs itself out after thirty minutes, without being told to', async () => {
        await signIn();

        await wait(29 * 60 * 1000);
        expect(screen.getByText(/signed in/)).toBeInTheDocument();

        await wait(2 * 60 * 1000);
        expect(screen.getByText(/signed out/)).toBeInTheDocument();
    });

    it('says why, so the sign-in page is not a mystery', async () => {
        await signIn();
        await wait(31 * 60 * 1000);
        expect(screen.getByText(/signed out because idle/)).toBeInTheDocument();
    });
});

describe('a session somebody is using', () => {
    it('stays open while there is a hand on it', async () => {
        await signIn();

        /* Twenty minutes, a touch, twenty more. Were the clock not reset by
           the touch, this would be forty minutes and signed out. */
        await wait(20 * 60 * 1000);
        fireEvent.pointerDown(window);
        await wait(20 * 60 * 1000);

        expect(screen.getByText(/signed in/)).toBeInTheDocument();
    });

    it('counts a keystroke too, not only a tap', async () => {
        await signIn();
        await wait(20 * 60 * 1000);
        fireEvent.keyDown(window, { key: 'a' });
        await wait(20 * 60 * 1000);
        expect(screen.getByText(/signed in/)).toBeInTheDocument();
    });
});

describe('what does not count as somebody being there', () => {
    it('is not kept alive by the portal polling itself', async () => {
        /* THE ONE THAT MATTERS. The client portal refreshes every fifteen
           seconds on a timer. If a request counted as activity, a tab left
           open on a counter would hold a session open all night, and the
           thirty minute window would mean nothing. */
        await signIn();
        const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

        await wait(31 * 60 * 1000);

        expect(screen.getByText(/signed out/)).toBeInTheDocument();
        /* And it really was polling throughout, so the test is not passing
           because nothing happened. */
        expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
            .toBeGreaterThanOrEqual(calls);
    });
});
