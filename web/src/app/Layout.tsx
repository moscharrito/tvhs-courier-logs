import { useCallback, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { SyncStatus } from './SyncStatus';
import { initials } from '../lib/initials';
import { counterName, isPharmacyOnly, projectHref } from '../lib/pharmacy';
import { rememberedFlag, rememberFlag } from '../lib/remember';

/* ROLE_LABEL used to sit here, declared and never read. It was left behind
   when the NavLink's title attribute went (see the comment on the project
   links below). ProjectHome has the copy that is actually used. */

/* Collapsing the rail (ticket 5.14).
 *
 * 240px of furniture on every screen, and the one screen that wants the width
 * most is the board: two columns of lanes that reflow to one the moment the
 * window is anything but wide. Collapsed it is 60px.
 *
 * IT COLLAPSES TO INITIALS, NOT TO NOTHING. A rail that hides itself entirely
 * takes the navigation with it, so getting to Home costs opening a menu first.
 * Each item keeps the same green circle it has on the sign-in page, so "UP" is
 * the same project in both places.
 *
 * THE LABEL IS HIDDEN FROM THE EYE, NOT FROM THE PAGE. The full text stays in
 * the document as visually-hidden, so every link keeps its accessible name and
 * the rail reads identically to a screen reader whether it is collapsed or
 * not. Replacing "UH Pharmacy Courier" with the letters "UP" in the accessible
 * name would be making the screen worse for the person who can least afford
 * it, in exchange for pixels they do not have.
 *
 * NOT OFFERED ON A PHONE. Under 900px the rail is already a compact row along
 * the top rather than a column, and there is no horizontal space to win.
 */
const RAIL = 'side.collapsed';

export function Layout() {
    const { user, projects, signOut } = useAuth();
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const [collapsed, setCollapsed] = useState(() => rememberedFlag(RAIL, false));
    /* A pharmacy counter gets its own rail. See lib/pharmacy.ts for why this
       is a shared answer rather than a check made here. */
    const pharmacy = isPharmacyOnly(projects);

    const toggleRail = useCallback(() => {
        setCollapsed((was) => {
            rememberFlag(RAIL, !was);
            return !was;
        });
    }, []);

    if (!user) return null;

    const onSignOut = async () => {
        await signOut();
        navigate('/', { replace: true });
    };

    /** One nav row: the circle the eye reads, the words everything else reads.
     *
     *  `also` widens what counts as being here. A project's link points at the
     *  project's own page, so standing on the board, the orders list or an
     *  invoice lit nothing at all in this rail. That was survivable while
     *  every item was spelled out and the page had a heading; with the rail
     *  collapsed to two letters, nothing highlighted means nothing telling you
     *  which project you are in. */
    const item = (to: string, label: string, opts: { end?: boolean; also?: boolean } = {}) => (
        <NavLink
            key={to}
            to={to}
            end={opts.end ?? false}
            className={({ isActive }) => (isActive || opts.also ? 'active' : '')}
        >
            <span className="izy-nav-ini" aria-hidden="true">{initials(label)}</span>
            <span className="izy-nav-label">{label}</span>
        </NavLink>
    );

    return (
        <div className={`izy${collapsed ? ' is-collapsed' : ''}`}>
            <aside className="izy-side">
                <div className="izy-side-top">
                    {/* Whose screen this is. A pharmacist reading
                        "Izy Global Services LLC" in the corner of a page
                        listing their own patients is being told they are a
                        guest in somebody else's system; their counter's name
                        tells them it is theirs. Izy is still named, under
                        Account, as the people who run it. */}
                    <div className="izy-brand">
                        TAG<small>{pharmacy && user ? counterName(user.name) : 'Izy Global Services LLC'}</small>
                    </div>
                    <button
                        type="button"
                        className="izy-rail-toggle"
                        onClick={toggleRail}
                        aria-expanded={!collapsed}
                        /* Says what the button does, not what it looks like.
                           There is no text beside it to lean on. */
                        aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'}
                    >
                        <RailIcon collapsed={collapsed} />
                    </button>
                </div>
                <nav className="izy-nav" aria-label="Main">
                    {pharmacy && projects[0] ? (
                        /* THE COUNTER'S OWN RAIL.
                        
                           No Home, because the picker it leads to is a
                           question with one answer. No Projects section,
                           because a pharmacy has one and does not think of
                           it as a project. What is left is the three things
                           they came to do.
                        
                           Send a list and Pharmacy logins are deliberately
                           NOT here. Both depend on answers the rail does not
                           have -- whether this contract takes lists through
                           the portal, and whether this account is the
                           contract manager -- and a rail that guessed would
                           be offering links the server refuses. They live on
                           the deliveries page, which already reads both off
                           the summary. */
                        <>
                            {item(`/projects/${projects[0].code}/deliveries`, 'Deliveries')}
                            {item(`/projects/${projects[0].code}/performance`, 'Performance')}
                            <div className="izy-nav-title">Account</div>
                        </>
                    ) : (
                        <>
                            {item('/', 'Home', { end: true })}
                            <div className="izy-nav-title">Projects</div>
                            {projects.length === 0 && (
                                <span className="izy-muted izy-nav-empty">No projects yet</span>
                            )}
                            {/* No title attribute: it would override the link
                                text as the accessible name and announce the
                                role instead. */}
                            {projects.map((p) => item(
                                projectHref(p.code),
                                p.name,
                                { also: pathname.startsWith(`/projects/${p.code}/`) },
                            ))}
                            <div className="izy-nav-title">Account</div>
                        </>
                    )}
                    {/* "This phone" is a courier's phone. For everybody
                        else the page is a password and a list of sessions,
                        and calling that This phone sends a pharmacist looking
                        for a feature they do not have and should not. */}
                    {item('/devices', user.role === 'driver' ? 'This phone' : 'Your account')}
                    {user.role === 'admin' && (
                        <>
                            <div className="izy-nav-title">Platform</div>
                            {item('/users', 'Users')}
                            {item('/audit', 'Audit log')}
                        </>
                    )}
                </nav>
                <div className="izy-me">
                    <b>{user.name}</b>
                    <span>{user.username}</span>
                    <div style={{ marginTop: 8 }}>
                        <button className="izy-btn secondary small" onClick={() => { void onSignOut(); }}>
                            {/* Collapsed, the word will not fit and the door
                                does. The name stays either way. */}
                            <span className="izy-nav-label">Sign out</span>
                            <span className="izy-nav-ini" aria-hidden="true"><ExitIcon /></span>
                        </button>
                    </div>
                </div>
            </aside>
            <main className="izy-main">
                {/* Above the screen, not tucked into a corner: a courier who
                    cannot tell "sent" from "on this phone" will assume sent. */}
                <SyncStatus />
                <Outlet />
            </main>
        </div>
    );
}

/* Drawn rather than typed, for the same reason as the fold chevron: an arrow
   character is a letter a screen reader reads out, and it renders differently
   on every platform. Decoration beside a real aria-label. */
function RailIcon({ collapsed }: { collapsed: boolean }) {
    return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.5" />
            <path
                d={collapsed ? 'M9 6.5 L11.5 8 L9 9.5' : 'M11.5 6.5 L9 8 L11.5 9.5'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ExitIcon() {
    return (
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <path d="M6 2.5 H3.5 A1 1 0 0 0 2.5 3.5 V12.5 A1 1 0 0 0 3.5 13.5 H6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M9.5 5 L12.5 8 L9.5 11 M12.5 8 H6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
