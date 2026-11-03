/* Going on and off shift, from a browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE WEB COULD READ A SHIFT AND NEVER OPEN ONE.
 *
 * The dispatch board has always shown who is on shift: it prints "(not on
 * shift)" beside a courier's name in the assign dropdown, counts "Drivers on
 * shift", and requests.ts escalates unclaimed work "to whoever is on shift".
 * Nothing in web/ ever called shifts/start. That was invisible while drivers
 * worked from the phone app, because the app opened the shift and the board
 * only reported it.
 *
 * Put the drivers on the web portal instead -- which is where Apple's
 * enrolment delay points -- and the whole contract runs with every driver
 * permanently off shift: dispatch sees zero on the board all day, and the
 * escalation that is supposed to catch an unclaimed STAT finds nobody to give
 * it to. A promise made to a hospital, broken by a missing button.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIMPLER THAN THE PHONE'S, AND THE DIFFERENCE IS HONEST.
 *
 * app/src/ui/ShiftBar.tsx carries a permission prompt, a prominent disclosure
 * and an ordering constraint, because going on shift there also starts
 * background location. A browser cannot track in the background at all, so
 * none of that applies and none of it is pretended at.
 *
 * What the browser DOES send is a position with each event -- see the
 * getCurrentPosition call in Stop.tsx and Pickup.tsx -- which is what the
 * board actually reads for its position column. So this says that plainly
 * rather than claiming either more or less than it does.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';

interface ShiftState {
    shift: { id: number; startedAt: string; open: boolean } | null;
    carrying: Array<{ id: number; reference: string; status: string }>;
}

interface Props {
    code: string;
    /** So the run reloads when a shift opens: what a courier may do changes. */
    onChanged?: () => void;
}

export function ShiftBar({ code, onChanged }: Props) {
    const [state, setState] = useState<ShiftState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The read failed, so the bar does not know. Said plainly, not shouted. */
    const [unread, setUnread] = useState(false);
    /** Said once when a shift ends over unfinished work. Dismissible, and
     *  never in the way of anything. */
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setState(await api<ShiftState>(`/api/projects/${code}/uh/shifts/mine`));
            setUnread(false);
        } catch {
            /* QUIETLY, AND THAT CHANGED WHEN THIS MOVED INTO THE TOP BAR.
               It used to raise an alert, which was right while it sat on one
               screen. The bar is now on every screen of the driver portal,
               so a read that fails would put a red alert over whatever the
               courier was actually doing -- and on a page with an alert of
               its own, two. Nobody asked for this request; it is the bar
               checking on its own behalf.

               A failed TOGGLE is the opposite and still shouts: that one the
               courier asked for, and the answer is the whole point. */
            setUnread(true);
        }
    }, [code]);

    useEffect(() => { void load(); }, [load]);

    const onShift = state?.shift?.open === true;
    /* Null until the first read answers. Claiming "off shift" to somebody who
       is on one is the direction that matters: they would tap Go on shift,
       be refused, and have no idea why. */
    const known = state !== null;

    async function toggle() {
        if (busy || !known) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api<{ carrying?: number }>(
                `/api/projects/${code}/uh/shifts/${onShift ? 'end' : 'start'}`,
                { method: 'POST', json: {} },
            );
            /* A NOTICE, NOT A REFUSAL. Going off shift over undelivered work
               used to be blocked, and the block printed a sentence that sat
               on the bar. The block went on 3 November -- the stops list
               already shows what is unfinished -- and this is what is left:
               said once, when the day ends, and closed with one tap.
               Nothing waits on it. */
            if (onShift && typeof res?.carrying === 'number' && res.carrying > 0) {
                setNotice(`${res.carrying} ${res.carrying === 1 ? 'delivery is' : 'deliveries are'} still open. `
                    + 'They go back to the pharmacy they came from.');
            }
            await load();
            onChanged?.();
            /* THE SCREEN THAT CARES IS NO LONGER THE ONE THIS IS INSIDE.
               It moved into the driver's top bar, which is rendered by the
               shell and knows nothing about a run. What a courier may do
               changes the moment a shift opens, so the screen has to re-read
               -- and an event is the smallest thing that crosses that gap
               without the shell importing the page or the page importing the
               shell. */
            window.dispatchEvent(new CustomEvent('izy:shift-changed'));
        } catch (err) {
            /* The server is the truth about whether a shift is open, so ask
               again rather than assuming the button did what it was asked. */
            setError(err instanceof ApiError ? err.message : 'That did not go through. Try again.');
            await load();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="izy-shift-pill">
            <span
                className={onShift ? 'izy-dot on' : 'izy-dot off'}
                aria-hidden="true"
            />
            {/* THREE WORDS, NOT THREE SENTENCES.
                This used to explain, beside the dot, that dispatch can give
                you work and see where your deliveries happen, and then add a
                line about the packages still in the car. It sat at the top of
                the one screen a driver works from all day, and by the second
                day nobody is reading it: what they need from this control is
                which state they are in and how to change it.

                The packages line has not been thrown away, it has been moved
                to where it bites. The server refuses to end a shift while
                undelivered packages are still with you and says so in a
                sentence written for the driver; that refusal now shows here,
                at the moment somebody tries, instead of standing on screen
                all day for the hours when it is not true. */}
            <span className="izy-shift-word" role="status" aria-live="polite">
                {unread && !known ? 'Shift unknown' : !known ? 'Checking…' : onShift ? 'On shift' : 'Off shift'}
            </span>
            <button
                className={onShift ? 'izy-btn secondary small' : 'izy-btn small'}
                type="button"
                onClick={() => { void toggle(); }}
                disabled={busy || !known}
                aria-busy={busy}
            >
                {busy ? (onShift ? 'Going off…' : 'Going on…') : (onShift ? 'Go off shift' : 'Go on shift')}
            </button>

            {/* Wraps to its own line inside the top bar: it is a sentence,
                and squeezing it between the contract name and Sign out is
                how it ends up truncated on the phone it is written for. */}
            {error !== null && <p className="izy-shift-error" role="alert">{error}</p>}

            {notice !== null && (
                <p className="izy-shift-notice" role="status">
                    {notice}
                    <button
                        type="button"
                        className="izy-shift-notice-close"
                        aria-label="Close"
                        onClick={() => { setNotice(null); }}
                    >
                        ×
                    </button>
                </p>
            )}
        </div>
    );
}
