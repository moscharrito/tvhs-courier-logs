/* Which server a build talks to (ticket 7.6).
 *
 * Pure, and tested, because getting this wrong is not a bug somebody notices
 * in development: it is a bug Apple notices.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS TO PREVENT.
 *
 * Until this ticket `app.json` carried `apiBaseUrl: http://127.0.0.1:3100`,
 * which is correct for a simulator on this machine and catastrophic in a
 * submitted build: the reviewer taps Sign in, the app reaches for a server on
 * the reviewer's own phone, nothing answers, and the app is rejected as
 * broken. That is a wasted review cycle for a one-line constant.
 *
 * So a release build has to be told, and is refused if it is not. A
 * development build defaults to localhost, because that is what it is for.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS .cjs AND NOT .ts, which looks like a step backwards.
 *
 * `app.config.ts` is the only caller, and Expo loads that file by
 * transpiling IT ALONE with sucrase and then handing the result to Node's
 * ordinary CommonJS require. Nothing registers a TypeScript loader for what
 * the config file imports, so `import { resolveApiUrl } from
 * './src/lib/apiUrl'` resolved under tsc, passed typecheck, and then failed
 * at run time with "Cannot find module ./src/lib/apiUrl" the first time
 * anybody ran `expo start`. Which was after it shipped, because ticket 7.6
 * typechecked the app and never ran it.
 *
 * So the one guard whose whole job is to stop a broken build was itself the
 * thing that broke every build. CommonJS, with a .d.cts beside it so callers
 * still get types and the tests still typecheck.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * AND IT MUST BE HTTPS IN RELEASE. Session tokens and patient addresses cross
 * this connection. Both platforms block plain HTTP by default anyway (App
 * Transport Security, and Android's cleartext policy), so an http:// release
 * URL produces a build that fails silently on device rather than loudly at
 * build time. Better to fail here.
 */

class ApiUrlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApiUrlError';
    }
}

/* Port 3000, matching .claude/launch.json and server/src/index.ts. It said
   3100 until this ticket, which is a port nothing in this repository listens
   on, so the documented default was wrong in development too. */
const DEV_FALLBACK = 'http://127.0.0.1:3000';

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2|\[::1\])(:\d+)?$/i;

/**
 * The base URL for this build, or a refusal explaining what to set.
 *
 * Throws rather than falling back, on purpose. A release build that quietly
 * points at localhost is the failure mode; a build that stops with a sentence
 * naming the variable is twenty seconds.
 */
function resolveApiUrl({ configured, profile }) {
    const release = profile === 'production' || profile === 'preview';
    const url = (configured ?? '').trim();

    if (url === '') {
        if (!release) return DEV_FALLBACK;
        throw new ApiUrlError(
            `EXPO_PUBLIC_API_URL is not set, and a ${profile} build cannot default to localhost: `
            + 'the app would reach for a server on the reviewer’s own phone and be rejected as broken. '
            + 'Set it in eas.json for this profile.',
        );
    }

    if (!/^https?:\/\//i.test(url)) {
        throw new ApiUrlError(`EXPO_PUBLIC_API_URL must start with http:// or https://. Got: ${url}`);
    }

    if (release && LOCAL.test(url.replace(/\/+$/, ''))) {
        throw new ApiUrlError(
            `A ${profile} build cannot point at ${url}. That address is the phone itself, so the app would `
            + 'reach nothing on any device but this one.',
        );
    }

    if (release && url.toLowerCase().startsWith('http://')) {
        throw new ApiUrlError(
            `A ${profile} build must use https. Session tokens and patient addresses cross this connection, `
            + 'and both platforms block plain HTTP by default, so this would fail silently on a device.',
        );
    }

    return url.replace(/\/+$/, '');
}

module.exports = { ApiUrlError, DEV_FALLBACK, resolveApiUrl };
