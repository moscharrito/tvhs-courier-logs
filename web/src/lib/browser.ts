/* Which browser this is, only where it changes what we tell somebody.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SNIFFING THE USER AGENT IS NORMALLY THE WRONG ANSWER, so here is why it
 * is the right one in this one place.
 *
 * The usual rule -- test for the feature, not the browser -- assumes the
 * feature either works or does not. The camera on iOS is not like that.
 * `navigator.mediaDevices.getUserMedia` EXISTS in every iOS browser, the
 * Permissions API answers `prompt`, the device reports a camera, and the
 * call then fails with NotAllowedError without ever asking the person
 * anything. Every feature test passes and the camera is still black.
 *
 * From a courier report on 31 October, pasted verbatim from the handset:
 *
 *     Browser: ... (iPhone; CPU iPhone OS 27_0_1 ...) CriOS/155.0.8059.37
 *     Camera permission: prompt
 *     Cameras the browser can see: 1
 *     Camera opened: NotAllowedError: The request is not allowed by the
 *       user agent or the platform in the current context
 *
 * `prompt` means the SITE has not been denied. No prompt appeared. So the
 * refusal came from above the page -- the app, or iOS itself -- and no
 * amount of anything we write in this repository will change it.
 *
 * What we CAN do is stop giving advice that is wrong for the device in
 * somebody's hand. The camera's NotAllowedError message said "tap the
 * padlock beside the address", which is Chrome-on-a-desktop language; on
 * an iPhone there is no such control and following it finds nothing. A
 * courier reads that, concludes the app is broken, and stops trying.
 *
 * Every browser on iOS is WebKit in a WKWebView -- Apple requires it -- so
 * "Chrome on iPhone" is not Chrome. It is Safari's engine inside another
 * app, and that app has to hold the camera permission from iOS before a
 * page inside it can be offered one. Safari does not have that problem
 * because Safari is the browser the permission belongs to.
 *
 * This is used to CHOOSE WORDS and never to decide whether to try. The
 * camera is attempted identically everywhere; only the sentence after a
 * failure differs.
 */

const ua = (): string => (typeof navigator === 'undefined' ? '' : navigator.userAgent);

/** iPad reports itself as a Mac from iPadOS 13, hence the touch check. */
export function isIos(): boolean {
    const s = ua();
    if (/iPhone|iPad|iPod/.test(s)) return true;
    return /Macintosh/.test(s) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
}

/** The tokens the other iOS browsers put in their user agent. */
const WRAPPERS: Array<[RegExp, string]> = [
    [/CriOS/, 'Chrome'],
    [/FxiOS/, 'Firefox'],
    [/EdgiOS/, 'Edge'],
    [/OPiOS|OPT\//, 'Opera'],
    [/DuckDuckGo/, 'DuckDuckGo'],
    [/GSA\//, 'the Google app'],
];

/**
 * The name of the app wrapping WebKit on this iPhone, or null for Safari
 * itself and for everything that is not iOS.
 *
 * Null is the good answer: it means either Safari, where the camera is the
 * browser's own to grant, or a platform where none of this applies.
 */
export function iosWrapper(): string | null {
    if (!isIos()) return null;
    const s = ua();
    for (const [pattern, name] of WRAPPERS) if (pattern.test(s)) return name;
    return null;
}

/**
 * What to tell somebody whose camera was refused, for the device they are
 * holding. Returns null where the generic advice is already right.
 */
export function cameraAdvice(): string | null {
    const wrapper = iosWrapper();
    if (wrapper !== null) {
        return `You are using ${wrapper} on an iPhone. On an iPhone the camera only works reliably in Safari, `
            + 'because every other browser is borrowing it from the app around it. Open this same page in Safari '
            + 'and try again. If Safari cannot do it either, open the iPhone Settings app, find Safari, and allow '
            + 'the Camera.';
    }
    if (isIos()) {
        return 'Open the iPhone Settings app, find Safari, and allow the Camera. If it is already allowed, check '
            + 'Screen Time, then Content and Privacy Restrictions, and make sure the Camera is not switched off.';
    }
    return null;
}
