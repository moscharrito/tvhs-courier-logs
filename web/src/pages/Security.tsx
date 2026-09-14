/* Two-factor authentication: setting it up, and living with it.
 *
 * Ticket 4.3. The screen has to work for somebody standing at a desk with a
 * phone in one hand, once, and then never again for months. So it is linear:
 * scan this, type the code it shows, write these ten codes down. No settings
 * to weigh up, no options that only make sense if you already know how TOTP
 * works.
 *
 * The recovery codes are shown exactly once, because the server keeps only
 * their hashes. That is said plainly on the screen rather than implied, and
 * the step cannot be dismissed by accident.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { api, ApiError, type MfaStatus } from '../lib/api';
import { useAuth } from '../app/auth';
import { Loading } from '../app/Loading';

interface EnrolStart { secret: string; uri: string }

/** The QR as an inline SVG: no canvas, no image host, nothing to load. */
function QrCode({ text }: { text: string }) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const cells: string[] = [];
    for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
            if (qr.isDark(row, col)) cells.push(`M${col},${row}h1v1h-1z`);
        }
    }
    const quiet = 2;
    const size = count + quiet * 2;
    return (
        <svg
            viewBox={`0 0 ${size} ${size}`}
            width={220}
            height={220}
            role="img"
            aria-label="QR code for your authenticator app"
            style={{ background: '#fff', borderRadius: 8, padding: 4 }}
        >
            <g transform={`translate(${quiet},${quiet})`} fill="#111">
                <path d={cells.join('')} />
            </g>
        </svg>
    );
}

export function Security() {
    const { user, refresh } = useAuth();
    const [status, setStatus] = useState<MfaStatus | null>(null);
    const [start, setStart] = useState<EnrolStart | null>(null);
    const [codes, setCodes] = useState<string[] | null>(null);
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const codeField = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        setStatus(await api<MfaStatus>('/api/me/mfa'));
    }, []);

    useEffect(() => { void load().catch(() => setStatus(null)); }, [load]);
    useEffect(() => { if (start) codeField.current?.focus(); }, [start]);

    const run = async (what: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await what();
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Something went wrong');
        } finally {
            setBusy(false);
        }
    };

    const beginEnrol = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            setStart(await api<EnrolStart>('/api/me/mfa/enrol', { method: 'POST', json: { password } }));
            setPassword('');
        });
    };

    const confirm = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const res = await api<{ recoveryCodes: string[] }>('/api/me/mfa/confirm', { method: 'POST', json: { code } });
            setCodes(res.recoveryCodes);
            setStart(null);
            setCode('');
            await load();
            /* Deliberately NOT refreshing the session here. Doing so clears
               the setup gate, the shell swaps this screen for the project
               list, and the ten recovery codes are gone: shown once, by
               design, and never seen. Found by walking the flow in a browser,
               where unit tests that render this screen on its own could not
               see it. The refresh happens when the codes are acknowledged. */
        });
    };

    /* The one exit from the codes screen, and the moment the gate lifts. */
    const acknowledgeCodes = () => {
        setCodes(null);
        void refresh();
    };

    const reissue = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const res = await api<{ recoveryCodes: string[] }>('/api/me/mfa/recovery-codes', { method: 'POST', json: { password, code } });
            setCodes(res.recoveryCodes);
            setPassword('');
            setCode('');
            await load();
        });
    };

    const disable = (e: FormEvent) => {
        e.preventDefault();
        void run(async () => {
            await api('/api/me/mfa', { method: 'DELETE', json: { password, code } });
            setPassword('');
            setCode('');
            await load();
            await refresh();
        });
    };

    if (!status) return <Loading label="Loading security settings" />;

    return (
        <div className="izy-page">
            <h1>Two-factor authentication</h1>
            <p className="izy-muted">
                A second step when you sign in: a six-digit code from an app on your phone.
                {status.required
                    ? ' Your role requires it, because it can read patient information for the whole contract.'
                    : ' Your role does not require it, and you can still turn it on.'}
            </p>

            {error && <div className="izy-alert error" role="alert">{error}</div>}

            {/* The codes, shown once. Deliberately above everything else on the
                page while they are on screen: this is the step people skip. */}
            {codes && (
                <section className="izy-card">
                    <h2>Write these down now</h2>
                    <p>
                        Ten recovery codes. Each one signs you in once, in place of a code from
                        your phone. <b>This is the only time they are shown.</b> They are stored
                        as one-way hashes, so nobody, including us, can show them to you again.
                    </p>
                    <ul className="izy-codes" style={{ columns: 2, fontFamily: 'ui-monospace, monospace', listStyle: 'none', padding: 0 }}>
                        {codes.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                    <button className="izy-btn" type="button" onClick={acknowledgeCodes}>
                        I have written them down
                    </button>
                </section>
            )}

            {!codes && status.confirmed && (
                <section className="izy-card">
                    <h2>Turned on</h2>
                    <p className="izy-muted">
                        {status.recoveryCodesRemaining} recovery {status.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
                        {status.recoveryCodesRemaining <= 2 && ' That is few enough to be worth replacing.'}
                    </p>

                    <form onSubmit={reissue} style={{ marginTop: 12 }}>
                        <h3>New recovery codes</h3>
                        <p className="izy-muted">The ones you have now stop working.</p>
                        <label className="izy-field">Your password
                            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        <label className="izy-field">Code from your app
                            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,9}" value={code} onChange={(e) => setCode(e.target.value)} required />
                        </label>
                        <button className="izy-btn" type="submit" disabled={busy}>Replace my recovery codes</button>
                    </form>

                    {!status.enforced && (
                        <form onSubmit={disable} style={{ marginTop: 20 }}>
                            <h3>Turn it off</h3>
                            <p className="izy-muted">Your password and a current code, same as above.</p>
                            <button className="izy-btn secondary" type="submit" disabled={busy || !password || !code}>
                                Turn off two-factor authentication
                            </button>
                        </form>
                    )}
                    {status.enforced && (
                        <p className="izy-muted" style={{ marginTop: 20 }}>
                            It cannot be turned off for your role. If you lose your phone, use a
                            recovery code, or ask an administrator to reset it.
                        </p>
                    )}
                </section>
            )}

            {!codes && !status.confirmed && !start && (
                <section className="izy-card">
                    <h2>Set it up</h2>
                    {status.enforced && (
                        <div className="izy-alert" role="status">
                            Until this is done, your account can reach this page and nothing else.
                        </div>
                    )}
                    <p>
                        You will need an authenticator app on your phone: Google Authenticator,
                        Microsoft Authenticator, 1Password, or any other. Any of them will do.
                    </p>
                    <form onSubmit={beginEnrol}>
                        <label className="izy-field">Your password
                            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        <button className="izy-btn" type="submit" disabled={busy}>Start</button>
                    </form>
                </section>
            )}

            {!codes && start && (
                <section className="izy-card">
                    <h2>Scan this</h2>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <QrCode text={start.uri} />
                        <div style={{ minWidth: 220 }}>
                            <p className="izy-muted">Cannot scan? Type this into the app instead:</p>
                            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 16, letterSpacing: 1 }}>{start.secret}</p>
                            <p className="izy-muted">
                                Account <b>{user?.username}</b>, issuer <b>TAG</b>, time-based, six digits.
                            </p>
                        </div>
                    </div>
                    <form onSubmit={confirm} style={{ marginTop: 16 }}>
                        <label className="izy-field">Now type the code it shows
                            <input
                                ref={codeField}
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                pattern="[0-9 ]{6,9}"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                required
                            />
                        </label>
                        <button className="izy-btn" type="submit" disabled={busy}>Turn it on</button>
                        <button className="izy-link" type="button" onClick={() => { setStart(null); setCode(''); }}>Cancel</button>
                    </form>
                </section>
            )}
        </div>
    );
}
