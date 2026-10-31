/* Sign in.
 *
 * Step 1 asks which project you are signing in to, because the courier list
 * is per project: TVHS has two drivers by route, UH will have twenty. Step 2
 * shows that project's couriers. What picking one does depends on whether
 * that project uses routes:
 *
 *   with a route     PIN, or password plus a new PIN the first time. TVHS,
 *                    unchanged.
 *   without a route  password only, and then the run screen offers to set
 *                    the phone up (ticket 5.4), after which this page opens
 *                    on their own PIN lock screen instead.
 *
 * The routeless courier is deliberately not offered a route-style PIN. That
 * PIN works from any device; the device-bound one from 5.4 does not, and
 * adding a second four-digit any-device route to PHI would undo it.
 *
 * Staff sign in with username and password from any step; their projects
 * come from their memberships after authentication. There is no second step:
 * the two-factor prompt that lived here between tickets 4.3 and 5.10 went
 * with the feature.
 *
 * Before any of that: if this phone has been set up (ticket 2.3, reachable
 * since 5.4), the first thing shown is a PIN and the courier's own name. That
 * is the point of the whole enrolment mechanism, and until 5.4 there was no
 * screen that used it, so couriers typed a username and password at a
 * pharmacy counter instead.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE URL PER CONTRACT: /uh AND /tvhs SKIP STEP 1.
 *
 * A University Health pharmacist opening the root is asked to choose between
 * their contract and somebody else's, named. It is a question they cannot
 * get wrong and should never have been asked, and it discloses that the
 * other contract exists. /uh and /tvhs answer it for them.
 *
 * THIS IS NOT A BOUNDARY, and must not be described as one. Anybody may type
 * either path; what changes is what each audience is SHOWN by default. The
 * separation that matters is done by the server, which authenticates and
 * then scopes every answer to the caller's memberships.
 *
 * The segment is matched against the project list the server already sends,
 * never against a list written here. A code this application does not have
 * -- a typo, an old bookmark, a third contract added later -- therefore
 * falls through to the picker, which is a working page rather than a dead
 * end. Nothing has to be edited here when a contract is added.
 *
 * The phone's own lock screen still wins. A courier who has enrolled this
 * handset gets their PIN whatever the URL says, because that screen is about
 * who is holding the phone and not about which contract they drive for. */

import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, type DriverPick, type DeviceIdentity } from '../lib/api';
import { useAuth } from '../app/auth';
import { SecretInput } from '../app/SecretInput';
import { CardButton } from '../app/Glass';
import { PasswordReset } from './PasswordReset';
import { Loading } from '../app/Loading';

type Mode = 'project' | 'pick' | 'pin' | 'setup' | 'password' | 'staff' | 'device' | 'reset';
interface LoginProject { code: string; name: string }

/** The first path segment, lowercased. Null at the root. */
const firstSegment = (pathname: string): string | null =>
    pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? null;

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const routeLabel = (r: string | null) => (r === 'northbound' ? 'NorthBound' : r === 'southbound' ? 'SouthBound' : r ?? '');

/** What picking this person will ask them for, said before they tap. */
const pickHint = (d: DriverPick) => (d.route === null
    ? 'Sign in with your password'
    : `${routeLabel(d.route)} · ${d.hasPin ? 'Enter PIN' : 'Set up PIN'}`);

export function Login() {
    const { refresh } = useAuth();
    const { pathname } = useLocation();
    const [projects, setProjects] = useState<LoginProject[] | null>(null);
    /** Who this phone belongs to, when it has been set up. */
    const [phone, setPhone] = useState<DeviceIdentity | null>(null);
    const [project, setProject] = useState<LoginProject | null>(null);
    const [drivers, setDrivers] = useState<DriverPick[] | null>(null);
    const [mode, setMode] = useState<Mode>('project');
    const [driver, setDriver] = useState<DriverPick | null>(null);
    const [pin, setPin] = useState('');
    const [password, setPassword] = useState('');
    const [username, setUsername] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    /* Null until the list arrives, and null for ever on a path that names no
       project. Derived rather than held: there is one source of truth for
       "which project", and it is the one the server sent. */
    const urlCode = firstSegment(pathname);
    const pinned = projects?.find((p) => p.code.toLowerCase() === urlCode) ?? null;

    useEffect(() => {
        api<LoginProject[]>('/api/login/projects').then(setProjects).catch(() => setProjects([]));
    }, []);

    /* Asked once, before anything is drawn. An enrolled phone goes straight to
       its own lock screen; every other phone never notices this happened. */
    useEffect(() => {
        api<DeviceIdentity>('/api/login/device')
            .then((d) => {
                setPhone(d);
                if (d.enrolled && d.hasPin) setMode('device');
            })
            .catch(() => setPhone({ enrolled: false }));
    }, []);

    const chooseProject = (p: LoginProject) => {
        setProject(p);
        setDrivers(null);
        setError(null);
        setMode('pick');
        /* A project with nobody to pick goes straight to a username and a
           password. UH is that project: its couriers work from the phone app
           and this page is for the people who do not, which is dispatch,
           administrators and pharmacy staff. The server decides, by returning
           an empty list for a project that does not sign in by route, so the
           roster is not merely hidden here but never sent. */
        api<DriverPick[]>(`/api/drivers/list?project=${encodeURIComponent(p.code)}`)
            .then((list) => {
                setDrivers(list);
                if (list.length === 0) setMode('staff');
            })
            .catch(() => { setDrivers([]); setMode('staff'); });
    };

    /* Answer step 1 from the URL, once both questions this page asks on load
       have come back.
     
       Waiting for `phone` is what keeps the enrolled handset's lock screen:
       acting on `projects` alone would race the device probe and the winner
       would depend on which request finished first. `mode` is in the
       dependencies so this cannot drag somebody back who has since moved on
       -- including out of a password reset, which returns to step 1 and from
       here lands back on their own contract rather than on the picker. */
    useEffect(() => {
        if (!pinned || phone === null) return;
        if (phone.enrolled && phone.hasPin) return;
        if (mode !== 'project') return;
        chooseProject(pinned);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pinned, phone, mode]);

    const pick = (d: DriverPick) => {
        setDriver(d);
        setPin('');
        setPassword('');
        setError(null);
        /* No route means no route PIN and no way to key one, so this is a
           password sign-in. It is also the only one they need: enrolling the
           phone afterwards is what makes the next sign-in four digits. */
        if (d.route === null) { setMode('password'); return; }
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
            if (mode === 'staff' || mode === 'password') {
                /* Same endpoint either way. The only difference is where the
                   username came from: typed, or the courier the picker
                   already knows. */
                const who = mode === 'password' ? driver?.username ?? '' : username;
                await api('/api/login', { method: 'POST', json: { username: who, password } });
            } else if (mode === 'device') {
                await api('/api/login/device', { method: 'POST', json: { pin } });
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
            {/* ABOVE THE CARD, ON THE GROUND, which is where the app puts
                it: the wordmark is the only thing on this screen wide
                enough to anchor to, and inside the pane it was competing
                with the thing somebody came here to do. See the same block
                at the top of app/src/screens/SignIn.tsx. */}
            <div className="izy-login-brand">
                {/* Still the page heading. It is the only one this screen
                    has, and a sign-in page with no h1 is a page a screen
                    reader cannot summarise. */}
                <h1 className="izy-login-wordmark">TAG</h1>
                <span className="izy-login-company">Izy Global Services LLC</span>
            </div>
            <div className="izy-login-card">
                {error && <div className="izy-alert error" role="alert">{error}</div>}

                {mode === 'device' && phone?.enrolled && (
                    <form onSubmit={(e) => { void submit(e); }}>
                        <div className="izy-driver" style={{ cursor: 'default' }}>
                            <span className="izy-avatar">{initials(phone.name)}</span>
                            <span><b>{phone.name}</b><span>{phone.label}</span></span>
                        </div>
                        <SecretInput
                            label="PIN"
                            inputMode="numeric"
                            pattern="\d{4,6}"
                            autoComplete="one-time-code"
                            value={pin}
                            onChange={(e) => setPin(e.target.value)}
                            required
                            autoFocus
                        />
                        <CardButton submit title="Sign in" tone="primary" busy={busy} />
                        {/* A shared phone, or somebody else's: always a way out. */}
                        <button
                            className="izy-link"
                            type="button"
                            onClick={() => {
                                setPin('');
                                setError(null);
                                /* Back to this contract's sign-in, not to a
                                   choice they were deliberately not asked. */
                                if (pinned) chooseProject(pinned); else setMode('project');
                            }}
                        >
                            Not {phone.name}? Sign in another way
                        </button>
                    </form>
                )}

                {mode === 'project' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div className="izy-muted">Which project are you signing in to?</div>
                        {/* The app's ChooseContract, which is a panel of
                            cards rather than a list of 36px avatars. Same
                            question, asked the same way, so a driver who
                            installs the app in December recognises it. */}
                        {projects === null ? <Loading label="Loading projects" /> : projects.map((p, i) => (
                            <CardButton
                                key={p.code}
                                title={p.name}
                                detail={p.code}
                                tone={i === 0 ? 'primary' : 'secondary'}
                                onClick={() => chooseProject(p)}
                            />
                        ))}
                        {projects?.length === 0 && <div className="izy-muted">No projects configured yet.</div>}
                        {staffLink}
                    </div>
                )}

                {mode === 'pick' && project && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {/* Only when the picker is where Back goes. On /tvhs
                            it would offer a step this URL exists to skip. */}
                        {!pinned && <button className="izy-link" type="button" onClick={backToProjects} style={{ alignSelf: 'flex-start' }}>Back</button>}
                        <div className="izy-muted">{project.name} · who is driving?</div>
                        {drivers === null ? <Loading label="Loading drivers" /> : drivers.map((d) => (
                            <CardButton
                                key={d.username}
                                title={d.name}
                                detail={pickHint(d)}
                                tone="secondary"
                                onClick={() => pick(d)}
                            />
                        ))}
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
                            <SecretInput label="Your password (first time only)" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                        )}
                        <SecretInput label={mode === 'setup' ? 'Create a 4 to 6 digit PIN' : 'PIN'} inputMode="numeric" pattern="\d{4,6}" autoComplete="one-time-code" value={pin} onChange={(e) => setPin(e.target.value)} required autoFocus />
                        <CardButton submit title={mode === 'setup' ? 'Set PIN and sign in' : 'Sign in'} tone="primary" busy={busy} />
                        {mode === 'pin' && (
                            <button className="izy-link" type="button" onClick={() => { setMode('setup'); setPin(''); }}>Forgot PIN? Use password</button>
                        )}
                    </form>
                )}

                {mode === 'password' && driver && (
                    <form onSubmit={(e) => { void submit(e); }}>
                        <button className="izy-link" type="button" onClick={() => setMode('pick')} style={{ alignSelf: 'flex-start' }}>Back</button>
                        <div className="izy-driver" style={{ cursor: 'default' }}>
                            <span className="izy-avatar">{initials(driver.name)}</span>
                            <span><b>{driver.name}</b><span>{driver.username}</span></span>
                        </div>
                        <SecretInput label="Your password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
                        <CardButton submit title="Sign in" tone="primary" busy={busy} />
                        {/* Said here rather than discovered later: this is the
                            once-per-phone step, and the next one is four
                            digits. */}
                        <div className="izy-muted" style={{ textAlign: 'center' }}>
                            Once you are in, set this phone up and a PIN signs you in next time.
                        </div>
                    </form>
                )}

                {mode === 'staff' && (
                    <form onSubmit={(e) => { void submit(e); }}>
                        {!pinned && <button className="izy-link" type="button" onClick={backToProjects} style={{ alignSelf: 'flex-start' }}>Back</button>}
                        {/* Which contract this is. On /uh it is the only thing
                            on the screen that says so, and a pharmacist who
                            has followed a link needs to see they are in the
                            right place before they type a password. */}
                        {project && <div className="izy-muted">{project.name}</div>}
                        <label className="izy-field">Username
                            <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
                        </label>
                        <SecretInput label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                        <CardButton submit title="Sign in" tone="primary" busy={busy} />
                        <div className="izy-muted" style={{ textAlign: 'center' }}>Your projects appear after you sign in.</div>
                    </form>
                )}

                {mode === 'reset' && (
                    <PasswordReset onBack={() => { setMode('project'); setError(null); }} />
                )}

                {/* OFFERED FROM EVERY WAY IN THAT USES A PASSWORD, and from
                    the first screen, because somebody who has forgotten
                    theirs does not know which of these screens they were
                    supposed to reach. Not offered on the PIN screens: a PIN
                    is device-bound and resetting a password does not bring
                    one back -- "Sign in another way" is the route out of
                    those, and it leads here. */}
                {mode !== 'reset' && mode !== 'device' && mode !== 'pin' && (
                    <CardButton
                        title="Forgotten your password?"
                        detail="We can email you a code to set a new one."
                        tone="quiet"
                        compact
                        onClick={() => { setMode('reset'); setError(null); }}
                    />
                )}
            </div>
        </div>
    );
}
