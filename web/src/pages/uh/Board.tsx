/* The dispatch board.
 *
 * The screen a dispatcher watches during the noon wave: the unassigned pool
 * on the left grouped by pharmacy, one lane per courier on the right, and
 * the time remaining on every card.
 *
 * Two decisions worth knowing about.
 *
 * Dragging is an enhancement, not the mechanism. Every assignment is also
 * reachable through a select and a button, because a drag-only board cannot
 * be used with a keyboard and a dispatcher on a headset during a 273-stop
 * wave is not always holding a mouse. The select is the accessible path and
 * the one the tests drive; drag calls the same function.
 *
 * Polling is paused while the tab is hidden. A board left open overnight
 * would otherwise ask the server for every patient address for the day, four
 * times a minute, into an empty room.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { slaLabel, type Sla } from './Orders';
import type { Site } from './Sites';

const POLL_MS = 15_000;

interface BoardOrder {
    id: number; siteId: number; externalRef: string; serviceType: string;
    recipientName: string; address: string; city: string; zip: string;
    zone: number | null; status: string; dueAt: string | null;
    assignedTo: string | null; signatureRequired: boolean; sla: Sla;
}

interface Position {
    lat: number; lng: number; at: string; minutesAgo: number;
    fresh: boolean; event: string; orderId: number | null;
}

interface Courier {
    username: string; name: string; lastSeenAt: string | null;
    minutesSinceSeen: number | null; present: boolean;
    /** Where they were when they last sent an event. Null if never. */
    position: Position | null;
}

interface Activity {
    id: number; at: string; minutesAgo: number; actor: string; courierName: string;
    type: string; orderId: number; externalRef: string; recipientName: string;
    orderStatus: string; reason: string; note: string; hasPosition: boolean;
}

interface Lane {
    run: { id: number; courierUsername: string; serviceDate: string; label: string; status: string; startedAt: string | null };
    courier: Courier;
    stops: Array<{ sequence: number; order: BoardOrder }>;
    currentStop: { sequence: number; order: BoardOrder } | null;
    counts: { total: number; remaining: number; done: number; overdue: number };
}

interface BoardData {
    serviceDate: string;
    generatedAt: string;
    timezone: string;
    summary: { total: number; unassigned: number; assigned: number; inTransit: number; delivered: number; failed: number; overdue: number; dueSoon: number };
    pool: Array<{ site: { id: number; code: string; name: string }; orders: BoardOrder[]; overdue: number }>;
    lanes: Lane[];
    couriers: Courier[];
    idleCouriers: Courier[];
    activity: Activity[];
}

/** Addendum 1's dry-run codes, in words a dispatcher would use out loud. */
const REASON_LABEL: Record<string, string> = {
    recipient_not_located: 'could not find the recipient',
    incorrect_address: 'address is wrong',
    no_access: 'could not get access',
    incomplete_shipment: 'shipment incomplete',
    refused: 'recipient refused it',
    other: 'other',
};

const EVENT_LABEL: Record<string, string> = {
    picked_up: 'collected', arrived: 'arrived at', delivered: 'delivered to',
    attempted: 'could not deliver to', returned: 'returned', note: 'noted',
};

const since = (minutes: number): string => {
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
};

/** A position is evidence about a moment. The age is never dropped. */
function positionLabel(p: Position): string {
    return `last seen ${since(p.minutesAgo)}${p.fresh ? '' : ' (old)'}`;
}

function seenLabel(c: Courier): string {
    if (c.minutesSinceSeen === null) return 'never signed in';
    if (c.minutesSinceSeen < 1) return 'just now';
    if (c.minutesSinceSeen < 60) return `${c.minutesSinceSeen} min ago`;
    return `${Math.round(c.minutesSinceSeen / 60)} h ago`;
}

export function Board() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    /* The project's zone, not this laptop's. The header says America/Chicago
       and the times beside it have to agree with it. */
    const clock = clockFor(useProjectTimezone(code));
    const [params, setParams] = useSearchParams();

    const [data, setData] = useState<BoardData | null>(null);
    const [sites, setSites] = useState<Site[]>([]);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] } | null>(null);
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState<number | null>(null);
    const [stale, setStale] = useState(false);
    const [newRunCourier, setNewRunCourier] = useState('');
    const pollRef = useRef<number | null>(null);

    const base = `/api/projects/${code}/uh`;
    const query = params.toString();

    const load = useCallback(async () => {
        try {
            setData(await api<BoardData>(`${base}/board${query ? `?${query}` : ''}`));
            setStale(false);
        } catch (err) {
            /* Say the board has stopped updating rather than leaving a
               dispatcher reading minute-old numbers as if they were live.
               During a wave that is the difference between a late delivery
               and a missed one. */
            setStale(true);
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load the board' });
        }
    }, [base, query]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => {
        const tick = () => { if (!document.hidden) void load(); };
        pollRef.current = window.setInterval(tick, POLL_MS);
        // Catch up immediately when the tab comes back, rather than showing a
        // stale board until the next interval.
        document.addEventListener('visibilitychange', tick);
        return () => {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [load]);

    useEffect(() => {
        api<Site[]>(`${base}/sites`).then(setSites).catch(() => setSites([]));
    }, [base]);

    /* Above every early return: hooks run in the same order every render.
       The feed only. The pool and the lanes are left whole on purpose, for
       the reasons recorded above the lanes. */
    const pagedFeed = usePaged(data?.activity ?? []);

    if (!project) {
        return (<><h1>Project not available</h1><Link className="izy-btn secondary" to="/">Back to projects</Link></>);
    }

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        if (value === '') next.delete(key); else next.set(key, value);
        setParams(next, { replace: true });
    };
    const get = (key: string) => params.get(key) ?? '';

    async function act(fn: () => Promise<unknown>, ok: string) {
        setBusy(true);
        setMsg(null);
        try {
            await fn();
            setMsg({ kind: 'ok', text: ok });
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'That did not work' });
        } finally {
            setBusy(false);
        }
    }

    /** Put an order on a run. allowMove covers dragging between lanes. */
    const assign = (orderId: number, runId: number) => act(
        () => api(`${base}/runs/${runId}/stops`, { method: 'POST', json: { orderIds: [orderId], allowMove: true } })
            .then((r) => {
                const rejected = (r as { rejected?: Array<{ error?: string }> }).rejected ?? [];
                if (rejected.length > 0) throw new ApiError(409, rejected[0]?.error ?? 'Could not assign that order');
            }),
        `Order ${orderId} assigned.`,
    );

    const unassign = (orderId: number, runId: number) => act(
        () => api(`${base}/runs/${runId}/stops/${orderId}`, { method: 'DELETE' }),
        `Order ${orderId} returned to the pool.`,
    );

    const autoSequence = (runId: number, strategy: 'nearest' | 'due') => act(
        () => api(`${base}/runs/${runId}/sequence/auto`, { method: 'POST', json: { strategy } }),
        `Run ${runId} sequenced.`,
    );

    const startRun = () => act(
        () => api(`${base}/runs`, { method: 'POST', json: { courierUsername: newRunCourier, label: 'Wave', serviceDate: data?.serviceDate } }),
        `Run started for ${newRunCourier}.`,
    ).then(() => setNewRunCourier(''));

    const laneOptions = (data?.lanes ?? []).map((l) => ({
        id: l.run.id,
        label: `${l.courier.name}${l.run.label ? ` (${l.run.label})` : ''}`,
    }));

    if (data === null) return <div className="izy-card"><Loading label="Loading the board" /></div>;

    /* Couriers carrying more than one run today. Their lanes say which. */
    const runsPer = new Map<string, number>();
    for (const lane of data.lanes) {
        runsPer.set(lane.courier.username, (runsPer.get(lane.courier.username) ?? 0) + 1);
    }
    const twiceOver = new Set([...runsPer].filter(([, n]) => n > 1).map(([u]) => u));

    const s = data.summary;

    return (
        <>
            <h1>Dispatch board</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}`}>{project.name}</Link> · {data.serviceDate} · {data.timezone}
                {' · '}
                {stale
                    ? <span className="izy-stat-bad">not updating, last read at {clock(data.generatedAt)}</span>
                    : <span className="izy-muted">updated {clock(data.generatedAt)}, every 15 seconds</span>}
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            <div className="izy-card">
                <div className="izy-row">
                    <label className="izy-field">Day
                        <input type="date" value={get('serviceDate') || data.serviceDate} onChange={(e) => set('serviceDate', e.target.value)} />
                    </label>
                    <label className="izy-field">Pharmacy
                        <select value={get('siteId')} onChange={(e) => set('siteId', e.target.value)}>
                            <option value="">any</option>
                            {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                        </select>
                    </label>
                    <label className="izy-field">Service
                        <select value={get('serviceType')} onChange={(e) => set('serviceType', e.target.value)}>
                            <option value="">any</option>
                            <option value="scheduled">scheduled</option>
                            <option value="stat">STAT</option>
                            <option value="adhoc">ad hoc</option>
                        </select>
                    </label>
                    <label className="izy-field">Zone
                        <select value={get('zone')} onChange={(e) => set('zone', e.target.value)}>
                            <option value="">any</option>
                            {[1, 2, 3, 4, 5].map((z) => <option key={z} value={z}>Zone {z}</option>)}
                            <option value="out_of_area">out of area</option>
                        </select>
                    </label>
                    <button className="izy-btn secondary" type="button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>
                    <button className="izy-btn secondary" type="button" onClick={() => { void load(); }}>Refresh</button>
                </div>
                <div className="izy-statline" style={{ marginTop: 10 }}>
                    <span><b>{s.total}</b> {s.total === 1 ? 'order' : 'orders'}</span>
                    <span><b>{s.unassigned}</b> unassigned</span>
                    <span><b>{s.assigned}</b> assigned</span>
                    <span><b>{s.inTransit}</b> in transit</span>
                    <span><b>{s.delivered}</b> delivered</span>
                    {s.failed > 0 && <span><b>{s.failed}</b> failed</span>}
                    <span className={s.dueSoon > 0 ? 'izy-stat-warn' : undefined}><b>{s.dueSoon}</b> due soon</span>
                    <span className={s.overdue > 0 ? 'izy-stat-bad' : undefined}><b>{s.overdue}</b> overdue</span>
                </div>
            </div>

            <div className="izy-board">
                <section className="izy-card izy-pool" aria-label="Unassigned pool">
                    <h2>Unassigned ({s.unassigned})</h2>
                    {data.pool.length === 0 ? <div className="izy-muted">Nothing waiting.</div> : data.pool.map((group) => (
                        <div key={group.site.id} className="izy-pool-group">
                            <h3>{group.site.name} <span className="izy-muted">({group.orders.length})</span></h3>
                            {group.orders.map((o) => (
                                <OrderCard
                                    key={o.id}
                                    order={o}
                                    draggable
                                    onDragStart={() => setDragging(o.id)}
                                    onDragEnd={() => setDragging(null)}
                                    projectCode={code}
                                    action={laneOptions.length === 0 ? null : (
                                        <label className="izy-assign">
                                            <span className="izy-visually-hidden">Assign order {o.id} to</span>
                                            <select
                                                aria-label={`Assign order ${o.id} to`}
                                                value=""
                                                disabled={busy}
                                                onChange={(e) => { if (e.target.value) void assign(o.id, Number(e.target.value)); }}
                                            >
                                                <option value="">Assign to...</option>
                                                {laneOptions.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                                            </select>
                                        </label>
                                    )}
                                />
                            ))}
                        </div>
                    ))}
                </section>

                <div className="izy-lanes-col">
                    {/* Above the lanes, not after them. It was the last cell
                        of a wrapping grid, so the control that starts a
                        courier's day drifted further down the page with every
                        courier who already had one: at the beginning of a
                        shift, when it is the only thing a dispatcher wants, it
                        sat below two rows of cards. Folded once everybody is
                        out, because then it is a control with nothing to do. */}
                    <Section
                        id="uh.board.startrun"
                        title="Start a run"
                        /* Open while it has something to do, folded when it
                           does not. "Is the start of the day" was the first
                           rule here and it was the wrong one: a courier who
                           comes on shift at two o'clock still needs a run,
                           and by then the panel had folded itself away. */
                        defaultOpen={data.idleCouriers.length > 0}
                        summary={data.idleCouriers.length === 0
                            ? 'everybody has a run today'
                            : `${data.idleCouriers.length} without a run today`}
                    >
                        {data.idleCouriers.length === 0 ? (
                            <p className="izy-muted">Every courier on this project already has a run today.</p>
                        ) : (
                            <div className="izy-row">
                                <label className="izy-field">Courier
                                    <select value={newRunCourier} onChange={(e) => setNewRunCourier(e.target.value)}>
                                        <option value="">Choose a courier</option>
                                        {data.idleCouriers.map((c) => (
                                            <option key={c.username} value={c.username}>{c.name}{c.present ? '' : ' (not on shift)'}</option>
                                        ))}
                                    </select>
                                </label>
                                <button className="izy-btn" type="button" disabled={busy || newRunCourier === ''} onClick={() => { void startRun(); }}>
                                    Start run
                                </button>
                            </div>
                        )}
                    </Section>

                    <div className="izy-lanes">
                    {data.lanes.map((lane) => (
                        <section
                            key={lane.run.id}
                            className="izy-card izy-lane"
                            /* Always the run, never just the courier. One
                               person can hold two runs in a day, which is what
                               a second wave is, and two sections labelled
                               "Run for Ana Ruiz" are two sections a screen
                               reader cannot tell apart. */
                            aria-label={`${runName(lane)} for ${lane.courier.name}`}
                            onDragOver={(e) => { e.preventDefault(); }}
                            onDrop={(e) => { e.preventDefault(); if (dragging !== null) void assign(dragging, lane.run.id); setDragging(null); }}
                        >
                            <div className="izy-row-between">
                                {/* The name alone is the heading until the
                                    same courier has a second run on the day,
                                    and then two lanes read identically and
                                    you have to drop to the grey line beneath
                                    to tell a finished morning wave from the
                                    afternoon's work. */}
                                <h2>
                                    {lane.courier.name}
                                    {twiceOver.has(lane.courier.username) && (
                                        <span className="izy-lane-run"> · {runName(lane)}</span>
                                    )}
                                </h2>
                                <span className={`izy-pill ${lane.courier.present ? '' : 'muted'}`} title={lane.courier.lastSeenAt ?? 'never signed in'}>
                                    {lane.courier.present ? 'on shift' : seenLabel(lane.courier)}
                                </span>
                            </div>
                            <p className="izy-muted">
                                {lane.run.label || 'Run'} {lane.run.id} · {lane.counts.done} of {lane.counts.total} done
                                {lane.counts.overdue > 0 && <span className="izy-stat-bad"> · {lane.counts.overdue} overdue</span>}
                                {lane.currentStop && <> · now at stop {lane.currentStop.sequence}</>}
                                {lane.courier.position && (
                                    <>
                                        {' · '}
                                        {/* Coordinates, not an address, and always with their age:
                                            this is where the phone was when it last sent an event,
                                            not where the courier is now. */}
                                        <a
                                            href={`https://www.google.com/maps/search/?api=1&query=${lane.courier.position.lat},${lane.courier.position.lng}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className={lane.courier.position.fresh ? undefined : 'izy-stat-warn'}
                                        >
                                            {positionLabel(lane.courier.position)}
                                        </a>
                                    </>
                                )}
                            </p>

                            <div className="izy-row">
                                <button className="izy-btn secondary" type="button" disabled={busy || lane.counts.total === 0}
                                    onClick={() => { void autoSequence(lane.run.id, 'nearest'); }}>
                                    Sequence by distance
                                </button>
                                <button className="izy-btn secondary" type="button" disabled={busy || lane.counts.total === 0}
                                    onClick={() => { void autoSequence(lane.run.id, 'due'); }}>
                                    Sequence by deadline
                                </button>
                            </div>

                            {lane.stops.length === 0 ? <div className="izy-muted">No stops yet.</div> : lane.stops.map((stop) => (
                                <OrderCard
                                    key={stop.order.id}
                                    order={stop.order}
                                    sequence={stop.sequence}
                                    current={lane.currentStop?.order.id === stop.order.id}
                                    draggable
                                    onDragStart={() => setDragging(stop.order.id)}
                                    onDragEnd={() => setDragging(null)}
                                    projectCode={code}
                                    action={(
                                        <button
                                            className="izy-btn secondary"
                                            type="button"
                                            disabled={busy}
                                            onClick={() => { void unassign(stop.order.id, lane.run.id); }}
                                        >
                                            Return to pool
                                        </button>
                                    )}
                                />
                            ))}
                        </section>
                    ))}

                    <section className="izy-card izy-lane" aria-label="Recent activity">
                        <h2>What just happened</h2>
                        {data.activity.length === 0 ? (
                            <p className="izy-muted">No courier has recorded anything today yet.</p>
                        ) : (
                            <ol className="izy-feed">
                                {pagedFeed.rows.map((a) => (
                                    <li key={a.id}>
                                        <span className="izy-feed-when">{since(a.minutesAgo)}</span>
                                        <span>
                                            <b>{a.courierName}</b> {EVENT_LABEL[a.type] ?? a.type}{' '}
                                            <Link to={`/projects/${code}/orders/${a.orderId}`}>{a.recipientName}</Link>
                                            {a.externalRef && <> · {a.externalRef}</>}
                                            {/* The courier's own words about a failure are the most
                                                useful thing on this feed, so they are not truncated
                                                away into a status pill. */}
                                            {(a.reason || a.note) && (
                                                <div className="izy-muted">
                                                    {a.type === 'attempted' ? (REASON_LABEL[a.reason] ?? a.reason) : a.reason}
                                                    {a.note && <> · {a.note}</>}
                                                </div>
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        )}
                        <Pager of={pagedFeed} noun="events" />
                    </section>

                    </div>
                </div>
            </div>
        </>
    );
}

function OrderCard({ order, sequence, current, action, draggable, onDragStart, onDragEnd, projectCode }: {
    order: BoardOrder;
    sequence?: number;
    current?: boolean;
    action: React.ReactNode;
    draggable?: boolean;
    onDragStart?: () => void;
    onDragEnd?: () => void;
    projectCode: string;
}) {
    const label = slaLabel(order.sla);
    const clock = clockFor(useProjectTimezone(projectCode));
    return (
        <div
            className={`izy-stop${current ? ' izy-stop-current' : ''}`}
            draggable={draggable}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            <div className="izy-row-between">
                <span>
                    {sequence !== undefined && <b>{sequence}. </b>}
                    <Link to={`/projects/${projectCode}/orders/${order.id}`}>#{order.id}</Link>
                    {' '}<span className="izy-muted">{order.serviceType}</span>
                    {/* The zone was on the card only when there was not one:
                        "out of area" showed, zone 1 to 5 showed nothing. So
                        the board offered a zone filter while the cards a
                        dispatcher drags between vans never said which zone
                        they were in, which is the one thing you are splitting
                        the work by. Found by running a day with two couriers
                        and eleven stops across all five zones. */}
                    {order.zone === null
                        ? <> <span className="izy-pill warn">out of area</span></>
                        : <> <span className="izy-pill muted">zone {order.zone}</span></>}
                </span>
                {label.text && <span className={`izy-pill ${label.tone === 'muted' ? 'muted' : label.tone}`}>{label.text}</span>}
            </div>
            <div>{order.recipientName}</div>
            <div className="izy-muted">{order.address}, {order.city} {order.zip}</div>
            <div className="izy-muted">due {clock(order.dueAt)} · {order.status}</div>
            {action}
        </div>
    );
}

/** What a run is called on screen: its label, or its number when it has none. */
function runName(lane: { run: { id: number; label: string } }): string {
    return lane.run.label.trim() || `Run ${lane.run.id}`;
}
