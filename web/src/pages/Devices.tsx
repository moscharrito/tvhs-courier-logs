/* This phone, your phones, and everywhere you are signed in.
 *
 * Ticket 5.4. The device enrolment built in ticket 2.3 was a complete, tested
 * API that nothing called: a courier had no way to reach a PIN, so they typed
 * a username and password at a pharmacy counter, and the device-bound second
 * factor that is the whole justification for accepting four digits on a
 * screen showing PHI did not exist in practice.
 *
 * Three sections, because they are three different things and the old page
 * called one of them by the other's name:
 *
 *   This phone   enrol it, or say it is already enrolled
 *   Your phones  enrolled devices, which is what "device" means everywhere
 *                else in this system
 *   Signed in    live sessions, which is a different list and a different
 *                revocation
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtWhen, type SessionSummary, type EnrolledDevice, type DeviceIdentity } from '../lib/api';
import { useAuth } from '../app/auth';
import { Pager, usePaged } from '../app/Pager';

export function Devices() {
    const { user, signOut } = useAuth();
    const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
    const [devices, setDevices] = useState<EnrolledDevice[] | null>(null);
    const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

    const [password, setPassword] = useState('');
    const [pin, setPin] = useState('');
    const [pinAgain, setPinAgain] = useState('');
    const [label, setLabel] = useState('');
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const [s, d, i] = await Promise.all([
                api<SessionSummary[]>('/api/me/sessions'),
                api<EnrolledDevice[]>('/api/devices'),
                api<DeviceIdentity>('/api/login/device'),
            ]);
            setSessions(s);
            setDevices(d);
            setIdentity(i);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Failed to load' });
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const revoke = async (url: string, label_: string, endsThisSession = false) => {
        setMsg(null);
        try {
            await api(url, { method: 'DELETE' });
            /* Signing THIS phone out removes its PIN and ends the session it
               is being done from, by design. Reloading the page afterwards
               asks the server who is signed in, gets a 401, and leaves a
               "Not authenticated" banner over a screen still showing the
               phone that was just removed. Somebody reading that cannot tell
               whether it worked. Ending the session properly puts them on the
               sign-in page, which is the honest answer and the one they were
               heading for anyway. */
            if (endsThisSession) {
                await signOut();
                return;
            }
            setMsg({ kind: 'ok', text: label_ });
            await load();
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Request failed' });
        }
    };

    const enrol = (e: FormEvent) => {
        e.preventDefault();
        setMsg(null);
        if (pin !== pinAgain) {
            setMsg({ kind: 'error', text: 'The two PINs do not match.' });
            return;
        }
        setBusy(true);
        void (async () => {
            try {
                /* The password again, even though they are signed in: enrolling
                   a phone is what lets four digits stand in for it afterwards,
                   so an unlocked screen must not be enough to do it. */
                await api('/api/devices/enrol', {
                    method: 'POST',
                    json: { username: user?.username, password, pin, label: label.trim() },
                });
                setPassword(''); setPin(''); setPinAgain(''); setLabel('');
                setMsg({ kind: 'ok', text: 'This phone is set up. Next time, your PIN is enough.' });
                await load();
            } catch (err) {
                setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not set up this phone' });
            } finally {
                setBusy(false);
            }
        })();
    };

    const thisPhoneEnrolled = identity?.enrolled === true;

    const pagedDevices = usePaged(devices ?? []);
    const pagedSessions = usePaged(sessions ?? []);

    return (
        <>
            <h1>Devices and sign-in</h1>
            <p className="izy-sub">
                Set up this phone so a PIN signs you in, see which phones are set up, and sign out
                anywhere you do not recognize.
            </p>
            {msg && <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

            <div className="izy-card">
                <h2>This phone</h2>
                {identity === null ? <div className="izy-muted">Loading...</div> : thisPhoneEnrolled ? (
                    <p>
                        Set up already. Next time you open the app it will ask for your PIN instead of
                        your password. To change the PIN, sign out this phone below and set it up again.
                    </p>
                ) : (
                    <>
                        <p>
                            Set this phone up once and a four-digit PIN signs you in afterwards. The PIN only
                            works on this phone: it is useless to anybody who does not have it.
                        </p>
                        <p className="izy-muted">
                            Only do this on a phone you keep. If you lose it, tell dispatch and they will cut
                            it off.
                        </p>
                        <form onSubmit={enrol}>
                            <label className="izy-field">Your password
                                <input
                                    type="password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                />
                            </label>
                            <label className="izy-field">Choose a PIN (4 to 6 digits)
                                <input
                                    type="password"
                                    inputMode="numeric"
                                    pattern="\d{4,6}"
                                    autoComplete="new-password"
                                    value={pin}
                                    onChange={(e) => setPin(e.target.value)}
                                    required
                                />
                            </label>
                            <label className="izy-field">PIN again
                                <input
                                    type="password"
                                    inputMode="numeric"
                                    pattern="\d{4,6}"
                                    autoComplete="new-password"
                                    value={pinAgain}
                                    onChange={(e) => setPinAgain(e.target.value)}
                                    required
                                />
                            </label>
                            <label className="izy-field">What to call this phone (optional)
                                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ada's phone" />
                            </label>
                            <button className="izy-btn" type="submit" disabled={busy}>
                                {busy ? 'Setting up' : 'Set up this phone'}
                            </button>
                        </form>
                    </>
                )}
            </div>

            <div className="izy-card">
                <h2>Your phones</h2>
                <p className="izy-muted">
                    Phones set up to sign in with a PIN. Signing one out here removes the PIN and ends
                    whatever is signed in on it.
                </p>
                {devices === null ? <div className="izy-muted">Loading...</div> : devices.length === 0 ? (
                    <div className="izy-muted">No phones are set up yet.</div>
                ) : (
                    <>
                    <table className="izy-table">
                        <thead><tr><th>Phone</th><th>Set up</th><th>Last used</th><th></th></tr></thead>
                        <tbody>
                            {pagedDevices.rows.map((d) => (
                                <tr key={d.id}>
                                    <td>
                                        {d.label} {d.current && <span className="izy-pill">this phone</span>}
                                        {d.revokedAt && <span className="izy-pill">signed out</span>}
                                        <div className="izy-muted">{d.userAgent}</div>
                                    </td>
                                    <td>{fmtWhen(d.createdAt)}</td>
                                    <td>{fmtWhen(d.lastSeenAt)}</td>
                                    <td style={{ textAlign: 'right' }}>
                                        {!d.revokedAt && (
                                            <button
                                                className="izy-btn danger small"
                                                type="button"
                                                onClick={() => { void revoke(`/api/devices/${d.id}`, 'Phone signed out', d.current); }}
                                            >
                                                Sign out
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                        <Pager of={pagedDevices} noun="phones" />
                    </>
                )}
            </div>

            <div className="izy-card">
                <h2>Signed in</h2>
                <p className="izy-muted">
                    Every browser or phone where you are signed in right now. Not the same as the list
                    above: a phone can be set up and not signed in, or signed in without being set up.
                </p>
                {sessions === null ? <div className="izy-muted">Loading...</div> : (
                    <>
                    <table className="izy-table">
                        <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead>
                        <tbody>
                            {pagedSessions.rows.map((s) => (
                                <tr key={s.id}>
                                    <td>{s.device} {s.current && <span className="izy-pill">this device</span>}</td>
                                    <td><code>{s.ip}</code></td>
                                    <td>{fmtWhen(s.created_at)}</td>
                                    <td>{fmtWhen(s.last_seen_at)}</td>
                                    <td style={{ textAlign: 'right' }}>
                                        {!s.current && (
                                            <button
                                                className="izy-btn danger small"
                                                type="button"
                                                onClick={() => { void revoke(`/api/me/sessions/${s.id}`, 'Device signed out'); }}
                                            >
                                                Sign out
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                        <Pager of={pagedSessions} noun="sessions" />
                    </>
                )}
                <div style={{ marginTop: 12 }}>
                    <button
                        className="izy-btn danger"
                        type="button"
                        disabled={!sessions || sessions.length < 2}
                        onClick={() => { void revoke('/api/me/sessions/others', 'All other devices signed out'); }}
                    >
                        Sign out all other devices
                    </button>
                </div>
            </div>
        </>
    );
}
