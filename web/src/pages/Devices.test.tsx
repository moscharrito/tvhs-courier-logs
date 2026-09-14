/* Setting up a phone, and telling three lists apart.
 *
 * Ticket 5.4. The API for all of this was built and tested in ticket 2.3 and
 * then nothing called it for three phases, so these tests are about the part
 * that was missing: a screen a courier can actually reach.
 *
 * The other thing under test is the naming. The old page called sessions
 * "devices", which is how a courier ends up signing out a browser and
 * believing they have cut off a lost phone.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../app/auth';
import { App } from '../app/App';
import { mockFetch } from '../test/setup';

const courier = {
    id: 7, username: 'mohammed', name: 'Mohammed', role: 'driver', route: null,
    mfa: { required: false, confirmed: false, enforced: false },
};
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];

const session = {
    id: 'sess-1', device: 'Chrome on Android', ip: '10.0.0.1',
    created_at: '2026-09-13T08:00:00Z', last_seen_at: '2026-09-13T12:00:00Z',
    idle_expires_at: '2026-09-14T00:00:00Z', absolute_expires_at: '2026-10-13T08:00:00Z', current: true,
};

const phone = {
    id: 'abc123def456', label: "Mohammed's phone", userAgent: 'Chrome on Android',
    createdAt: '2026-09-01T08:00:00Z', lastSeenAt: '2026-09-13T12:00:00Z', revokedAt: null, current: true,
};

function renderDevices(routes: Record<string, unknown>) {
    const mocked = mockFetch({
        'GET /api/session': courier,
        'GET /api/me/projects': projects,
        'GET /api/me/sessions': [session],
        ...routes,
    });
    render(
        <MemoryRouter initialEntries={['/devices']}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('a phone that is not set up', () => {
    it('offers to set it up, and says what that buys', async () => {
        renderDevices({
            'GET /api/devices': [],
            'GET /api/login/device': { enrolled: false },
        });

        expect(await screen.findByRole('heading', { name: 'This phone' })).toBeInTheDocument();
        /* findByText, not getByText: the heading renders before the fetch that
           decides what goes under it, so a synchronous read here catches the
           loading state and fails for the wrong reason. */
        expect(await screen.findByText(/a four-digit PIN signs you in afterwards/i)).toBeInTheDocument();
        // The PIN is worth having because it is bound to this phone, and the
        // screen has to say so or four digits looks like a weak password.
        expect(screen.getByText(/only works on this phone/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Set up this phone' })).toBeInTheDocument();
    });

    it('asks for the password again, even though they are signed in', async () => {
        /* Enrolling is what lets four digits stand in for the password
           afterwards, so an unlocked screen must not be enough to do it. */
        const { calls } = renderDevices({
            'GET /api/devices': [],
            'GET /api/login/device': { enrolled: false },
            'POST /api/devices/enrol': { status: 201, body: { enrolled: true, device: { label: "Mohammed's phone" } } },
        });

        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'courier-pass' } });
        fireEvent.change(screen.getByLabelText(/Choose a PIN/), { target: { value: '4417' } });
        fireEvent.change(screen.getByLabelText('PIN again'), { target: { value: '4417' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set up this phone' }));

        await waitFor(() => expect(calls).toContain('POST /api/devices/enrol'));
        expect(await screen.findByText(/your PIN is enough/i)).toBeInTheDocument();
    });

    it('will not send two PINs that do not match', async () => {
        const { calls } = renderDevices({
            'GET /api/devices': [],
            'GET /api/login/device': { enrolled: false },
        });

        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'courier-pass' } });
        fireEvent.change(screen.getByLabelText(/Choose a PIN/), { target: { value: '4417' } });
        fireEvent.change(screen.getByLabelText('PIN again'), { target: { value: '4418' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set up this phone' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/);
        expect(calls).not.toContain('POST /api/devices/enrol');
    });

    it('shows what the server refused, rather than a generic failure', async () => {
        renderDevices({
            'GET /api/devices': [],
            'GET /api/login/device': { enrolled: false },
            'POST /api/devices/enrol': { status: 401, body: { error: 'Incorrect username or password' } },
        });

        fireEvent.change(await screen.findByLabelText('Your password'), { target: { value: 'wrong' } });
        fireEvent.change(screen.getByLabelText(/Choose a PIN/), { target: { value: '4417' } });
        fireEvent.change(screen.getByLabelText('PIN again'), { target: { value: '4417' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set up this phone' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/Incorrect username or password/);
    });
});

describe('a phone that is set up', () => {
    it('says so, and does not offer to do it again', async () => {
        renderDevices({
            'GET /api/devices': [phone],
            'GET /api/login/device': { enrolled: true, name: 'Mohammed', username: 'mohammed', hasPin: true, label: "Mohammed's phone" },
        });

        expect(await screen.findByText(/Set up already/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Set up this phone' })).not.toBeInTheDocument();
    });

    it('lists phones separately from sessions, because they are different things', async () => {
        /* The bug this pins: the old page listed sessions under the heading
           "My devices", so signing one out looked like cutting off a lost
           phone when it only ended a browser session. */
        renderDevices({
            'GET /api/devices': [phone],
            'GET /api/login/device': { enrolled: true, name: 'Mohammed', username: 'mohammed', hasPin: true, label: "Mohammed's phone" },
        });

        expect(await screen.findByRole('heading', { name: 'Your phones' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Signed in' })).toBeInTheDocument();
        expect(screen.getByText("Mohammed's phone")).toBeInTheDocument();
        expect(screen.getByText(/Not the same as the list above/i)).toBeInTheDocument();
    });

    it('signs a phone out through the devices endpoint, not the sessions one', async () => {
        const { calls } = renderDevices({
            'GET /api/devices': [{ ...phone, current: false }],
            'GET /api/login/device': { enrolled: false },
            'DELETE /api/devices/abc123def456': { ok: true },
        });

        const phones = (await screen.findByRole('heading', { name: 'Your phones' })).closest('.izy-card') as HTMLElement;
        fireEvent.click(within(phones).getByRole('button', { name: 'Sign out' }));
        await waitFor(() => expect(calls).toContain('DELETE /api/devices/abc123def456'));
    });

    it('lands on the sign-in page after signing THIS phone out, not on a dead one', async () => {
        /* Signing this phone out removes its PIN and ends the session it is
           being done from. Reloading afterwards used to leave a "Not
           authenticated" banner over a screen still listing the phone that
           had just been removed, which reads as a failure rather than as the
           thing working exactly as described. */
        const { calls } = renderDevices({
            'GET /api/devices': [phone], // current: true, this phone
            'GET /api/login/device': { enrolled: true, hasPin: true, name: 'Mohammed', label: "Mohammed's phone" },
            'DELETE /api/devices/abc123def456': { ok: true },
            'POST /api/logout': { ok: true },
            'GET /api/login/projects': [{ code: 'uh', name: 'UH Pharmacy Courier' }],
            'GET /api/drivers/list?project=uh': [],
        });

        const phones = (await screen.findByRole('heading', { name: 'Your phones' })).closest('.izy-card') as HTMLElement;
        fireEvent.click(within(phones).getByRole('button', { name: 'Sign out' }));

        await waitFor(() => expect(calls).toContain('DELETE /api/devices/abc123def456'));

        /* The session is over, so the app is out of the shell and on the
           sign-in page. Which sign-in page depends on what the server says
           about this device afterwards, and that is not this test's business:
           what matters is that the app left. */
        expect(await screen.findByText(/Sign in another way/)).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Your phones' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Not authenticated/)).not.toBeInTheDocument();
    });
});
