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

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';

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
}

export function Directions({ code, orderId, embed, label = 'Directions', className = 'izy-btn', mapsUrl }: Props) {
    const [open, setOpen] = useState(false);
    const [answer, setAnswer] = useState<DirectionsAnswer | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const panel = useRef<HTMLDivElement | null>(null);

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
        return <a className={className} href={mapsUrl} target="_blank" rel="noreferrer">{label}</a>;
    }

    return (
        <>
            <button
                className={className}
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}
            >
                {open ? 'Hide map' : label}
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
