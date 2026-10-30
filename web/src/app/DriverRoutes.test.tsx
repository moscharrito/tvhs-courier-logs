/* What a driver may reach in the browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS.
 *
 * Every University Health driver works in the BROWSER for the first month
 * and only then moves to the phone, so the browser has to offer a driver
 * exactly what the app does -- no more. It did not.
 *
 * A courier signed in on the web could open the dispatch screens, either by
 * typing the path or by following "Back to orders" from their own delivery.
 * What they got was an operations console: a Pharmacy filter naming all
 * nine University Health counters, a Courier box inviting them to look
 * somebody else up, Export to Excel, and the contract's on-time figures.
 *
 * NO PATIENT DATA LEAKED, which is worth being precise about because it
 * decides what the fix is. The server scopes a courier in three places and
 * all three held: the order list ANDs `assigned_to_username = me` on last,
 * so no query parameter reaches past it; a single order 403s when it is not
 * theirs; pricing is withheld. The board, roster, reports and invoices
 * refuse a courier outright. What leaked was the SHAPE of the operation,
 * and what was offered was a screen nobody should be handed mid-round.
 *
 * The board was worse than a wrong screen: it mounted, asked, got 403, and
 * asked again, forever. A driver who tapped it got a spinner that never
 * resolved and a request every few seconds.
 *
 * This is an ALLOW-LIST, tested as one. A route added later is closed to
 * couriers until somebody decides otherwise, which is the right way round
 * for a screen that might carry another person's prescription.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { App } from './App';
import { mockFetch } from '../test/setup';

const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };
const asCourier = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const asLead = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'lead' }];

const mine = {
    serviceDate: '2026-10-30', timezone: 'America/Chicago', courierUsername: 'ada.courier',
    runs: [], dispatch: { phone: '', name: '' }, directions: { embed: false },
};

function renderAt(path: string, projects: unknown) {
    const mock = mockFetch({
        'GET /api/session': session,
        'GET /api/me/projects': projects,
        'GET /api/projects/uh/uh/runs/mine': mine,
        'GET /api/login/device': { enrolled: false },
        /* Deliberately present and deliberately never expected: a test that
           passes only because the endpoint is missing would pass for the
           wrong reason. */
        'GET /api/projects/uh/uh/board': { couriers: [], lanes: [], unassigned: [] },
        'GET /api/projects/uh/uh/orders': { rows: [], total: 0 },
        'GET /api/projects/uh/uh/sites': [],
    });
    render(
        <MemoryRouter initialEntries={[path]}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mock;
}

/* Every project route a driver has no business on. Pharmacy pages are in
   here too: a courier reaching one got the same 403 loop as the board. */
const CLOSED = [
    '/projects/uh/board',
    '/projects/uh/orders',
    '/projects/uh/roster',
    '/projects/uh/drivers',
    '/projects/uh/reports',
    '/projects/uh/invoices',
    '/projects/uh/deliveries',
    '/projects/uh/performance',
    '/projects/uh/send-list',
    '/projects/uh/pharmacy-logins',
];

describe('a driver on the web', () => {
    it.each(CLOSED)('is sent back to their run from %s', async (path) => {
        renderAt(path, asCourier);
        expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    });

    it('never asks the server for a screen it was redirected away from', async () => {
        /* The board did not merely render: it polled. Proving the redirect
           without proving the request stopped would leave the 403 storm in
           place behind a screen nobody sees. */
        const { calls } = renderAt('/projects/uh/board', asCourier);
        await screen.findByRole('heading', { name: 'Today' });
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(calls.some((c) => c.includes('/uh/board'))).toBe(false);
    });

    it('keeps the screens a driver does need', async () => {
        renderAt('/projects/uh/my-run', asCourier);
        expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    });

    /* ONE SCREEN IS DELIBERATELY NOT GUARDED. Applications checks the role
       itself and answers with a sentence about somebody's licence and
       background check, which is a better answer than a redirect. It is the
       only one that gives it; the rest render a console or hang on a 403. */
    it('is told why, not bounced, from the one screen that explains itself', async () => {
        renderAt('/projects/uh/applications', asCourier);
        expect(await screen.findByText('Not yours to see')).toBeInTheDocument();
    });

    /* The guard is about the role, not about the person. A site manager has
       to keep every one of these. */
    it('does not take the same screens away from a site lead', async () => {
        renderAt('/projects/uh/board', asLead);
        await waitFor(() => {
            expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument();
        });
    });
});
