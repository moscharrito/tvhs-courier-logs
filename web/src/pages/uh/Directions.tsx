/* Directions without leaving the run (ticket 5.13).
 *
 * The old button was a link with target="_blank". On a phone that is not a
 * new tab, it is a different application: the courier leaves the run, comes
 * back through the app switcher if they remember to, and the list has
 * reloaded. Opening the map in place keeps one screen in front of them.
 *
 * WHETHER there is a map at all is the server's decision, not this file's.
 * Embedding a patient's address makes the application the sender of it to
 * Google, which is why server/src/modules/uh/directions.ts keeps it behind
 * its own switch. When the answer is no this is a plain link, exactly what it
 * was before ticket 5.13, and it opens on the FIRST tap: a courier standing
 * at a van door must not press Directions and get a button that turns into a
 * link they have to press again.
 *
 * That is why `embed` arrives from the run response rather than being
 * discovered here. It is a property of the installation, not of an address,
 * so the screen already knows it before anything is drawn.
 */

import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { CardFace } from '../../app/Glass';
import type { IconProps } from '../../app/Icons';

export interface DirectionsAnswer {
    available: boolean;
    embedUrl: string | null;
    mapsUrl: string;
    why: string;
}

/** Where the phone is, if it will say and the courier allows it. */
async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 8000);
        navigator.geolocation.getCurrentPosition(
            (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
            () => { clearTimeout(timer); resolve(null); },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
        );
    });
}

interface Props {
    code: string;
    orderId: number;
    /** Whether this installation draws maps in place, from GET runs/mine. */
    embed: boolean;
    label?: string;
    className?: string;
    /** Google Maps for this stop. The link when there is no embed, and the
     *  way out to turn-by-turn when there is. */
    mapsUrl: string;
    /* ─────────────────────────────────────────────────────────────────────
     * WEARING THE CARD SHAPE, on the driver's run screen.
     *
     * The run screen is the phone app's layout now — context above, actions
     * in a sheet under the thumb — and in that sheet Directions sits beside
     * "Collect from a pharmacy" and "Open the stop" as a card: a glyph, the
     * action, and a sentence under it.
     *
     * It cannot simply BE a CardLink or a CardButton, because which of those
     * it is depends on the installation: a server with no map key renders a
     * link that opens on the first tap, and one with a key renders a button
     * that unfolds a frame and relabels itself "Hide map". So it borrows the
     * card's FACE and keeps its own element. See app/Glass.tsx.
     *
     * Absent, as it is everywhere else, this renders exactly what it always
     * did: one element with one word in it.
     * ───────────────────────────────────────────────────────────────────── */
    /** The sentence under the action. Turns this into a card. */
    detail?: ReactNode;
    /** Decorative; the label is the accessible name. */
    Icon?: ComponentType<IconProps>;
}

export function Directions({ code, orderId, embed, label = 'Directions', className = 'izy-btn', mapsUrl, detail, Icon }: Props) {
    const [open, setOpen] = useState(false);
    const [answer, setAnswer] = useState<DirectionsAnswer | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const panel = useRef<HTMLDivElement | null>(null);
    const detailId = useId();

    /* With no `detail` this is exactly what it was: one element, one word
       inside it, no ARIA. With one, it is a card, and the name is pinned to
       the action while the sentence becomes a description — see the note
       above `named` in app/Glass.tsx for why that is the right way round.
       Both take the CURRENT label, so the name says "Hide map" when the
       button does. */
    const cardProps = (name: string) => (detail === undefined
        ? {}
        : { 'aria-label': name, 'aria-describedby': detailId });
    const cardInside = (name: string) => (detail === undefined
        ? name
        : <CardFace Icon={Icon} title={name} detail={detail} detailId={detailId} />);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            /* Asked for only when the courier taps. A run of twenty stops must
               not fire twenty position requests and twenty map loads for the
               one address they are actually driving to. */
            const at = await currentPosition();
            const query = at ? `?origin=${encodeURIComponent(`${at.lat},${at.lng}`)}` : '';
            setAnswer(await api<DirectionsAnswer>(`/api/projects/${code}/uh/orders/${orderId}/directions${query}`));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch for the map.');
        } finally {
            setLoading(false);
        }
    }, [code, orderId]);

    useEffect(() => {
        if (open && answer === null && !loading && error === null) void load();
    }, [open, answer, loading, error, load]);

    /* Brings the map to the courier rather than leaving it below the fold.
       Feature-detected: scrollIntoView is missing in jsdom and, more to the
       point, this is a convenience and must never be what breaks the screen. */
    useEffect(() => {
        const el = panel.current;
        if (open && answer?.available && typeof el?.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest' });
        }
    }, [open, answer]);

    /* No embed on this installation: the link, opening on the first tap.
       Also the landing place if the per-stop call comes back refusing one,
       which it can when a stop has no address on it. */
    if (!embed || (answer !== null && !answer.available)) {
        return (
            <a className={className} href={mapsUrl} target="_blank" rel="noreferrer" {...cardProps(label)}>
                {cardInside(label)}
            </a>
        );
    }

    return (
        <>
            <button
                className={className}
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}
                {...cardProps(open ? 'Hide map' : label)}
            >
                {cardInside(open ? 'Hide map' : label)}
            </button>

            {open && (
                <div className="izy-directions" ref={panel}>
                    {loading && <p className="izy-muted">Finding the way there...</p>}
                    {error !== null && (
                        <div className="izy-alert warn" role="status">
                            {error}{' '}
                            <a href={mapsUrl} target="_blank" rel="noreferrer">Open in Google Maps</a>
                        </div>
                    )}
                    {answer?.available && answer.embedUrl && (
                        <>
                            {/* No allow="geolocation": the route was already
                                computed from the position we sent. A frame
                                does not need to ask the phone again. */}
                            <iframe
                                className="izy-directions-map"
                                title="Directions to this stop"
                                src={answer.embedUrl}
                                loading="lazy"
                                /* Our URLs carry order ids, and the whole app
                                   sends Referrer-Policy: no-referrer for that
                                   reason. The frame does not get an exception.
                                   The cost is that the map key cannot be
                                   HTTP-referrer restricted, which is why it is
                                   handed out per request to somebody already
                                   authorised rather than baked into the
                                   bundle. */
                                referrerPolicy="no-referrer"
                            />
                            {answer.why && <p className="izy-muted">{answer.why}</p>}
                            {/* Turn-by-turn while driving belongs in the phone's
                                own map app, which can talk and stay awake. */}
                            <a className="izy-btn secondary small" href={answer.mapsUrl || mapsUrl} target="_blank" rel="noreferrer">
                                Open in Google Maps
                            </a>
                        </>
                    )}
                </div>
            )}
        </>
    );
}
