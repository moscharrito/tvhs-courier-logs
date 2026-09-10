/* Sign in. Drivers tap their name and enter a PIN (first time: password + new
   PIN). Staff use username and password. Same endpoints the legacy app used. */

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type DriverPick } from '../lib/api';
import { useAuth } from '../app/auth';

type Mode = 'pick' | 'pin' | 'setup' | 'staff';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const routeLabel = (r: string) => (r === 'northbound' ? 'NorthBound' : r === 'southbound' ? 'SouthBound' : r);

export function Login() {
    const { refresh } = useAuth();
    const [drivers, setDrivers] = useState<DriverPick[]>([]);
    const [mode, setMode] = useState<Mode>('pick');
    const [driver, setDriver] = useState<DriverPick | null>(null);
    const [pin, setPin] = useState('');
    const [password, setPassword] = useState('');
    const [username, setUsername] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api<DriverPick[]>('/api/drivers/list').then(setDrivers).catch(() => setDrivers([]));
    }, []);

    const pick = (d: DriverPick) => {
        setDriver(d);
        setPin('');
        setPassword('');
        setError(null);
        setMode(d.hasPin ? 'pin' : 'setup');
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (mode === 'staff') {
                await api('/api/login', { method: 'POST', json: { username, password } });
            } else if (mode === 'pin' && driver) {
                await api('/api/login/pin', { method: 'POST', json: { route: driver.route, pin } });
            } else if (mode === 'setup' && driver) {
                await api('/api/login/pin/setup', { method: 'POST', json: { route: driver.route, password, pin } });
            }
            await refresh();
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Sign in failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="izy-login">
            <div className="izy-login-card">
                <h1>Izy Ops</h1>
                <p className="izy-sub">Izy Global Services LLC</p>
                {error && <div className="izy-alert error" role="alert">{error}</div>}

                {mode === 'pick' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div className="izy-muted">Who is driving?</div>
                        {drivers.map((d) => (
                            <button key={d.route} className="izy-driver" onClick={() => pick(d)} type="button">
                                <span className="izy-avatar">{initials(d.name)}</span>
                                <span><b>{d.name}</b><span>{routeLabel(d.route)} · {d.hasPin ? 'Enter PIN' : 'Set up PIN'}</span></span>
                            </button>
                        ))}
                        {drivers.length === 0 && <div className="izy-muted">No drivers configured yet.</div>}
                        <div style={{ textAlign: 'center', marginTop: 8 }}>
                            <button className="izy-link" type="button" onClick={() => { setMode('staff'); setError(null); }}>Staff sign in</button>
                        </div>
                    </div>
                )}

                {(mode === 'pin' || mode === 'setup') && driver && (
                    <form onSubmit={(e) => { void submit(e); }}>
                        <button className="izy-link" type="button" onClick={() => setMode('pick')} style={{ alignSelf: 'flex-start' }}>Back</button>
                        <div className="izy-driver" style={{ cursor: 'default' }}>
                            <span className="izy-avatar">{initials(driver.name)}</span>
                            <span><b>{driver.name}</b><span>{routeLabel(driver.route)}</span></span>
                        </div>
                        {mode === 'setup' && (
                            <label className="izy-field">Your password (first time only)
                                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                            </label>
                        )}
                        <label className="izy-field">{mode === 'setup' ? 'Create a 4 to 6 digit PIN' : 'PIN'}
                            <input type="password" inputMode="numeric" pattern="\d{4,6}" autoComplete="one-time-code" value={pin} onChange={(e) => setPin(e.target.value)} required autoFocus />
                        </label>
                        <button className="izy-btn" type="submit" disabled={busy}>{mode === 'setup' ? 'Set PIN and sign in' : 'Sign in'}</button>
                        {mode === 'pin' && (
                            <button className="izy-link" type="button" onClick={() => { setMode('setup'); setPin(''); }}>Forgot PIN? Use password</button>
                        )}
                    </form>
                )}

                {mode === 'staff' && (
                    <form onSubmit={(e) => { void submit(e); }}>
                        <button className="izy-link" type="button" onClick={() => setMode('pick')} style={{ alignSelf: 'flex-start' }}>Back</button>
                        <label className="izy-field">Username
                            <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
                        </label>
                        <label className="izy-field">Password
                            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        <button className="izy-btn" type="submit" disabled={busy}>Sign in</button>
                    </form>
                )}
            </div>
        </div>
    );
}
