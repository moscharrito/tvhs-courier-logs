/* Keep a screen current without anybody pressing anything.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT setInterval AND BE DONE.
 *
 * This runs on a pharmacy counter, on a machine that stays logged in all day
 * with the tab in the background behind whatever else the staff are doing. A
 * plain interval keeps polling into a hidden tab for eight hours, which is
 * several thousand requests nobody will ever look at, against a free-tier
 * server and a database billed by the read.
 *
 * So it stops when the tab is hidden and fetches once immediately when it
 * comes back, which is the moment somebody actually wants the answer.
 *
 * IT ALSO HAS TO BE PAUSABLE BY HAND. A pharmacist reading a row does not
 * want it to move, and "why did it jump" is a support call. Pausing is theirs
 * to choose and the screen says when it last managed to look.
 *
 * NEVER OVERLAPS. A slow response on a bad connection must not stack up
 * behind itself; a tick that arrives while one is in flight is dropped,
 * because the one in flight will be newer anyway.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Live {
    /** When the last successful load finished. Null until the first one. */
    updatedAt: Date | null;
    /** Seconds since that, recomputed every second so a label can count up. */
    secondsAgo: number | null;
    paused: boolean;
    setPaused: (paused: boolean) => void;
    /** Load now, whatever the timer is doing. */
    refresh: () => void;
    /** True while a load is in flight, for a quiet spinner. */
    busy: boolean;
}

/**
 * @param load   what to run. Should not throw; a rejection is swallowed and
 *               the clock simply does not advance, which is the honest thing
 *               to show when the last attempt failed.
 * @param everySeconds how often, when visible and not paused.
 */
export function useLive(load: () => Promise<void>, everySeconds = 20): Live {
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const [paused, setPaused] = useState(false);
    const [busy, setBusy] = useState(false);
    const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

    /* The callback changes identity whenever its filters do. Held in a ref so
       the timer below is not torn down and restarted on every render, which
       would reset the interval and, with a short enough interval and a busy
       screen, mean it never fires at all. */
    const loadRef = useRef(load);
    loadRef.current = load;
    const inFlight = useRef(false);

    const run = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        try {
            await loadRef.current();
            setUpdatedAt(new Date());
        } catch {
            /* Left to the caller to surface. The clock not moving is the
               signal here: a stale screen that says it is stale beats a fresh
               error banner over yesterday's data. */
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }, []);

    /* The timer. Restarted when the tab becomes visible, so a counter screen
       left in the background all morning is current the moment it is clicked
       back to rather than up to a cycle out of date. */
    useEffect(() => {
        if (paused) return undefined;

        let timer: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (timer === null) timer = setInterval(() => { void run(); }, everySeconds * 1000);
        };
        const stop = () => {
            if (timer !== null) { clearInterval(timer); timer = null; }
        };

        const onVisibility = () => {
            if (document.hidden) { stop(); return; }
            void run();
            start();
        };

        if (!document.hidden) start();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            stop();
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [paused, everySeconds, run]);

    /* A separate, cheap tick so "updated 14 seconds ago" counts up between
       loads rather than jumping by the poll interval. */
    useEffect(() => {
        if (updatedAt === null) { setSecondsAgo(null); return undefined; }
        const tick = () => setSecondsAgo(Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 1000)));
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [updatedAt]);

    return { updatedAt, secondsAgo, paused, setPaused, refresh: () => { void run(); }, busy };
}

/** "just now", "14s ago", "3m ago". Short, because it sits in a line of
 *  controls rather than in prose. */
export function agoLabel(secondsAgo: number | null): string {
    if (secondsAgo === null) return 'not yet loaded';
    if (secondsAgo < 5) return 'just now';
    if (secondsAgo < 60) return `${secondsAgo}s ago`;
    const minutes = Math.round(secondsAgo / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}
