import { describe, it, expect } from 'vitest';
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

describe('Login', () => {
    it('shows the driver picker when there is no session, with PIN or setup per driver', async () => {
        mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/drivers/list': drivers,
        });
        renderApp();
        expect(await screen.findByText('Who is driving?')).toBeInTheDocument();
        expect(await screen.findByText('Bereket Nigusse')).toBeInTheDocument();
        expect(screen.getByText(/NorthBound · Enter PIN/)).toBeInTheDocument();
        expect(screen.getByText(/SouthBound · Set up PIN/)).toBeInTheDocument();
    });

    it('signs a staff user in with username and password and shows the shell', async () => {
        const { calls } = mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/drivers/list': drivers,
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
        expect(calls).toContain('GET /api/drivers/list');
    });

    it('shows an error from the API on a bad password', async () => {
        mockFetch({
            'GET /api/session': { status: 401, body: { error: 'No session' } },
            'GET /api/drivers/list': drivers,
            'POST /api/login': { status: 401, body: { error: 'Invalid username or password' } },
        });
        renderApp();
        fireEvent.click(await screen.findByText('Staff sign in'));
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
    });

    it('routes a courier-only user straight to the TVHS app without shell chrome', async () => {
        mockFetch({
            'GET /api/session': { id: 3, username: 'north.driver', name: 'Bereket Nigusse', role: 'driver', route: 'northbound' },
            'GET /api/me/projects': [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'courier' }],
            'GET /legacy/index.html': { status: 404, body: {} },
        });
        renderApp();
        await waitFor(() => expect(screen.getByText('TVHS RMD Courier')).toBeInTheDocument());
        expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
        expect(screen.queryByText('Back to platform')).not.toBeInTheDocument();
        expect(screen.getByTestId('legacy-host')).toBeInTheDocument();
    });
});
