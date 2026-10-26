/* Resetting a forgotten password, from the sign-in screen.
 *
 * Two steps on one card: an address, then the code that was emailed and a new
 * password. Its own component rather than a fifth branch of Login's state
 * machine, which already has seven modes and does not need to know about any
 * of this.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN WILL NOT DO.
 *
 * It will not say whether an address has an account. The server answers
 * identically either way (see core/auth/password-reset.ts) and a screen that
 * helpfully added "we don't recognise that email" would hand out the staff
 * directory the server is careful not to.
 *
 * So after step one it always moves on, and the wording is honest about the
 * conditional: "if that address belongs to an account". A courier who
 * mistyped finds out by never getting a code, which is the same way they
 * would find out if the server told them -- only without telling a stranger
 * who works here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND IT SAYS WHEN EMAIL IS OFF.
 *
 * `reset.mailUnavailable` is a fact about the server, not about the address,
 * so it is shown in full. SES is in sandbox today, which means a code sent to
 * an unverified address is accepted by this screen and never arrives. That
 * case is indistinguishable from a wrong address by design, which is exactly
 * why the last line of step two tells somebody who is stuck to ring the
 * office instead of refreshing an inbox.
 */

import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { SecretInput } from '../app/SecretInput';

type Step = 'email' | 'code' | 'done';

export function PasswordReset({ onBack }: { onBack: () => void }) {
    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const ask = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const res = await api<{ message: string }>('/api/password-reset/request', {
                method: 'POST', json: { email: email.trim().toLowerCase() },
            });
            setNote(res.message);
            setStep('code');
        } catch (err) {
            /* The only refusals worth repeating are the ones that are about
               this server or this caller: email switched off, and too many
               attempts. Neither says anything about the address. */
            setError(err instanceof ApiError ? err.message : 'That did not go through. Try again.');
        } finally {
            setBusy(false);
        }
    };

    const confirm = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            /* THE SERVER'S OWN SENTENCE, because it is the only one that
               knows whether a phone PIN was removed. A courier's phone signs
               in on a PIN that the reset revokes (core/auth/password-reset.ts)
               and a pharmacist has never had one, so a fixed line here is
               wrong for one of them whichever way it is written. */
            const res = await api<{ message?: string }>('/api/password-reset/confirm', {
                method: 'POST',
                json: { email: email.trim().toLowerCase(), code: code.trim(), password },
            });
            setNote(res.message ?? null);
            setStep('done');
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'That did not go through. Try again.');
        } finally {
            setBusy(false);
        }
    };

    if (step === 'done') {
        return (
            <div>
                <h2>Password changed</h2>
                <p className="izy-muted">
                    {note ?? 'Every device signed in as you has been signed out, including any phone '
                        + 'you set up. Sign in with the new password.'}
                </p>
                <button className="izy-btn" type="button" onClick={onBack}>Back to sign in</button>
            </div>
        );
    }

    return (
        <div>
            <h2>Reset your password</h2>
            {error && <div className="izy-alert error" role="alert">{error}</div>}

            {step === 'email' && (
                <form onSubmit={(e) => { void ask(e); }}>
                    <label className="izy-field">Your email address
                        <input
                            type="email"
                            value={email}
                            onChange={(ev) => setEmail(ev.target.value)}
                            autoComplete="email"
                            required
                            autoFocus
                        />
                        <span className="izy-muted izy-field-note">
                            The address the office has for you. Not your username.
                        </span>
                    </label>
                    <button className="izy-btn" type="submit" disabled={busy || email.trim() === ''}>
                        {busy ? 'Sending' : 'Send me a code'}
                    </button>
                    <button className="izy-link" type="button" onClick={onBack}>Back to sign in</button>
                </form>
            )}

            {step === 'code' && (
                <form onSubmit={(e) => { void confirm(e); }}>
                    {note && <p className="izy-muted">{note}</p>}
                    <label className="izy-field">The six digit code
                        <input
                            inputMode="numeric"
                            pattern="\d{6}"
                            maxLength={6}
                            autoComplete="one-time-code"
                            value={code}
                            onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))}
                            required
                            autoFocus
                        />
                    </label>
                    <SecretInput
                        label="New password"
                        value={password}
                        onChange={(ev) => setPassword(ev.target.value)}
                        autoComplete="new-password"
                        required
                    />
                    <button
                        className="izy-btn"
                        type="submit"
                        disabled={busy || code.length !== 6 || password.length < 8}
                    >
                        {busy ? 'Saving' : 'Set the new password'}
                    </button>
                    <p className="izy-muted izy-field-note">
                        The code expires in 15 minutes and works once. If nothing arrives,
                        check the address you typed, then ring the office — they can reset it
                        for you.
                    </p>
                    <button className="izy-link" type="button" onClick={onBack}>Back to sign in</button>
                </form>
            )}
        </div>
    );
}
