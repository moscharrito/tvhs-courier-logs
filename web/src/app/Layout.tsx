import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';

const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin', ops_manager: 'Ops manager', dispatcher: 'Dispatcher', courier: 'Courier', client_viewer: 'Client viewer',
};

export function Layout() {
    const { user, projects, signOut } = useAuth();
    const navigate = useNavigate();
    if (!user) return null;

    const onSignOut = async () => {
        await signOut();
        navigate('/', { replace: true });
    };

    return (
        <div className="izy">
            <aside className="izy-side">
                <div className="izy-brand">Izy Ops<small>Izy Global Services LLC</small></div>
                <nav className="izy-nav" aria-label="Main">
                    <NavLink to="/" end>Home</NavLink>
                    <div className="izy-nav-title">Projects</div>
                    {projects.length === 0 && <span className="izy-muted" style={{ padding: '6px 12px', display: 'block', color: '#c7f0d6' }}>No projects yet</span>}
                    {projects.map((p) => (
                        <NavLink key={p.code} to={`/projects/${p.code}/${p.code}`} title={ROLE_LABEL[p.role] ?? p.role}>
                            {p.name}
                        </NavLink>
                    ))}
                    <div className="izy-nav-title">Account</div>
                    <NavLink to="/devices">My devices</NavLink>
                    {user.role === 'admin' && (
                        <>
                            <div className="izy-nav-title">Platform</div>
                            <NavLink to="/users">Users</NavLink>
                            <NavLink to="/audit">Audit log</NavLink>
                        </>
                    )}
                </nav>
                <div className="izy-me">
                    <b>{user.name}</b>
                    <span>{user.username}</span>
                    <div style={{ marginTop: 8 }}>
                        <button className="izy-btn secondary small" onClick={() => { void onSignOut(); }}>Sign out</button>
                    </div>
                </div>
            </aside>
            <main className="izy-main">
                <Outlet />
            </main>
        </div>
    );
}
