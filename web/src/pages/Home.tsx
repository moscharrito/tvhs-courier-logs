import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../app/auth';
import { isCourierOnly, isPharmacyOnly, projectHref } from '../lib/pharmacy';
import { CardLink, Panel, ScreenHeader } from '../app/Glass';
import { RouteIcon } from '../app/Icons';

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
    /* A COURIER GETS THE APP'S SHAPE HERE TOO, because this is a screen
       they see every morning and the app has its own version of it:
       ChooseContract, a glass panel of cards. Same question, same shape.
     *
     * WHAT THIS DELIBERATELY DOES NOT DO is redirect a courier who has one
     * project, the way a pharmacy is redirected three lines up. The
     * argument for that is the same -- "choose the project you are working
     * in" is a question with one answer, asked of somebody who does not
     * know what a project is -- and it may well be right. It is a change to
     * WHERE A DRIVER LANDS rather than to how the screen looks, it would
     * take the two live TVHS drivers straight into the legacy app without
     * anybody deciding that, and it is not what a layout change should
     * smuggle in. Worth asking; not worth assuming. */
    if (isCourierOnly(projects)) {
        /* NO SHEET ON THIS ONE, and it is the one driver screen that
           should not have it. A sheet is for a screen with something to
           protect above it -- the next stop, the counter being collected
           from -- and it takes the whole height so a long list can scroll
           under a fixed region. There is nothing above this and the list is
           one card, so the sheet rendered as nine hundred pixels of white
           under a single button. The app's own ChooseContract is a panel on
           the ground, which is this. */
        return (
            <>
                <ScreenHeader
                    title={`Welcome, ${user.name.split(' ')[0]}`}
                    subtitle="Choose the project you are working in."
                />
                <Panel>
                    {projects.length === 0 ? (
                        <p className="izy-muted">
                            You are not a member of any project yet. Ask an admin to add you.
                        </p>
                    ) : projects.map((p, i) => (
                        <CardLink
                            key={p.code}
                            to={projectHref(p.code)}
                            title={p.name}
                            Icon={RouteIcon}
                            /* The first is the one they almost always want.
                               The app tints its primary contract the same
                               way rather than offering two identical slabs. */
                            tone={i === 0 ? 'primary' : 'secondary'}
                            detail={`${ROLE_LABEL[p.role] ?? p.role} · ${p.timezone}`}
                        />
                    ))}
                </Panel>
            </>
        );
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
