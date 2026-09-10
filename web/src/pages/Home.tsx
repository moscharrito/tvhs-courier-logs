import { Link } from 'react-router-dom';
import { useAuth } from '../app/auth';

const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin', ops_manager: 'Ops manager', dispatcher: 'Dispatcher', courier: 'Courier', client_viewer: 'Client viewer',
};

export function Home() {
    const { user, projects } = useAuth();
    if (!user) return null;
    return (
        <>
            <h1>Welcome, {user.name.split(' ')[0]}</h1>
            <p className="izy-sub">Pick a project to open it.</p>
            <div className="izy-card">
                <h2>Your projects</h2>
                {projects.length === 0 ? (
                    <div className="izy-muted">You are not a member of any project yet. Ask an admin to add you.</div>
                ) : (
                    <table className="izy-table">
                        <thead><tr><th>Project</th><th>Your role</th><th></th></tr></thead>
                        <tbody>
                            {projects.map((p) => (
                                <tr key={p.code}>
                                    <td><b>{p.name}</b><div className="izy-muted">{p.code} · {p.timezone}</div></td>
                                    <td><span className="izy-pill">{ROLE_LABEL[p.role] ?? p.role}</span></td>
                                    <td style={{ textAlign: 'right' }}><Link className="izy-btn small" to={`/projects/${p.code}/${p.code}`}>Open</Link></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            {user.role === 'admin' && (
                <div className="izy-card">
                    <h2>Platform</h2>
                    <div className="izy-row">
                        <Link className="izy-btn secondary" to="/users">Manage users</Link>
                        <Link className="izy-btn secondary" to="/audit">Audit log</Link>
                    </div>
                </div>
            )}
        </>
    );
}
