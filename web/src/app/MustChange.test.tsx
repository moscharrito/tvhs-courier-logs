/* Somebody whose password was set for them, signing in on the web.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF THE PROBLEM.
 *
 * The server refuses almost everything to an account in this state. The list
 * of what stays open is deliberately three entries long (core/auth/
 * must-change.ts): the session read, the logout, and the password change
 * itself. /api/me/projects is NOT on it, and never could be: it is a read of
 * what the account can reach, which is exactly what the refusal is for.
 *
 * So the first thing any such account does on the web is sign in, and the
 * second thing the shell does is ask for the project list and be refused.
 * What happens next is the whole of whether the forced change works at all,
 * and it had never been exercised with a must-change session until this file.
 *
 * Every pharmacy account about to be created for University Health starts in
 * exactly this state, because an administrator chooses the first password and
 * the rule says a password two people know does not outlive the conversation.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { App } from './App';
import { mockFetch } from '../test/setup';

/* A pharmacy account on its first sign-in: the password was set for them. */
const forced = {
    id: 21, username: 'uh.green', name: 'Robert B. Green Pharmacy',
    role: 'staff', route: null, mustChangePassword: true,
};

/* What the server actually answers while the flag is set. */
const refused = {
    status: 403,
    body: {
        error: 'Your password was set for you and has to be changed before you can go further. '
            + 'Change it on your own account screen.',
        code: 'password.mustChange',
    },
};

function renderApp(over: Record<string, unknown> = {}) {
    const mocked = mockFetch({
        'GET /api/session': forced,
        'GET /api/me/projects': refused,
        'GET /api/me/sessions': [],
        ...over,
    });
    render(
        <MemoryRouter initialEntries={['/']}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('a first sign-in with a password somebody else chose', () => {
    it('does not drop them back to the sign-in page', async () => {
        /* THE FAILURE THIS CATCHES. The session is valid and the server is
           waiting for one specific request. Showing a password box again
           tells somebody their credential did not work, so they type it
           again, and again, until they telephone us. */
        renderApp();
        await waitFor(() => {
            expect(screen.queryByRole('button', { name: /^Sign in$/i }), 'should not be back at sign-in').toBeNull();
        });
    });

    it('puts them where they can change it', async () => {
        /* The only screen the server will let them act on. */
        renderApp();
        expect(await screen.findByRole('heading', { name: /password/i })).toBeInTheDocument();
    });

    it('tells them why they are there', async () => {
        /* They were redirected from wherever they were going. A routine
           looking form with no explanation reads as the site being broken,
           and the next thing that happens is a telephone call. */
        renderApp();
        /* By its words rather than by role: the page carries several status
           regions and which one comes first is not the thing under test. */
        const said = await screen.findByText(/has to be changed before you can go further/i);
        expect(said).toHaveTextContent(/set for you/i);
        expect(said).toHaveTextContent(/nothing else on the site will work/i);
    });

    it('names the screen for the thing they have to do', async () => {
        renderApp();
        expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeInTheDocument();
    });

    it('survives the project list being refused, which it always will be', async () => {
        /* /api/me/projects is not on the allowed list and cannot be: it is a
           read of what this account can reach. The shell has to treat that
           403 as "nothing yet" rather than as a failure. */
        const mocked = renderApp();
        await waitFor(() => expect(mocked.calls.some((c) => c.includes('/api/me/projects'))).toBe(true));
        expect(screen.queryByText(/something went wrong|unexpected error/i)).toBeNull();
    });
});
