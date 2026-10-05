import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type UserSummary } from '../lib/api';
import { Pager, usePaged } from '../app/Pager';
import { useAuth } from '../app/auth';

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', staff: 'Staff', driver: 'Driver' };

/* ─────────────────────────────────────────────────── turning access off
 *
 * This page could show that an account was disabled and not disable one.
 * Revoking somebody's access needed a shell, an admin password and a PATCH,
 * which for a platform carrying patient data is the wrong shape: the day
 * somebody leaves is not the day to go looking for a terminal.
 *
 * DISABLING SIGNS EVERY DEVICE OUT, IMMEDIATELY. The server revokes all
 * sessions in the same request (core/users/routes.ts) and returns how many.
 * So the phone in a courier's pocket stops working the moment this is
 * clicked, which is correct for an offboarding and ruinous for a misclick on
 * the wrong row during a wave.
 *
 * Hence: count the live devices FIRST and say the number in the question. "Do
 * you want to disable this?" and "this signs out 2 devices now" are different
 * questions and only the second one can be answered honestly. window.confirm
 * rather than a modal, matching Sites.tsx, because the established pattern
 * here is worth more than a nicer dialog.
 *
 * NOT OFFERED ON YOUR OWN ROW. The server refuses it with a 400, and an
 * admin who locks themselves out of the only admin account has nobody left
 * to let them back in. A button that exists to be refused is worse than no
 * button.
 */

export function Users() {
    const [users, setUsers] = useState<UserSummary[] | null>(null);
    const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
    const [form, setForm] = useState({ username: '', name: '', email: '', password: '', role: 'staff' as UserSummary['role'] });
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<string | null>(null);
    /** What the last status change did, said back rather than left to infer. */
    const [note, setNote] = useState<string | null>(null);
    /** The row being changed, so one button spins and the rest stay usable. */
    const [changing, setChanging] = useState<string | null>(null);
    const { user: me } = useAuth();

    const load = useCallback(async () => {
        try {
            setUsers(await api<UserSummary[]>('/api/users'));
        } catch (err) {
            setError({ message: err instanceof ApiError ? err.message : 'Failed to load users', details: [] });
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const paged = usePaged(users ?? []);

    const create = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setCreated(null);
        try {
            const body: Record<string, string> = { username: form.username, name: form.name, password: form.password, role: form.role };
            if (form.email.trim()) body['email'] = form.email.trim();
            const u = await api<UserSummary>('/api/users', { method: 'POST', json: body });
            setCreated(u.username);
            setForm({ username: '', name: '', email: '', password: '', role: 'staff' });
            await load();
        } catch (err) {
            setError(err instanceof ApiError ? { message: err.message, details: err.details } : { message: 'Could not create user', details: [] });
        } finally {
            setBusy(false);
        }
    };

    const setStatus = async (u: UserSummary, to: 'active' | 'disabled') => {
        setError(null);
        setNote(null);

        if (to === 'disabled') {
            /* Counted before the question is asked, so the question can name
               the consequence. A failure here must not become a silent
               "0 devices": if we cannot find out, say so and let the admin
               decide with that knowledge. */
            let live: number | null = null;
            try {
                const sessions = await api<unknown[]>(`/api/users/${encodeURIComponent(u.username)}/sessions`);
                live = sessions.length;
            } catch {
                live = null;
            }
            const consequence = live === null
                ? 'Their signed-in devices will be signed out; I could not check how many.'
                : live === 0
                    ? 'They have no signed-in devices.'
                    : `This signs out ${live} signed-in device${live === 1 ? '' : 's'} straight away.`;
            if (!confirm(`Disable ${u.name} (${u.username})?\n\n${consequence}\n\nThey will not be able to sign in until re-enabled.`)) return;
        } else if (!confirm(`Re-enable ${u.name} (${u.username})?\n\nThey will be able to sign in again.`)) {
            return;
        }

        setChanging(u.username);
        try {
            const updated = await api<UserSummary & { revokedSessions: number }>(
                `/api/users/${encodeURIComponent(u.username)}`,
                { method: 'PATCH', json: { status: to } },
            );
            setNote(to === 'disabled'
                ? `Disabled ${u.username}. ${updated.revokedSessions} device${updated.revokedSessions === 1 ? '' : 's'} signed out.`
                : `Re-enabled ${u.username}. They can sign in again; any old sessions stay revoked.`);
            await load();
        } catch (err) {
            setError(err instanceof ApiError
                ? { message: err.message, details: err.details }
                : { message: `Could not change ${u.username}`, details: [] });
        } finally {
            setChanging(null);
        }
    };

    return (
        <>
            <h1>Users</h1>
            <p className="izy-sub">Everyone who can sign in. Project access comes from memberships.</p>

            <div className="izy-card">
                <h2>New user</h2>
                {error && (
                    <div className="izy-alert error" role="alert">
                        {error.message}
                        {error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                    </div>
                )}
                {created && <div className="izy-alert ok">Created <b>{created}</b>. <Link to={`/users/${encodeURIComponent(created)}`}>Add memberships</Link>.</div>}
                <form className="izy-row" onSubmit={(e) => { void create(e); }}>
                    <label className="izy-field">Username<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
                    <label className="izy-field">Full name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
                    <label className="izy-field">Email (optional)<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                    <label className="izy-field">Temporary password<input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} /></label>
                    <label className="izy-field">Platform role
                        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserSummary['role'] })}>
                            <option value="staff">Staff</option>
                            <option value="driver">Driver</option>
                            <option value="admin">Admin</option>
                        </select>
                    </label>
                    <button className="izy-btn" type="submit" disabled={busy}>Create</button>
                </form>
            </div>

            <div className="izy-card">
                <h2>Directory</h2>
                {note && <div className="izy-alert ok" role="status">{note}</div>}
                {users === null ? <div className="izy-muted">Loading...</div> : (
                    <table className="izy-table">
                        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Projects</th><th>PIN</th><th>Access</th></tr></thead>
                        <tbody>
                            {paged.rows.map((u) => (
                                <tr key={u.username}>
                                    <td><Link to={`/users/${encodeURIComponent(u.username)}`}>{u.name}</Link></td>
                                    <td><code>{u.username}</code></td>
                                    <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                                    <td><span className={`izy-pill ${u.status === 'active' ? '' : 'off'}`}>{u.status}</span></td>
                                    <td>{u.memberships.length === 0 ? <span className="izy-muted">none</span> : u.memberships.map((m) => (
                                        <span key={m.code} className="izy-pill muted" style={{ marginRight: 4 }}>{m.project_name}: {m.role}{typeof m.settings['route'] === 'string' ? ` (${String(m.settings['route'])})` : ''}</span>
                                    ))}</td>
                                    <td>{u.role === 'driver' ? (u.hasPin ? 'set' : <span className="izy-pill warn">not set</span>) : ''}</td>
                                    <td>
                                        {me?.role !== 'admin' ? <span className="izy-muted">admin only</span>
                                            : me.username === u.username ? <span className="izy-muted">this is you</span>
                                                : (
                                                    <button
                                                        className="izy-btn"
                                                        type="button"
                                                        disabled={changing !== null}
                                                        onClick={() => { void setStatus(u, u.status === 'active' ? 'disabled' : 'active'); }}
                                                    >
                                                        {changing === u.username
                                                            ? 'Working...'
                                                            : u.status === 'active' ? 'Disable' : 'Re-enable'}
                                                    </button>
                                                )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <Pager of={paged} noun="people" />
            </div>
        </>
    );
}
