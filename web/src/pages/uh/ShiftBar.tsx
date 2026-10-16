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

    const load = useCallback(async () => {
        try {
            setState(await api<ShiftState>(`/api/projects/${code}/uh/shifts/mine`));
        } catch (err) {
            /* A courier who cannot read their own shift is a courier who
               should still see their stops, so this reports and does not
               throw. */
            setError(err instanceof ApiError ? err.message : 'Could not check whether you are on shift.');
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
            await api(`/api/projects/${code}/uh/shifts/${onShift ? 'end' : 'start'}`, { method: 'POST', json: {} });
            await load();
            onChanged?.();
        } catch (err) {
            /* The server is the truth about whether a shift is open, so ask
               again rather than assuming the button did what it was asked. */
            setError(err instanceof ApiError ? err.message : 'That did not go through. Try again.');
            await load();
        } finally {
            setBusy(false);
        }
    }

    const carrying = state?.carrying ?? [];

    return (
        <div className="izy-card izy-shift">
            <div className="izy-row-between">
                <div>
                    <p className="izy-shift-state" role="status" aria-live="polite">
                        <span className={onShift ? 'izy-dot on' : 'izy-dot off'} aria-hidden="true" />
                        {!known
                            ? 'Checking whether you are on shift…'
                            : onShift
                                ? 'On shift. Dispatch can give you work and see where your deliveries happen.'
                                : 'Off shift. Dispatch cannot assign you anything until you go on shift.'}
                    </p>
                </div>
                <button
                    className={onShift ? 'izy-btn secondary' : 'izy-btn'}
                    type="button"
                    onClick={() => { void toggle(); }}
                    disabled={busy || !known}
                    aria-busy={busy}
                >
                    {busy ? (onShift ? 'Going off…' : 'Going on…') : (onShift ? 'Go off shift' : 'Go on shift')}
                </button>
            </div>

            {error !== null && <p className="izy-alert warn" role="alert">{error}</p>}

            {/* GOING OFF SHIFT HOLDING SOMETHING IS THE CASE WORTH NAMING.
                Section 9 of the courier offer letter requires every
                undelivered package back at the pharmacy it came from the same
                day, so a courier about to end their shift with items in the
                car needs telling before they drive home, not after. */}
            {onShift && carrying.length > 0 && (
                <p className="izy-muted izy-shift-carrying">
                    You are still carrying {carrying.length} {carrying.length === 1 ? 'package' : 'packages'}.
                    They go back to the pharmacy they came from before you finish.
                </p>
            )}
        </div>
    );
}
