import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fmtWhen, type ProjectMembership, type SessionSummary, type UserSummary } from '../lib/api';
import { useAuth } from '../app/auth';

type Msg = { kind: 'ok' | 'error'; text: string; details?: string[] } | null;
const PROJECT_ROLES: ProjectMembership['role'][] = ['admin', 'ops_manager', 'dispatcher', 'courier', 'client_viewer'];
const TVHS_ROUTES = ['northbound', 'southbound'];

export function UserDetail() {
    const { username = '' } = useParams();
    const { user: me, projects: myProjects } = useAuth();
    const [u, setU] = useState<UserSummary | null>(null);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [msg, setMsg] = useState<Msg>(null);
    const [edit, setEdit] = useState({ name: '', email: '', role: 'staff' as UserSummary['role'] });
    const [password, setPassword] = useState('');
    const [pin, setPin] = useState('');
    const [member, setMember] = useState({ project: 'tvhs', role: 'courier' as ProjectMembership['role'], route: 'northbound' });
    /* Which pharmacies a client viewer may see. Nothing is ticked by default:
       an unscoped viewer sees nothing, which is the safe way round. Ticking
       "all" by accident would hand one pharmacy every other pharmacy's
       patients (ticket 3.1). */
    const [scopeSites, setScopeSites] = useState<number[]>([]);
    const [sites, setSites] = useState<Array<{ id: number; name: string }>>([]);

    useEffect(() => {
        if (member.role !== 'client_viewer') { setSites([]); return; }
        api<Array<{ id: number; name: string }>>(`/api/projects/${member.project}/uh/sites`)
            .then(setSites)
            .catch(() => setSites([]));
    }, [member.project, member.role]);

    const load = useCallback(async () => {
        const data = await api<UserSummary>(`/api/users/${encodeURIComponent(username)}`);
        setU(data);
        setEdit({ name: data.name, email: data.email ?? '', role: data.role });
        setSessions(await api<SessionSummary[]>(`/api/users/${encodeURIComponent(username)}/sessions`));
    }, [username]);
    useEffect(() => { load().catch((err) => setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Failed to load' })); }, [load]);

    const run = async (label: string, fn: () => Promise<unknown>) => {
        setMsg(null);
        try {
            await fn();
            await load();
            setMsg({ kind: 'ok', text: label });
        } catch (err) {
            setMsg(err instanceof ApiError ? { kind: 'error', text: err.message, details: err.details } : { kind: 'error', text: 'Request failed' });
        }
    };

    if (!u) return <div className="izy-muted">{msg?.text ?? 'Loading...'}</div>;
    const base = `/api/users/${encodeURIComponent(u.username)}`;
    const isSelf = me?.username === u.username;

    const save = (e: FormEvent) => {
        e.preventDefault();
        void run('Saved', () => api(base, { method: 'PATCH', json: { name: edit.name, email: edit.email.trim() || null, role: edit.role } }));
    };

    return (
        <>
            <div className="izy-muted"><Link to="/users">Users</Link> / {u.username}</div>
            <h1>{u.name} {u.status === 'disabled' && <span className="izy-pill off">disabled</span>}</h1>
            <p className="izy-sub"><code>{u.username}</code> · created {fmtWhen(u.created_at)}</p>
            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            <div className="izy-card">
                <h2>Profile</h2>
                <form className="izy-row" onSubmit={save}>
                    <label className="izy-field">Full name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></label>
                    <label className="izy-field">Email<input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
                    <label className="izy-field">Platform role
                        <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as UserSummary['role'] })} disabled={isSelf}>
                            <option value="staff">Staff</option>
                            <option value="driver">Driver</option>
                            <option value="admin">Admin</option>
                        </select>
                    </label>
                    <button className="izy-btn" type="submit">Save</button>
                    {u.status === 'active' ? (
                        <button className="izy-btn danger" type="button" disabled={isSelf} onClick={() => { if (confirm(`Disable ${u.username}? They will be signed out everywhere.`)) void run('Account disabled', () => api(base, { method: 'PATCH', json: { status: 'disabled' } })); }}>Disable</button>
                    ) : (
                        <button className="izy-btn secondary" type="button" onClick={() => { void run('Account enabled', () => api(base, { method: 'PATCH', json: { status: 'active' } })); }}>Enable</button>
                    )}
                </form>
            </div>

            <div className="izy-card">
                <h2>Credentials</h2>
                <div className="izy-row">
                    <label className="izy-field">New password<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} /></label>
                    <button className="izy-btn secondary" type="button" disabled={password.length < 8} onClick={() => { void run('Password reset, all devices signed out', () => api(`${base}/password`, { method: 'POST', json: { password } })).then(() => setPassword('')); }}>Reset password</button>
                    {u.role === 'driver' && (
                        <>
                            <label className="izy-field">PIN (4 to 6 digits)<input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} pattern="\d{4,6}" /></label>
                            <button className="izy-btn secondary" type="button" disabled={!/^\d{4,6}$/.test(pin)} onClick={() => { void run('PIN set', () => api(`${base}/pin`, { method: 'PUT', json: { pin } })).then(() => setPin('')); }}>Set PIN</button>
                            <button className="izy-btn danger" type="button" disabled={!u.hasPin} onClick={() => { void run('PIN cleared', () => api(`${base}/pin`, { method: 'DELETE' })); }}>Clear PIN</button>
                        </>
                    )}
                </div>
            </div>

            <div className="izy-card">
                <h2>Project memberships</h2>
                {u.memberships.length === 0 ? <div className="izy-muted">No projects.</div> : (
                    <table className="izy-table">
                        <thead><tr><th>Project</th><th>Role</th><th>Settings</th><th></th></tr></thead>
                        <tbody>
                            {u.memberships.map((m) => (
                                <tr key={m.code}>
                                    <td>{m.project_name} <code>{m.code}</code></td>
                                    <td>{m.role}</td>
                                    <td>{Object.keys(m.settings).length === 0 ? <span className="izy-muted">none</span> : <code>{JSON.stringify(m.settings)}</code>}</td>
                                    <td style={{ textAlign: 'right' }}><button className="izy-btn danger small" type="button" onClick={() => { if (confirm(`Remove ${u.username} from ${m.project_name}?`)) void run('Membership removed', () => api(`${base}/memberships/${m.code}`, { method: 'DELETE' })); }}>Remove</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <form className="izy-row" style={{ marginTop: 12 }} onSubmit={(e) => {
                    e.preventDefault();
                    const settings = member.project === 'tvhs' && member.role === 'courier'
                        ? { route: member.route }
                        : member.role === 'client_viewer'
                            ? { siteIds: scopeSites }
                            : {};
                    void run('Membership saved', () => api(`${base}/memberships/${member.project}`, { method: 'PUT', json: { role: member.role, settings } }));
                }}>
                    <label className="izy-field">Project
                        <select value={member.project} onChange={(e) => setMember({ ...member, project: e.target.value })}>
                            {myProjects.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                        </select>
                    </label>
                    <label className="izy-field">Role
                        <select value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value as ProjectMembership['role'] })}>
                            {PROJECT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </label>
                    {member.role === 'client_viewer' && (
                        <fieldset className="izy-fieldset">
                            <legend>Pharmacies this account may see</legend>
                            {sites.length === 0
                                ? <span className="izy-muted">That project has no pharmacies to choose from.</span>
                                : sites.map((site) => (
                                    <label key={site.id} className="izy-check">
                                        <input
                                            type="checkbox"
                                            checked={scopeSites.includes(site.id)}
                                            onChange={(e) => setScopeSites(e.target.checked
                                                ? [...scopeSites, site.id]
                                                : scopeSites.filter((id) => id !== site.id))}
                                        />
                                        {site.name}
                                    </label>
                                ))}
                            {scopeSites.length === 0 && sites.length > 0 && (
                                <span className="izy-muted">
                                    None chosen: this account will see nothing until a pharmacy is ticked.
                                </span>
                            )}
                        </fieldset>
                    )}
                    {member.project === 'tvhs' && member.role === 'courier' && (
                        <label className="izy-field">Route
                            <select value={member.route} onChange={(e) => setMember({ ...member, route: e.target.value })}>
                                {TVHS_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                        </label>
                    )}
                    <button className="izy-btn" type="submit">Add or update</button>
                </form>
                <div className="izy-muted" style={{ marginTop: 8 }}>You can add memberships to projects you belong to.</div>
            </div>

            <div className="izy-card">
                <h2>Signed-in devices</h2>
                {sessions.length === 0 ? <div className="izy-muted">No live sessions.</div> : (
                    <table className="izy-table">
                        <thead><tr><th>Device</th><th>IP</th><th>Last seen</th><th>Expires</th></tr></thead>
                        <tbody>
                            {sessions.map((s) => (
                                <tr key={s.id}><td>{s.device}</td><td><code>{s.ip}</code></td><td>{fmtWhen(s.last_seen_at)}</td><td>{fmtWhen(s.absolute_expires_at)}</td></tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div style={{ marginTop: 12 }}>
                    <button className="izy-btn danger" type="button" disabled={sessions.length === 0} onClick={() => { void run('All devices signed out', () => api(`${base}/sessions`, { method: 'DELETE' })); }}>Sign out all devices</button>
                    <Link className="izy-btn secondary" style={{ marginLeft: 8 }} to={`/audit?username=${encodeURIComponent(u.username)}`}>Audit history</Link>
                </div>
            </div>
        </>
    );
}
