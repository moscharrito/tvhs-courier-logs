/* Which pharmacy each driver works from.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS WORTH TESTING HERE.
 *
 * The question this page answers is "is every counter covered" before
 * 1 November, not "can I edit a field". So the cases that matter are the
 * ones where a tidy-looking screen hides the answer: a pharmacy with nobody
 * driving from it, drivers with no home set, and an address missing from
 * somebody who will have to reset their own password.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Roster } from './Roster';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];
const session = { id: 9, username: 'dispatch', name: 'Dispatcher One', role: 'staff', route: null };

/* The counters as University Health supplied them, shortened to the three
   the cases below actually need. */
const sites = [
    { id: 1, code: 'green', name: 'Robert B. Green' },
    { id: 2, code: 'southeast', name: 'Southeast' },
    { id: 3, code: 'vida', name: 'Vida' },
];

const driver = (over = {}) => ({
    username: 'dana.whitfield', name: 'Dana Whitfield', email: 'dana.whitfield@example.com',
    status: 'active', role: 'courier', homeSiteId: 1,
    homeSiteCode: 'green', homeSiteName: 'Robert B. Green', onShift: false, ...over,
});

type Driver = ReturnType<typeof driver>;

const rosterData = (over: { drivers?: Driver[] } = {}) => {
    const drivers = over.drivers ?? [driver()];
    return {
        drivers,
        sites,
        counts: sites.map((s) => ({ siteId: s.id, drivers: drivers.filter((d) => d.homeSiteId === s.id).length })),
        unassigned: drivers.filter((d) => d.homeSiteId === null).length,
        ...over,
    };
};

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/roster': rosterData(),
    ...over,
});

function renderRoster(r = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/roster']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/roster" element={<Roster />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

afterEach(() => { vi.useRealTimers(); });

describe('the driver roster', () => {
    it('groups drivers under the pharmacy they work from', async () => {
        renderRoster();
        const group = await screen.findByRole('region', { name: 'Robert B. Green' });
        expect(within(group).getByText('Dana Whitfield')).toBeInTheDocument();
    });

    it('SAYS WHEN A PHARMACY HAS NOBODY, which is what the page is read for', async () => {
        /* An empty counter is the answer somebody opened this page to find.
           A zero in a corner is not an answer; it is a number to notice. */
        renderRoster();
        const southeast = await screen.findByRole('region', { name: 'Southeast' });
        expect(within(southeast).getByText('Nobody drives from here.')).toBeInTheDocument();
    });

    it('puts the drivers with no home pharmacy first', async () => {
        /* The only group that is work to do. An empty one means the page is
           finished with. */
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({
                drivers: [
                    driver(),
                    driver({ username: 'owen.c', name: 'Owen Castellanos', homeSiteId: null, homeSiteCode: null, homeSiteName: null }),
                ],
            }),
        }));
        const groups = await screen.findAllByRole('region');
        const first = groups[0]!;
        expect(first).toHaveAccessibleName('No home pharmacy yet');
        expect(within(first).getByText('Owen Castellanos')).toBeInTheDocument();
    });

    it('does not show an unassigned group when there is nobody in it', async () => {
        renderRoster();
        await screen.findByRole('region', { name: 'Robert B. Green' });
        expect(screen.queryByRole('region', { name: 'No home pharmacy yet' })).not.toBeInTheDocument();
        expect(screen.getByText(/every one has a home pharmacy/)).toBeInTheDocument();
    });

    it('counts the drivers with no home pharmacy at the top', async () => {
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({
                drivers: [
                    driver({ homeSiteId: null, homeSiteCode: null, homeSiteName: null }),
                    driver({ username: 'heldon.h', name: 'Heldon Holness', homeSiteId: null, homeSiteCode: null, homeSiteName: null }),
                ],
            }),
        }));
        expect(await screen.findByText(/with no home pharmacy/)).toBeInTheDocument();
    });

    it('flags a driver with no email address', async () => {
        /* A driver with no address cannot reset their own password, and this
           is a list of drivers in front of the person who can fix it. */
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({
                drivers: [driver({ email: '' })],
            }),
        }));
        expect(await screen.findByText('no email address')).toBeInTheDocument();
    });

    it('saves a change on its own, with no Save button to forget', async () => {
        /* Twenty-three dropdowns behind one Save is a form somebody
           half-fills and gets called away from. */
        const { calls } = renderRoster(routes({
            'PUT /api/projects/uh/uh/roster/dana.whitfield': { ok: true, username: 'dana.whitfield', homeSiteId: 2 },
        }));
        fireEvent.change(await screen.findByLabelText('Home pharmacy for Dana Whitfield'), { target: { value: '2' } });

        await waitFor(() => expect(calls).toContain('PUT /api/projects/uh/uh/roster/dana.whitfield'));
        expect(await screen.findByRole('status')).toHaveTextContent('Dana Whitfield → Southeast');
    });

    it('says what went wrong rather than leaving a value the server refused', async () => {
        const { calls } = renderRoster(routes({
            'PUT /api/projects/uh/uh/roster/dana.whitfield': { status: 409, body: { error: 'dana.whitfield is on this project as pharmacy, not as a driver.' } },
        }));
        fireEvent.change(await screen.findByLabelText('Home pharmacy for Dana Whitfield'), { target: { value: '2' } });

        expect(await screen.findByRole('status')).toHaveTextContent(/not as a driver/);
        /* And it reloads, so the select shows what is really stored rather
           than the value that was rejected. */
        expect(calls.filter((c) => c === 'GET /api/projects/uh/uh/roster').length).toBeGreaterThan(1);
    });

    it('offers no home pharmacy as a real choice, not an empty one', async () => {
        /* Clearing an assignment is a thing somebody means to do, and a
           blank first option reads as "not filled in yet". */
        renderRoster();
        const select = await screen.findByLabelText('Home pharmacy for Dana Whitfield');
        expect(within(select).getByRole('option', { name: 'No home pharmacy' })).toBeInTheDocument();
    });

    it('points somewhere useful when nobody is a driver yet', async () => {
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [] }),
        }));
        expect(await screen.findByText(/Nobody on this project is a driver yet/)).toBeInTheDocument();
    });

    it('pages a pharmacy with more drivers than fit, and folds each counter', async () => {
        /* Robert B. Green has eight today and the contract grows. Each
           counter gets its OWN page state -- turning to page two at one
           pharmacy must not move another -- which is why the group is its
           own component rather than a hook inside the map. */
        const many = Array.from({ length: 11 }, (_, i) => driver({
            username: `d${i}`, name: `Driver Number ${i}`, homeSiteId: 1,
            homeSiteCode: 'green', homeSiteName: 'Robert B. Green',
        }));
        renderRoster(routes({ 'GET /api/projects/uh/uh/roster': rosterData({ drivers: many }) }));
        await screen.findByRole('heading', { name: 'Driver roster' });

        /* Eight of eleven, and the pager says so. */
        expect(screen.getByText('Driver Number 0')).toBeInTheDocument();
        expect(screen.queryByText('Driver Number 10')).not.toBeInTheDocument();

        /* And the group folds, which is what makes nine counters readable
           on a phone. */
        const toggle = screen.getByRole('button', { name: /Robert B. Green/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        fireEvent.click(toggle);
        expect(screen.queryByText('Driver Number 0')).not.toBeInTheDocument();
    });

    it('says a home pharmacy is a default and not a restriction', async () => {
        /* Cover is the normal case on a contract where somebody rings in
           sick, and a screen that read as a lock would stop a dispatcher
           doing the obvious thing. */
        renderRoster();
        expect(await screen.findByText(/default and not a restriction/)).toBeInTheDocument();
    });
});
