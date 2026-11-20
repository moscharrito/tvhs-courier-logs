/* The banner that goes on somebody's screen, and the four ways it must not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A FILE THAT MOSTLY ASSERTS "FALSE" IS WORTH HAVING.
 *
 * Every path in desktop.ts returns a boolean and none of them throws, and
 * that is not a style choice: this sits in the middle of the notification
 * poll, which runs every twenty-five seconds behind every screen in the
 * application. A rejected promise there is an unhandled rejection on a
 * dispatcher's console once a minute, and in the wrong arrangement it is a
 * poll that stops.
 *
 * The things that go wrong here are all environmental and none of them are
 * rare: a browser with no Notification API, a permission revoked in site
 * settings an hour ago, a service worker that failed to register, Android
 * Chrome refusing the constructor outright. None of them should produce
 * anything louder than `false`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { desktopState, askForDesktop, showDesktop, desktopTitleFor } from './desktop';

/* The kinds core/notify/prefs.ts can send, copied deliberately rather than
   imported: the web app does not depend on the server's source tree, and a
   kind added there without a line here should show up as a failure in a
   place somebody will read. */
const SERVER_KINDS = [
    'request.approved', 'request.denied', 'request.superseded', 'work.assigned',
    'work.unclaimed', 'shift.missed', 'dispatch.notStarted', 'shift.carryingOvernight',
    'mail.failing', 'delivery.completed', 'delivery.failed', 'thread.mention',
    'list.dropped', 'stop.arrived', 'stop.delivered',
];

const NOTICE = { id: 7, kind: 'work.unclaimed', body: 'Nobody can take delivery 12.', href: '/projects/uh/orders/12' };

/** Install a Notification stand-in with the permission a test wants. */
function withPermission(permission: NotificationPermission, requested?: NotificationPermission) {
    const ctor = vi.fn();
    const stub = Object.assign(ctor, {
        permission,
        requestPermission: vi.fn(async () => {
            (stub as unknown as { permission: string }).permission = requested ?? permission;
            return requested ?? permission;
        }),
    });
    vi.stubGlobal('Notification', stub);
    return stub;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('reading the state', () => {
    it('says unsupported when the browser has no Notification at all', () => {
        vi.stubGlobal('Notification', undefined);
        /* Firefox in private browsing, an old WebView, and an iPhone running
           Safari outside an installed app. The screen offers no button. */
        expect(desktopState()).toBe('unsupported');
    });

    it('reads granted and denied straight through', () => {
        withPermission('granted');
        expect(desktopState()).toBe('granted');
        withPermission('denied');
        expect(desktopState()).toBe('denied');
    });

    it('treats anything else as never asked', () => {
        withPermission('default');
        expect(desktopState()).toBe('default');
    });
});

describe('asking', () => {
    it('returns what the browser decided', async () => {
        withPermission('default', 'granted');
        await expect(askForDesktop()).resolves.toBe('granted');
    });

    it('does not ask a browser that cannot answer', async () => {
        vi.stubGlobal('Notification', undefined);
        await expect(askForDesktop()).resolves.toBe('unsupported');
    });

    it('survives the old Safari that rejects instead of resolving', async () => {
        /* Safari's callback-style requestPermission rejects on await. The
           state afterwards is still readable, and that is the answer. */
        const stub = withPermission('default');
        stub.requestPermission = vi.fn(async () => { throw new Error('not a promise'); });
        await expect(askForDesktop()).resolves.toBe('default');
    });
});

describe('showing one', () => {
    beforeEach(() => {
        vi.stubGlobal('navigator', { serviceWorker: undefined });
    });

    it('refuses without permission, rather than asking for it', async () => {
        /* Asking from inside a poll is the single most-refused dialog on the
           web, and a refusal cannot be taken back from script. The ask is
           wired to a button somebody pressed and nowhere else. */
        const stub = withPermission('default');
        await expect(showDesktop(NOTICE)).resolves.toBe(false);
        expect(stub.requestPermission).not.toHaveBeenCalled();
    });

    it('refuses when the permission was revoked after it was granted', async () => {
        withPermission('denied');
        await expect(showDesktop(NOTICE)).resolves.toBe(false);
    });

    it('goes through the service worker when there is one', async () => {
        withPermission('granted');
        const showNotification = vi.fn(async (_t: string, _o: NotificationOptions) => {});
        vi.stubGlobal('navigator', {
            serviceWorker: { getRegistration: vi.fn(async () => ({ showNotification })) },
        });

        await expect(showDesktop(NOTICE)).resolves.toBe(true);
        expect(showNotification).toHaveBeenCalledTimes(1);
        const [title, options] = showNotification.mock.calls[0]!;
        expect(title).toBe('Nobody has claimed a STAT');
        /* The body verbatim. This file composes nothing: see the header of
           desktop.ts on why the one surface the operating system renders
           over a pharmacy counter gets the server's sentence unaltered. */
        expect(options.body).toBe(NOTICE.body);
        /* THE TAG IS THE ROW ID, which is what stops a dispatcher with two
           tabs open getting two banners for one notification. */
        expect(options.tag).toBe('tag-notice-7');
        expect((options.data as { href: string }).href).toBe(NOTICE.href);
    });

    it('falls back to the constructor when no worker is registered', async () => {
        /* The development server, where registration is skipped on purpose
           so a stale worker cannot serve an old bundle. */
        const stub = withPermission('granted');
        vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn(async () => undefined) } });
        vi.stubGlobal('window', { Notification: stub, focus: vi.fn(), location: { assign: vi.fn() } });

        await expect(showDesktop(NOTICE)).resolves.toBe(true);
        expect(stub).toHaveBeenCalledTimes(1);
    });

    it('answers false rather than throwing when the constructor is illegal', async () => {
        /* Android Chrome. `new Notification(...)` is not merely unsupported
           there, it throws -- and the drivers are on phones. An exception
           escaping here would surface inside the poll that every screen in
           the application depends on. */
        const stub = withPermission('granted');
        vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn(async () => undefined) } });
        const boom = Object.assign(
            vi.fn(() => { throw new TypeError('Illegal constructor'); }),
            { permission: 'granted', requestPermission: stub.requestPermission },
        );
        vi.stubGlobal('Notification', boom);
        vi.stubGlobal('window', { Notification: boom });

        await expect(showDesktop(NOTICE)).resolves.toBe(false);
    });

    it('answers false rather than throwing when getRegistration itself fails', async () => {
        const stub = withPermission('granted');
        vi.stubGlobal('navigator', {
            serviceWorker: { getRegistration: vi.fn(async () => { throw new Error('no'); }) },
        });
        const boom = Object.assign(
            vi.fn(() => { throw new TypeError('Illegal constructor'); }),
            { permission: 'granted', requestPermission: stub.requestPermission },
        );
        vi.stubGlobal('Notification', boom);
        vi.stubGlobal('window', { Notification: boom });

        await expect(showDesktop(NOTICE)).resolves.toBe(false);
    });
});

describe('the titles', () => {
    it('has a line for every kind the server can send', () => {
        /* A missing one degrades to the product name rather than breaking,
           so nothing checks this at runtime. It is still worth knowing. */
        const generic = SERVER_KINDS.filter((k) => desktopTitleFor(k) === 'TAG Courier');
        expect(generic).toEqual([]);
    });

    it('falls back rather than showing a raw kind to a human', () => {
        expect(desktopTitleFor('something.invented.later')).toBe('TAG Courier');
    });
});
