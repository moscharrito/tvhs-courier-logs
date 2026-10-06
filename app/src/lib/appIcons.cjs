/* The app icon, and refusing to ship without one.
 *
 * Pure, and tested, for the same reason as apiUrl.cjs beside it: getting this
 * wrong is not a bug somebody notices in development, it is a bug a store
 * reviewer notices.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO PLACEHOLDER IN THIS REPOSITORY.
 *
 * docs/app-store-submission.md made the call and it is the right one: a green
 * square that ships by accident is worse than a build that stops. Expo will
 * happily substitute its own default icon, so a release build with no artwork
 * does not fail, it succeeds and produces an app wearing somebody else's
 * logo. That reaches a reviewer, or worse, a courier's phone.
 *
 * So this refuses instead. A development build runs without artwork, because
 * that is what development is for; preview and production stop with a
 * sentence naming the file and its size.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE TWO PLATFORMS ACTUALLY WANT, since they are not the same thing.
 *
 * iOS takes one 1024x1024 square and masks the corners itself. It must have
 * NO transparency and NO pre-rounded corners: an alpha channel is a rejection
 * at submission, and corners rounded in the artwork get rounded again.
 *
 * Android 8 and later takes a foreground layer over a background colour and
 * masks the result to whatever shape the launcher uses, which may be a
 * circle. Anything outside the middle 66 percent can be cut off, so the
 * foreground needs padding the iOS icon does not.
 *
 * One file cannot be both. Hence two, and a refusal that says which is
 * missing rather than "icon not found".
 */

class AppIconError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppIconError';
    }
}

/** Where the artwork goes. See assets/README.md for the specifications. */
const ICON = './assets/icon.png';
const ADAPTIVE_ICON = './assets/adaptive-icon.png';

/* The colour behind the Android foreground layer, and the one a launcher
 * shows around a circular mask. Not white: a white-on-white icon vanishes on
 * a light launcher background. This is the green used by the app shell. */
const ADAPTIVE_BACKGROUND = '#0B6E4F';

const REQUIRED = [
    {
        path: ICON,
        what: 'the iOS and store icon',
        spec: '1024x1024 PNG, square, no transparency, no rounded corners (iOS rounds them itself)',
    },
    {
        path: ADAPTIVE_ICON,
        what: 'the Android adaptive foreground',
        spec: '1024x1024 PNG, the mark centred inside the middle 66 percent, transparent background',
    },
];

/**
 * Icon configuration for this build, or a refusal naming what is missing.
 *
 * `exists` is injected so the decision is testable without touching a disk,
 * the way apiUrl takes its interface map.
 */
/* The deliberate way past the refusal, for an internal Android build while
 * the artwork is still being drawn.
 *
 * It exists because the refusal is otherwise too blunt: `preview` is internal
 * distribution to our own drivers, and an Expo default icon on a test APK is
 * a cosmetic oddity rather than a rejection. Blocking that for a week while
 * somebody draws a logo would be the guard getting in the way of the work.
 *
 * An environment variable rather than a config key, so it has to be typed on
 * the command that runs the build. Nobody sets this by accident, nobody sets
 * it in a file and forgets, and it is visible in the build log afterwards.
 *
 * It does NOT help with iOS. App Store Connect rejects a build with a missing
 * or transparent icon during processing, TestFlight included, so an iOS build
 * using this override merely fails later and less clearly. */
const OVERRIDE = 'IZY_ALLOW_DEFAULT_ICON';

function resolveIcons({ profile, exists, env }) {
    const release = profile === 'production' || profile === 'preview';
    const missing = REQUIRED.filter((f) => !exists(f.path));
    const overridden = String((env ?? process.env)[OVERRIDE] ?? '') === '1';

    if (missing.length === 0) {
        return {
            icon: ICON,
            android: {
                adaptiveIcon: {
                    foregroundImage: ADAPTIVE_ICON,
                    backgroundColor: ADAPTIVE_BACKGROUND,
                },
            },
        };
    }

    if (release && !overridden) {
        const list = missing.map((f) => `  ${f.path}\n      ${f.what}: ${f.spec}`).join('\n');
        throw new AppIconError(
            `A ${profile} build has no app icon, and Expo would quietly substitute its own.\n`
            + `Add the artwork before building:\n${list}\n`
            + 'See app/assets/README.md and docs/app-store-submission.md.\n'
            + `For an internal Android test build only, ${OVERRIDE}=1 proceeds without one. `
            + 'It will not help on iOS: App Store Connect rejects a missing icon during '
            + 'processing, TestFlight included.',
        );
    }

    /* Development: no icon keys at all, so Expo uses its default and nobody
       is blocked from running the app. Returning partial configuration here
       would be worse than none, because a build with one of the two is a
       build with a default icon on the other platform and no warning. */
    return {};
}

module.exports = {
    AppIconError, ICON, ADAPTIVE_ICON, ADAPTIVE_BACKGROUND, OVERRIDE, REQUIRED, resolveIcons,
};
