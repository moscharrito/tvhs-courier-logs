import { Link } from 'react-router-dom';
import { useAuth } from '../app/auth';

const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin and dispatch', courier: 'Driver', pharmacy: 'Pharmacy staff',
};

/* Project picker. Everyone lands here after sign-in, drivers included, and
   chooses the project to work in. */
export function Home() {
    const { user, projects } = useAuth();
    if (!user) return null;
    return (
        <>
            <h1>Welcome, {user.name.split(' ')[0]}</h1>
            <p className="izy-sub">Choose the project you are working in.</p>
            <div className="izy-card">
                <h2>Your projects</h2>
                {projects.length === 0 ? (
                    <div className="izy-muted">You are not a member of any project yet. Ask an admin to add you.</div>
                ) : (
                    <div className="tag-projects">
                        {projects.map((p) => (
                            <Link key={p.code} className="tag-project" to={`/projects/${p.code}/${p.code}`}>
                                <b>{p.name}</b>
                                <span className="izy-muted">{p.code} · {p.timezone}</span>
                                <span className="izy-pill">{ROLE_LABEL[p.role] ?? p.role}</span>
                            </Link>
                        ))}
                    </div>
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
