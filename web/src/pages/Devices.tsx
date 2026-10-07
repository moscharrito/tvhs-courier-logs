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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FIRST TWO SECTIONS ARE FOR COURIERS AND NOBODY ELSE.
 *
 * University Health's pharmacy staff were being shown a form offering to
 * reduce their sign-in to four digits, on a workstation a dispensary shares.
 * The case for a four-digit PIN is in devices.ts and all of it rests on a
 * phone one person keeps; a shared desktop is not that phone, and the account
 * behind it reaches patient names, addresses and proof-of-delivery
 * photographs. It is the first thing a hospital security questionnaire asks
 * about.
 *
 * The server refuses it now, which is the part that matters and the part a
 * reviewer can test. This is the other half: not offering what cannot be
 * done. Hiding a form whose endpoint still worked would have been the
 * decoration, not the fix.
 *
 * WHAT IS LEFT IS STILL WORTH A PAGE. Changing your own password and seeing
 * where you are signed in are the two things any account needs, so for
 * everybody else this is an account page with those two things and a title
 * that says so.
 *
 * NO IP COLUMN unless an administrator is reading. The address is still
 * recorded, because an access review is read from it and University Health
 * will ask for one; the server simply stops handing it to the account it
 * belongs to. See the note on /api/me/sessions. A pharmacist does not
 * identify their own browser by its network address, and a column of them is
 * a field to be explained in a questionnaire for no gain.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmtWhen, type SessionSummary, type EnrolledDevice, type DeviceIdentity } from '../lib/api';
import { useAuth } from '../app/auth';
import { Pager, usePaged } from '../app/Pager';

export function Devices() {
    const { user, signOut } = useAuth();
    /* Platform role, the same rule the server enforces in
       MAY_USE_DEVICE_PIN. A site lead is a driver here and works from a phone
       at a counter exactly as a courier does. */
    const mayUsePin = user?.role === 'driver';
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
            /* The device calls are not made for an account that may not use a
               PIN. Asking and ignoring the answer would put two requests
               about a feature they do not have into their browser's network
               log, which is the sort of thing that gets screenshotted into a
               security questionnaire. */
            const [s, d, i] = await Promise.all([
                api<SessionSummary[]>('/api/me/sessions'),
                mayUsePin ? api<EnrolledDevice[]>('/api/devices') : Promise.resolve([]),
                mayUsePin ? api<DeviceIdentity>('/api/login/device') : Promise.resolve({ enrolled: false } as DeviceIdentity),
            ]);
            setSessions(s);
            setDevices(d);
            setIdentity(i);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Failed to load' });
        }
    }, [mayUsePin]);
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
    /* Whether any row came back with an address on it. The server decides
       (see /api/me/sessions); this only renders what it was given. */
    const showIp = (sessions ?? []).some((s) => typeof s.ip === 'string' && s.ip !== '');

    const pagedDevices = usePaged(devices ?? []);
    const pagedSessions = usePaged(sessions ?? []);

    return (
        <>
            <h1>{mayUsePin ? 'Devices and sign-in' : 'Your account'}</h1>
            <p className="izy-sub">
                {mayUsePin
                    ? 'Set up this phone so a PIN signs you in, see which phones are set up, and sign out anywhere you do not recognize.'
                    : 'Change your password, and sign out anywhere you do not recognize.'}
            </p>
            {msg && <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

            {/* The forced case is the only reason an account in that state
                can reach this page at all: Layout sends them here and the
                server refuses everything else. */}
            <ChangePassword required={user?.mustChangePassword === true} />

            {mayUsePin && (<>
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
            </>)}

            <div className="izy-card">
                <h2>Signed in</h2>
                <p className="izy-muted">
                    {mayUsePin
                        ? 'Every browser or phone where you are signed in right now. Not the same as the list above: a phone can be set up and not signed in, or signed in without being set up.'
                        : 'Every browser where you are signed in right now. Sign out any you do not recognize, then change your password.'}
                </p>
                {sessions === null ? <div className="izy-muted">Loading...</div> : (
                    <>
                    <table className="izy-table">
                        {/* The IP column only when the server sent one, which
                            it does for an administrator and not for the
                            account the row belongs to. Driven by the data
                            rather than by a second copy of the rule here, so
                            the two cannot disagree. */}
                        <thead><tr>
                            <th>Device</th>
                            {showIp && <th>IP</th>}
                            <th>Signed in</th><th>Last seen</th><th></th>
                        </tr></thead>
                        <tbody>
                            {pagedSessions.rows.map((s) => (
                                <tr key={s.id}>
                                    <td>{s.device} {s.current && <span className="izy-pill">this device</span>}</td>
                                    {showIp && <td><code>{s.ip}</code></td>}
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

/* ───────────────────────────────────────────── changing your own password
 *
 * There was no way to. The only endpoint that could change a password was
 * the admin one, so every rotation went through Izy: an administrator set a
 * University Health user's credential and then told them what it was. For an
 * account that reaches patient data under a business associate agreement
 * that is the wrong shape; a credential should be known to the person using
 * it and to nobody else.
 *
 * Here rather than on a page of its own, because this page is already the
 * one about your own account and sign-in, and the thing most likely to make
 * somebody change a password is reading the list of sessions below it and
 * not recognising one.
 */
/**
 * Changing your own password.
 *
 * `required` is the forced case: an administrator chose this password and the
 * server is refusing everything else until it is replaced. Somebody in that
 * state is redirected here from wherever they were going, so the card has to
 * say why they have arrived somewhere they did not ask for. Landing on a
 * routine-looking form after being bounced reads as the site being broken,
 * and the next thing that happens is a telephone call.
 */
function ChangePassword({ required = false }: { required?: boolean }) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setNote(null);
        try {
            const res = await api<{ revokedSessions: number }>('/api/me/password', {
                method: 'POST', json: { currentPassword: current, password: next },
            });
            setCurrent('');
            setNext('');
            /* Say what it did to the other devices. A change made because
               somebody thinks their password is known is only reassuring if
               the reader can see that the other sessions went. */
            setNote({
                kind: 'ok',
                text: res.revokedSessions === 0
                    ? 'Password changed. You were not signed in anywhere else.'
                    : `Password changed, and ${res.revokedSessions} other ${res.revokedSessions === 1 ? 'session was' : 'sessions were'} signed out.`,
            });
        } catch (err) {
            setNote({
                kind: 'error',
                text: err instanceof ApiError ? err.message : 'Could not change your password',
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="izy-card">
            <h2>{required ? 'Choose a password' : 'Your password'}</h2>
            {required && (
                <div className="izy-alert warn" role="status">
                    The password you were given was set for you, and has to be changed before you can go
                    further. Nothing else on the site will work until it is. Nobody can see what you choose
                    here, including us.
                </div>
            )}
            <p className="izy-sub">
                {required
                    ? 'Pick something only you know. Changing it signs you out anywhere else you are signed in.'
                    : 'Changing it signs you out everywhere else, which is usually the point. This browser stays signed in.'}
            </p>
            {note && (
                <div className={`izy-alert ${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>
                    {note.text}
                </div>
            )}
            <form className="izy-row" onSubmit={(e) => { void submit(e); }}>
                <label className="izy-field">
                    Current password
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={current}
                        onChange={(e) => setCurrent(e.target.value)}
                        required
                    />
                </label>
                <label className="izy-field">
                    New password
                    <input
                        type="password"
                        autoComplete="new-password"
                        value={next}
                        onChange={(e) => setNext(e.target.value)}
                        required
                        minLength={8}
                    />
                </label>
                <button className="izy-btn" type="submit" disabled={busy || !current || !next}>
                    {busy ? 'Changing...' : 'Change password'}
                </button>
            </form>
        </div>
    );
}
