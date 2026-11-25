/* TAG courier service worker.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: nothing from /api is ever cached.
 *
 * A service worker is a cache that outlives the session, the sign-out and
 * often the employment. If it cached API responses, a courier's personal
 * phone would keep a copy of a day of patient names and addresses in Cache
 * Storage, readable by anyone who picks the phone up, long after the session
 * cookie expired and the account was disabled. That is a reportable breach
 * caused by a performance optimisation.
 *
 * So the cache holds the application shell only: the HTML, the JavaScript,
 * the stylesheet, the icon. Those contain no patient data and never will.
 * Every request to /api and /legacy goes straight to the network, and if the
 * network is not there the request fails and the app says so.
 *
 * Offline queueing of a courier's own events is ticket 2.7, and it will use
 * IndexedDB with an explicit lifetime, not this cache.
 */

/* ── THE VERSION IS THE BUILD, from 25 November, and that is the whole
   point of it.
 
   It was the literal string 'tag-shell-v1' and never changed. A browser
   decides a service worker has been updated by comparing the BYTES of
   this file against the one it has; a deploy that rewrote the entire
   application left this file identical, so no update was ever detected,
   the old caches were never cleared, and nothing on a handset ever
   learned that anything had changed.
 
   web/vite.config.ts replaces the token below at build time. Each deploy
   therefore ships a different sw.js, the browser notices on its next
   update check, the activate handler throws away every cache from the
   previous build, and the open page is told. */
const VERSION = 'tag-shell-__BUILD_ID__';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSION)
            // addAll fails the whole install if one entry 404s. The hashed
            // asset names are not known here, so only the stable entries are
            // pre-cached and the rest arrive on first use.
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
        await self.clients.claim();

        /* ── AND TELL WHOEVER IS LOOKING AT IT.
         *
         * A page that has been open on a bench all day is running the
         * JavaScript it downloaded that morning, and until now nothing
         * could tell it otherwise: it is the page itself that would have
         * to notice, and it cannot notice anything about code it is not
         * running. This is the one message that arrives from outside it.
         *
         * IT DOES NOT NAVIGATE THEM. client.navigate() would work and
         * would reload a dispatcher mid-form, or loop if this is ever
         * wrong. The page decides what to do with it -- see
         * app/FreshBuild.tsx, which puts a bar up with a button on it.
         *
         * A page from an older build does not listen for this and will
         * ignore it, which is correct and is also why the caches above
         * are cleared whether anybody is listening or not: that at least
         * makes their NEXT load a clean one. */
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows) client.postMessage({ type: 'tag:updated', version: VERSION });
    })());
});

/** Anything that could carry patient data, or that changes what the user sees. */
function isPrivate(url) {
    return url.pathname.startsWith('/api/')
        || url.pathname.startsWith('/legacy/')
        || url.pathname === '/health';
}

/** The shell: hashed build assets, the icon, the manifest. */
function isShellAsset(url) {
    return url.pathname.startsWith('/assets/')
        || url.pathname === '/icon.svg'
        || url.pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Never touched, never stored. See the header comment.
    if (isPrivate(url)) return;

    if (isShellAsset(url)) {
        // Build assets are content-hashed, so a cached one is never stale.
        event.respondWith(
            caches.match(request).then((hit) => hit || fetch(request).then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(VERSION).then((cache) => cache.put(request, copy));
                }
                return res;
            })),
        );
        return;
    }

    if (request.mode === 'navigate') {
        /* Network first, so a deployed change is picked up immediately; the
         * cached shell is the fallback when the van is somewhere with no
         * signal. The shell renders and then tells the courier it cannot
         * reach dispatch, which is more useful than a browser error page. */
        event.respondWith(
            fetch(request)
                .then((res) => {
                    if (res.ok) {
                        const copy = res.clone();
                        caches.open(VERSION).then((cache) => cache.put('/', copy));
                    }
                    return res;
                })
                .catch(() => caches.match('/').then((hit) => hit || Response.error())),
        );
    }
});

/* Signing out clears the shell cache as well as the session. The shell holds
 * no patient data, but a courier handing a phone back should not find the app
 * still installed and warm. */
self.addEventListener('message', (event) => {
    if (event.data === 'tag:signed-out') {
        event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
    }
});

/* ─────────────────────────────────────────── clicking a desktop notification
 *
 * The banner is shown by this worker rather than by the page (see
 * web/src/lib/desktop.ts for why), so the click arrives here and the worker
 * decides where it goes.
 *
 * IT FOCUSES THE TAB THAT IS ALREADY OPEN. A dispatcher has this application
 * open all day; a notification that opened a second copy of it would leave
 * them with two, then three, then a browser they have to tidy up, and the
 * pharmacy's own system somewhere behind them. So: look for a window on this
 * origin, focus it, and tell it where to go. Only when there is genuinely
 * none -- the laptop was shut, the tab was closed -- is a new one opened.
 *
 * THE NAVIGATION IS A MESSAGE, NOT A RELOAD, when a tab exists. This is a
 * single-page application: navigating the window would throw away the
 * React tree, re-authenticate, re-fetch the board and lose anything half
 * typed. `navigate()` on a WindowClient is tried first because it is the
 * standard way, and the message is the fallback for browsers that do not
 * implement it. The app listens for that message in
 * web/src/app/useNotices.ts and routes it, rather than setting
 * location.href, so the React tree survives the trip.
 *
 * NOTHING HERE IS CACHED AND NOTHING IS STORED. The href is a path this
 * application already routes; the notification itself is discarded on click.
 */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const href = (event.notification.data && event.notification.data.href) || '/';
    const target = new URL(href, self.location.origin).href;

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows) {
            if (new URL(client.url).origin !== self.location.origin) continue;
            await client.focus();
            if ('navigate' in client) {
                try {
                    await client.navigate(target);
                    return;
                } catch {
                    /* Some browsers refuse navigate() on a client they did
                       not open. The message below is the way through. */
                }
            }
            client.postMessage({ type: 'tag:open', href });
            return;
        }
        await self.clients.openWindow(target);
    })());
});

/* A notification dismissed rather than clicked. Nothing to do -- it stays
 * unread in the bell, which is the correct outcome: swiping a banner away is
 * not the same as dealing with the thing. Declared so that the absence is a
 * decision somebody wrote down rather than an oversight. */
self.addEventListener('notificationclose', () => {});
