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
/* The dispatch membership. `lead` reaches this screen and reaches the shift
   switch on it, and reaches nothing that goes to /api/users. */
const leadProjects = [{ ...projects[0]!, role: 'lead' }];
const session = { id: 9, username: 'dispatch', name: 'Dispatcher One', role: 'staff', route: null };
/* The create/reset/remove controls go to /api/users, which is guarded by
   requireAdmin on the SESSION role -- not the project role. A dispatcher
   with project role 'admin' is still staff to that endpoint. */
const adminSession = { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null };

/* The counters as University Health supplied them, shortened to the three
   the cases below actually need. */
const sites = [
    { id: 1, code: 'green', name: 'Robert B. Green' },
    { id: 2, code: 'southeast', name: 'Southeast' },
    { id: 3, code: 'vida', name: 'Vida' },
];

const driver = (over = {}) => ({
    username: 'dana.whitfield', name: 'Dana Whitfield', email: 'dana.whitfield@example.com',
    phone: '(210) 555 0142',
    status: 'active', role: 'courier', homeSiteId: 1, alsoCovers: [] as number[],
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

function renderAsAdmin(over = {}) {
    return renderRoster(routes({ 'GET /api/session': adminSession, ...over }));
}

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

    /* ─────────────────────────────────────────────────────────────────
     * HOW TO REACH SOMEBODY (3 November 2026).
     *
     * The page said only WHETHER a driver had an address, which is the
     * right call on the dispatch board and the wrong one on the staff
     * list: the thing this page is open for at four in the afternoon is
     * reaching a driver, and "has an email address" cannot be acted on.
     * ───────────────────────────────────────────────────────────────── */

    it('gives the address as something to write to, not a fact about it', async () => {
        renderRoster();
        const to = await screen.findByRole('link', { name: 'dana.whitfield@example.com' });
        expect(to).toHaveAttribute('href', 'mailto:dana.whitfield@example.com');
    });

    it('gives the number as something to dial, with the punctuation left on', async () => {
        /* The handset wants digits and the reader wants it readable, so
           the href is stripped and the text is not. A dispatcher reading
           back a number down a radio needs the spaces. */
        renderRoster();
        const call = await screen.findByRole('link', { name: '(210) 555 0142' });
        expect(call).toHaveAttribute('href', 'tel:2105550142');
    });

    it('flags a driver with no phone number', async () => {
        /* Blank was indistinguishable from "nobody has looked", and this
           is the list in front of the person who can fill it in. */
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ phone: '' })] }),
        }));
        expect(await screen.findByText('no phone number')).toBeInTheDocument();
        expect(screen.getByText(/with no phone number/)).toBeInTheDocument();
    });

    it('records a number typed in place, without leaving the list', async () => {
        /* The moment to record forty-three numbers is while looking at the
           list of forty-three drivers. A field only reachable from an
           account page one driver at a time is a field that stays empty. */
        const { calls } = renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ phone: '' })] }),
            'PUT /api/projects/uh/uh/roster/dana.whitfield/contact': { ok: true, username: 'dana.whitfield', phone: '210 555 0199' },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Add a phone number for Dana Whitfield' }));
        fireEvent.change(screen.getByLabelText('Phone number for Dana Whitfield'), { target: { value: ' 210 555 0199 ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(calls).toContain('PUT /api/projects/uh/uh/roster/dana.whitfield/contact'));
        expect(await screen.findByRole('status')).toHaveTextContent('Dana Whitfield → 210 555 0199');
    });

    it('does not put forty-three text boxes on the page to tab through', async () => {
        /* A row is a link until somebody says they are editing it. One
           stray keystroke changing the wrong driver's number is the thing
           this avoids. */
        renderRoster();
        await screen.findByRole('heading', { name: 'Driver roster' });
        expect(screen.queryByLabelText('Phone number for Dana Whitfield')).not.toBeInTheDocument();
    });

    it('abandons an edit on Escape rather than saving what was half typed', async () => {
        const { calls } = renderRoster();
        fireEvent.click(await screen.findByRole('button', { name: 'Change the phone number for Dana Whitfield' }));
        const box = screen.getByLabelText('Phone number for Dana Whitfield');
        fireEvent.change(box, { target: { value: '210 555' } });
        fireEvent.keyDown(box, { key: 'Escape' });

        expect(screen.queryByLabelText('Phone number for Dana Whitfield')).not.toBeInTheDocument();
        expect(calls).not.toContain('PUT /api/projects/uh/uh/roster/dana.whitfield/contact');
        /* And the number that is really stored is back on screen. */
        expect(screen.getByRole('link', { name: '(210) 555 0142' })).toBeInTheDocument();
    });

    it('says what went wrong when a number is refused, and shows what is stored', async () => {
        const { calls } = renderRoster(routes({
            'PUT /api/projects/uh/uh/roster/dana.whitfield/contact': { status: 409, body: { error: 'dana.whitfield is on this project as pharmacy, not as a driver.' } },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Change the phone number for Dana Whitfield' }));
        fireEvent.keyDown(screen.getByLabelText('Phone number for Dana Whitfield'), { key: 'Enter' });

        expect(await screen.findByRole('status')).toHaveTextContent(/not as a driver/);
        expect(calls.filter((c) => c === 'GET /api/projects/uh/uh/roster').length).toBeGreaterThan(1);
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

describe('one driver, several pharmacies', () => {
    /* The board has always offered a stop to anybody whose homeSiteId OR
       alsoCovers matches the site -- see targetsFor() in Board.tsx. The
       roster screen simply never read the field, which is why "a driver
       can only work one pharmacy" was believed. It was never true of the
       system, only of this page. */

    it('offers every pharmacy except the one they are already homed at', async () => {
        renderRoster();
        await screen.findByText('Dana Whitfield');
        // Homed at Robert B. Green, so the other two are offerable.
        expect(screen.getByRole('checkbox', { name: 'Southeast' })).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Vida' })).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: 'Robert B. Green' })).not.toBeInTheDocument();
    });

    it('shows what they already cover', async () => {
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ alsoCovers: [3] })] }),
        }));
        await screen.findByText('Dana Whitfield');
        expect(screen.getByRole('checkbox', { name: 'Vida' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Southeast' })).not.toBeChecked();
    });

    it('sends the home pharmacy with the covers list', async () => {
        /* The endpoint validates alsoCovers against homeSiteId and drops
           the home site from it. Sending covers alone reads homeSiteId as
           absent, which would clear it. */
        const mocked = renderRoster();
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('checkbox', { name: 'Southeast' }));
        await waitFor(() => {
            const body = mocked.bodies['PUT /api/projects/uh/uh/roster/dana.whitfield'] as
                { homeSiteId: number; alsoCovers: number[] };
            expect(body).toBeTruthy();
            expect(body.alsoCovers).toEqual([2]);
            expect(body.homeSiteId, 'the home must travel with it').toBe(1);
        });
    });

    it('removes one without disturbing the others', async () => {
        const mocked = renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ alsoCovers: [2, 3] })] }),
        }));
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('checkbox', { name: 'Southeast' }));
        await waitFor(() => {
            const body = mocked.bodies['PUT /api/projects/uh/uh/roster/dana.whitfield'] as { alsoCovers: number[] };
            expect(body.alsoCovers).toEqual([3]);
        });
    });

    it('does not fall over when the field is missing entirely', async () => {
        /* A row without the field would throw on .includes() and take the
           whole page with it. Absent means "covers nowhere else". */
        const { alsoCovers: _gone, ...withoutField } = driver();
        renderRoster(routes({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [withoutField as Driver] }),
        }));
        expect(await screen.findByText('Dana Whitfield')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Southeast' })).not.toBeChecked();
    });
});

describe('what only an admin may do', () => {
    it('hides create, reset and remove from a dispatcher', async () => {
        renderRoster();
        await screen.findByText('Dana Whitfield');
        expect(screen.queryByRole('button', { name: 'New password' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Off the roster' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /Add a driver/ })).not.toBeInTheDocument();
    });

    it('shows them to an admin', async () => {
        renderAsAdmin();
        await screen.findByText('Dana Whitfield');
        expect(screen.getByRole('button', { name: 'New password' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Off the roster' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /Add a driver/ })).toBeInTheDocument();
    });

    it('still lets a dispatcher set the home pharmacy and the covers', async () => {
        /* The roster endpoints take any dispatcher. Only /api/users is
           admin-only, so hiding too much would be a regression. */
        renderRoster();
        await screen.findByText('Dana Whitfield');
        expect(screen.getByRole('combobox', { name: 'Home pharmacy for Dana Whitfield' })).toBeEnabled();
        expect(screen.getByRole('checkbox', { name: 'Southeast' })).toBeEnabled();
    });
});

describe('creating a driver', () => {
    it('writes the account and the courier membership, in that order', async () => {
        /* An account without the membership signs in to an empty run,
           which looks exactly like a quiet day. Both or it is not a
           driver. */
        const mocked = renderAsAdmin({
            'POST /api/users': { status: 201, body: { username: 'ada' } },
            'PUT /api/users/ada/memberships/uh': { ok: true },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: /Add a driver/ }));
        fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Ada Pay' } });
        fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: 'ada' } });
        fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.com' } });
        fireEvent.change(screen.getByLabelText(/^Home pharmacy$/), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create the driver' }));

        await waitFor(() => {
            expect(mocked.calls).toContain('POST /api/users');
            expect(mocked.calls).toContain('PUT /api/users/ada/memberships/uh');
        });
        const made = mocked.bodies['POST /api/users'] as { role: string; email: string; password: string };
        expect(made.role, 'the platform role that lets them hold a phone PIN').toBe('driver');
        expect(made.email).toBe('ada@example.com');
        expect(made.password, 'generated here, never typed').toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);

        const member = mocked.bodies['PUT /api/users/ada/memberships/uh'] as
            { role: string; settings: { homeSiteId?: number } };
        expect(member.role, 'courier is what gives them work').toBe('courier');
        expect(member.settings.homeSiteId).toBe(2);
    });

    it('shows the password once, and only after it worked', async () => {
        renderAsAdmin({
            'POST /api/users': { status: 201, body: { username: 'ada' } },
            'PUT /api/users/ada/memberships/uh': { ok: true },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: /Add a driver/ }));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Ada Pay' } });
        fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: 'ada' } });
        fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create the driver' }));

        const panel = await screen.findByRole('alert');
        expect(panel).toHaveTextContent(/signs in as/);
        expect(panel).toHaveTextContent(/Shown once/);
    });

    it('says nothing about a password when the create failed', async () => {
        /* A panel reading "Ada signs in with abcd-efgh-jkmn" over a 409 is
           a credential that does not exist, handed to somebody. */
        renderAsAdmin({
            'POST /api/users': { status: 409, body: { error: 'Username already exists' } },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: /Add a driver/ }));
        fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Ada Pay' } });
        fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: 'dana.whitfield' } });
        fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create the driver' }));

        await screen.findByText(/Username already exists/);
        expect(screen.queryByText(/Shown once/)).not.toBeInTheDocument();
    });
});

describe('resetting and removing', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('asks before signing somebody out, and does nothing if refused', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        const mocked = renderAsAdmin();
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'New password' }));
        await waitFor(() => {
            expect(mocked.calls.some((c) => c.includes('/password'))).toBe(false);
        });
    });

    it('warns that the reset signs them out mid-round', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        renderAsAdmin();
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'New password' }));
        expect(confirm.mock.calls[0]?.[0]).toMatch(/signed out of the app everywhere/);
    });

    it('sets a generated password and shows it once', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const mocked = renderAsAdmin({
            'POST /api/users/dana.whitfield/password': { ok: true, revokedSessions: 2 },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'New password' }));
        const panel = await screen.findByRole('alert');
        expect(panel).toHaveTextContent(/Dana Whitfield/);
        const sent = mocked.bodies['POST /api/users/dana.whitfield/password'] as { password: string };
        expect(sent.password).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    });

    it('removes the MEMBERSHIP, never the account', async () => {
        /* Deleting a signatory is what the append-only trigger on
           custody_events exists to prevent. Off the roster means they stop
           being offered work and keep every delivery they ever made. */
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const mocked = renderAsAdmin({
            'DELETE /api/users/dana.whitfield/memberships/uh': { ok: true },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Off the roster' }));
        await waitFor(() => {
            expect(mocked.calls).toContain('DELETE /api/users/dana.whitfield/memberships/uh');
        });
        expect(mocked.calls.some((c) => c.startsWith('DELETE /api/users/dana.whitfield') && !c.includes('memberships')))
            .toBe(false);
    });

    it('says their history survives, in the confirmation', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        renderAsAdmin();
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Off the roster' }));
        expect(confirm.mock.calls[0]?.[0]).toMatch(/past deliveries and their signatures all stay/);
    });
});

/* ── ON SHIFT AND OFF SHIFT, FROM THE ROSTER (10 November 2026) ────────────
 *
 * Being on shift decides who may be handed a delivery. Until now the only
 * account that could open one was the driver's own phone, so a flat battery
 * or a driver who pulled away from the counter without tapping was a driver
 * dispatch could not give work to. Ending somebody else's shift had been
 * possible since the file was written; starting one had not.
 */
describe('putting a driver on shift from here', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    const START = 'POST /api/projects/uh/uh/shifts/for/dana.whitfield/start';
    const END = 'POST /api/projects/uh/uh/shifts/for/dana.whitfield/end';

    it('offers to put an off-shift driver on, and says what it will do', async () => {
        /* THE LABEL IS THE ACTION, not the state. The state is already on
           the row as a pill, and a button labelled with the current state
           is the oldest way to make somebody click the opposite of what
           they meant. */
        renderAsAdmin();
        await screen.findByText('Dana Whitfield');
        expect(screen.getByRole('button', { name: 'Put on shift' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Take off shift' })).not.toBeInTheDocument();
    });

    it('offers the opposite to somebody already out there', async () => {
        renderAsAdmin({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ onShift: true })] }),
        });
        await screen.findByText('Dana Whitfield');
        expect(screen.getByRole('button', { name: 'Take off shift' })).toBeInTheDocument();
    });

    it('opens the shift without asking anything, because starting one needs no excuse', async () => {
        const mocked = renderAsAdmin({
            [START]: { status: 201, body: { id: 7, open: true, alreadyOn: false, courierUsername: 'dana.whitfield' } },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Put on shift' }));

        await waitFor(() => { expect(mocked.calls).toContain(START); });
        expect(await screen.findByRole('status')).toHaveTextContent(/is on shift and can be given work/);
    });

    it('relays the server’s refusal rather than inventing a success', async () => {
        /* The gate is NOT softer because an administrator is asking: a
           driver with no counter cannot be handed work, which is why the
           courier's own route refuses it too. The dispatcher is looking at
           the screen where that is fixed. */
        const mocked = renderAsAdmin({
            'GET /api/projects/uh/uh/roster': rosterData({
                drivers: [driver({ homeSiteId: null, homeSiteCode: null, homeSiteName: null })],
            }),
            [START]: {
                status: 409,
                body: { error: 'Dana Whitfield has no home pharmacy, so they cannot go on shift. Give them one on this screen first.', code: 'shift.noHomeSite' },
            },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Put on shift' }));

        await waitFor(() => { expect(mocked.calls).toContain(START); });
        expect(await screen.findByRole('status')).toHaveTextContent(/no home pharmacy/);
    });

    it('asks why before taking somebody off, and sends what was typed', async () => {
        vi.spyOn(window, 'prompt').mockReturnValue('Went home without tapping off; confirmed by telephone.');
        const mocked = renderAsAdmin({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ onShift: true })] }),
            [END]: { ok: true, carrying: 0 },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Take off shift' }));

        await waitFor(() => { expect(mocked.calls).toContain(END); });
        expect((mocked.bodies[END] as { reason: string }).reason)
            .toBe('Went home without tapping off; confirmed by telephone.');
    });

    it('changes nothing when the dispatcher backs out of the question', async () => {
        vi.spyOn(window, 'prompt').mockReturnValue(null);
        const mocked = renderAsAdmin({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ onShift: true })] }),
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Take off shift' }));

        await waitFor(() => { expect(mocked.calls.some((c) => c.includes('/shifts/'))).toBe(false); });
    });

    it('refuses a reason that is not one, without troubling the server', async () => {
        /* The server demands five characters. Catching it here means the
           dispatcher is told on the screen they are looking at rather than
           by a 400 relayed out of context. */
        vi.spyOn(window, 'prompt').mockReturnValue('  x  ');
        const mocked = renderAsAdmin({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ onShift: true })] }),
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Take off shift' }));

        expect(await screen.findByRole('status')).toHaveTextContent(/Say why in a few words/);
        expect(mocked.calls.some((c) => c.includes('/shifts/'))).toBe(false);
    });

    it('says what was still in the van when a loaded shift is ended', async () => {
        /* The server allows it -- a courier at a pharmacy that has shut
           cannot hand anything back -- and the person who just ended it is
           the person who should hear about the packages. */
        vi.spyOn(window, 'prompt').mockReturnValue('Pharmacy shut; packages stay in the van overnight.');
        renderAsAdmin({
            'GET /api/projects/uh/uh/roster': rosterData({ drivers: [driver({ onShift: true })] }),
            [END]: { ok: true, carrying: 3 },
        });
        await screen.findByText('Dana Whitfield');
        fireEvent.click(screen.getByRole('button', { name: 'Take off shift' }));

        expect(await screen.findByRole('status')).toHaveTextContent(/3 deliveries are still recorded as with them/);
    });

    it('IS offered to dispatch, who is the person it was built for', async () => {
        /* `lead` is the dispatch role on this contract: one person, all
           eight counters, the one actually at the board at noon. It shipped
           admin-only and was widened the next day, because a control for
           staffing the pool held by somebody who is not staffing the pool
           gets used by ringing somebody.

           Rendered with the ORDINARY session, not the administrator one, so
           this cannot pass on the platform role by accident. */
        renderRoster(routes({ 'GET /api/me/projects': leadProjects }));
        await screen.findByText('Dana Whitfield');
        expect(screen.getByRole('button', { name: 'Put on shift' })).toBeInTheDocument();
    });

    it('still gives a site manager nothing that goes to /api/users', async () => {
        /* The row now holds two audiences. The shift switch is guarded by
           the project role and the other two by the platform admin role, so
           dispatch sees one button and not three -- which is exactly what
           the server will let them do. Showing a button that 403s is worse
           than not showing it. */
        renderRoster(routes({ 'GET /api/me/projects': leadProjects }));
        await screen.findByText('Dana Whitfield');
        expect(screen.queryByRole('button', { name: 'New password' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Off the roster' })).not.toBeInTheDocument();
    });

    it('is offered to nobody who only drives', async () => {
        /* A courier switching THEMSELVES on has their own route on their own
           phone. Nobody on a courier membership may switch anybody. */
        renderRoster(routes({
            'GET /api/me/projects': [{ ...projects[0]!, role: 'courier' }],
        }));
        await screen.findByText('Dana Whitfield');
        expect(screen.queryByRole('button', { name: 'Put on shift' })).not.toBeInTheDocument();
    });
});
