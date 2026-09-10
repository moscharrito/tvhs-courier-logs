import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../app/auth';
import { App } from '../app/App';
import { mockFetch } from '../test/setup';

const admin = { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null };
const projects = [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'admin' }];
const users = [
    { id: 1, username: 'admin', name: 'Administrator', email: null, role: 'admin', status: 'active', hasPin: false, created_at: '2026-09-01T00:00:00Z', memberships: [{ project_id: 1, code: 'tvhs', project_name: 'TVHS RMD Courier', role: 'admin', settings: {} }] },
    { id: 3, username: 'north.driver', name: 'Bereket Nigusse', email: null, role: 'driver', status: 'active', hasPin: false, created_at: '2026-09-02T00:00:00Z', memberships: [{ project_id: 1, code: 'tvhs', project_name: 'TVHS RMD Courier', role: 'courier', settings: { route: 'northbound' } }] },
    { id: 4, username: 'old.staff', name: 'Old Staff', email: 'o@example.com', role: 'staff', status: 'disabled', hasPin: false, created_at: null, memberships: [] },
];

function renderAt(path: string) {
    return render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

describe('Users', () => {
    it('lists the directory with roles, status, memberships and PIN state', async () => {
        mockFetch({ 'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users });
        renderAt('/users');
        expect(await screen.findByText('Bereket Nigusse')).toBeInTheDocument();
        expect(screen.getByText('TVHS RMD Courier: courier (northbound)')).toBeInTheDocument();
        expect(screen.getByText('disabled')).toBeInTheDocument();
        expect(screen.getByText('not set')).toBeInTheDocument();
    });

    it('creates a user and shows validation details from the API', async () => {
        const { calls } = mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'POST /api/users': { status: 400, body: { error: 'Invalid request', details: ['password: String must contain at least 8 character(s)'] } },
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');
        fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new.user' } });
        fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New User' } });
        fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'longenough1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request');
        expect(screen.getByText(/password: String must contain/)).toBeInTheDocument();
        expect(calls).toContain('POST /api/users');
    });

    it('blocks non-admins from the users page', async () => {
        mockFetch({
            'GET /api/session': { id: 9, username: 'dispatch', name: 'Dispatcher', role: 'staff', route: null },
            'GET /api/me/projects': [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'dispatcher' }],
        });
        renderAt('/users');
        await waitFor(() => expect(screen.getByText('Welcome, Dispatcher')).toBeInTheDocument());
        expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument();
    });
});
