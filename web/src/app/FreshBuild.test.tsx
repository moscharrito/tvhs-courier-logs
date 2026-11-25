/* Noticing that the page in somebody's hand is not the one being served.
 *
 * This exists because of an hour lost on 25 November: a fix was deployed,
 * the bench reported the old behaviour word for word, and the fix was
 * correct -- the phone was running the morning's JavaScript. The pure
 * parts are tested here rather than the polling, because the comparison
 * is where a mistake would be silent and a timer is not.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import { assetsIn, isDifferentBuild, loadedAssets } from './FreshBuild';

/** Roughly what Vite emits, preloads and all. */
const page = (entry: string, chunk = 'vendor-aaaaaaaa.js') => `<!doctype html>
<html><head>
<link rel="modulepreload" crossorigin href="/assets/${chunk}">
<link rel="stylesheet" crossorigin href="/assets/index-bbbb.css">
<script type="module" crossorigin src="/assets/${entry}"></script>
</head><body><div id="root"></div></body></html>`;

describe('reading the build out of a page', () => {
    it('finds the entry and the chunks, and nothing else', () => {
        expect(assetsIn(page('index-Sixaqj4L.js')))
            .toEqual(['/assets/index-Sixaqj4L.js', '/assets/vendor-aaaaaaaa.js']);
    });

    it('does not count the stylesheet, which has its own hash', () => {
        expect(assetsIn(page('index-Sixaqj4L.js')).some((a) => a.endsWith('.css'))).toBe(false);
    });

    it('reads the running page off the tags in the head', () => {
        /* React renders into #root and never touches these, which is why
           they are a safe record of what this document loaded with. */
        document.head.innerHTML = '<script src="/assets/index-Zzz1.js"></script>'
            + '<link rel="modulepreload" href="/assets/vendor-Qqq2.js">';
        expect(loadedAssets()).toEqual(['/assets/index-Zzz1.js', '/assets/vendor-Qqq2.js']);
        document.head.innerHTML = '';
    });
});

describe('deciding whether to say anything', () => {
    const running = assetsIn(page('index-OLD11111.js'));

    it('says nothing while the served build is the one running', () => {
        expect(isDifferentBuild(running, assetsIn(page('index-OLD11111.js')))).toBe(false);
    });

    it('notices a new entry bundle', () => {
        expect(isDifferentBuild(running, assetsIn(page('index-NEW22222.js')))).toBe(true);
    });

    it('notices a deploy that only changed a lazily loaded chunk', () => {
        /* THE SORT BENCH'S READER IS ONE OF THOSE. A comparison of the
           entry alone would call this build identical and a bench phone
           would keep a stale reader for ever. */
        expect(isDifferentBuild(running, assetsIn(page('index-OLD11111.js', 'vendor-cccccccc.js'))))
            .toBe(true);
    });

    it('is not fooled by the order the tags appear in', () => {
        const shuffled = ['/assets/vendor-aaaaaaaa.js', '/assets/index-OLD11111.js'];
        expect(isDifferentBuild(running, [...shuffled].sort())).toBe(false);
    });

    it('stays quiet when the fetch did not return the application at all', () => {
        /* A captive portal, a maintenance page, a proxy error. Offering a
           reload INTO that is the worst moment to do it, and "the page
           has no bundles on it" is not evidence of a new build. */
        expect(isDifferentBuild(running, [])).toBe(false);
        expect(isDifferentBuild(running, assetsIn('<html><body>Sign in to the wifi</body></html>')))
            .toBe(false);
    });

    it('stays quiet when it cannot tell what is running either', () => {
        expect(isDifferentBuild([], assetsIn(page('index-NEW22222.js')))).toBe(false);
    });
});

/* ── THE WORKER'S HALF OF IT.
 *
 * A browser decides a service worker has changed by comparing the bytes
 * of public/sw.js. It carried a hard-coded cache version until
 * 25 November, so every deploy shipped a byte-identical worker, no
 * update was ever detected, and no handset ever learned that the
 * application had changed. These are static assertions about that file
 * because the failure is total, silent, and costs an hour each time
 * somebody rediscovers it.
 */
describe('the service worker can tell a deploy happened', () => {
    const sw = readFileSync('public/sw.js', 'utf8');

    it('carries the token the build replaces, or it can never update', () => {
        /* vite.config.ts fails the build if this is missing. The test is
           here so the reason is written down next to the consequence. */
        expect(sw).toContain('__BUILD_ID__');
        expect(sw).not.toMatch(/const VERSION = 'tag-shell-v\d+'/);
    });

    it('tells the open page when it takes over', () => {
        expect(sw).toContain("type: 'tag:updated'");
        expect(sw).toContain('clients.matchAll');
    });

    it('throws the previous build’s caches away first', () => {
        expect(sw).toMatch(/caches\.keys\(\)/);
        expect(sw).toMatch(/caches\.delete\(k\)/);
    });

    it('does not navigate anybody by itself', () => {
        /* A reload firing under a dispatcher mid-form, or looping if the
           detection is ever wrong. The page decides; the bar has a
           button on it. The notification handler's own navigate() is a
           different thing and is allowed. */
        const activate = sw.slice(sw.indexOf("addEventListener('activate'"), sw.indexOf("addEventListener('fetch'"));
        /* Comments stripped first: the handler's own note explains at
           length why it does NOT call client.navigate(), and a test that
           reads prose would fail on the explanation. */
        const code = activate.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toContain('navigate');
    });
});
