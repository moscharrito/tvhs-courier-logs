/* Resetting a forgotten password, from the screen a person actually uses.
 *
 * The server's half is covered in server/test/password-reset.test.mjs. What
 * matters here is that the screen does not undo the property the server went
 * to some trouble to have: it must not tell anybody whether an address
 * belongs to an account, and it must not pretend a code arrived when the
 * server said email is switched off.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PasswordReset } from './PasswordReset';
import { mockFetch } from '../test/setup';

const REQUEST = 'POST /api/password-reset/request';
const CONFIRM = 'POST /api/password-reset/confirm';

const accepted = {
    ok: true,
    message: 'If that address belongs to an account, a six digit code is on its way. '
        + 'It expires in 15 minutes. If nothing arrives, ring the office.',
};

function renderReset(routes: Record<string, unknown>) {
    const mock = mockFetch(routes);
    render(<PasswordReset onBack={() => undefined} />);
    return mock;
}

async function askFor(address: string) {
    fireEvent.change(screen.getByLabelText(/Your email address/), { target: { value: address } });
    fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
    await screen.findByLabelText(/The six digit code/);
}

describe('asking for a code', () => {
    it('moves on identically whether or not the address is known', async () => {
        /* THE WHOLE POINT. The server answers the same for both, and a screen
           that added "we don't recognise that email" would hand out the staff
           directory the server refuses to. */
        const { bodies } = renderReset({ [REQUEST]: { status: 202, body: accepted } });
        await askFor('counter@example.invalid');

        expect(screen.getByText(/If that address belongs to an account/)).toBeInTheDocument();
        expect(screen.queryByText(/not recognised|no account|unknown/i)).toBeNull();
        expect((bodies[REQUEST] as { email: string }).email).toBe('counter@example.invalid');
    });

    it('lowercases and trims the address, so a capitalised one still matches', async () => {
        /* Somebody typing on a phone gets a capital first letter for free.
           The server looks the address up in lower case. */
        const { bodies } = renderReset({ [REQUEST]: { status: 202, body: accepted } });
        await askFor('  Counter@Example.Invalid  ');
        expect((bodies[REQUEST] as { email: string }).email).toBe('counter@example.invalid');
    });

    it('says plainly when email is switched off, rather than pretending', async () => {
        /* Not a fact about the address, so repeating it leaks nothing -- and
           somebody who would otherwise refresh an inbox forever is told to
           ring the office instead. */
        renderReset({
            [REQUEST]: {
                status: 503,
                body: { error: 'Password reset by email is not available on this server. Ring the office and ask for a reset.', code: 'reset.mailUnavailable' },
            },
        });
        fireEvent.change(screen.getByLabelText(/Your email address/), { target: { value: 'counter@example.invalid' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not available on this server/));
        /* And it does NOT move on to ask for a code that cannot exist. */
        expect(screen.queryByLabelText(/The six digit code/)).toBeNull();
    });

    it('passes the throttle refusal through in the server\'s own words', async () => {
        renderReset({
            [REQUEST]: { status: 429, body: { error: 'Too many attempts. Wait 15 minutes, or ring the office.', code: 'throttled' } },
        });
        fireEvent.change(screen.getByLabelText(/Your email address/), { target: { value: 'counter@example.invalid' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Too many attempts/));
    });
});

describe('using the code', () => {
    it('will not submit until there are six digits and a long enough password', async () => {
        renderReset({ [REQUEST]: { status: 202, body: accepted } });
        await askFor('counter@example.invalid');
        const submit = () => screen.getByRole('button', { name: 'Set the new password' });

        expect(submit()).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/The six digit code/), { target: { value: '12345' } });
        fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'long-enough-1' } });
        expect(submit(), 'five digits').toBeDisabled();

        fireEvent.change(screen.getByLabelText(/The six digit code/), { target: { value: '123456' } });
        expect(submit()).toBeEnabled();

        fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'short' } });
        expect(submit(), 'password under eight').toBeDisabled();
    });

    it('keeps the code field to digits', async () => {
        /* A code pasted out of an email arrives with whatever was around it. */
        renderReset({ [REQUEST]: { status: 202, body: accepted } });
        await askFor('counter@example.invalid');
        const field = screen.getByLabelText(/The six digit code/) as HTMLInputElement;
        fireEvent.change(field, { target: { value: ' 12-34 56 ' } });
        expect(field.value).toBe('123456');
    });

    it('says what happened to the other devices, because it is not obvious', async () => {
        const { bodies } = renderReset({
            [REQUEST]: { status: 202, body: accepted },
            [CONFIRM]: { status: 200, body: { ok: true, username: 'uh.counter', revokedSessions: 2 } },
        });
        await askFor('counter@example.invalid');
        fireEvent.change(screen.getByLabelText(/The six digit code/), { target: { value: '123456' } });
        fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'a-brand-new-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set the new password' }));

        await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
        expect(screen.getByText(/signed out/i)).toBeInTheDocument();
        expect(bodies[CONFIRM]).toMatchObject({ email: 'counter@example.invalid', code: '123456' });
    });

    it('repeats what the server says it did, including a removed phone PIN', async () => {
        /* A courier's phone signs in on a PIN held on the device, not on the
           password, so the reset revokes it too -- and the courier is about
           to find their PIN pad gone. Only the server knows whether that
           happened to this account, so the sentence is its own rather than a
           fixed line here that would be wrong for a pharmacist. */
        renderReset({
            [REQUEST]: { status: 202, body: accepted },
            [CONFIRM]: {
                status: 200,
                body: {
                    ok: true, username: 'uh.courier', revokedSessions: 1, revokedDevices: 1,
                    message: 'Your password is changed, every device signed out, and the PIN on '
                        + 'your phone removed. Sign in with the new password, then set up a new PIN.',
                },
            },
        });
        await askFor('courier@example.invalid');
        fireEvent.change(screen.getByLabelText(/The six digit code/), { target: { value: '123456' } });
        fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'a-brand-new-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set the new password' }));

        await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
        expect(screen.getByText(/PIN on your phone removed/)).toBeInTheDocument();
        expect(screen.getByText(/set up a new PIN/)).toBeInTheDocument();
    });

    it('falls back to its own words when the server sends none', async () => {
        /* An older server, or one that answered without a message. The screen
           still has to say what happened rather than show an empty space. */
        renderReset({
            [REQUEST]: { status: 202, body: accepted },
            [CONFIRM]: { status: 200, body: { ok: true, username: 'uh.counter', revokedSessions: 2 } },
        });
        await askFor('counter@example.invalid');
        fireEvent.change(screen.getByLabelText(/The six digit code/), { target: { value: '123456' } });
        fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'a-brand-new-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set the new password' }));

        await waitFor(() => expect(screen.getByText('Password changed')).toBeInTheDocument());
        expect(screen.getByText(/signed out/i)).toBeInTheDocument();
    });

    it('shows the refusal and stays put so the code can be retyped', async () => {
        renderReset({
            [REQUEST]: { status: 202, body: accepted },
            [CONFIRM]: { status: 400, body: { error: 'That code is not valid, or it has expired. Ask for a new one.', code: 'reset.invalidCode' } },
        });
        await askFor('counter@example.invalid');
        fireEvent.change(screen.getByLabelText(/The six digit code/), { target: { value: '000000' } });
        fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'a-brand-new-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set the new password' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not valid, or it has expired/));
        /* Still on the same step: a courier who mistyped one digit should not
           have to ask for another code. */
        expect(screen.getByLabelText(/The six digit code/)).toBeInTheDocument();
    });
});
