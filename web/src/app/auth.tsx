/* Session state for the shell: who is signed in and which projects they belong to. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type ProjectMembership, type SessionUser } from '../lib/api';
import { clearOutbox, startOutbox } from '../lib/outbox';

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
            const p = await api<ProjectMembership[]>('/api/me/projects');
            setUser(u);
            setProjects(p);
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
        if (!user) return;
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
