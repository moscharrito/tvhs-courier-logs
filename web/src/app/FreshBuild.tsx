/* Telling a page that has been open for hours that it is out of date.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT HAPPENED ON 25 NOVEMBER, BECAUSE NOTHING HERE EXISTED.
 *
 * A fix went out, the bench tested it within the minute, and reported the
 * old behaviour word for word. The server was on the new commit and the
 * bundle it was serving had the new code in it -- both checked. The phone
 * was simply still running the JavaScript it had downloaded that morning.
 *
 * It is a progressive web app pinned to a home screen on a bench handset.
 * Nothing in that story ever reloads. The sorter opens it, uses it all
 * day, and the tab is the same tab tomorrow; a deploy changes the files
 * on the server and not one byte of what is running in their hand.
 *
 * THE COST IS NOT THE STALENESS. It is that nobody can tell. A tester
 * reports a fix did not work, the fix is correct, and the next hour goes
 * on looking for a bug in the wrong place -- which is exactly the hour
 * that was lost. A driver on an old build gets yesterday's rules for
 * today's round and has no idea.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT KNOWS, WHICH IS NOT THE SERVICE WORKER.
 *
 * The obvious mechanism is the worker's own update lifecycle. It cannot
 * work here: public/sw.js is a fixed file with a hard-coded VERSION, so a
 * deploy that changes the application changes nothing about the worker,
 * registration.update() fetches a byte-identical file and no updatefound
 * ever fires. Making the worker's version a build stamp would work and
 * would mean the cache is thrown away on every deploy, which is a real
 * cost on warehouse wifi for a problem that does not need it.
 *
 * So: index.html names its entry bundle, and the name carries a content
 * hash. Fetch it, compare the asset names against the ones this document
 * loaded with, and any difference means a different build is being
 * served. No build-time plumbing, no version endpoint to keep in step,
 * and it is true by construction -- the thing being compared IS the code.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT OFFERS, IT DOES NOT RELOAD.
 *
 * A reload that happens by itself under somebody's hands throws away a
 * half-typed delivery note and, if the detection is ever wrong, does it
 * in a loop. A dispatcher mid-form would not thank us. So this is a bar
 * with a button on it, and the one thing it must get right is being
 * impossible to miss on a phone -- see the stylesheet.
 */

import { useCallback, useEffect, useState } from 'react';

/** How often a page that is being looked at checks. */
const EVERY_MS = 5 * 60 * 1000;

/**
 * The build assets this document loaded with.
 *
 * Read off the tags in <head>, which React never touches -- it renders
 * into #root. Both the entry script and the preloaded chunks count: a
 * deploy that changes only a lazily imported chunk, which is where the
 * sort bench's reader lives, still has to register as a new build.
 */
export function loadedAssets(doc: Document = document): string[] {
    const srcs = [...doc.querySelectorAll('script[src], link[href]')]
        .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
        .filter((u) => u.startsWith('/assets/') && u.endsWith('.js'));
    return [...new Set(srcs)].sort();
}

/**
 * The build assets named by a served index.html.
 *
 * Deliberately a regular expression over the text rather than a parse
 * into a document: parsing it would mean handing an HTML string to the
 * browser, and the only thing wanted out of it is a list of file names.
 */
export function assetsIn(html: string): string[] {
    const found = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/g) ?? [];
    return [...new Set(found)].sort();
}

/** Whether these are two different builds. Same list, same code. */
export function isDifferentBuild(running: string[], served: string[]): boolean {
    /* An empty served list is a fetch that returned something other than
       the application -- a captive portal, a maintenance page, an error.
       Not a new build, and prompting a reload into it would be the worst
       possible moment to do so. */
    if (served.length === 0 || running.length === 0) return false;
    return running.join('|') !== served.join('|');
}

/**
 * True once the server is serving a different build to the one running.
 *
 * Checks when the tab is looked at again and every few minutes while it
 * is, which is as often as it is worth asking: a deploy a sorter has not
 * looked at the screen since is not yet a problem.
 */
export function useFreshBuild(): boolean {
    const [stale, setStale] = useState(false);

    const check = useCallback(async () => {
        if (document.visibilityState !== 'visible') return;
        try {
            /* no-store so neither the browser cache nor anything between
               here and the server can answer with the page this tab was
               opened from -- which is the very thing being tested. */
            const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
            if (!res.ok) return;
            const html = await res.text();
            if (isDifferentBuild(loadedAssets(), assetsIn(html))) setStale(true);
        } catch {
            /* Offline, or dispatch is unreachable. Neither is news this
               bar should break to deliver, and SyncStatus says it
               already. */
        }
    }, []);

    useEffect(() => {
        /* Nothing to compare in development: Vite serves modules from
           /src and there is no hashed bundle at all. */
        if (!import.meta.env.PROD) return undefined;

        void check();
        const timer = setInterval(() => { void check(); }, EVERY_MS);
        const onShow = () => { void check(); };
        document.addEventListener('visibilitychange', onShow);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onShow);
        };
    }, [check]);

    return stale;
}

/**
 * The bar itself.
 *
 * Above everything, because the thing it is warning about is that what
 * is below it may be wrong -- including, on a bad day, the driver's own
 * round. It is phrased for somebody who has never heard the word build.
 */
export function FreshBuild() {
    const stale = useFreshBuild();
    if (!stale) return null;
    return (
        <div className="izy-fresh-build" role="status">
            <span>A newer version of TAG is ready. What you are looking at may be out of date.</span>
            <button type="button" className="izy-btn small" onClick={() => { window.location.reload(); }}>
                Reload
            </button>
        </div>
    );
}
