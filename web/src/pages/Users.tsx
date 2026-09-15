import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type UserSummary } from '../lib/api';
import { Pager, usePaged } from '../app/Pager';

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', staff: 'Staff', driver: 'Driver' };

export function Users() {
    const [users, setUsers] = useState<UserSummary[] | null>(null);
    const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
    const [form, setForm] = useState({ username: '', name: '', email: '', password: '', role: 'staff' as UserSummary['role'] });
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<string | null>(null);

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
                {users === null ? <div className="izy-muted">Loading...</div> : (
                    <table className="izy-table">
                        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Projects</th><th>PIN</th></tr></thead>
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
