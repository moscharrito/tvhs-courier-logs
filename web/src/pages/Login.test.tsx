import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../app/auth';
import { App } from '../app/App';
import { mockFetch } from '../test/setup';

const drivers = [
    { route: 'northbound', name: 'Bereket Nigusse', hasPin: true },
    { route: 'southbound', name: 'Mohamed Djemai', hasPin: false },
];

function renderApp(initialPath = '/') {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
}

const loginProjects = [
    { code: 'tvhs', name: 'TVHS RMD Courier' },
    { code: 'uh', name: 'UH Pharmacy Courier' },
];

describe('Login', () => {
    it('asks which project first, then shows that project\'s drivers with PIN or setup', async () => {
        const { calls } = mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'GET /api/drivers/list?project=tvhs': drivers,
        });
        renderApp();

        expect(await screen.findByText('Which project are you signing in to?')).toBeInTheDocument();
        const tvhsButton = await screen.findByRole('button', { name: /TVHS RMD Courier/ });
        expect(screen.getByRole('button', { name: /UH Pharmacy Courier/ })).toBeInTheDocument();
        // No driver names are shown before a project is chosen.
        expect(screen.queryByText('Bereket Nigusse')).not.toBeInTheDocument();

        fireEvent.click(tvhsButton);

        expect(await screen.findByText(/who is driving\?/)).toBeInTheDocument();
        expect(await screen.findByText('Bereket Nigusse')).toBeInTheDocument();
        expect(screen.getByText(/NorthBound · Enter PIN/)).toBeInTheDocument();
        expect(screen.getByText(/SouthBound · Set up PIN/)).toBeInTheDocument();
        // The driver list was fetched scoped to the chosen project.
        expect(calls).toContain('GET /api/drivers/list?project=tvhs');
        expect(calls).not.toContain('GET /api/drivers/list');
    });

    it('tells a driver when the chosen project has no couriers yet', async () => {
        mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'GET /api/drivers/list?project=uh': [],
        });
        renderApp();
        fireEvent.click(await screen.findByRole('button', { name: /UH Pharmacy Courier/ }));
        expect(await screen.findByText(/No drivers are set up for this project yet/)).toBeInTheDocument();
    });

    it('goes back from the driver list to the project list', async () => {
        mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'GET /api/drivers/list?project=tvhs': drivers,
        });
        renderApp();
        fireEvent.click(await screen.findByRole('button', { name: /TVHS RMD Courier/ }));
        await screen.findByText('Bereket Nigusse');
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(await screen.findByText('Which project are you signing in to?')).toBeInTheDocument();
        expect(screen.queryByText('Bereket Nigusse')).not.toBeInTheDocument();
    });

    it('signs a staff user in with username and password and shows the shell', async () => {
        const { calls } = mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'POST /api/login': { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null },
            'GET /api/me/projects': [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'admin' }],
        });
        renderApp();
        fireEvent.click(await screen.findByText('Staff sign in'));
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });

        // After POST /api/login the provider re-reads the session.
        const routes = (globalThis.fetch as unknown as { mock: { calls: unknown[] } });
        expect(routes).toBeTruthy();
        mockFetch({
            'GET /api/session': { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null },
            'GET /api/me/projects': [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'admin' }],
            'POST /api/login': { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByText('Welcome, Administrator')).toBeInTheDocument();
        const nav = within(screen.getByRole('navigation', { name: 'Main' }));
        expect(nav.getByRole('link', { name: 'Users' })).toBeInTheDocument();
        expect(nav.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
        // Staff never trigger a courier lookup.
        expect(calls.some((c) => c.startsWith('GET /api/drivers/list'))).toBe(false);
    });

    it('shows an error from the API on a bad password', async () => {
        mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'POST /api/login': { status: 401, body: { error: 'Invalid username or password' } },
        });
        renderApp();
        fireEvent.click(await screen.findByText('Staff sign in'));
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
    });

    it('lands a driver on the project picker, without admin links, and opens the TVHS app on choice', async () => {
        mockFetch({
            'GET /api/session': { id: 3, username: 'north.driver', name: 'Bereket Nigusse', role: 'driver', route: 'northbound' },
            'GET /api/me/projects': [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'courier' }],
            'GET /legacy/index.html': { status: 404, body: {} },
        });
        renderApp();
        await waitFor(() => expect(screen.getByText('Welcome, Bereket')).toBeInTheDocument());
        expect(screen.getByText('Choose the project you are working in.')).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument();

        // The sidebar lists projects too; click the picker card in the main area.
        fireEvent.click(within(screen.getByRole('main')).getByRole('link', { name: /TVHS RMD Courier/ }));
        await waitFor(() => expect(screen.getByTestId('legacy-host')).toBeInTheDocument());
        expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
    });

    it('shows a placeholder page for a project without a module yet', async () => {
        mockFetch({
            'GET /api/session': { id: 9, username: 'dispatch', name: 'Dispatcher One', role: 'staff', route: null },
            'GET /api/me/projects': [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'dispatcher' }],
            'GET /api/projects/uh/uh/pricing': {
                on: '2026-09-11',
                schedule: { effectiveFrom: '2026-05-18', zoneRates: { 1: 12.5, 2: 14.5, 3: 22, 4: 36, 5: 52 }, statSurcharge: 22, afterHoursSurcharge: 18, dryRunFee: 9, outOfAreaPerMile: 1.95 },
                settings: { afterHoursStart: '20:00', afterHoursEnd: '07:00', timezone: 'America/Chicago', dryRunReplacesBase: true },
                zoneZipCounts: [{ zone: 1, zips: 38 }],
            },
            'GET /api/projects/uh/settings': {
                timezone: 'America/Chicago',
                settings: {
                    sla: { clockStart: 'receipt', scheduledMinutes: 120, statMinutes: 120, statFromPickupMinutes: 60, adhocMinutes: 240 },
                    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
                    listRelease: { earliest: '12:00', latest: '14:00' },
                    pricing: { afterHoursStart: '20:00', afterHoursEnd: '07:00', dryRunReplacesBase: true },
                },
                defaults: {
                    sla: { clockStart: 'receipt', scheduledMinutes: 120, statMinutes: 120, statFromPickupMinutes: 60, adhocMinutes: 240 },
                    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
                    listRelease: { earliest: '12:00', latest: '14:00' },
                    pricing: { afterHoursStart: '20:00', afterHoursEnd: '07:00', dryRunReplacesBase: true },
                },
                overridden: [],
                canManage: false,
                example: [{ serviceType: 'scheduled', receivedAt: '2026-09-14T17:00:00.000Z', dueAt: '2026-09-14T19:00:00.000Z', minutes: 120, from: 'receipt', pending: false, basis: '120 minutes from the list being received.' }],
            },
            'GET /api/projects/uh/uh/imports': [],
            'GET /api/projects/uh/uh/sites': [
                { id: 7, code: 'vida', name: 'University Health Vida Pharmacy', type: 'pharmacy', addressLine: '3611 Jaguar Parkway', city: 'San Antonio', state: 'TX', zip: '78224', fullAddress: '3611 Jaguar Parkway, San Antonio, TX 78224', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
            ],
        });
        renderApp('/projects/uh/uh');
        await waitFor(() => expect(screen.getByRole('heading', { name: 'UH Pharmacy Courier' })).toBeInTheDocument());
        expect(screen.getByText(/your role: Dispatcher/)).toBeInTheDocument();
        expect(screen.getByText('Coming next')).toBeInTheDocument();
        // A dispatcher sees the sites but gets no management controls. The
        // name also appears in the import screen's pharmacy picker, so scope
        // the assertion to the sites table.
        const sitesTable = (await screen.findByText('Pickup locations')).closest('.izy-card') as HTMLElement;
        expect(within(sitesTable).getByText('University Health Vida Pharmacy')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'New site' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
        // and sees the contract pricing
        expect(await screen.findByText('Contract pricing')).toBeInTheDocument();
        expect(screen.getByText('$12.50')).toBeInTheDocument();
        expect(screen.getByText(/After hours 20:00 to 07:00/)).toBeInTheDocument();
        // and the operating settings, read-only: a dispatcher cannot edit them
        expect(await screen.findByText('Operating settings')).toBeInTheDocument();
        expect(screen.getByText('120 minutes from the list being received.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('asks for a code when the password is not the whole of signing in', async () => {
        /* Ticket 4.3. The password reply carries a challenge rather than a
           session, and nothing about the account is shown until the code is
           right: the screen must not say "welcome back" first. */
        const { calls } = mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'POST /api/login': { mfaRequired: true, challengeToken: 'chal-123', expiresAt: '2026-09-13T12:05:00Z' },
            'POST /api/login/mfa': { id: 3, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null },
        });
        renderApp();

        fireEvent.click(await screen.findByRole('button', { name: 'Staff sign in' }));
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'dee.dispatch' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByText(/six-digit code from your authenticator app/i)).toBeInTheDocument();
        // A lost phone has an answer on the same screen, not a support call.
        expect(screen.getByText(/recovery code goes in the same box/i)).toBeInTheDocument();
        expect(screen.queryByText('Dee Dispatch')).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Code'), { target: { value: '081804' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        await waitFor(() => expect(calls).toContain('POST /api/login/mfa'));
    });

    it('shows a wrong code as an error without dropping the challenge', async () => {
        mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/login/projects': loginProjects,
            'POST /api/login': { mfaRequired: true, challengeToken: 'chal-123' },
            'POST /api/login/mfa': { status: 401, body: { error: 'That code is not right.' } },
        });
        renderApp();

        fireEvent.click(await screen.findByRole('button', { name: 'Staff sign in' }));
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'dee.dispatch' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/not right/);
        // Still on the code step: a typo should not mean typing the password again.
        expect(screen.getByLabelText('Code')).toBeInTheDocument();
    });

    it('shows the TAG brand and the dotted loader while the session is resolving', async () => {
        let release = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        vi.stubGlobal('fetch', vi.fn(async () => { await gate; return new Response(JSON.stringify({ error: 'No session' }), { status: 401, headers: { 'Content-Type': 'application/json' } }); }));
        renderApp();
        expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
        release();
        expect(await screen.findByRole('heading', { name: 'TAG' })).toBeInTheDocument();
    });
});
