/* The grey line under a driver's name: a number to ring them on.
 *
 * ONE COMPONENT RATHER THAN THE SAME THREE LINES ON FOUR SCREENS. The
 * dispatcher's order list, the order itself, the board's feed and the
 * pharmacy's own portal all show a courier and all want the same thing
 * under it. Four copies of "if there is a number, render a small grey
 * link" is four places for them to drift apart -- and the one that drifts
 * is always the one somebody is looking at in a hurry.
 *
 * "N/A" WHEN THE ROSTER HAS NO NUMBER, asked for on 19 November 2026 and
 * the opposite of what this did first, which was render nothing.
 *
 * Nothing is ambiguous in the one way that matters here. A dispatcher who
 * sees a bare name cannot tell whether we have no number for this driver or
 * whether the screen simply is not showing it, so they ring the office to
 * find out -- which is the call this component exists to stop. "N/A" is an
 * answer: there is no number on file, go and put one on the roster.
 *
 * It renders only under a driver who EXISTS. An unassigned order shows
 * "unassigned" and no second line, because there is nobody to have a
 * number.
 */
import { dialable } from './people';

export function CourierPhone({ phone }: { phone?: string | null | undefined }) {
    const typed = (phone ?? '').trim();
    if (typed === '') {
        /* Spelled out for a screen reader, which otherwise says "nuh" or
           spells the letters, and titled so a dispatcher knows where to go
           and fix it rather than wondering whether the page is broken. */
        return (
            <div className="izy-phone izy-phone-none">
                {/* The title lives on the abbr and NOT on the div as well.
                    Two elements carrying the same tooltip is one tooltip to
                    a reader and two matches to anything querying by it,
                    which is how the test for this found it. */}
                <abbr title="No phone number on the driver roster">N/A</abbr>
            </div>
        );
    }
    const href = dialable(typed);
    return (
        <div className="izy-phone">
            {/* As typed, always. The roster is a free text field and what
                somebody wrote there -- an extension, a second number, "after
                6" -- is the half worth keeping. The link only takes the
                digits out of it. */}
            {href === null ? typed : <a href={`tel:${href}`}>{typed}</a>}
        </div>
    );
}
