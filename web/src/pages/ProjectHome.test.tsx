/* Who gets which panel on the project landing page.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS PINS IS A BUTTON THE SERVER REFUSES.
 *
 * The flags here are the only thing deciding what a role is offered, and
 * they are one boolean each. Widening one by habit draws somebody a form
 * that 403s when they press it, which reads as a broken product rather than
 * as a permission they do not have -- and narrowing one silently removes a
 * screen somebody does their job from.
 *
 * So each row below is paired with the server's own rule, named in the
 * comment, and access-matrix.test.mjs is where that rule actually lives.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProjectHome } from './ProjectHome';
import { AuthProvider } from '../app/auth';
import { mockFetch } from '../test/setup';

const session = { id: 1, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null };

const project = (role: string) => [{
    id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role,
}];

/* The children all fetch on mount. None of them is what these tests are
   about, so they answer empty and stay quiet. */
const settings = {
    sla: { clockStart: 'receipt', scheduledMinutes: 120, statMinutes: 120, statFromPickupMinutes: 60, adhocMinutes: 240 },
    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
    listRelease: { earliest: '12:00', latest: '14:00' },
    pricing: { afterHoursStart: '20:00', afterHoursEnd: '07:00', dryRunReplacesBase: true },
    dispatch: { phone: '', name: 'Dispatch' },
};

const routes = (role: string) => ({
    'GET /api/session': session,
    'GET /api/me/projects': project(role),
    'GET /api/projects/uh/uh/sites': [],
    'GET /api/projects/uh/uh/imports': [],
    'GET /api/projects/uh/uh/orders*': { orders: [], total: 0 },
    'GET /api/projects/uh/settings': {
        timezone: 'America/Chicago', settings, defaults: settings,
        overridden: [], canManage: role === 'admin', example: [],
    },
    'GET /api/projects/uh/uh/pricing*': { zones: [], zipRates: [] },
});

function renderAs(role: string, over: Record<string, unknown> = {}) {
    mockFetch({ ...routes(role), ...over });
    render(
        <MemoryRouter initialEntries={['/projects/uh']}>
            <AuthProvider>
                <Routes>
                    <Route path="/projects/:code" element={<ProjectHome />} />
                    {/* ── THE TWO PLACES THIS PAGE SENDS PEOPLE.

                        Added 23 November 2026. Without them a redirect lands
                        on nothing, so there is no moment a test can wait for
                        and the only thing left to assert is an ABSENCE -- and
                        an absence is true of every role before the page has
                        decided anything. See the two tests at the bottom of
                        this file for what that cost. */}
                    <Route path="/projects/:code/my-run" element={<p>the driver run</p>} />
                    <Route path="/projects/:code/deliveries" element={<p>the client portal</p>} />
                </Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('the site manager, who is dispatch', () => {
    it('is offered the daily list, because taking it in is the job', async () => {
        /* imports.ts lets `lead` call POST /imports since 7 November. A
           dispatcher who cannot take a list in cannot dispatch, and the
           lists arrive by email for them to upload. */
        renderAs('lead');
        expect(await screen.findByRole('heading', { name: /daily list/i })).toBeInTheDocument();
    });

    it('is offered the manual order form, because a STAT by phone is dispatch', async () => {
        /* POST /orders takes `lead` since 7 November. Which counter they may
           take one FOR is leadMaySee inside the handler, not this flag. */
        renderAs('lead');
        expect(await screen.findByRole('heading', { name: /STAT or ad hoc order/i })).toBeInTheDocument();
    });

    it('may remove an order it mistyped, so a wrong STAT does not sit there', async () => {
        /* DELETE /orders/:id takes `lead` since 7 November, scoped by
           loadOr404 to their own counters. The flag here has to agree with
           that guard or the screen draws a button the server refuses.
        
           The list has to come back with a row in it or there is no Delete
           to look for, and the test passes on an empty table -- which is
           what the first version of it did. */
        renderAs('lead', {
            'GET /api/projects/uh/uh/orders*': {
                orders: [{
                    id: 41, externalRef: 'RX-9001', serviceType: 'stat', siteId: 7,
                    recipientName: 'Ines Vargas', address: '1200 Encanto Street', zip: '78215',
                    status: 'ready', assignedTo: null, dueAt: null,
                }],
                total: 1,
            },
        });
        fireEvent.click(await screen.findByRole('button', { name: /STAT or ad hoc order/i }));
        fireEvent.click(await screen.findByRole('button', { name: 'Find orders' }));

        expect(await screen.findByRole('button', { name: /Delete order 41/ })).toBeInTheDocument();
    });

    it('gets the row it actually works from, and nothing else', async () => {
        /* Set on 7 November at the owner's direction. Discrepancies,
           Returns and the client's view are client-facing screens -- read
           when answering a question about the contract, not while running a
           day -- so they came off the row of the person running the day.

           PERFORMANCE CAME BACK ON 18 NOVEMBER, same direction, reversed
           with eleven days of the contract actually running behind it: the
           people answering questions about how it is going turned out to be
           the people on the desk. Neither move was an access change. The
           endpoint has admitted a lead throughout and the page has always
           loaded at its own URL; only the shortcut moved. */
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });

        for (const name of ['Open the board', 'Search orders', 'Driver roster', 'Performance', 'Sort packages']) {
            expect(screen.getByRole('link', { name }), name).toBeInTheDocument();
        }
        /* Drivers record came off on 18 November, same direction and same
           reasoning. Note what stays: the ROSTER does, because it is read
           before a wave to see which pharmacy each driver works from, and
           that is what lets the board offer a proposed run to somebody who
           drives that counter. The record is a report of what they did. */
        for (const name of ['Discrepancies', 'Returns', "The client's view", 'Drivers record']) {
            expect(screen.queryByRole('link', { name }), name).toBeNull();
        }
    });

    it('can reach the sort bench, which it could not when it shipped', async () => {
        /* IT WENT OUT INVISIBLE. The Sort page was wired to the pharmacy
           rail only -- the one rail an administrator or a dispatcher never
           sees -- so the page existed, the route worked, the server
           admitted them, and nobody running dispatch could find it.

           Pinned as an href rather than as "a link exists", because the
           failure was not a missing component. It was a link in a place
           the people who need it do not look. */
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });
        expect(screen.getByRole('link', { name: 'Sort packages' }))
            .toHaveAttribute('href', '/projects/uh/sort');
    });

    it('is given the driver roster, which the server always allowed', async () => {
        /* GET and PUT on /roster are UH_DISPATCH -- lead plus admin -- and
           only this link was drawn tighter, so the person who plans the
           waves could not see which pharmacy each driver works from. */
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });
        expect(screen.getByRole('link', { name: 'Driver roster' }))
            .toHaveAttribute('href', '/projects/uh/roster');
    });

    it('is kept away from the commercials', async () => {
        /* The manager sees the operation and not what it bills at. */
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });
        /* Driver roster came OFF this list on 7 November: it is operational,
           not commercial -- which pharmacy each driver works from is what
           lets the board offer a proposed run to somebody who drives that
           counter -- and the server had always allowed it. */
        for (const name of ['Invoices', 'Driver applications']) {
            expect(screen.queryByRole('link', { name })).toBeNull();
        }
    });

});

describe('an administrator', () => {
    it('keeps every shortcut, including the four dispatch no longer gets', async () => {
        /* Narrowing dispatch's row must not narrow anybody else's: these
           pages did not move, only the shortcut to them. */
        renderAs('admin');
        await screen.findByRole('heading', { name: /daily list/i });
        for (const name of [
            'Open the board', 'Search orders', 'Performance', 'Discrepancies', 'Returns',
            'Drivers record', 'Driver roster', 'Invoices', 'Driver applications', "The client's view",
            'Sort packages',
        ]) {
            expect(screen.getByRole('link', { name }), name).toBeInTheDocument();
        }
    });
});

describe('everybody else', () => {
    /* ──────────── AN ABSENCE PROVES NOTHING UNTIL THE PAGE HAS DECIDED
     *
     * Both of these asserted that the daily list is not rendered. Neither
     * waited for anything that could only be true afterwards, and the panel
     * is absent for EVERY role until /api/me/projects answers -- so both
     * passed identically against a page that handed a courier or a pharmacy
     * the whole day of patient addresses. One used `await waitFor` around
     * the absence, which reads like a wait and is not one: waitFor calls its
     * callback immediately and resolves on the first pass.
     *
     * Found by sweeping the web suite on 23 November, after two gate runs
     * turned up two unrelated tests that were winning races rather than
     * waiting.
     *
     * THE REDIRECT IS THE BEHAVIOUR, so landing on the destination is the
     * positive fact to wait for. The absence then means something, because
     * by that point the page has decided and acted.
     */
    it('sends a courier to their own run and nowhere near the day\'s addresses', async () => {
        renderAs('courier');
        expect(await screen.findByText('the driver run')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /daily list/i })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Drivers record' })).toBeNull();
    });

    it('does not offer a pharmacy the landing page at all', async () => {
        renderAs('pharmacy');
        expect(await screen.findByText('the client portal')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /daily list/i })).toBeNull();
    });
});
