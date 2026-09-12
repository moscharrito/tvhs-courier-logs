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

const VERSION = 'tag-shell-v1';
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
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
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
