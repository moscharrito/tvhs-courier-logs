/* What you have been told, kept current behind whatever you are doing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT useLive.
 *
 * useLive stops polling the moment the tab is hidden, and it is right to:
 * it backs screens -- the board, a counter's deliveries list -- that nobody
 * is reading when nobody is looking, and eight hours of polling into a
 * background tab is thousands of reads against a database billed by the row
 * to refresh a page no human is in front of.
 *
 * A notification is the one thing in the application with the opposite
 * requirement. Its entire purpose is to arrive while the person is in a
 * spreadsheet, on the telephone, or in the pharmacy's own system -- which is
 * to say, while this tab is hidden. A bell that only updates when you are
 * already looking at it is a list, not a notification.
 *
 * SO IT KEEPS POLLING WHEN HIDDEN, SLOWER, AND HERE IS THE BILL. Twenty-five
 * seconds visible, seventy-five hidden. A dispatch chair logged in for a
 * nine-hour day costs about 430 requests hidden, each one an indexed read of
 * one person's rows on notifications_user_idx. Four chairs is under two
 * thousand a day, against a contract doing fifteen hundred deliveries. That
 * is the price of the feature and it is worth writing down, because the
 * cheap-looking version of this -- poll every five seconds, it is only a
 * count -- is ten times that and nobody would have noticed until the bill.
 *
 * ONE CHAIN OF TIMEOUTS, NOT AN INTERVAL, so the cadence can change when the
 * tab is hidden or shown without tearing the timer down and restarting it --
 * a restart resets the clock, and a short enough cycle with a slow enough
 * response means it never fires at all.
 *
 * NEVER OVERLAPS, same rule as useLive. A slow response on a bad connection
 * must not stack up behind itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY PROJECT, NOT THE ONE YOU ARE STANDING IN.
 *
 * A notification addressed to you about a contract you are not currently
 * looking at is precisely the one you would otherwise miss. In practice this
 * is one request: a driver has one contract, a pharmacist has one counter.
 * An administrator on both pays two.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE HIGH-WATER MARK, AND WHY A PAGE REFRESH IS SILENT.
 *
 * The first load after signing in finds whatever was waiting -- possibly
 * twenty rows from overnight. Announcing those to the operating system would
 * put twenty banners on the screen at once, every morning, which is how
 * somebody learns to turn the feature off on day one.
 *
 * So the rule is: the first successful load ANNOUNCES NOTHING and records
 * the highest id it saw. Only a row above that line is new enough to
 * interrupt somebody. The line is kept in localStorage per account, so
 * reloading the page -- or opening a second tab -- does not re-announce what
 * has already been seen on this machine. The bell itself still shows every
 * unread row, because that is a list and a list is allowed to be long.
 */

import {
    createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState,
    type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from './auth';
import { desktopState, showDesktop } from '../lib/desktop';

/** Seconds between looks while somebody is on the tab. */
const EVERY_VISIBLE = 25;
/** And while they are not. See the header for what this costs. */
const EVERY_HIDDEN = 75;

export interface Notice {
    id: number;
    kind: string;
    body: string;
    orderId: number | null;
    createdAt: string;
    readAt: string | null;
    /** Whether a channel outside the app ever took it. Null while none is
     *  configured, which is the honest state and is shown as such. */
    pushedAt: string | null;
    dispatchResult: string;
    /** Which contract it belongs to -- the code, for the link. */
    project: string;
    /** And its name, shown only when somebody is on more than one. */
    projectName: string;
}

interface Fetched {
    unread: number;
    notifications: Omit<Notice, 'project' | 'projectName'>[];
}

export interface Notices {
    /** Newest first, across every contract. */
    notices: Notice[];
    unread: number;
    /** Null until the first successful load; a stale bell that says it is
     *  stale beats a confident wrong count. */
    updatedAt: Date | null;
    /** True while the very first load is in flight, so the panel can say
     *  "looking" rather than "nothing". */
    loading: boolean;
    /** The last load failed. The count shown is the one before it. */
    failing: boolean;
    markRead: (ids: number[]) => Promise<void>;
    markAllRead: () => Promise<void>;
    refresh: () => void;
}

const EMPTY: Notices = {
    notices: [], unread: 0, updatedAt: null, loading: true, failing: false,
    markRead: async () => {}, markAllRead: async () => {}, refresh: () => {},
};

const Ctx = createContext<Notices>(EMPTY);

export const useNotices = (): Notices => useContext(Ctx);

/** Where a notification takes you when it is clicked.
 *
 *  An order if it names one, and otherwise the contract's own page -- which
 *  is where the drop box lives, so `list.dropped` lands on the thing it is
 *  about rather than on a generic home. Nothing here guesses at a screen the
 *  reader may not be allowed to open: both of these are routed for every
 *  role (see App.tsx). */
export function hrefFor(n: Pick<Notice, 'project' | 'orderId'>): string {
    return n.orderId === null
        ? `/projects/${n.project}`
        : `/projects/${n.project}/orders/${n.orderId}`;
}

/** The line below which a row is old news, per account and per machine. */
const markKey = (username: string) => `notify.seen.${username}`;

function readMark(username: string): number | null {
    try {
        const raw = window.localStorage.getItem(markKey(username));
        if (raw === null) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        /* Private browsing, or storage refused. The consequence is that a
           reload re-announces, which is noisy rather than broken -- and the
           same direction the server's prefs module errs in. */
        return null;
    }
}

function writeMark(username: string, id: number): void {
    try { window.localStorage.setItem(markKey(username), String(id)); } catch { /* as above */ }
}

export function NoticesProvider({ children }: { children: ReactNode }) {
    const { user, projects } = useAuth();
    const navigate = useNavigate();
    const [notices, setNotices] = useState<Notice[]>([]);
    const [unread, setUnread] = useState(0);
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const [loading, setLoading] = useState(true);
    const [failing, setFailing] = useState(false);

    const username = user?.username ?? '';
    /* ── THE DEPENDENCY THAT HAD TO BE A STRING ───────────────────────────
     *
     * `projects` is a fresh array on every render of the auth provider. Used
     * as a dependency it makes `load` a new function every render, which
     * makes the polling effect below tear its timer down and build a new one
     * every render -- and a timer that is restarted before it fires never
     * fires at all. The bell would have sat on its first load for ever,
     * looking exactly like a working feature.
     *
     * So the identity of "which contracts" is the codes joined, which only
     * changes when they really do, and the NAMES -- needed for a label and
     * nothing else -- are read from a ref rather than depended on. */
    const codes = projects.map((p) => p.code).join(',');
    const names = useRef(new Map<string, string>());
    names.current = new Map(projects.map((p) => [p.code, p.name]));

    const inFlight = useRef(false);
    /* The high-water mark, held in a ref as well as storage: the poll reads
       it on every cycle and a state update per cycle would re-render the
       whole application shell twenty-four times an hour for nothing. */
    const mark = useRef<number | null>(null);

    const load = useCallback(async () => {
        if (inFlight.current || username === '' || codes === '') return;
        inFlight.current = true;
        try {
            const list = codes.split(',');
            const pages = await Promise.all(list.map(async (code) => {
                const got = await api<Fetched>(`/api/projects/${code}/uh/notifications`);
                return got.notifications.map((n) => ({
                    ...n, project: code, projectName: names.current.get(code) ?? code,
                }));
            }));
            const all = pages.flat().sort((a, b) => (
                a.createdAt === b.createdAt ? b.id - a.id : (a.createdAt < b.createdAt ? 1 : -1)
            ));

            setNotices(all);
            setUnread(all.filter((n) => n.readAt === null).length);
            setUpdatedAt(new Date());
            setFailing(false);
            setLoading(false);

            /* ── who gets interrupted ──────────────────────────────────────
               The first load only draws the line; see the header. */
            const highest = all.reduce((hi, n) => Math.max(hi, n.id), 0);
            if (mark.current === null) {
                mark.current = readMark(username) ?? highest;
                if (readMark(username) === null) writeMark(username, highest);
            }
            const line = mark.current;
            if (desktopState() === 'granted') {
                /* Oldest first, so three arriving together stack in the
                   order they happened rather than backwards. */
                const fresh = all
                    .filter((n) => n.id > line && n.readAt === null)
                    .sort((a, b) => a.id - b.id);
                for (const n of fresh) await showDesktop({ ...n, href: hrefFor(n) });
            }
            if (highest > line) {
                mark.current = highest;
                writeMark(username, highest);
            }
        } catch {
            /* Left as a flag rather than thrown. A bell that cannot reach the
               server shows the last count it had and says it is stale; an
               error banner across the top of every screen in the application
               because one poll missed would be worse than the problem. */
            setFailing(true);
            setLoading(false);
        } finally {
            inFlight.current = false;
        }
    }, [username, codes]);

    /* Reset when the account changes, so one person's line is never used for
       the next person to sign in on the same machine. */
    useEffect(() => {
        mark.current = null;
        setNotices([]);
        setUnread(0);
        setUpdatedAt(null);
        setLoading(username !== '');
    }, [username]);

    useEffect(() => {
        if (username === '' || codes === '') return undefined;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;

        const cycle = () => {
            if (stopped) return;
            timer = setTimeout(() => {
                void load().finally(cycle);
            }, (document.hidden ? EVERY_HIDDEN : EVERY_VISIBLE) * 1000);
        };

        /* Coming back to the tab is the moment somebody wants the answer, so
           it is worth a look out of turn. Hiding is not: the chain carries
           on at the slower cadence from wherever it is. */
        const onVisibility = () => {
            if (document.hidden) return;
            if (timer !== null) { clearTimeout(timer); timer = null; }
            void load().finally(cycle);
        };

        void load().finally(cycle);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            stopped = true;
            if (timer !== null) clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [username, codes, load]);

    /* ── somebody clicked the banner in the corner of the screen ───────────
     *
     * The service worker focuses the tab and then tries to move it; browsers
     * that refuse a WindowClient.navigate() post this message instead. See
     * web/public/sw.js.
     *
     * ROUTED RATHER THAN RELOADED, which is the whole reason the message
     * exists: this is a single-page application, and setting location.href
     * would throw away the React tree, re-authenticate, re-fetch the board
     * and lose anything half-typed on the screen the dispatcher was on.
     *
     * ONLY A PATH ON THIS SITE IS FOLLOWED. The message arrives through the
     * service worker and nothing else can post it, but a router handed an
     * absolute URL from a message is one bug away from being an open
     * redirect, and the check is one line. */
    useEffect(() => {
        if (!('serviceWorker' in navigator)) return undefined;
        const onMessage = (e: MessageEvent) => {
            const data = e.data as { type?: string; href?: string } | null;
            if (!data || data.type !== 'tag:open') return;
            const href = String(data.href ?? '');
            if (!href.startsWith('/') || href.startsWith('//')) return;
            navigate(href);
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    }, [navigate]);

    const markRead = useCallback(async (ids: number[]) => {
        if (ids.length === 0) return;
        const mine = notices.filter((n) => ids.includes(n.id));
        /* Optimistic, because the bell has to answer a click instantly and
           the next poll corrects anything that did not take. */
        const at = new Date().toISOString();
        setNotices((was) => was.map((n) => (ids.includes(n.id) && n.readAt === null ? { ...n, readAt: at } : n)));
        setUnread((was) => Math.max(0, was - mine.filter((n) => n.readAt === null).length));
        /* Grouped by contract: the ids are per project and sending one
           project's ids to another marks nothing, silently. */
        const byProject = new Map<string, number[]>();
        for (const n of mine) byProject.set(n.project, [...(byProject.get(n.project) ?? []), n.id]);
        await Promise.all([...byProject].map(async ([code, list]) => {
            try {
                await api(`/api/projects/${code}/uh/notifications/read`, { method: 'POST', json: { ids: list } });
            } catch { /* The next poll will put it back, which is the honest end. */ }
        }));
    }, [notices]);

    const markAllRead = useCallback(async () => {
        const at = new Date().toISOString();
        setNotices((was) => was.map((n) => (n.readAt === null ? { ...n, readAt: at } : n)));
        setUnread(0);
        await Promise.all(codes.split(',').filter(Boolean).map(async (code) => {
            try {
                await api(`/api/projects/${code}/uh/notifications/read`, { method: 'POST', json: { ids: [] } });
            } catch { /* as above */ }
        }));
    }, [codes]);

    const value = useMemo<Notices>(() => ({
        notices, unread, updatedAt, loading, failing, markRead, markAllRead, refresh: () => { void load(); },
    }), [notices, unread, updatedAt, loading, failing, markRead, markAllRead, load]);

    /* createElement rather than JSX so this file stays .ts beside the other
       hooks, which is where somebody looks for it. */
    return createElement(Ctx.Provider, { value }, children);
}
