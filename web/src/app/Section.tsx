/* A card that folds away (ticket 5.14).
 *
 * The project page had eight of these stacked open at once: a STAT order
 * form, the import, nine pharmacies, a nine-row rate card, a twelve-row
 * settings table, and at the very bottom, below all of it, the link to the
 * dispatch board. The one control somebody opens that page to reach was the
 * last thing on it. Everything above it was reference material that changes
 * about twice a year.
 *
 * So: one primitive, used everywhere, rather than a toggle invented per
 * screen. Three things it has to get right.
 *
 * IT REMEMBERS. A dispatcher who folds the rate card away should not find it
 * open again tomorrow. Kept per browser in localStorage, which is the right
 * storage for it: this is a preference about a screen, not a fact about the
 * contract, and it has no business on the server or in anybody else's session.
 * Every read and write is wrapped, because a private window and blocked site
 * data both throw here, and a screen that will not render because it could not
 * remember whether a panel was open is a worse bug than the one being fixed.
 *
 * IT SAYS WHAT IS INSIDE. A folded panel that reads only "Pickup locations"
 * makes you open it to find out whether you care. `summary` puts the answer on
 * the header: "9 pharmacies, none geocoded". Folding should cost less
 * information, not all of it.
 *
 * IT IS A REAL HEADING AND A REAL BUTTON. `<h2><button aria-expanded>` is the
 * accordion pattern, and it is what keeps the page navigable by headings for
 * a screen reader while still being one tab stop and one Enter to open. A div
 * with an onClick would look identical and be neither.
 */

import { useCallback, useState, type ReactNode } from 'react';

const KEY = (id: string) => `izy.section.${id}`;

/** Remembered state, or the default when there is none or storage refuses. */
function remembered(id: string, fallback: boolean): boolean {
    try {
        const raw = window.localStorage.getItem(KEY(id));
        return raw === null ? fallback : raw === '1';
    } catch {
        return fallback;
    }
}

function remember(id: string, open: boolean): void {
    try {
        window.localStorage.setItem(KEY(id), open ? '1' : '0');
    } catch {
        /* A preference that could not be saved is not worth a word to
           anybody. The panel still opens and closes for this visit. */
    }
}

interface Props {
    /** Stable across renders and releases: it is the localStorage key. */
    id: string;
    title: string;
    /** Shown on the header WHILE FOLDED. Say what is inside.
     *
     *  Only while folded: it stands in for the content, so repeating it above
     *  the content it summarises is the clutter this was meant to remove. The
     *  order page showed "$34.50" on the header and "Total $34.50" in the
     *  table directly beneath it. */
    summary?: ReactNode;
    /** Sentence under the title, shown only when open. */
    intro?: ReactNode;
    /** Controls on the header, such as Edit. Clicks do not fold the panel.
     *
     *  Given `expand` because a header button almost always reveals something
     *  in the body, and on a folded panel that is a tap that does nothing:
     *  "Take an order" hid itself and showed no form, because the form was
     *  inside the fold. A control that opens a thing has to be able to open
     *  the thing it is inside. */
    actions?: ReactNode | ((expand: () => void) => ReactNode);
    defaultOpen?: boolean;
    children: ReactNode;
}

export function Section({ id, title, summary, intro, actions, defaultOpen = true, children }: Props) {
    const [open, setOpen] = useState(() => remembered(id, defaultOpen));

    const toggle = useCallback(() => {
        setOpen((was) => {
            remember(id, !was);
            return !was;
        });
    }, [id]);

    const expand = useCallback(() => {
        remember(id, true);
        setOpen(true);
    }, [id]);

    const header = typeof actions === 'function' ? actions(expand) : actions;

    return (
        <section className={`izy-card izy-section${open ? '' : ' is-folded'}`}>
            <div className="izy-section-head">
                <h2>
                    <button type="button" className="izy-section-toggle" aria-expanded={open} onClick={toggle}>
                        <Chevron open={open} />
                        <span className="izy-section-title">{title}</span>
                        {!open && summary !== undefined && <span className="izy-section-summary">{summary}</span>}
                    </button>
                </h2>
                {/* Outside the button on purpose: an Edit control that also
                    folded the panel it edits would be a trap. */}
                {header !== undefined && header !== false && <div className="izy-section-actions">{header}</div>}
            </div>
            {open && (
                <div className="izy-section-body">
                    {intro !== undefined && <p className="izy-section-intro">{intro}</p>}
                    {children}
                </div>
            )}
        </section>
    );
}

/* Drawn rather than typed. A "v" in a font is a letter a screen reader reads
   out, and the arrow characters render differently on every platform. This is
   decoration next to a real aria-expanded, so it is hidden from the tree. */
function Chevron({ open }: { open: boolean }) {
    return (
        <svg
            className={`izy-chev${open ? ' is-open' : ''}`}
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M5 3 L11 8 L5 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
