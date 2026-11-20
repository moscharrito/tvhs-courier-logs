/* The poll behind the bell, and the one thing it must not do on a Monday.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TEST THIS FILE EXISTS FOR IS THE FIRST ONE.
 *
 * A dispatcher signs in at seven and the first load finds whatever was
 * written overnight: a STAT nobody claimed at eleven, two drivers who never
 * came on shift, four lists in the drop box. Announce those to the operating
 * system and they get seven banners stacked down the corner of the screen
 * before they have taken their coat off, every morning, and by Wednesday
 * they have turned the feature off in the browser where nothing in this
 * application can turn it back on.
 *
 * So the first successful load draws a line and announces nothing. Only what
 * arrives above the line interrupts anybody. Everything else here is the
 * supporting cast: the line survives a reload, a row somebody already dealt
 * with in another tab stays quiet, and the poll keeps running while the tab
 * is hidden -- which is the only state in which a notification has any point
 * at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NoticesProvider, useNotices, hrefFor } from './useNotices';

/* The desktop layer is stubbed rather than exercised: what it does with a
   notice is desktop.test.ts's business, and what this file is about is
   WHICH notices reach it. */
const shown = vi.fn(async (_n: { id: number; kind: string; body: string; href: string }) => true);
let permission = 'granted';
vi.mock('../lib/desktop', () => ({
    /* An arrow, not `shown` itself: vi.mock is hoisted above the const
       below, so naming it directly here reads it before it exists. */
    showDesktop: (n: Parameters<typeof shown>[0]) => shown(n),
    desktopState: () => permission,
}));

let projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'lead' }];
let user: { username: string; name: string } | null = { username: 'dee.lead', name: 'Dee' };
vi.mock('./auth', () => ({ useAuth: () => ({ user, projects }) }));

interface Row { id: number; kind: string; body: string; orderId: number | null; createdAt: string; readAt: string | null }

/** What the server will answer with on the next poll. */
let rows: Row[] = [];
const posted: { url: string; body: unknown }[] = [];

const row = (id: number, over: Partial<Row> = {}): Row => ({
    id,
    kind: 'work.unclaimed',
    body: `Nobody can take delivery ${id}.`,
    orderId: id,
    createdAt: new Date(2026, 10, 19, 7, id).toISOString(),
    readAt: null,
    ...over,
});

function stubFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            posted.push({ url, body: JSON.parse(String(init.body)) });
            return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(
            JSON.stringify({
                unread: rows.filter((r) => r.readAt === null).length,
                notifications: rows.map((r) => ({ ...r, pushedAt: null, dispatchResult: '' })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
    }));
}

/** A window onto the context, so a test can read the count and press things. */
function Probe() {
    const { notices, unread, markRead, markAllRead } = useNotices();
    return (
        <div>
            <span data-testid="unread">{unread}</span>
            <span data-testid="count">{notices.length}</span>
            <button type="button" onClick={() => { void markRead([notices[0]!.id]); }}>one</button>
            <button type="button" onClick={() => { void markAllRead(); }}>all</button>
        </div>
    );
}

const mount = () => render(
    <MemoryRouter><NoticesProvider><Probe /></NoticesProvider></MemoryRouter>,
);

const hidden = (is: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, value: is });

beforeEach(() => {
    shown.mockClear();
    posted.length = 0;
    rows = [];
    permission = 'granted';
    user = { username: 'dee.lead', name: 'Dee' };
    projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'lead' }];
    window.localStorage.clear();
    hidden(false);
    stubFetch();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('the first load of the day', () => {
    it('shows everything in the bell and announces none of it', async () => {
        /* Seven o'clock, overnight backlog. See the header: this is the one
           that decides whether the feature survives its first week. */
        rows = [row(1), row(2), row(3), row(4)];
        mount();

        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('4'));
        expect(screen.getByTestId('count')).toHaveTextContent('4');
        expect(shown).not.toHaveBeenCalled();
    });

    it('announces what arrives afterwards, and only that', async () => {
        rows = [row(1), row(2)];
        mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));

        rows = [row(1), row(2), row(3)];
        await act(async () => {
            /* Coming back to the tab is a look out of turn, which is also
               the cheapest way to make the poll run in a test. */
            hidden(false);
            document.dispatchEvent(new Event('visibilitychange'));
        });

        await waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
        expect(shown.mock.calls[0]![0]).toMatchObject({ id: 3, body: 'Nobody can take delivery 3.' });
    });

    it('does not announce the same row twice, however often it is polled', async () => {
        rows = [row(1)];
        mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));

        rows = [row(1), row(2)];
        for (let i = 0; i < 3; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        }
        await waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
    });

    it('stays quiet about a row somebody already dealt with in another tab', async () => {
        rows = [row(1)];
        mount();
        await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

        /* Read elsewhere before this tab ever saw it. A banner for something
           already handled is the fastest way to teach somebody that the
           banners are not worth reading. */
        rows = [row(1), row(2, { readAt: new Date().toISOString() })];
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

        await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
        expect(shown).not.toHaveBeenCalled();
    });

    it('is silent again after a reload, because the line is on the machine', async () => {
        rows = [row(1), row(2)];
        const first = mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
        first.unmount();

        /* Same rows, same browser, a refresh. Without the stored line this
           re-announces the whole list every time somebody hits F5. */
        mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
        expect(shown).not.toHaveBeenCalled();
    });

    it('never calls the desktop layer at all when permission was not given', async () => {
        permission = 'default';
        rows = [row(1)];
        mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));

        rows = [row(1), row(2)];
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
        expect(shown).not.toHaveBeenCalled();
    });
});

describe('polling', () => {
    it('keeps looking while the tab is hidden, which is the whole point', async () => {
        /* useLive stops when hidden and is right to; this must not. A bell
           that only updates while you are looking at it is a list. */
        vi.useFakeTimers({ shouldAdvanceTime: true });
        rows = [row(1)];
        mount();
        await vi.waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

        hidden(true);
        rows = [row(1), row(2)];
        /* The hidden cadence is 75 seconds. */
        await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });

        await vi.waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
        expect(shown).toHaveBeenCalledTimes(1);
    });
});

describe('marking things read', () => {
    it('sends the ids to the contract they belong to', async () => {
        rows = [row(1), row(2)];
        mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));

        await act(async () => { screen.getByText('one').click(); });
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]!.url).toBe('/api/projects/uh/uh/notifications/read');
        /* The ids are per project. Sending one contract's ids to another
           marks nothing and says it worked. */
        expect(posted[0]!.body).toEqual({ ids: [2] });
        expect(screen.getByTestId('unread')).toHaveTextContent('1');
    });

    it('empties the count straight away rather than waiting for the server', async () => {
        rows = [row(1), row(2), row(3)];
        mount();
        await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));

        await act(async () => { screen.getByText('all').click(); });
        expect(screen.getByTestId('unread')).toHaveTextContent('0');
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]!.body).toEqual({ ids: [] });
    });
});

describe('where a notification takes you', () => {
    it('goes to the delivery when it names one', () => {
        expect(hrefFor({ project: 'uh', orderId: 4312 })).toBe('/projects/uh/orders/4312');
    });

    it('goes to the contract when it does not, which is where the drop box is', () => {
        /* `list.dropped` carries no order. Landing on the contract's own
           page puts the reader on the drop box, which is the thing the
           notification is about. */
        expect(hrefFor({ project: 'uh', orderId: null })).toBe('/projects/uh');
    });
});

describe('signed out', () => {
    it('asks the server nothing', async () => {
        user = null;
        projects = [];
        mount();
        await new Promise((r) => { setTimeout(r, 20); });
        expect(fetch).not.toHaveBeenCalled();
    });
});
