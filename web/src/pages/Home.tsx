import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../app/auth';
import { isPharmacyOnly, projectHref } from '../lib/pharmacy';

const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin and dispatch', courier: 'Driver', pharmacy: 'Pharmacy staff',
};

/* Project picker. Almost everyone lands here after sign-in, drivers
   included, and chooses the project to work in.
   
   A PHARMACY NEVER SEES IT. They have one project and will only ever have
   one, so "choose the project you are working in" is a question with one
   answer, asked of somebody who does not know what a project is. It was the
   first screen a pharmacist met and it told them, correctly, that they were
   using an internal tool that had been pointed at them. See lib/pharmacy.ts.
   
   Redirect rather than a different Home, so there is one landing page and
   one place that decides. */
export function Home() {
    const { user, projects } = useAuth();
    if (!user) return null;
    if (isPharmacyOnly(projects)) {
        return <Navigate to={`/projects/${projects[0]!.code}/deliveries`} replace />;
    }
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
                            <Link key={p.code} className="tag-project" to={projectHref(p.code)}>
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
