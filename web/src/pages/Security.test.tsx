/* The two-factor screens.
 *
 * Ticket 4.3. Two things here are worth a test rather than a look: that the
 * recovery codes cannot be walked past by accident, because the server keeps
 * only their hashes and this is genuinely the only time they exist; and that
 * a staff account which owes a factor is shown the setup screen instead of a
 * shell full of 403s.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../app/auth';
import { App } from '../app/App';
import { mockFetch } from '../test/setup';

const dispatcher = (mfa: Record<string, boolean>) => ({
    id: 3, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null, mfa,
});

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'dispatcher' }];

function renderApp(path = '/security') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
}

describe('Security', () => {
    it('walks through setting one up: password, QR, code, then the codes once', async () => {
        const { calls } = mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: false, enforced: false }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: false, enrolled: false, confirmed: false, recoveryCodesRemaining: 0 },
            'POST /api/me/mfa/enrol': {
                status: 201,
                body: { secret: 'GEZD GNBV GY3T QOJQ', uri: 'otpauth://totp/TAG:dee.dispatch?secret=GEZDGNBVGY3TQOJQ' },
            },
            'POST /api/me/mfa/confirm': { status: 201, body: { confirmed: true, recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-TUVWX'] } },
        });
        renderApp();

        fireEvent.change(await screen.findByLabelText(/Your password/), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));

        // The QR is drawn here, from the URI, with nothing fetched to do it.
        expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();
        expect(screen.getByText('GEZD GNBV GY3T QOJQ')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/type the code it shows/i), { target: { value: '081804' } });
        fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));

        expect(await screen.findByText('Write these down now')).toBeInTheDocument();
        expect(screen.getByText('ABCDE-FGHJK')).toBeInTheDocument();
        expect(screen.getByText(/only time they are shown/i)).toBeInTheDocument();
        expect(calls).toContain('POST /api/me/mfa/confirm');
    });

    it('keeps the recovery codes on screen until they are acknowledged', async () => {
        mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: false, enforced: false }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: false, enrolled: true, confirmed: false, recoveryCodesRemaining: 0 },
            'POST /api/me/mfa/enrol': { status: 201, body: { secret: 'AAAA BBBB', uri: 'otpauth://totp/TAG:x?secret=AAAABBBB' } },
            'POST /api/me/mfa/confirm': { status: 201, body: { confirmed: true, recoveryCodes: ['ABCDE-FGHJK'] } },
        });
        renderApp();

        fireEvent.change(await screen.findByLabelText(/Your password/), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        fireEvent.change(await screen.findByLabelText(/type the code it shows/i), { target: { value: '111111' } });
        fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));

        const done = await screen.findByRole('button', { name: /written them down/i });
        expect(screen.getByText('ABCDE-FGHJK')).toBeInTheDocument();
        fireEvent.click(done);
        await waitFor(() => expect(screen.queryByText('ABCDE-FGHJK')).not.toBeInTheDocument());
    });

    it('does not let the shell lift the gate while the codes are on screen', async () => {
        /* The bug this pins, found by walking the flow in a browser:
           confirming refreshed the session, the setup gate lifted, the shell
           replaced this screen with the project list, and ten codes that are
           shown exactly once were never seen. The session is re-read when the
           codes are acknowledged, and not before. */
        const { calls } = mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: false, enforced: true }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: true, enrolled: false, confirmed: false, recoveryCodesRemaining: 0 },
            'POST /api/me/mfa/enrol': { status: 201, body: { secret: 'AAAA BBBB', uri: 'otpauth://totp/TAG:x?secret=AAAABBBB' } },
            'POST /api/me/mfa/confirm': { status: 201, body: { confirmed: true, recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-TUVWX'] } },
        });
        renderApp('/');

        fireEvent.change(await screen.findByLabelText(/Your password/), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        fireEvent.change(await screen.findByLabelText(/type the code it shows/i), { target: { value: '111111' } });

        const sessionReadsBefore = calls.filter((c) => c === 'GET /api/session').length;
        fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));

        expect(await screen.findByText('ABCDE-FGHJK')).toBeInTheDocument();
        expect(calls.filter((c) => c === 'GET /api/session').length).toBe(sessionReadsBefore);

        fireEvent.click(screen.getByRole('button', { name: /written them down/i }));
        await waitFor(() => expect(calls.filter((c) => c === 'GET /api/session').length).toBeGreaterThan(sessionReadsBefore));
    });

    it('shows a wrong code as an error and stays on the step', async () => {
        mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: false, enforced: false }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: false, enrolled: false, confirmed: false, recoveryCodesRemaining: 0 },
            'POST /api/me/mfa/enrol': { status: 201, body: { secret: 'AAAA BBBB', uri: 'otpauth://totp/TAG:x?secret=AAAABBBB' } },
            'POST /api/me/mfa/confirm': { status: 401, body: { error: 'That code is not right. Check the time on your phone and try the next one.' } },
        });
        renderApp();

        fireEvent.change(await screen.findByLabelText(/Your password/), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        fireEvent.change(await screen.findByLabelText(/type the code it shows/i), { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/not right/);
        expect(screen.getByRole('button', { name: 'Turn it on' })).toBeInTheDocument();
    });

    it('offers no way to turn it off when the role requires it', async () => {
        mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: true, enforced: true }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: true, enrolled: true, confirmed: true, recoveryCodesRemaining: 7 },
        });
        renderApp();

        expect(await screen.findByText('Turned on')).toBeInTheDocument();
        expect(screen.getByText(/7 recovery codes left/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Turn off/ })).not.toBeInTheDocument();
        expect(screen.getByText(/cannot be turned off for your role/i)).toBeInTheDocument();
    });

    it('says so when the codes are nearly gone', async () => {
        mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: true, enforced: true }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: true, enrolled: true, confirmed: true, recoveryCodesRemaining: 1 },
        });
        renderApp();
        expect(await screen.findByText(/1 recovery code left/)).toBeInTheDocument();
        expect(screen.getByText(/worth replacing/)).toBeInTheDocument();
    });
});

describe('an account that owes a second factor', () => {
    it('sees the setup screen instead of the rest of the shell', async () => {
        mockFetch({
            'GET /api/session': dispatcher({ required: true, confirmed: false, enforced: true }),
            'GET /api/me/projects': projects,
            'GET /api/me/mfa': { required: true, enforced: true, enrolled: false, confirmed: false, recoveryCodesRemaining: 0 },
        });
        // Asking for the board, which the API would refuse anyway.
        renderApp('/projects/uh/board');

        expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
        expect(screen.getByText(/can reach this page and nothing else/i)).toBeInTheDocument();
        expect(screen.queryByText('Dispatch board')).not.toBeInTheDocument();
    });

    it('does not gate a courier', async () => {
        mockFetch({
            'GET /api/session': { id: 9, username: 'mohammed', name: 'Mohammed', role: 'driver', route: null, mfa: { required: false, confirmed: false, enforced: false } },
            'GET /api/me/projects': [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }],
            'GET /api/me/mfa': { required: false, enforced: false, enrolled: false, confirmed: false, recoveryCodesRemaining: 0 },
        });
        renderApp('/security');
        expect(await screen.findByText(/Your role does not require it/)).toBeInTheDocument();
    });
});
