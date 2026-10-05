import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
            'GET /api/me/projects': [{ id: 1, code: 'tvhs', name: 'TVHS RMD Courier', timezone: 'America/Chicago', role: 'admin' }],
        });
        renderAt('/users');
        await waitFor(() => expect(screen.getByText('Welcome, Dispatcher')).toBeInTheDocument());
        expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument();
    });
});

/* ───────────────────────────────────────────── turning somebody's access off
 *
 * Revoking access used to need a shell, an admin password and a PATCH, which
 * for a platform carrying patient data is the wrong shape. The risk of
 * putting it on a page is the opposite one: disabling signs out every device
 * immediately, so a misclick on the wrong row during a wave takes a phone out
 * of a courier's hand.
 *
 * So what is tested is mostly the asking, not the doing.
 */
describe('Users: disabling an account', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    /* Anchored on the <code> cell, because a username can also appear in a
       membership pill and in a role label, and "admin" matches all three. */
    const rowFor = (username: string) => {
        const cell = screen.getAllByText(username).find((el) => el.tagName === 'CODE');
        if (!cell) throw new Error(`no row for ${username}`);
        return within(cell.closest('tr') as HTMLElement);
    };

    it('says how many devices will be signed out before asking', async () => {
        const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false);
        mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'GET /api/users/north.driver/sessions': [{ id: 1 }, { id: 2 }],
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');

        fireEvent.click(rowFor('north.driver').getByRole('button', { name: 'Disable' }));

        await waitFor(() => expect(confirmed).toHaveBeenCalled());
        expect(confirmed.mock.calls[0]![0]).toContain('signs out 2 signed-in devices straight away');
        expect(confirmed.mock.calls[0]![0]).toContain('north.driver');
    });

    it('does nothing at all when the question is declined', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        const { calls } = mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'GET /api/users/north.driver/sessions': [{ id: 1 }],
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');

        fireEvent.click(rowFor('north.driver').getByRole('button', { name: 'Disable' }));
        await waitFor(() => expect(calls).toContain('GET /api/users/north.driver/sessions'));
        expect(calls).not.toContain('PATCH /api/users/north.driver');
    });

    it('disables and says how many devices it signed out', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { calls } = mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'GET /api/users/north.driver/sessions': [{ id: 1 }, { id: 2 }],
            'PATCH /api/users/north.driver': { ...users[1], status: 'disabled', revokedSessions: 2 },
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');

        fireEvent.click(rowFor('north.driver').getByRole('button', { name: 'Disable' }));

        expect(await screen.findByRole('status')).toHaveTextContent('Disabled north.driver. 2 devices signed out.');
        expect(calls).toContain('PATCH /api/users/north.driver');
    });

    it('says one device in the singular, because a count nobody reads is a count nobody trusts', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'GET /api/users/north.driver/sessions': [{ id: 1 }],
            'PATCH /api/users/north.driver': { ...users[1], status: 'disabled', revokedSessions: 1 },
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');
        fireEvent.click(rowFor('north.driver').getByRole('button', { name: 'Disable' }));
        expect(await screen.findByRole('status')).toHaveTextContent('1 device signed out.');
    });

    it('admits when it could not find out, rather than implying none', async () => {
        /* The dishonest version of this reports "no signed-in devices" when
           the lookup failed, which is the one answer that would make somebody
           click through without thinking. */
        const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false);
        mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'GET /api/users/north.driver/sessions': { status: 500, body: { error: 'nope' } },
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');

        fireEvent.click(rowFor('north.driver').getByRole('button', { name: 'Disable' }));
        await waitFor(() => expect(confirmed).toHaveBeenCalled());
        expect(confirmed.mock.calls[0]![0]).toContain('could not check how many');
    });

    it('offers to re-enable a disabled account, and does not count devices for it', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { calls } = mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'PATCH /api/users/old.staff': { ...users[2], status: 'active', revokedSessions: 0 },
        });
        renderAt('/users');
        await screen.findByText('Old Staff');

        fireEvent.click(rowFor('old.staff').getByRole('button', { name: 'Re-enable' }));

        expect(await screen.findByRole('status')).toHaveTextContent('Re-enabled old.staff');
        /* Nothing to sign out, so nothing is asked about. */
        expect(calls).not.toContain('GET /api/users/old.staff/sessions');
    });

    it('does not offer it on your own row', async () => {
        mockFetch({ 'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');
        /* The server refuses it with a 400, and an admin who locks themselves
           out of the only admin account has nobody left to let them back in. */
        expect(rowFor('admin').queryByRole('button')).toBeNull();
        expect(rowFor('admin').getByText('this is you')).toBeInTheDocument();
    });

    it('surfaces a refusal from the server instead of looking like it worked', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            'GET /api/session': admin, 'GET /api/me/projects': projects, 'GET /api/users': users,
            'GET /api/users/north.driver/sessions': [],
            'PATCH /api/users/north.driver': { status: 400, body: { error: 'You cannot disable or demote your own account' } },
        });
        renderAt('/users');
        await screen.findByText('Bereket Nigusse');

        fireEvent.click(rowFor('north.driver').getByRole('button', { name: 'Disable' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('You cannot disable or demote your own account');
        expect(screen.queryByRole('status')).toBeNull();
    });
});
