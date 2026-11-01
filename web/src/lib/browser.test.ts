/* Which browser this is, and what that changes about the advice.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE REPORT THESE ARE WRITTEN FROM, pasted off a courier's handset on
 * 31 October after four days of "the camera is black":
 *
 *     Browser: Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X)
 *       AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.8059.37
 *       Mobile/15E148 Safari/604.1
 *     Camera permission: prompt
 *     Cameras the browser can see: 1
 *     Camera opened: NotAllowedError: The request is not allowed by the
 *       user agent or the platform in the current context
 *
 * Two things in that are decisive and neither is the error.
 *
 * `CriOS` means Chrome on an iPhone, which is WebKit inside another app --
 * Apple requires it -- so the app has to hold the camera permission from
 * iOS before a page inside it can be offered one.
 *
 * `prompt` means the SITE was never denied, and no prompt appeared. The
 * refusal therefore came from above the page, where nothing we ship can
 * reach.
 *
 * Note the trap in that string: it ends `Safari/604.1`. Every iOS browser
 * says Safari. Matching on it would have called this Safari and given the
 * courier the one piece of advice guaranteed not to help.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { isIos, iosWrapper, cameraAdvice } from './browser';

/* defineProperty rather than spyOn: jsdom's navigator has no
   maxTouchPoints at all, and you cannot spy on a getter that is not
   there. Both are put back in afterEach. */
const as = (userAgent: string, maxTouchPoints = 5) => {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
};

/** The exact string from the 31 October report. */
const COURIER_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) CriOS/155.0.8059.37 Mobile/15E148 Safari/604.1';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/152.0.0.0 Mobile Safari/537.36';

const realUa = navigator.userAgent;
afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: realUa, configurable: true });
    Reflect.deleteProperty(navigator, 'maxTouchPoints');
    vi.restoreAllMocks();
});

describe('telling an iPhone from everything else', () => {
    it('knows the handset from the report', () => {
        as(COURIER_IPHONE);
        expect(isIos()).toBe(true);
    });

    it('knows an iPad, which has called itself a Mac since iPadOS 13', () => {
        as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 5);
        expect(isIos()).toBe(true);
    });

    it('does not mistake a real Mac for one', () => {
        /* The touch count is the whole difference. A desktop reports 0. */
        as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 0);
        expect(isIos()).toBe(false);
    });

    it('leaves Android alone', () => {
        as(ANDROID_CHROME, 5);
        expect(isIos()).toBe(false);
    });
});

describe('which app is wrapping WebKit', () => {
    it('names Chrome on the courier\'s iPhone, despite the string ending in Safari', () => {
        /* THE TRAP. Every iOS browser's user agent ends `Safari/604.1`.
           Reading that would have told a courier to use the browser they
           were already using. */
        as(COURIER_IPHONE);
        expect(iosWrapper()).toBe('Chrome');
    });

    it('says null for Safari itself, which is the good answer', () => {
        as(IOS_SAFARI);
        expect(iosWrapper()).toBeNull();
    });

    it('names the other wrappers a driver might have installed', () => {
        const stem = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ';
        as(`${stem}FxiOS/133.0 Mobile/15E148 Safari/605.1.15`);
        expect(iosWrapper()).toBe('Firefox');
        as(`${stem}EdgiOS/133.0 Mobile/15E148 Safari/605.1.15`);
        expect(iosWrapper()).toBe('Edge');
        as(`${stem}Mobile/15E148 Safari/604.1 GSA/333.0`);
        expect(iosWrapper()).toBe('the Google app');
    });

    it('says null on Android, where none of this applies', () => {
        as(ANDROID_CHROME, 5);
        expect(iosWrapper()).toBeNull();
    });
});

describe('the advice a refused camera gets', () => {
    it('sends the courier from the report to Safari, by name', () => {
        as(COURIER_IPHONE);
        const advice = cameraAdvice();
        expect(advice).toMatch(/Chrome on an iPhone/);
        expect(advice).toMatch(/Safari/);
        /* And never the thing it used to say, which on an iPhone sends
           somebody looking for a control that is not there. */
        expect(advice).not.toMatch(/padlock/i);
    });

    it('sends an iPhone already in Safari to the Settings app instead', () => {
        as(IOS_SAFARI);
        const advice = cameraAdvice();
        expect(advice).toMatch(/Settings/);
        expect(advice).toMatch(/Screen Time/);
    });

    it('says nothing on Android, where the generic advice is already right', () => {
        /* Null means "the caller's own wording stands". Inventing iPhone
           advice for an Android handset would be the same mistake pointing
           the other way. */
        as(ANDROID_CHROME, 5);
        expect(cameraAdvice()).toBeNull();
    });
});
