/* Sign in.
 *
 * Step 1 asks which project you are signing in to, because the courier list
 * is per project: TVHS has two drivers by route, UH will have twenty. Step 2
 * shows that project's couriers (PIN, or password plus a new PIN the first
 * time). Staff sign in with username and password from any step; their
 * projects come from their memberships after authentication. */

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type DriverPick } from '../lib/api';
import { useAuth } from '../app/auth';
import { Loading } from '../app/Loading';

type Mode = 'project' | 'pick' | 'pin' | 'setup' | 'staff';
interface LoginProject { code: string; name: string }

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const routeLabel = (r: string) => (r === 'northbound' ? 'NorthBound' : r === 'southbound' ? 'SouthBound' : r);

export function Login() {
    const { refresh } = useAuth();
    const [projects, setProjects] = useState<LoginProject[] | null>(null);
    const [project, setProject] = useState<LoginProject | null>(null);
    const [drivers, setDrivers] = useState<DriverPick[] | null>(null);
    const [mode, setMode] = useState<Mode>('project');
    const [driver, setDriver] = useState<DriverPick | null>(null);
    const [pin, setPin] = useState('');
    const [password, setPassword] = useState('');
    const [username, setUsername] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api<LoginProject[]>('/api/login/projects').then(setProjects).catch(() => setProjects([]));
    }, []);

    const chooseProject = (p: LoginProject) => {
        setProject(p);
        setDrivers(null);
        setError(null);
        setMode('pick');
        api<DriverPick[]>(`/api/drivers/list?project=${encodeURIComponent(p.code)}`).then(setDrivers).catch(() => setDrivers([]));
    };

    const pick = (d: DriverPick) => {
        setDriver(d);
        setPin('');
        setPassword('');
        setError(null);
        setMode(d.hasPin ? 'pin' : 'setup');
    };

    const backToProjects = () => {
        setMode('project');
        setProject(null);
        setDriver(null);
        setError(null);
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

    const staffLink = (
        <div style={{ textAlign: 'center', marginTop: 8 }}>
            <button className="izy-link" type="button" onClick={() => { setMode('staff'); setError(null); }}>Staff sign in</button>
        </div>
    );

    return (
        <div className="izy-login">
            <div className="izy-login-card">
                <h1>TAG</h1>
                <p className="izy-sub">Izy Global Services LLC</p>
                {error && <div className="izy-alert error" role="alert">{error}</div>}

                {mode === 'project' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div className="izy-muted">Which project are you signing in to?</div>
                        {projects === null ? <Loading label="Loading projects" /> : projects.map((p) => (
                            <button key={p.code} className="izy-driver" onClick={() => chooseProject(p)} type="button">
                                <span className="izy-avatar">{initials(p.name)}</span>
                                <span><b>{p.name}</b><span>{p.code}</span></span>
                            </button>
                        ))}
                        {projects?.length === 0 && <div className="izy-muted">No projects configured yet.</div>}
                        {staffLink}
                    </div>
                )}

                {mode === 'pick' && project && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <button className="izy-link" type="button" onClick={backToProjects} style={{ alignSelf: 'flex-start' }}>Back</button>
                        <div className="izy-muted">{project.name} · who is driving?</div>
                        {drivers === null ? <Loading label="Loading drivers" /> : drivers.map((d) => (
                            <button key={d.route} className="izy-driver" onClick={() => pick(d)} type="button">
                                <span className="izy-avatar">{initials(d.name)}</span>
                                <span><b>{d.name}</b><span>{routeLabel(d.route)} · {d.hasPin ? 'Enter PIN' : 'Set up PIN'}</span></span>
                            </button>
                        ))}
                        {drivers?.length === 0 && <div className="izy-muted">No drivers are set up for this project yet. Use staff sign in, or ask an admin to add you.</div>}
                        {staffLink}
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
                        <button className="izy-link" type="button" onClick={backToProjects} style={{ alignSelf: 'flex-start' }}>Back</button>
                        <label className="izy-field">Username
                            <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
                        </label>
                        <label className="izy-field">Password
                            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        <button className="izy-btn" type="submit" disabled={busy}>Sign in</button>
                        <div className="izy-muted" style={{ textAlign: 'center' }}>Your projects appear after you sign in.</div>
                    </form>
                )}
            </div>
        </div>
    );
}
