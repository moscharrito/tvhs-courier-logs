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
const DEV_PORT = 3000;
const DEV_FALLBACK = `http://127.0.0.1:${DEV_PORT}`;

/* ─────────────────────────────────────────────────────────────────────────
 * WHY DEVELOPMENT LOOKS UP THIS MACHINE'S LAN ADDRESS.
 *
 * 127.0.0.1 is the phone, not the laptop. A real device on Expo Go loads the
 * bundle over the network and then asks 127.0.0.1:3000 for the API, which is
 * itself, and hangs at sign-in with nothing on screen explaining why.
 *
 * The workaround was to pass EXPO_PUBLIC_API_URL with the laptop's address
 * by hand, and that address is a DHCP lease. It changed once mid-session
 * here: the phone stopped connecting, the QR pointed at a subnet nobody was
 * on any more, and the baked-in apiBaseUrl pointed at the old network, which
 * is the failure that looks like a broken app rather than a moved laptop.
 *
 * So development works it out. An explicit EXPO_PUBLIC_API_URL still wins,
 * because a developer pointing at a staging server means it. Release builds
 * are untouched: they refuse, as they always did.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The first real IPv4 address of this machine, or null when there is none.
 *
 * Takes the interface map rather than reading it, so the choice between two
 * addresses is testable without a second network card.
 */
function lanAddress(interfaces) {
    /* Sorted, so a machine with Wi-Fi and Ethernet gives the same answer
       twice rather than depending on enumeration order. */
    for (const name of Object.keys(interfaces || {}).sort()) {
        for (const address of interfaces[name] || []) {
            /* Node 18+ reports family as the number 4; older as 'IPv4'. */
            const four = address.family === 'IPv4' || address.family === 4;
            if (four && !address.internal && address.address) return address.address;
        }
    }
    return null;
}

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2|\[::1\])(:\d+)?$/i;

/**
 * The base URL for this build, or a refusal explaining what to set.
 *
 * Throws rather than falling back, on purpose. A release build that quietly
 * points at localhost is the failure mode; a build that stops with a sentence
 * naming the variable is twenty seconds.
 */
function resolveApiUrl({ configured, profile, interfaces }) {
    const release = profile === 'production' || profile === 'preview';
    const url = (configured ?? '').trim();

    if (url === '') {
        if (!release) {
            const lan = lanAddress(interfaces === undefined ? require('node:os').networkInterfaces() : interfaces);
            return lan === null ? DEV_FALLBACK : `http://${lan}:${DEV_PORT}`;
        }
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

module.exports = { ApiUrlError, DEV_FALLBACK, DEV_PORT, lanAddress, resolveApiUrl };
