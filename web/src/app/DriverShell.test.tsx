/* The shell a courier gets in the browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS PROTECTING.
 *
 * Every University Health driver works in the browser for the first month
 * and only then moves to the phone app, and on a phone the side rail was
 * taking the top third of the screen before a single stop appeared. So a
 * courier gets the app's shell instead: a top bar, the screen, and the same
 * three tabs the app has, in the same order, with the same words.
 *
 * TWO FAILURES ARE WORTH A TEST EACH, and they fail in opposite directions.
 *
 * Giving the tab bar to the wrong account is the worse one. An Izy
 * administrator is enrolled in every project at boot; reduced to Today,
 * History and You they would lose the board, the roster, the planner, the
 * audit log and the user directory, with no rail left to reach them by. So
 * the admin case is asserted as hard as the courier case.
 *
 * And the tab bar not reaching what it claims to. Three labels, three URLs
 * a courier is actually allowed to open — see the allow-list in App.tsx. A
 * tab pointing at a guarded route would bounce them straight back to their
 * run, which looks exactly like a tab that does nothing.
 *
 * The bars are hidden above 900px by CSS rather than by a branch, so these
 * assertions are about the document and not about what is on screen at any
 * particular width. jsdom has no layout; a media query cannot be tested
 * here and is verified in a browser.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { App } from './App';
import { mockFetch } from '../test/setup';

const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };
const admin = { id: 1, username: 'admin', name: 'Izy Admin', role: 'admin', route: null };

const asCourier = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const asAdmin = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];

const mine = {
    serviceDate: '2026-10-31', timezone: 'America/Chicago', courierUsername: 'ada.courier',
    runs: [], dispatch: { phone: '', name: '' }, directions: { embed: false },
};

function renderAt(path: string, who: unknown, projects: unknown) {
    mockFetch({
        'GET /api/session': who,
        'GET /api/me/projects': projects,
        'GET /api/projects/uh/uh/runs/mine': mine,
        'GET /api/projects/uh/uh/shifts/mine': { shift: null, carrying: [] },
        'GET /api/login/device': { enrolled: false },
        'GET /api/projects/uh/uh/sites': [],
        'GET /api/projects/uh/uh/orders': { rows: [], total: 0 },
    });
    render(
        <MemoryRouter initialEntries={[path]}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
}

/**
 * The top bar, scoped by its class.
 *
 * Both bars and the rail are in the document at every width — which one you
 * see is a media query, and jsdom has no layout — so the rail's copy of the
 * contract name and the tab bar's own "Today" are present here too. A test
 * about what is IN the top bar therefore has to say so.
 */
const topBar = () => within(document.querySelector('.izy-courier-top') as HTMLElement);

/* Today, History, You — the app's three, in the app's order. The hrefs are
   the three a courier may open. */
const TABS: ReadonlyArray<[string, string]> = [
    ['Today', '/projects/uh/my-run'],
    ['History', '/projects/uh/my-deliveries'],
    ['You', '/devices'],
];

describe('a courier on a phone', () => {
    it('gets the app\'s three tabs, pointing where they say', async () => {
        renderAt('/projects/uh/my-run', session, asCourier);
        const tabs = await screen.findByRole('navigation', { name: 'Your work' });
        for (const [label, href] of TABS) {
            expect(within(tabs).getByRole('link', { name: label })).toHaveAttribute('href', href);
        }
        /* Three, and not a fourth somebody added without shortening the
           labels: they share a 375px phone and the longest already sits at
           14px to fit. See the note in styles.css. */
        expect(within(tabs).getAllByRole('link')).toHaveLength(3);
    });

    it('can still sign out, which the rail used to be the only way to do', async () => {
        /* The rail is hidden on a phone, and it held the only Sign out on
           every screen. Losing it on a shared phone at a counter is how one
           driver's session records another driver's deliveries. */
        renderAt('/projects/uh/my-run', session, asCourier);
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBeGreaterThan(0);
    });

    it('is told which contract they are on, where a back control would be pointless', async () => {
        /* On a tab root, "back" points at the screen you are already on,
           and a dead control teaches people to stop trusting the others.
           The contract's name goes there instead — a driver on two of them
           has to be able to tell, and an empty corner reads as a missing
           button. */
        renderAt('/projects/uh/my-run', session, asCourier);
        await screen.findByRole('heading', { name: 'Today' });
        expect(topBar().getByText('UH Pharmacy Courier')).toBeInTheDocument();
        expect(topBar().queryByRole('link', { name: 'Today' })).toBeNull();
    });

    it('is given a way back to the run from a screen that is not a tab', async () => {
        renderAt('/projects/uh/orders/21', session, asCourier);
        await waitFor(() => expect(document.querySelector('.izy-courier-top')).not.toBeNull());
        const back = topBar().getByRole('link', { name: 'Today' });
        expect(back).toHaveAttribute('href', '/projects/uh/my-run');
    });
});

describe('everybody else', () => {
    it('keeps the console, and never sees a tab bar', async () => {
        /* The failure that matters most here. An administrator is enrolled
           in every project at boot; three tabs would take the board, the
           roster, the audit log and the user directory away from the person
           who administers them. */
        renderAt('/', admin, asAdmin);
        await waitFor(() => {
            expect(screen.queryByRole('navigation', { name: 'Your work' })).toBeNull();
        });
        expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    });
});
