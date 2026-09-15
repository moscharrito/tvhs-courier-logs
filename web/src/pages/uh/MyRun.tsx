/* Today's run, on a courier's phone.
 *
 * The whole screen answers one question: where do I go next. So the current
 * stop is large and first, the rest follow in sequence, and the two things a
 * courier reaches for while holding a package in the other hand, directions
 * and dispatch, are single taps.
 *
 * The map carries the ADDRESS ONLY. Never the patient's name. An address is
 * what the courier needs to drive there; the name adds nothing to the
 * navigation and everything to the disclosure. That rule holds whether the
 * address goes out in a link the courier taps or into a frame this page
 * draws, and which of those happens is decided on the server: see
 * server/src/modules/uh/directions.ts, which keeps the in-app map behind its
 * own switch because embedding makes US the sender of a patient's address to
 * a vendor with no BAA.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type DeviceIdentity } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { slaLabel, type Sla } from './Orders';
import { Directions } from './Directions';

interface Stop {
    sequence: number;
    orderId: number;
    externalRef: string;
    serviceType: string;
    recipientName: string;
    address: string;
    city: string;
    zip: string;
    zone: number | null;
    status: string;
    dueAt: string | null;
    sla: Sla;
}

interface Run {
    id: number;
    courierUsername: string;
    serviceDate: string;
    label: string;
    status: string;
    startedAt: string | null;
    stops: Stop[];
}

interface MineResponse {
    serviceDate: string;
    timezone: string;
    courierUsername: string;
    runs: Run[];
    dispatch: { phone: string; name: string };
    /** Whether this installation draws the map in place. See Directions.tsx. */
    directions?: { embed: boolean };
}

const DONE = ['delivered', 'failed', 'cancelled'];

/** Address only. See the header comment: the name must not leave the app.
 *  Still used as the fallback link and as what the map panel opens into the
 *  phone's own Google Maps, which is where turn-by-turn actually belongs. */
export function mapsUrl(stop: Pick<Stop, 'address' | 'city' | 'zip'>): string {
    const query = [stop.address, stop.city, stop.zip].filter(Boolean).join(', ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function MyRun() {
    const { code = '' } = useParams();
    const { user, projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    /* A deadline a courier is driving against. It is the project's clock,
       whatever this phone thinks the time is. */
    const clock = clockFor(useProjectTimezone(code));
    const [data, setData] = useState<MineResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Whether this phone is set up for PIN sign-in (ticket 5.4). */
    const [phone, setPhone] = useState<DeviceIdentity | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setData(await api<MineResponse>(`/api/projects/${code}/uh/runs/mine`));
        } catch (err) {
            // A courier is often somewhere with no signal. Say that plainly
            // rather than showing an empty run, which would read as "no work".
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch. Check your signal and try again.');
        }
    }, [code]);
    useEffect(() => { void load(); }, [load]);

    /* Asked once. A failure here is not worth showing anybody: the prompt is
       an offer, and a courier who cannot reach dispatch has a bigger problem. */
    useEffect(() => {
        api<DeviceIdentity>('/api/login/device').then(setPhone).catch(() => setPhone(null));
    }, []);

    if (!project) {
        return (<><h1>Project not available</h1><Link className="izy-btn secondary" to="/">Back to projects</Link></>);
    }
    if (error !== null && data === null) {
        return (
            <>
                <h1>Today</h1>
                <div className="izy-alert error" role="alert">{error}</div>
                <button className="izy-btn" type="button" onClick={() => { void load(); }}>Try again</button>
            </>
        );
    }
    if (data === null) return <div className="izy-card"><Loading label="Loading your run" /></div>;

    const stops = data.runs.flatMap((r) => r.stops);
    const remaining = stops.filter((s) => !DONE.includes(s.status));
    /* Still at the counter: a courier cannot deliver what they have not
       collected, so this is the first thing the screen offers. */
    const toCollect = stops.filter((s) => s.status === 'assigned');
    const current = remaining.find((s) => s.status !== 'assigned') ?? remaining[0] ?? null;
    const done = stops.length - remaining.length;
    /* Defaults to the link-out. A server that has not been told about maps,
       which is every server until somebody sets UH_MAPS_EMBED, behaves the
       way it did before ticket 5.13. */
    const embed = data.directions?.embed === true;

    return (
        <>
            <h1>Today</h1>
            <p className="izy-sub">
                {user?.name} · {data.serviceDate} · {done} of {stops.length} done
            </p>

            {error !== null && <div className="izy-alert warn" role="status">{error}</div>}

            {/* Offered, never enforced: a courier at a pharmacy counter must
                not be held up by a setup screen. Without a prompt nobody
                discovers the PIN exists at all, which is exactly what happened
                between tickets 2.3 and 5.4. */}
            {phone?.enrolled === false && (
                <div className="izy-alert muted" role="status">
                    Set this phone up once and a PIN signs you in instead of your password.{' '}
                    <Link to="/devices">Set up this phone</Link>
                </div>
            )}

            {data.dispatch.phone ? (
                <a className="izy-btn izy-call" href={`tel:${data.dispatch.phone.replace(/[^0-9+]/g, '')}`}>
                    Call {data.dispatch.name}
                </a>
            ) : (
                /* Says who fixes it. A courier reading this is the one person
                   who cannot, and until the settings screen carried the field
                   nobody could. */
                <p className="izy-muted">
                    No dispatch number is set yet, so there is no call button. An administrator adds one in the
                    project&rsquo;s operating settings.
                </p>
            )}

            {/* The shadow week only works if the people at the door can file
                what they see (ticket 5.2). This is their only screen. */}
            <p className="izy-muted">
                Something not matching what you see? <Link to={`/projects/${code}/discrepancies`}>Tell us</Link>
            </p>

            {toCollect.length > 0 && (
                <div className="izy-card izy-collect">
                    <h2>Collect first</h2>
                    <p>
                        {toCollect.length} {toCollect.length === 1 ? 'stop is' : 'stops are'} still at the pharmacy.
                        You cannot deliver what you have not taken custody of.
                    </p>
                    {data.runs.filter((r) => r.stops.some((s) => s.status === 'assigned')).map((r) => (
                        <Link key={r.id} className="izy-btn" to={`/projects/${code}/runs/${r.id}/pickup`}>
                            Pick up for run {r.id}
                        </Link>
                    ))}
                </div>
            )}

            {stops.length === 0 ? (
                <div className="izy-card"><p>No stops assigned to you today.</p></div>
            ) : (
                <>
                    {current && (
                        <div className="izy-card izy-next" aria-label="Next stop">
                            <div className="izy-row-between">
                                <h2>Next: stop {current.sequence}</h2>
                                <StopBadge sla={current.sla} />
                            </div>
                            <p className="izy-next-name">{current.recipientName}</p>
                            <p className="izy-next-address">{current.address}<br />{current.city} {current.zip}</p>
                            <p className="izy-muted">
                                {current.serviceType} · due {clock(current.dueAt)}
                                {current.externalRef && <> · {current.externalRef}</>}
                                {current.zone === null && <> · <span className="izy-pill warn">out of area</span></>}
                            </p>
                            <div className="izy-row">
                                <Directions code={code} orderId={current.orderId} embed={embed} mapsUrl={mapsUrl(current)} />
                                {/* The stop is the work. Details is for looking something up. */}
                                <Link className="izy-btn" to={`/projects/${code}/orders/${current.orderId}/stop`}>Open the stop</Link>
                                <Link className="izy-btn secondary" to={`/projects/${code}/orders/${current.orderId}`}>Details</Link>
                            </div>
                        </div>
                    )}

                    <div className="izy-card">
                        <h2>All stops</h2>
                        <ol className="izy-stoplist">
                            {stops.map((s) => (
                                <li key={s.orderId} className={DONE.includes(s.status) ? 'izy-stop-done' : undefined}>
                                    <div className="izy-row-between">
                                        <span><b>{s.sequence}.</b> {s.recipientName}</span>
                                        {DONE.includes(s.status) ? <span className="izy-pill muted">{s.status}</span> : <StopBadge sla={s.sla} />}
                                    </div>
                                    <div className="izy-muted">{s.address}, {s.city} {s.zip}</div>
                                    <div className="izy-row">
                                        <Directions code={code} orderId={s.orderId} embed={embed} className="izy-btn secondary" mapsUrl={mapsUrl(s)} />
                                        {!DONE.includes(s.status) && (
                                            <Link className="izy-btn secondary" to={`/projects/${code}/orders/${s.orderId}/stop`}>Open the stop</Link>
                                        )}
                                        <Link className="izy-btn secondary" to={`/projects/${code}/orders/${s.orderId}`}>Details</Link>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </div>
                </>
            )}

            <div className="izy-row">
                <button className="izy-btn secondary" type="button" onClick={() => { void load(); }}>Refresh</button>
                {/* Always offered, not only when today's run has a failure on it:
                    a package can sit in a van overnight, and a screen that hides
                    the way to hand it back is how it stays there. */}
                <Link className="izy-btn secondary" to={`/projects/${code}/returns`}>Take back undelivered</Link>
            </div>
        </>
    );
}

function StopBadge({ sla }: { sla: Sla }) {
    const label = slaLabel(sla);
    if (!label.text) return null;
    return <span className={`izy-pill ${label.tone === 'muted' ? 'muted' : label.tone}`}>{label.text}</span>;
}
