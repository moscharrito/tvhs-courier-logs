/* The notification that reaches somebody who is not looking at the tab.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR.
 *
 * A bell with a red dot on it only works on somebody who is already looking
 * at the screen, and the four dispatch chairs spend the morning in a
 * spreadsheet, on the telephone, and in the pharmacy's own system. The whole
 * value of "a STAT nobody has claimed" is that it arrives while you are
 * doing something else. So the exceptions go to the operating system and
 * appear in the corner of the screen whatever the person is in.
 *
 * ONLY THE BELL, NEVER THE FEED. Arrivals and completions run between five
 * hundred and fifteen hundred a day each; the Activity tab shows them and
 * nothing in this file ever will. See core/notify/prefs.ts, which makes the
 * same decision one layer down and explains it at length. The rule is the
 * same here: a banner somebody has learned to dismiss without reading is
 * worse than no banner, because the one that mattered is inside it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE BODY IS SAFE TO PUT ON A LOCK SCREEN, AND THE RULE THAT KEEPS IT
 * SAFE.
 *
 * This text is rendered by the operating system, over whatever is on the
 * screen, on a laptop that is quite often on a pharmacy counter with members
 * of the public on the other side of it. It is the least private surface the
 * application has.
 *
 * Every `notifications.body` on this system is composed from a delivery
 * number, a counter's business name, a courier's name and a time. Not one of
 * them carries a patient name, an address or a telephone number, and that is
 * deliberate rather than lucky -- see the comment in modules/uh/
 * order-messages.ts, which says "the reference, never the patient and never
 * the body. This is read on a lock screen", written before any lock screen
 * existed to read it on.
 *
 * SO THE RULE IS: this file shows `body` verbatim and composes nothing. The
 * day somebody writes a notification body with a patient's name in it, it
 * goes onto that counter, so the check belongs at the point the body is
 * written. There is a test beside the composers that says so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT NEVER THROWS, AND IT NEVER BLOCKS.
 *
 * Same rule as the server's outbox: this is a courtesy wrapped around work
 * that matters, and a courtesy must not be able to break it. Every path
 * returns a boolean. A browser with no Notification API, a permission that
 * was revoked in settings an hour ago, a service worker that failed to
 * register -- all of them are "false", none of them is an exception, and the
 * in-app bell carries on regardless. The bell is the product; this is the
 * tap on the shoulder.
 */

export type DesktopState =
    /** No Notification API at all. Firefox in private browsing, an iPhone
     *  running Safari outside an installed app, an old WebView. */
    | 'unsupported'
    /** Supported, never asked. */
    | 'default'
    | 'granted'
    /** Refused, or dismissed, which browsers record as a refusal. Cannot be
     *  asked again from script: the person has to change it in the browser's
     *  own site settings, and the screen has to say so rather than offering
     *  a button that silently does nothing. */
    | 'denied';

/** Whether this browser can show one, and whether it has been allowed to.
 *
 *  THE CHECK IS ON THE VALUE, NOT ON THE KEY, and a test caught the
 *  difference. `'Notification' in window` is true in several browsers where
 *  `window.Notification` is undefined -- Firefox in private browsing, some
 *  embedded WebViews, and any of the privacy extensions that blank the API
 *  rather than delete it. Reading `.permission` off that throws, and it
 *  throws inside the poll that runs behind every screen in the application
 *  every twenty-five seconds.
 *
 *  Reading `requestPermission` as well, because an object with a
 *  `permission` and no way to ask is a browser that can only ever answer
 *  "default" -- which would leave somebody pressing a button that does
 *  nothing, for ever. */
export function desktopState(): DesktopState {
    if (typeof window === 'undefined') return 'unsupported';
    const api = (window as { Notification?: typeof Notification }).Notification;
    if (!api || typeof api.requestPermission !== 'function') return 'unsupported';
    const p = api.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
}

/**
 * Ask. MUST be called from a click.
 *
 * Safari refuses a request that did not come from a user gesture, and Chrome
 * holds it against the origin, so this is only ever wired to a button
 * somebody pressed. Never on load: a permission prompt that appears before
 * anybody has asked for anything is the most-refused dialog on the web, and
 * a refusal cannot be taken back from script.
 */
export async function askForDesktop(): Promise<DesktopState> {
    if (desktopState() === 'unsupported') return 'unsupported';
    try {
        await window.Notification.requestPermission();
    } catch {
        /* Older Safari hands back a callback rather than a promise and
           rejects on await. The state read below is correct either way. */
    }
    return desktopState();
}

/** What the operating system puts in bold on the first line.
 *
 *  Presentation only, and local on purpose: the catalogue that decides
 *  BEHAVIOUR lives on the server (see core/notify/prefs.ts) because a label
 *  that disagrees with what the software does is how somebody switches on
 *  the wrong thing. Nothing here changes what is sent or to whom. A kind
 *  with no entry falls through to the product's name, which is dull rather
 *  than wrong -- so a kind added on the server never needs a deploy here. */
const TITLES: Record<string, string> = {
    'request.approved': 'Request approved',
    'request.denied': 'Request declined',
    'request.superseded': 'Request no longer applies',
    'work.assigned': 'New work on your run',
    'work.unclaimed': 'Nobody has claimed a STAT',
    'shift.missed': 'A driver has not come on shift',
    'dispatch.notStarted': 'The day has not started',
    'shift.carryingOvernight': 'Packages still in a van',
    'mail.failing': 'Email has stopped',
    'delivery.completed': 'Delivery completed',
    'delivery.failed': 'Delivery could not be completed',
    'thread.mention': 'Somebody tagged you',
    'list.dropped': 'A daily list has arrived',
    'stop.arrived': 'A driver arrived',
    'stop.delivered': 'A delivery was completed',
};

/** Exported for the test, which asserts every kind the server can send has a
 *  line here -- a missing one is survivable, so nothing checks it at
 *  runtime, but it is worth knowing at build time. */
export const desktopTitleFor = (kind: string): string => TITLES[kind] ?? 'TAG Courier';

export interface DesktopNotice {
    /** The notification row's id. Becomes the tag: see below. */
    id: number;
    kind: string;
    /** The server's sentence, shown verbatim. See the header. */
    body: string;
    /** Where clicking it should land, as an in-app path. */
    href: string;
}

/**
 * Put one on the screen. Returns whether it got there.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THROUGH THE SERVICE WORKER WHEN THERE IS ONE, AND WHY THAT IS THE
 * PREFERENCE RATHER THAN THE FALLBACK.
 *
 *   IT IS THE ONLY ONE THAT WORKS EVERYWHERE. `new Notification(...)` is not
 *   implemented on Android Chrome at all -- it throws "Illegal constructor"
 *   -- and the drivers are on phones in the web app. The constructor is kept
 *   as the fallback for the development server, where no worker is
 *   registered on purpose (see main.tsx).
 *
 *   IT SURVIVES THE TAB. A notification owned by a page vanishes when the
 *   page is closed or navigated away; one shown by the worker stays in the
 *   notification centre until it is dealt with, which is the entire point of
 *   telling somebody who is not looking.
 *
 *   IT CAN BE CLICKED INTO THE APP. The worker's `notificationclick` handler
 *   focuses the tab that is already open rather than opening a second one.
 *   See web/public/sw.js.
 *
 * THE TAG IS THE ROW ID, which is what makes two tabs safe. A dispatcher
 * with the board open on one screen and the orders list on another polls
 * twice, finds the same new row twice and calls this twice; the operating
 * system REPLACES a notification carrying a tag it already has, so they get
 * one banner. Without it they would get one per open tab, which is how a
 * notification system teaches people to turn it off.
 */
export async function showDesktop(n: DesktopNotice): Promise<boolean> {
    if (desktopState() !== 'granted') return false;

    const title = desktopTitleFor(n.kind);
    const options: NotificationOptions = {
        body: n.body,
        tag: `tag-notice-${n.id}`,
        /* The raster icon rather than /icon.svg: Chrome will not render an
           SVG here and falls back to its own generic bell, which is the mark
           every other site's notifications carry. */
        icon: '/apple-touch-icon.png',
        data: { href: n.href },
    };

    try {
        /* getRegistration rather than `ready`, which never settles when
           nothing is registered and would hang this call for the lifetime of
           the page -- the exact state of the dev server. */
        const reg = 'serviceWorker' in navigator
            ? await navigator.serviceWorker.getRegistration()
            : undefined;
        if (reg) {
            await reg.showNotification(title, options);
            return true;
        }
    } catch {
        /* Fall through to the constructor. */
    }

    try {
        const popped = new window.Notification(title, options);
        popped.onclick = () => {
            window.focus();
            window.location.assign(n.href);
            popped.close();
        };
        return true;
    } catch {
        /* Android Chrome, and anything else that only does worker
           notifications. Nothing to do and nothing to report: the row is in
           the bell either way. */
        return false;
    }
}
