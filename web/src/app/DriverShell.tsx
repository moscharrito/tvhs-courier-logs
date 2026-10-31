/* The shell a courier gets in the browser, which is the phone app's shell.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE SIDE RAIL IS NOT IT.
 *
 * Every University Health driver works in the browser for the first month
 * and only then moves to the phone app, and on a phone the rail was taking
 * the top third of the screen before a single stop appeared: the wordmark
 * and its tagline on one row, the links on a second, the name and Sign out
 * on a third. Trimming it helped and did not fix the shape. A driver holding
 * a package needs the next address; a column of links to the dispatch
 * console is furniture, and most of it is furniture they are not allowed to
 * open — see the allow-list in App.tsx.
 *
 * So on a phone a courier gets what app/src/screens/Driving.tsx gives them:
 * a top bar, the screen, and three tabs along the bottom. Same three tabs,
 * same words, same order, because somebody who learns this in November and
 * installs the app in December should not have to learn it twice.
 *
 * THE RAIL IS STILL THERE AT DESKTOP WIDTH. Some drivers will be at a
 * laptop — the dispatch number on the run screen is written out rather than
 * only linked for exactly that reason — and a tab bar welded to the bottom
 * of a 1400px window is a shape borrowed past the point where it means
 * anything. Both bars are in the document always and hidden by a media
 * query, which keeps one markup tree rather than two.
 *
 * WHAT MAPS TO WHAT. The app's tabs are Today, History and You. In the
 * browser those are three URLs that already existed and that a courier is
 * already allowed to open:
 *
 *   Today    /projects/:code/my-run        the round
 *   History  /projects/:code/my-deliveries what they have finished, and what
 *                                          it comes to
 *   You      /devices                      who is signed in, and the way out
 *
 * The app's fourth thing — switching contract — is the back pill, and it is
 * only offered where it means something. See below.
 */

import { NavLink, useLocation, useParams } from 'react-router-dom';
import { HistoryIcon, ProfileIcon, RouteIcon, SignOutIcon } from './Icons';

/* The tab roots. A back control on one of these would point at the screen
   you are already on, which is the kind of dead control that teaches people
   to stop trusting the others. */
const ROOTS = ['my-run', 'my-deliveries'];

function isTabRoot(pathname: string): boolean {
    if (pathname === '/devices') return true;
    const last = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    return ROOTS.includes(last);
}

/**
 * Back on the left, sign out on the right. The app's ui/Nav.tsx TopBar.
 *
 * The back pill says where it GOES rather than "Back": a courier who has
 * opened a stop, then the order behind it, wants to know what they are
 * returning to. It goes to Today rather than to the browser's own history,
 * because the history of a round worked over four hours is forty entries
 * deep and none of them is where they want to be.
 */
export function DriverTopBar({ code, contract, onSignOut }: {
    code: string;
    /** The contract's name, shown where a back pill would be pointless. */
    contract: string;
    onSignOut: () => void;
}) {
    const { pathname } = useLocation();

    return (
        <div className="izy-courier-top">
            {isTabRoot(pathname) ? (
                /* Not a control. Which contract this is, because a driver on
                   two of them has to be able to tell, and because an empty
                   corner reads as a missing button. */
                <span className="izy-courier-where">{contract}</span>
            ) : (
                <NavLink className="izy-courier-back" to={`/projects/${code}/my-run`}>
                    <BackChevron />
                    <span>Today</span>
                </NavLink>
            )}
            <button type="button" className="izy-courier-out" onClick={onSignOut}>
                <SignOutIcon size={19} />
                <span>Sign out</span>
            </button>
        </div>
    );
}

/**
 * The three tabs, as a glass bar floating clear of the bottom edge.
 *
 * ICON AND WORD, ALWAYS, which is a rule rather than a style and is copied
 * from the app along with the shapes: the audience is a courier who may have
 * used this twice, in a van, in a hurry, possibly in their second language.
 * A row of tasteful glyphs is a memory test. The word is the label and the
 * glyph is what makes it findable at a glance, so the icons are decorative
 * and hidden from the accessibility tree.
 */
export function DriverTabs({ code }: { code: string }) {
    const tab = (to: string, label: string, Icon: typeof RouteIcon, hint: string, end = false) => (
        <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => (isActive ? 'active' : '')}
            title={hint}
        >
            <Icon size={24} strokeWidth={2} />
            <span>{label}</span>
        </NavLink>
    );

    return (
        <nav className="izy-tabbar" aria-label="Your work">
            <div className="izy-tabbar-inner">
                {tab(`/projects/${code}/my-run`, 'Today', RouteIcon, 'The stops assigned to you today')}
                {tab(`/projects/${code}/my-deliveries`, 'History', HistoryIcon, 'The deliveries you have already finished')}
                {tab('/devices', 'You', ProfileIcon, 'Your account, your password, and signing out', true)}
            </div>
        </nav>
    );
}

/* Drawn rather than typed, for the same reason as the fold chevron in
   Section.tsx: an arrow character is a letter a screen reader reads out, and
   it renders differently on every platform. Decoration beside a real word. */
function BackChevron() {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
