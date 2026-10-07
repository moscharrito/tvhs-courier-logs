/* Session state for the shell: who is signed in and which projects they belong to. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type ProjectMembership, type SessionUser } from '../lib/api';
import { clearOutbox, setOutboxUser, startOutbox } from '../lib/outbox';
import { deviceZone } from '../lib/when';

/* The server's code for "your password was set for you". Spelled once here
   rather than at each call site; it is MUST_CHANGE_CODE in
   server/src/core/auth/must-change.ts and the two have to stay the same
   string. */
const MUST_CHANGE_CODE = 'password.mustChange';

interface AuthState {
    loading: boolean;
    user: SessionUser | null;
    projects: ProjectMembership[];
    /** Re-read /api/session and /api/me/projects (after login or a change). */
    refresh: () => Promise<void>;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState<SessionUser | null>(null);
    const [projects, setProjects] = useState<ProjectMembership[]>([]);

    const refresh = useCallback(async () => {
        try {
            const u = await api<SessionUser>('/api/session');
            /* SET BEFORE THE PROJECT LIST IS ASKED FOR, and that order is the
               fix rather than a tidy-up.
               
               An account whose password an administrator chose is refused
               almost everything until it is replaced, and /api/me/projects is
               refused with the rest: it is a read of what the account can
               reach, which is exactly what the refusal is for, so it can
               never join the allowed list.
               
               This used to await both and set neither until both had
               returned. So the 403 threw, `user` stayed null, and the shell
               rendered the sign-in page to somebody holding a perfectly good
               session. The redirect that takes them to the password form is
               keyed on user.mustChangePassword, so it could not fire either:
               the one screen the server would have accepted a request from
               was the one screen they could not reach. They would have typed
               a working password repeatedly and then telephoned us. */
            setUser(u);

            try {
                setProjects(await api<ProjectMembership[]>('/api/me/projects'));
            } catch (err) {
                /* Matched on the code, not the sentence. A 403 here means
                   "do this one thing first" rather than "you may not", and
                   telling those apart by wording is how a copy edit becomes
                   a lockout. Empty is the truthful answer: they reach no
                   project until the password is replaced. */
                if (err instanceof ApiError && err.code === MUST_CHANGE_CODE) setProjects([]);
                else throw err;
            }
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

    useEffect(() => { void refresh(); }, [refresh]);

    const value = useMemo(() => ({ loading, user, projects, refresh, signOut }), [loading, user, projects, refresh, signOut]);
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
