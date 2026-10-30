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
import { api, ApiError } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { slaLabel, type Sla } from './Orders';
import { Directions } from './Directions';
import { Pager, usePaged } from '../../app/Pager';
import { Section } from '../../app/Section';
import { ShiftBar } from './ShiftBar';

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

    /* Declared before the early returns below, which is why it takes the
       stops off `data` defensively rather than off the list computed further
       down. */
    const pagedStops = usePaged(data?.runs.flatMap((r) => r.stops) ?? []);

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

            {/* FIRST, ABOVE THE STOPS, because it gates the day. Dispatch
                cannot assign to a courier who is not on shift, and the
                escalation for unclaimed work looks for somebody who is -- so
                a driver who never finds this control is a driver the board
                cannot use. */}
            <ShiftBar code={code} onChanged={() => { void load(); }} />

            {error !== null && <div className="izy-alert warn" role="status">{error}</div>}

            {/* NO PIN PROMPT HERE. It lived above the run between tickets
                5.4 and this one, offering enrolment to anybody whose phone
                was not set up. It is a setup task on a working screen: the
                courier reading it is mid-round, it reappeared every day
                until acted on, and the PIN is still discoverable from Your
                account, which is where a setting belongs. */}

            {/* The button, or nothing at all. The missing branch used to
                explain the absence -- "an administrator adds one in the
                project's operating settings" -- which is an instruction
                addressed to somebody who is not holding this phone, on the
                screen a driver works from. The absence is now silent here
                and loud where it can be acted on: set-dispatch.mjs prints
                it, and the operating settings screen says it. */}
            {data.dispatch.phone !== '' && (
                <a className="izy-btn izy-call" href={`tel:${data.dispatch.phone.replace(/[^0-9+]/g, '')}`}>
                    Call {data.dispatch.name}
                </a>
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
                    {/* WHERE THEY ARE GOING IS NOT SHOWN UNTIL THEY HAVE THE
                        PACKAGES. The addresses, the names and the deadlines
                        all appear once the pickup is recorded. */}
                    <p className="izy-muted">
                        Your stops appear once you have recorded the pickup.
                    </p>
                    {data.runs.filter((r) => r.stops.some((s) => s.status === 'assigned')).map((r) => (
                        <Link key={r.id} className="izy-btn" to={`/projects/${code}/runs/${r.id}/pickup`}>
                            Pick up for run {r.id}
                        </Link>
                    ))}
                </div>
            )}

            {/* ─────────────────────────── NOTHING BELOW UNTIL IT IS COLLECTED
             *
             * The round used to be on screen from the moment dispatch
             * assigned it: every name, every address, every deadline, while
             * the medication was still behind the counter. Two reasons that
             * is wrong, and the second is the one that matters.
             *
             * It invites the round to start in the wrong order. A courier
             * reading "next: 4 Hickory, due 13:15" before they have been to
             * the pharmacy is being shown a destination they cannot serve.
             *
             * And it is a patient list on a screen, for work that has not
             * begun. A phone open at a counter, a browser on a shared
             * machine -- the names and addresses of people expecting
             * medication, belonging to a round the courier is not yet
             * carrying. Custody is the line: once they have signed for the
             * packages the round is theirs and they need every detail of
             * it. Before that they need one instruction, which is to go and
             * collect.
             *
             * Deliberately ALL or nothing, not "hide the uncollected ones".
             * A partial list is the same disclosure made quieter, and a
             * courier part-way through a pickup should be finishing it. */}
            {toCollect.length > 0 ? null : stops.length === 0 ? (
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

                    {/* THE ONLY THING ON THIS PAGE THAT FOLDS.
                        Collect-first is a blocker and the next stop is the
                        work; folding either would hide the reason a driver
                        opened the page. The whole list is reference once the
                        next stop is on screen, and a driver who has memorised
                        their round should be able to put it away and have it
                        stay away. */}
                    <Section
                        id="myrun-all-stops"
                        title="All stops"
                        summary={`${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}${done > 0 ? `, ${done} done` : ''}`}
                    >
                        <ol className="izy-stoplist">
                            {pagedStops.rows.map((s) => (
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
                        <Pager of={pagedStops} noun="stops" />
                    </Section>
                </>
            )}

            <div className="izy-row">
                <button className="izy-btn secondary" type="button" onClick={() => { void load(); }}>Refresh</button>
                {/* Always offered, not only when today's run has a failure on it:
                    a package can sit in a van overnight, and a screen that hides
                    the way to hand it back is how it stays there. */}
                <Link className="izy-btn secondary" to={`/projects/${code}/returns`}>Take back undelivered</Link>
                {/* Their own record: what they have delivered by day, month
                    and year, and what it comes to. A courier is redirected
                    straight here from the project page, so this screen is the
                    only place the link can live for them. */}
                <Link className="izy-btn secondary" to={`/projects/${code}/my-deliveries`}>My deliveries</Link>
            </div>
        </>
    );
}

function StopBadge({ sla }: { sla: Sla }) {
    const label = slaLabel(sla);
    if (!label.text) return null;
    return <span className={`izy-pill ${label.tone === 'muted' ? 'muted' : label.tone}`}>{label.text}</span>;
}
