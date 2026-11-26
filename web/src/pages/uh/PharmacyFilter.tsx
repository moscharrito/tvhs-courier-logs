/* The pharmacy dropdown that every filtered screen shares.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A FILTER SHOULD ONLY OFFER WHAT IT CAN FIND.
 *
 * Nine counters are on this contract and most ranges only involve some of
 * them. Six screens had each grown their own copy of the same <select> over
 * all nine, so picking a quiet pharmacy meant proving a negative one option
 * at a time: choose it, wait for the request, read "nothing in this range",
 * choose the next. The server now counts orders per site for a window (see
 * modules/uh/sites.ts) and this offers what it found.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CHOSEN ONE NEVER DISAPPEARS, WHICH IS THE WHOLE DIFFICULTY.
 *
 * Narrowing the options moves the ground under a selection that has already
 * been made. Pick the Pavilion, then move the dates back a week to a range
 * the Pavilion has nothing in, and a list of only-what-exists no longer
 * contains the option the URL still names. A <select> with a value matching
 * no option renders BLANK -- so the page would show the Pavilion's (empty)
 * figures above a filter that appears to say "every pharmacy", which is a
 * worse lie than the one this was built to fix.
 *
 * So the chosen pharmacy is always in the list, and when it is one of the
 * quiet ones it says so in the option itself. The reader sees what they
 * chose, sees that it has nothing, and can tell those two facts apart.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE QUIET ONES ARE NEVER SIMPLY GONE.
 *
 * An option that vanishes without explanation reads as a bug, or worse as a
 * pharmacy that has been removed from the contract. So when any are left
 * out the control says how many and offers them, in the same words the
 * drivers record uses for the roster it folds away. Hiding and saying
 * nothing is not available here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT FOR.
 *
 * Only filters. A form that ASKS WHERE TO FILE SOMETHING -- a new order, a
 * list import, a drop handed over -- must keep offering every open
 * pharmacy, because the first order at a counter is otherwise impossible to
 * record. Those screens call the sites endpoint without a window, which is
 * what makes them immune to all of this, and they must keep doing so.
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Site } from './Sites';

/** A site as the window-aware listing returns it: `orders` is how many
 *  orders the site had in the range asked for, and is absent when no range
 *  was asked for. */
export type CountedSite = Site & { orders?: number };

/**
 * The pharmacies for a range, and whether each had anything in it.
 *
 * SILENT ON FAILURE, deliberately, which is the behaviour each of the six
 * screens had already arrived at separately: without the list the filter
 * offers nothing and the page it sits on still loads, which is what
 * matters. A dropdown is not worth an error banner over a payment run.
 */
export function usePharmacies(
    code: string,
    range?: { from: string; to: string },
    /* `false` asks for nothing at all, for a screen whose filter is behind a
       role check. A hook cannot be called conditionally, so the condition
       goes in here rather than around it. */
    enabled = true,
): CountedSite[] {
    const [sites, setSites] = useState<CountedSite[]>([]);
    /* The range enters the dependency list as the query string that will be
       sent, not as an object: an object literal is a new value every render
       and would refetch the list on every keystroke anywhere on the page. */
    const window = range === undefined ? '' : `?from=${range.from}&to=${range.to}`;

    useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        void api<CountedSite[]>(`/api/projects/${code}/uh/sites${window}`)
            .then((got) => { if (live) setSites(got); })
            .catch(() => { if (live) setSites([]); });
        return () => { live = false; };
    }, [code, window, enabled]);

    return sites;
}

interface Props {
    sites: CountedSite[];
    /** The chosen pharmacy's id as a string, or '' for every pharmacy. */
    value: string;
    onChange: (value: string) => void;
    /** 'Every pharmacy' on a report, 'any' beside the other filters on an
     *  operational board. The screens phrase this differently and both are
     *  right in their own place. */
    anyLabel?: string;
    label?: string;
}

export function PharmacyFilter({ sites, value, onChange, anyLabel = 'Every pharmacy', label = 'Pharmacy' }: Props) {
    const [showQuiet, setShowQuiet] = useState(false);

    /* "Show the quiet ones" is an answer to the range that was on screen
       when it was clicked. `sites` is a fresh array on every refetch and a
       refetch is exactly what a change of range causes, so this folds them
       away again when the question changes underneath. */
    useEffect(() => { setShowQuiet(false); }, [sites]);

    /* `orders` absent means the caller asked for no window, so there is
        nothing to narrow by and every site is offered -- the old behaviour,
        reached by not opting in rather than by a flag. */
    const counted = sites.some((s) => s.orders !== undefined);
    const busy = !counted || showQuiet ? sites : sites.filter((s) => (s.orders ?? 0) > 0);
    /* Always offered, even when quiet: see the header. */
    const chosen = sites.find((s) => String(s.id) === value);
    const offered = chosen !== undefined && !busy.includes(chosen) ? [...busy, chosen] : busy;
    const hidden = sites.length - offered.length;

    return (
        <>
            <label className="izy-field">{label}
                <select value={value} onChange={(e) => { onChange(e.target.value); }}>
                    <option value="">{anyLabel}</option>
                    {offered.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                            {s.name}
                            {counted && (s.orders ?? 0) === 0 ? ' — nothing in this range' : ''}
                        </option>
                    ))}
                </select>
            </label>
            {hidden > 0 && (
                <button
                    className="izy-btn secondary small"
                    type="button"
                    onClick={() => { setShowQuiet(true); }}
                >
                    {hidden === 1
                        ? 'Show 1 pharmacy with nothing in this range'
                        : `Show ${hidden} pharmacies with nothing in this range`}
                </button>
            )}
        </>
    );
}
