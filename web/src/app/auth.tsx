/* Session state for the shell: who is signed in and which projects they belong to. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type ProjectMembership, type SessionUser, whenSessionEnds } from '../lib/api';
import { clearOutbox, setOutboxUser, startOutbox } from '../lib/outbox';
import { deviceZone } from '../lib/when';

/* THE IDLE WINDOW, IN THE BROWSER.
 *
 * Thirty minutes, matching SESSION_STAFF_IDLE_MINUTES on the server. The
 * server has always enforced it; what it could not do is tell a browser
 * that nobody is touching. So the app only found out its session had gone
 * when something it asked for came back 401, and the page it was on
 * rendered that the way it renders any failure -- a red banner over a
 * screen still showing four stale zeros.
 *
 * Reported four times, and each time I fixed the REACTION to the 401. This
 * is the thing that was actually asked for: stop waiting to be told.
 *
 * Slightly early rather than late. If the server window is ever made longer
 * this signs out first, which is harmless; if it is made shorter the 401
 * handler is still there underneath as the backstop.
 */
const IDLE_MS = 30 * 60 * 1000;
/* Checked every half minute. The cost is one comparison; the benefit is
 * that a closed laptop reopened at four o'clock lands on the sign-in page
 * rather than on a stale screen that 401s at the first touch. */
const IDLE_TICK_MS = 30 * 1000;

interface AuthState {
    loading: boolean;
    user: SessionUser | null;
    projects: ProjectMembership[];
    /** Why the sign-in page is showing, when it is showing for a reason. */
    signedOutBecause: 'idle' | null;
    /** Re-read /api/session and /api/me/projects (after login or a change). */
    refresh: () => Promise<void>;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState<SessionUser | null>(null);
    const [projects, setProjects] = useState<ProjectMembership[]>([]);
    const [signedOutBecause, setSignedOutBecause] = useState<'idle' | null>(null);

    const refresh = useCallback(async () => {
        try {
            const u = await api<SessionUser>('/api/session');
            /* SET BEFORE THE PROJECT LIST IS ASKED FOR, and the order is kept
               deliberately now that the reason for it has gone.
               
               It was the fix for a lockout (38e5912): an account whose
               password an administrator had chosen was refused
               /api/me/projects, this function awaited both and set neither
               until both returned, so the 403 threw, `user` stayed null, and
               the shell showed the sign-in page to somebody holding a
               perfectly good session. The forced change is gone
               (drizzle/0050) and that particular 403 cannot happen.
               
               The ordering stays because it is simply the better shape: who
               is signed in does not depend on what they are a member of, and
               any future refusal of the project list should leave a signed-in
               person looking at an application rather than a login form. */
            setUser(u);
            setProjects(await api<ProjectMembership[]>('/api/me/projects'));
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                setUser(null);
                setProjects([]);
            } else {
                throw err;
            }
        } finally {
            setLoading(false);
        }
    }, []);

    /* Start draining as soon as somebody is signed in, and keep draining while
       they are. Nothing queued can be sent without a session, so this is the
       right moment rather than app boot. */
    useEffect(() => {
        if (!user) { setOutboxUser(''); return; }
        // Stamp the queue with who is signed in before it starts draining.
        setOutboxUser(user.username);
        return startOutbox();
    }, [user]);

    const signOut = useCallback(async () => {
        try { await api('/api/logout', { method: 'POST' }); } catch { /* already gone */ }
        /* Tell the service worker to drop its cache too. The shell holds no
           patient data, but a courier handing a phone back should not find
           the app still installed and warm. */
        navigator.serviceWorker?.controller?.postMessage('tag:signed-out');
        /* And empty the outbox. It holds names, addresses and signatures on a
           phone that may be personal; anything still queued belongs to a
           session that is over and could no longer be sent anyway. */
        await clearOutbox().catch(() => { /* nothing queued, or no IndexedDB */ });
        setUser(null);
        setProjects([]);
    }, []);

    /* ANY 401, ANYWHERE, ENDS THE SESSION HERE.
     *
     * refresh() already handled the one on /api/session. Every other call
     * threw into whichever page made it, and the portal rendered that as a
     * red banner over four zeros -- which reads as "your deliveries are
     * gone" rather than "you have been signed out". One handler, registered
     * once, so a page added later cannot forget it.
     *
     * The local state only. No /api/logout call: the session the server
     * holds is already over, that is what the 401 said, and posting to it
     * would be a second refusal to ignore. The outbox is left alone too --
     * it belongs to the person, not the session, and they are about to sign
     * back in on the same device. */
    useEffect(() => {
        whenSessionEnds(() => {
            /* The backstop, for a session the server dropped before this
               browser's own clock reached thirty minutes -- revoked from
               another device, a restart, a tab open since before the idle
               timer shipped. The sign-in page says the same thing either
               way, because to the person reading it the cause is the same. */
            setSignedOutBecause('idle');
            setUser(null);
            setProjects([]);
        });
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    /* ─────────────────────────── signing off before being told to ───────
     *
     * The server idles a session out after thirty minutes and the browser
     * had no idea, so it carried on showing a screen full of numbers until
     * something it asked for failed. This watches the clock instead.
     *
     * Activity is a touch, a key or bringing the tab back. NOT a poll: the
     * portal refreshes itself every fifteen seconds whether anybody is in
     * the room or not, and counting that as activity would mean a session
     * that never idles out as long as a tab is open somewhere -- which is
     * the opposite of what a thirty minute window is for.
     *
     * THE DISPATCH BOARD IS NOT EXEMPT, and that was asked and answered on
     * 14 October rather than left to whoever reads this next.
     *
     * The board polls every fifteen seconds all day, so before this a
     * dispatcher was effectively never signed out; now one who has not
     * touched it for half an hour is. That was raised as a real cost -- it
     * changes how a shift feels, and the first morning of the contract is a
     * bad day to discover it -- and the owner's answer was to treat the
     * board like everything else.
     *
     * It is the right answer. A board left untouched for thirty minutes is
     * an unattended screen showing patients' names, addresses and
     * medications, which is precisely what an idle timeout is for. An
     * exemption for the screen that displays the most PHI for the longest
     * would be the exemption that mattered.
     *
     * So: no allowlist of "active" screens, and no treating a timer as a
     * person. If this is ever revisited, revisit the thirty minutes, not
     * who it applies to.
     */
    useEffect(() => {
        if (!user) return undefined;

        let last = Date.now();
        const touched = () => { last = Date.now(); };

        const check = () => {
            if (Date.now() - last < IDLE_MS) return;
            /* Local only. The server has already dropped it, or is about to,
               and a POST to /api/logout here would be a request nobody is
               waiting for. The outbox is left alone: it belongs to the
               person, not the session. */
            setSignedOutBecause('idle');
            setUser(null);
            setProjects([]);
        };

        /* Checked on wake as well as on the timer, so a laptop closed at
           noon and opened at four lands on the sign-in page rather than on
           a stale screen that 401s at the first touch. */
        const woke = () => { if (!document.hidden) check(); };

        for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
            window.addEventListener(event, touched, { passive: true });
        }
        document.addEventListener('visibilitychange', woke);
        const timer = window.setInterval(check, IDLE_TICK_MS);

        return () => {
            for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
                window.removeEventListener(event, touched);
            }
            document.removeEventListener('visibilitychange', woke);
            window.clearInterval(timer);
        };
    }, [user]);

    /* Cleared the moment somebody is back in, so the line on the sign-in
       page does not survive into the next session. */
    useEffect(() => { if (user) setSignedOutBecause(null); }, [user]);

    const value = useMemo(
        () => ({ loading, user, projects, signedOutBecause, refresh, signOut }),
        [loading, user, projects, signedOutBecause, refresh, signOut],
    );
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth outside AuthProvider');
    return ctx;
}

/* The timezone every time on a project's screens is shown in. It is the
   project's, not the device's: see lib/when.ts for why that distinction is
   worth a module. Pages deep in a project (a stop, an order) have a code from
   the URL but no project object, and this is how they get the zone without
   threading it through every prop. Falls back to the device's zone before the
   memberships have loaded, which is the same answer the app gave before and
   is only ever on screen for one paint. */
export function useProjectTimezone(code: string): string {
    const { projects } = useAuth();
    return projects.find((p) => p.code === code)?.timezone ?? deviceZone();
}
