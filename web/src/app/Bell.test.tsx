/* The bell, and the two faults a browser found that this file cannot.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BOTH FAULTS PASSED THE TYPE CHECKER AND READ CORRECTLY, AND BOTH WERE
 * FOUND BY OPENING THE THING IN A BROWSER.
 *
 * ONE: THE PANEL DID NOT OPEN AT ALL. The toggle was written as
 *
 *     setOpen((was) => { if (!was) refresh(); return !was; });
 *
 * which looks like one tidy statement and is not: a state updater must be
 * pure, and refresh() sets state on the provider above. aria-expanded
 * stayed "false" through every click of a real browser.
 *
 * READ THIS BEFORE TRUSTING THE TEST BELOW. "opens, and STAYS open" DOES
 * NOT REPRODUCE THAT FAULT. It was checked the only way such a claim can
 * be: the broken toggle was put back and the suite run again, under
 * StrictMode, and all ten tests passed. jsdom and React's test build
 * between them tolerate an impure updater that a browser will not.
 *
 * The test is kept because what it does assert is worth asserting -- the
 * panel opens, and is still open after the refresh it fires has come back
 * and re-rendered the provider above it -- and this note is kept because a
 * green test that silently covers nothing is worse than no test at all. If
 * that fault returns it will show up in somebody's browser, not here.
 *
 * TWO: THE ACTIVITY TAB STATED THE OPPOSITE OF THE TRUTH FOR FIFTEEN
 * SECONDS. useLive starts an interval and fetches on nothing but a
 * visibilitychange -- correct for the screens it was built for, which mount
 * with data the page around them already loaded. This one mounts empty
 * every time the tab is pressed, so it said "Nothing in the last twelve
 * hours" over an API response holding six events, and then filled itself
 * in. That one IS reproduced below, and it is the more dangerous of the
 * two: a dispatcher who reads "nothing happening" and goes back to what
 * they were doing has been told something false by a screen whose whole job
 * is telling them things.
 */

import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Bell } from './Bell';
import { NoticesProvider } from './useNotices';

vi.mock('../lib/desktop', () => ({
    showDesktop: async () => true,
    desktopState: () => 'default',
    askForDesktop: async () => 'granted',
}));

vi.mock('./auth', () => ({
    useAuth: () => ({
        user: { username: 'dee.lead', name: 'Dee' },
        projects: [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'lead' }],
    }),
}));

const NOTICES = [{
    id: 9, kind: 'work.unclaimed', body: 'Nobody can take delivery 4312, a STAT due in 18 minutes.',
    orderId: 4312, createdAt: new Date().toISOString(), readAt: null, pushedAt: null, dispatchResult: '',
}];

const FEED = [{
    id: 'e1', at: new Date().toISOString(), what: 'delivered', pharmacy: 'Medical Arts Pharmacy',
    orderId: 4312, reference: 'MA-7781', who: 'Rehearsal Driver', by: '',
}];

let activityCalls = 0;
let activityStatus = 200;

beforeEach(() => {
    activityCalls = 0;
    activityStatus = 200;
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).includes('/activity')) {
            activityCalls += 1;
            if (activityStatus !== 200) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: activityStatus, headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ activity: FEED, newCount: 1, latest: FEED[0].at, scope: 'all' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ unread: 1, notifications: NOTICES }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    }));
});

afterEach(() => { vi.unstubAllGlobals(); });

/* THROUGH A ROUTE WITH :code ON IT, not just a MemoryRouter at that URL.
   The Activity tab reads the contract out of useParams, which is empty
   unless a matched route declares the segment -- so a bare MemoryRouter
   gives the component the same answer it gets on /devices, and every
   assertion about the feed quietly tests the "no contract here" branch
   instead. The real rail sits inside this route, which is how it works at
   all. */
/* AND INSIDE StrictMode, because main.tsx is. Without it React invokes a
   state updater once instead of twice, and the first fault above -- a
   refresh() called from inside the setOpen updater -- passes cleanly here
   while the panel refuses to open in every real browser. A regression test
   that cannot reproduce the regression is worse than no test, because it
   says the ground is covered. */
const mount = () => render(
    <StrictMode>
        <MemoryRouter initialEntries={['/projects/uh']}>
            <Routes>
                <Route path="/projects/:code" element={<NoticesProvider><Bell /></NoticesProvider>} />
            </Routes>
        </MemoryRouter>
    </StrictMode>,
);

const bell = () => screen.getByRole('button', { name: /Notifications/ });

describe('opening it', () => {
    it('says how many are unread in the name, not only in the red disc', async () => {
        /* The disc is aria-hidden. Without the count in the label this is an
           unlabelled button on every screen in the application. */
        mount();
        await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 1 unread'));
    });

    it('opens, and STAYS open', async () => {
        /* Fault one -- but see the header: this does NOT reproduce it.
           Asserted anyway, because the panel opening and surviving the
           refresh is the behaviour, however it came to be broken. */
        mount();
        await waitFor(() => expect(bell()).toHaveAccessibleName(/1 unread/));

        await act(async () => { fireEvent.click(bell()); });
        expect(bell()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();

        /* And still open a moment later, after the refresh it triggers has
           come back and re-rendered the provider above it. */
        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        expect(bell()).toHaveAttribute('aria-expanded', 'true');
    });

    it('shows the message, which is the only thing anybody came for', async () => {
        mount();
        await act(async () => { fireEvent.click(bell()); });
        expect(await screen.findByText(/Nobody can take delivery 4312/)).toBeInTheDocument();
    });

    it('closes on Escape and gives the focus back to the button', async () => {
        /* Dropping focus on the document means the next Tab starts from the
           top of the page, which on a screen with a rail is a dozen presses
           back to where somebody was. */
        mount();
        await act(async () => { fireEvent.click(bell()); });
        await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(document.activeElement).toBe(bell());
    });

    it('closes when somebody clicks away from it', async () => {
        mount();
        await act(async () => { fireEvent.click(bell()); });
        await act(async () => { fireEvent.mouseDown(document.body); });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});

describe('the activity tab', () => {
    it('is not asked for until somebody opens it', async () => {
        /* The whole reason the feed can exist at this volume. A panel
           nobody opened costs nothing. */
        mount();
        await waitFor(() => expect(bell()).toHaveAccessibleName(/1 unread/));
        await act(async () => { fireEvent.click(bell()); });
        expect(activityCalls).toBe(0);
    });

    it('fills as soon as it is opened, rather than fifteen seconds later', async () => {
        /* Fault two, and this one does reproduce: revert the mount effect
           in Bell.tsx and this fails. */
        mount();
        await act(async () => { fireEvent.click(bell()); });
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Activity' })); });

        expect(await screen.findByText(/Rehearsal Driver/)).toBeInTheDocument();
        expect(screen.getByText(/Medical Arts Pharmacy/)).toBeInTheDocument();
        expect(activityCalls).toBeGreaterThan(0);
    });

    it('never says "nothing happening" before it has asked', async () => {
        /* The dangerous half of fault two: not that it was slow, but that
           what it said while it waited was false. */
        mount();
        await act(async () => { fireEvent.click(bell()); });
        fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
        expect(screen.queryByText(/Nothing in the last twelve hours/)).not.toBeInTheDocument();
    });

    it('tells a courier or a pharmacist it is not theirs, rather than that it broke', async () => {
        /* A 403 here is an answer, not a failure. "Could not load" sends
           somebody who was never going to have a feed to support. */
        activityStatus = 403;
        mount();
        await act(async () => { fireEvent.click(bell()); });
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Activity' })); });

        expect(await screen.findByText(/The activity feed is for dispatch/)).toBeInTheDocument();
        expect(screen.queryByText(/Could not reach/)).not.toBeInTheDocument();
    });
});

describe('the desktop line', () => {
    it('offers the switch when nobody has been asked yet', async () => {
        mount();
        await act(async () => { fireEvent.click(bell()); });
        expect(screen.getByText('Also show these on this computer')).toBeInTheDocument();
    });
});
