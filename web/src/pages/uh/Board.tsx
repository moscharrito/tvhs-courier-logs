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
import { Pager, usePaged, PAGE_SIZE } from '../../app/Pager';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { slaLabel, type Sla } from './Orders';
import type { Site } from './Sites';
import { mergeBoard, type BoardView, type BoardWire, type SiteRef } from '../../lib/board';

const POLL_MS = 15_000;

/* How often a poll asks for the whole board rather than a delta. Ten polls is
 * two and a half minutes. The membership arrives complete every time, so this
 * is not what keeps the board correct; it is what makes a mistake in the
 * cursor logic self-correcting rather than permanent. */
const FULL_EVERY = 10;

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
    /* Whether a shift is OPEN, from the shifts table -- not inferred from
       recent activity, which is what `present` means. See the note on
       courierNote(): the board used to print one as the other. */
    onShift: boolean; shiftStartedAt: string | null;
    /** Their standing pharmacy, or null for a floater. */
    homeSiteId: number | null;
    /** Other counters they may be given work for. See the picker below:
     *  one driver is based at Vida and runs Wheatley as part of the same
     *  round, and nobody is based at Wheatley at all. */
    alsoCovers: number[];
    /** On shift under a membership that is not courier or lead. */
    offRoster: boolean;
    /** Disabled mid-shift. They may still be carrying. */
    inactive: boolean;
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
    /** Put back by lib/board.ts from the ids the server sent. */
    stops: Array<{ sequence: number; order: BoardOrder }>;
    currentStop: { sequence: number; order: BoardOrder } | null;
    counts: { total: number; remaining: number; done: number; overdue: number };
}

/* The board as this page renders it.
 *
 * A poll no longer carries the cards inside the lanes and the pool; they
 * arrive in a map keyed by id, and with a cursor only the ones that moved
 * arrive at all. lib/board.ts puts them back, so everything below this line
 * sees the same shape it always did. The only thing that changed up here is
 * where the shape is defined. */
type BoardData = BoardView<BoardOrder, Courier, Activity> & {
    summary: { total: number; unassigned: number; assigned: number; inTransit: number; delivered: number; failed: number; overdue: number; dueSoon: number };
    couriers: Courier[];
    idleCouriers: Courier[];
    activity: Activity[];
    lanes: Lane[];
};

/** Addendum 1's dry-run codes, in words a dispatcher would use out loud. */
const REASON_LABEL: Record<string, string> = {
    recipient_not_located: 'could not find the recipient',
    incorrect_address: 'address is wrong',
    no_access: 'could not get access',
    incomplete_shipment: 'shipment incomplete',
    refused: 'recipient refused it',
    other: 'other',
};

/* Each label is the MIDDLE of a sentence: courier, label, then the
 * recipient as a link. So every one of these has to read straight into a
 * person's name.
 *
 * `picked_up` was 'collected', so the feed read "<courier> collected
 * <patient>" -- a sentence about collecting the patient. What actually
 * happened is that the courier took that patient's package from the
 * pharmacy counter, and the line now says so. It is longer than the
 * others and that is the right trade: this is the one event in the chain
 * where the thing handed over and the person named are different. */
const EVENT_LABEL: Record<string, string> = {
    picked_up: 'received the package at the pharmacy for',
    arrived: 'arrived at', delivered: 'delivered to',
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

/* WHAT TO PUT AFTER A COURIER'S NAME.
 *
 * This used to be `c.present ? '' : ' (not on shift)'`, and `present` means
 * "used the app in the last ten minutes". So a driver who was on shift and
 * mid-drive, phone in a pocket for eleven minutes, was labelled as not
 * working -- and a dispatcher looking for somebody to take a STAT would pass
 * over the nearest person on the strength of it.
 *
 * Three states now, because there are three:
 *
 *   not on shift          not working today. Do not assign.
 *   on shift, quiet       working; their phone has not spoken to us for a
 *                         while. Assignable, but ring rather than assume.
 *   on shift, seen        working and in touch. Nothing to say.
 */
/* Takes a partial courier, because the proposal's picker offers names the
   board may not be holding a full record for -- somebody the server staffed
   from the shift roster who has since picked up a run. An absent `onShift`
   is unknown, not false: "(not on shift)" beside a driver the server just
   planned around would be the misleading label this function exists to
   avoid. See the note on the presence query in modules/uh/board.ts. */
function courierNote(c: Partial<Courier>): string {
    if (c.onShift === undefined) return '';
    if (!c.onShift) return ' (not on shift)';
    if (!c.present) return ` (on shift, last seen ${seenLabel(c as Courier)})`;
    return '';
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
    /* Eighteen on paper. A dispatcher with fifteen on shift needs to see
       what fifteen looks like before they start ringing people, so it is a
       box on the screen and not a setting in a file. */
    /* Typed by hand until 17 October, defaulting to eighteen -- the number in
       the contract rather than the number standing in a car park. Proposing a
       wave for eighteen drivers when five are on shift produces a plan that
    /* Narrows the lanes below. Not in the URL: it is a glance at one
       driver during a wave, not a view somebody links to. */
    const [laneFilter, setLaneFilter] = useState('');
    const pollRef = useRef<number | null>(null);
    /* The cards we already hold, and the cursor that says what we have seen.
       Refs rather than state: a poll reads and replaces both, and making them
       state would re-run the effect that polls and restart the interval every
       fifteen seconds. */
    const cardsRef = useRef<ReadonlyMap<number, BoardOrder>>(new Map());
    const cursorRef = useRef<string | null>(null);
    /* A full load every so often regardless, so that any drift between what
       we hold and what is really there corrects itself without anybody
       noticing. The membership arriving whole on every poll means drift
       should be impossible; this is for the case where it is not. */
    const pollsRef = useRef(0);

    const base = `/api/projects/${code}/uh`;
    const query = params.toString();

    const load = useCallback(async (full = false) => {
        try {
            /* Every tenth poll asks for the whole board, which at fifteen
               seconds is about every two and a half minutes. */
            const wantsFull = full || cursorRef.current === null || pollsRef.current % FULL_EVERY === 0;
            const parts = [query, wantsFull ? '' : `since=${encodeURIComponent(cursorRef.current!)}`]
                .filter(Boolean).join('&');
            const wire = await api<BoardWire<BoardOrder, Courier, Activity>>(`${base}/board${parts ? `?${parts}` : ''}`);

            const merged = mergeBoard(wire, cardsRef.current);
            cardsRef.current = merged.cards;
            cursorRef.current = merged.cursor;
            pollsRef.current += 1;
            setData(merged.view as BoardData);
            setStale(false);

            /* A card the membership named and we do not hold. Not a gap to
               draw: ask again for everything, immediately. See lib/board.ts
               for why this is better than a placeholder. */
            if (merged.missing.length > 0 && !wantsFull) {
                cursorRef.current = null;
                void load(true);
            }
        } catch (err) {
            /* Say the board has stopped updating rather than leaving a
               dispatcher reading minute-old numbers as if they were live.
               During a wave that is the difference between a late delivery
               and a missed one. */
            setStale(true);
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load the board' });
        }
    }, [base, query]);

    /* A filter change rebuilds `load`, and the cache behind it belongs to the
       previous filter: a board scoped to one pharmacy holds none of the cards
       the unscoped one will reference. Dropping the cursor here makes the
       next call a full load. */
    useEffect(() => {
        cardsRef.current = new Map();
        cursorRef.current = null;
        pollsRef.current = 0;
        void load(true);
    }, [load]);

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
       The feed only. The pool groups and the lanes hold a page each of their
       own, in PoolGroup and LaneStops, because one page number shared across
       nine pharmacies would turn to page 2 for all of them at once. */
    const pagedFeed = usePaged(data?.activity ?? []);
    /* The driver lanes. Three fitted on a screen and twenty-three do not:
       each lane is a card carrying every stop on the run, so the contract's
       full fleet is several thousand pixels of scroll with the lane you
       want as likely to be at the bottom as the top.

       Filtered before paged, so the count under the pager is the count of
       what matches rather than of the whole board. Matching on the driver's
       name and on the run's label, which is where "Wave 3" and "STAT" live
       -- the two things a dispatcher says out loud when looking for one. */
    const laneMatches = (data?.lanes ?? []).filter((l) => {
        const q = laneFilter.trim().toLowerCase();
        if (q === '') return true;
        return l.courier.name.toLowerCase().includes(q)
            || l.courier.username.toLowerCase().includes(q)
            || l.run.label.toLowerCase().includes(q);
    });
    const pagedLanes = usePaged(laneMatches);

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

    /** Put an order on a run, or on a driver who has not got one yet.
     *
     * The target is `run:<id>` or `courier:<username>`, because the dropdown
     * now offers both and a bare number could not tell them apart.
     * allowMove covers dragging between lanes. */
    const assign = (orderId: number, target: string) => act(
        async () => {
            const refused = (r: unknown) => (r as { rejected?: Array<{ error?: string }> }).rejected ?? [];
            const stop = (r: unknown) => {
                const no = refused(r);
                if (no.length > 0) throw new ApiError(409, no[0]?.error ?? 'Could not assign that order');
            };

            if (target.startsWith('courier:')) {
                /* ONE CALL, NOT TWO. The create endpoint takes its stops with
                   it, so there is no window in which a run exists with
                   nothing on it because the second request failed -- which
                   would leave an empty lane on the board and the card still
                   in the pool, looking like the assignment simply vanished. */
                stop(await api(`${base}/runs`, {
                    method: 'POST',
                    json: {
                        courierUsername: target.slice('courier:'.length),
                        label: 'Wave',
                        serviceDate: data?.serviceDate,
                        orderIds: [orderId],
                    },
                }));
                return;
            }

            const runId = Number(target.slice('run:'.length));
            stop(await api(`${base}/runs/${runId}/stops`, {
                method: 'POST', json: { orderIds: [orderId], allowMove: true },
            }));
        },
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

    /* THE POOL'S "Assign to..." IS A LIST OF LANES, AND IT USED TO BE ALL OF
     * THEM.
     *
     * The run-proposal picker below was narrowed to the counter's own drivers
     * on 2 November and this one was missed, which is the half that dispatch
     * actually uses: every card waiting at Wheatley offered every driver on
     * the board, including drivers based at counters on the other side of the
     * city. Reported 2 November as "still see all drivers in the dropdown".
     *
     * ON SHIFT AND MAPPED TO THAT PHARMACY, both. A lane exists because a run
     * was made, and a run outlives the shift that started it: a driver who
     * went home at two still has today's lane, and offering it at four hands
     * work to somebody who is not working.
     *
     * AND THE OTHER HALF, WHICH WAS MISSING UNTIL 3 NOVEMBER. A lane is a run
     * that already exists. A driver who has signed in, gone on shift and is
     * standing at the counter has no run yet, so a list built only from lanes
     * cannot contain them at all -- reported on 3 November as a driver who
     * was mapped to the counter and on shift, with only one other name in
     * the dropdown. He was not being filtered out by the pharmacy rule; he
     * was never a candidate, because the list was a list of runs wearing
     * drivers' names, and the other name was there only because that driver
     * happened to have started one.
     *
     * Picking a driver with no run starts one, with the card on it. That is
     * what choosing them meant. Sending a dispatcher to the Start a run panel
     * to make an empty run and then come back to fill it is ceremony, and it
     * is ceremony at the one moment they are busiest. */
    const targetsFor = (siteId: number) => {
        const mapped = (c: { homeSiteId: number | null; alsoCovers?: number[] }) =>
            c.homeSiteId === siteId || (c.alsoCovers ?? []).includes(siteId);

        const running = (data?.lanes ?? [])
            .filter((l) => l.courier.onShift === true && mapped(l.courier))
            .map((l) => ({
                value: `run:${l.run.id}`,
                label: `${l.courier.name}${l.run.label ? ` (${l.run.label})` : ''}`,
            }));

        /* idleCouriers is exactly "on the board, with no lane today", so
           these two lists cannot name the same person twice. */
        const free = (data?.idleCouriers ?? [])
            .filter((c) => c.onShift && mapped(c))
            .map((c) => ({ value: `courier:${c.username}`, label: `${c.name} — starts a run` }));

        return [...running, ...free];
    };

    /* ON SHIFT, FROM THE SHIFTS TABLE. Not `present`, which is "used the app
       in the last ten minutes" -- a driver halfway between two addresses is
       on shift and quiet, and both panels below would be wrong about them.
       See courierNote() for the same distinction on the lane pills. */
    const onShift = (data?.couriers ?? []).filter((c) => c.onShift);
    const onShiftCount = onShift.length;
    /* Somebody who can be given a run right now: on shift, without one,
       AND based at the pharmacy the board is filtered to.
     *
     * THE FILTER AT THE TOP NOW MEANS SOMETHING HERE TOO. This panel offered
     * every driver on shift anywhere, so a dispatcher working Wheatley was
     * shown eighteen names of whom one drives Wheatley -- the same complaint
     * as the assignment dropdown, in the one control that creates a run
     * rather than fills it.
     *
     * Home counter or cover, the same rule as targetsFor and the pool picker:
     * three places now answer "who may take this pharmacy’s work" and they
     * have to answer it the same way.
     *
     * UNFILTERED MEANS UNNARROWED. With no pharmacy chosen the board is
     * showing the whole contract, and so does this. */
    const startable = (data?.idleCouriers ?? [])
        .filter((c) => c.onShift)
        .filter((c) => {
            const wanted = Number(get('siteId'));
            if (!Number.isInteger(wanted) || wanted <= 0) return true;
            if (c.homeSiteId === wanted) return true;
            return (c.alsoCovers ?? []).includes(wanted);
        });

    if (data === null) return <div className="izy-card"><Loading label="Loading the board" /></div>;

    /* Couriers carrying more than one run today. Their lanes say which. */
    const runsPer = new Map<string, number>();
    for (const lane of data.lanes) {
        runsPer.set(lane.courier.username, (runsPer.get(lane.courier.username) ?? 0) + 1);
    }
    const twiceOver = new Set([...runsPer].filter(([, n]) => n > 1).map(([u]) => u));

    const s = data.summary;

    /* The pharmacy a run collects from, by name. `bySite` is every counter
       with work today, which is every counter a proposed run can name. */
    const siteNames = new Map(data.bySite.map((b) => [b.site.id, b.site.name]));
    const siteName = (id: number) => siteNames.get(id) ?? sites.find((x) => x.id === id)?.name ?? `site ${id}`;


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
                {/* The counts above are the whole day. The cards below may not
                    be, on a day big enough, and a board that quietly showed a
                    subset would be the same fault the orders list had. */}
                {/* A DAY TOO BIG FOR ONE BOARD IS A DAY WORKED ONE COUNTER AT
                    A TIME. University Health run 1,417 deliveries on a
                    Tuesday across eight pharmacies; the largest single
                    counter is 241. Raising the card limit would only trade a
                    truncated board for an unusable one, so this offers the
                    thing that actually works and says why. */}
                {data.carrying?.truncated && get('siteId') === '' && (
                    <div className="izy-alert warn" role="status" style={{ marginTop: 8 }}>
                        <p style={{ marginTop: 0 }}>
                            <b>{data.carrying.of} deliveries today</b>, and the board is showing{' '}
                            {data.carrying.shown} of them as cards. The counts above are the whole day.
                            Pick a pharmacy to work one counter at a time.
                        </p>
                        <div className="izy-row">
                            {(data.bySite ?? []).map((s) => (
                                <button
                                    key={s.site.id}
                                    type="button"
                                    className="izy-btn secondary"
                                    onClick={() => set('siteId', String(s.site.id))}
                                >
                                    {s.site.name} ({s.open})
                                    {s.overdue > 0 && <span className="izy-stat-bad"> {s.overdue} late</span>}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {data.carrying?.truncated && get('siteId') !== '' && (
                    <p className="izy-muted" style={{ marginTop: 6 }}>
                        Showing {data.carrying.shown} of {data.carrying.of}. Completed work is left off
                        the board before anything a dispatcher can act on.
                    </p>
                )}
            </div>

            {/* Above the pool, deliberately. Everything below this line is
                work sitting still; this is the only thing on the board with
                a courier standing still behind it, waiting to be told yes or
                no. Staff only, so a courier who reaches /board directly does
                not fire a request the server will refuse. */}

            <div className="izy-board">
                <Section
                    id="uh.board.pool"
                    title="Unassigned"
                    /* The count in the summary, not the title, so it reads
                       the same way as every other section on this page. The
                       whole number stays visible when the section is folded,
                       which is the one fact a dispatcher must never lose. */
                    summary={s.unassigned === 0 ? 'nothing waiting' : `${s.unassigned} waiting`}
                >
                  {/* Still a labelled region, not a plain div: a section
                      with an aria-label is a landmark a screen reader can
                      jump to, and "the unassigned pool" is one of the two
                      places on this page somebody navigates straight to. */}
                  <section aria-label="Unassigned pool">
                    {data.pool.length === 0 ? <div className="izy-muted">Nothing waiting.</div> : data.pool.map((group) => (
                        <PoolGroup
                            key={group.site.id}
                            group={group}
                            projectCode={code}
                            busy={busy}
                            laneOptions={targetsFor(group.site.id)}
                            onDragStart={setDragging}
                            assign={assign}
                        />
                    ))}
                  </section>
                </Section>

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
                        defaultOpen={startable.length > 0}
                        summary={startable.length === 0
                            ? (onShiftCount === 0 ? 'nobody is on shift' : 'everybody on shift has a run')
                            : `${startable.length} on shift without a run`}
                    >
                        {startable.length === 0 ? (
                            /* TWO DIFFERENT NOTHINGS. "Everybody has a run" is
                               a finished morning; "nobody is on shift" is a
                               day that has not started, and a dispatcher who
                               reads the first when the second is true goes
                               looking for a fault that is not there. */
                            <p className="izy-muted">
                                {onShiftCount === 0
                                    ? 'Nobody is on shift. A driver has to go on shift in the app before they can be given a run.'
                                    : get('siteId') !== ''
                                        /* A THIRD NOTHING, since the list is
                                           narrowed to one counter: "everybody
                                           has a run" would be false about the
                                           contract and send a dispatcher
                                           looking for work that is not there. */
                                        ? 'No driver on shift at this pharmacy is free. Clear the pharmacy filter to see the rest.'
                                        : 'Every driver on shift already has a run today.'}
                            </p>
                        ) : (
                            <div className="izy-row">
                                <label className="izy-field">Courier
                                    <select value={newRunCourier} onChange={(e) => setNewRunCourier(e.target.value)}>
                                        <option value="">Choose a courier</option>
                                        {startable.map((c) => (
                                            <option key={c.username} value={c.username}>{c.name}{courierNote(c)}</option>
                                        ))}
                                    </select>
                                </label>
                                <button className="izy-btn" type="button" disabled={busy || newRunCourier === ''} onClick={() => { void startRun(); }}>
                                    Start run
                                </button>
                            </div>
                        )}
                    </Section>

                    {/* NO "PLAN THE WAVE" HERE ANY MORE. It proposed runs
                        for a whole noon release at once, which was the
                        right tool while the sweep assigned work. Dispatch
                        now picks every driver by hand from the pool above,
                        and a second way to create runs -- with its own
                        courier picker and its own rules about who may be
                        offered -- was a second place for those rules to
                        drift. Removed 3 November as redundant. */}

                    {/* ───────────────────────────────── THE LANES, IN PAGES.

                        Every lane is a card with every stop on it. Three
                        drivers is a screen; twenty-three is about four
                        thousand pixels of scroll, and the one a dispatcher
                        wants is as likely to be at the bottom as the top.
                        So: eight at a time, the same page size as every
                        other list, with a filter above for the case where
                        you know whose lane you want.

                        The pager says the total, which is the part that
                        matters: a page of eight lanes is otherwise
                        indistinguishable from a day with eight drivers. */}
                    {data.lanes.length > PAGE_SIZE && (
                        <label className="izy-field izy-lane-filter">Find a driver
                            <input
                                value={laneFilter}
                                onChange={(e) => { setLaneFilter(e.target.value); pagedLanes.setPage(0); }}
                                placeholder="name or pharmacy"
                                aria-label="Filter lanes by driver"
                            />
                        </label>
                    )}
                    {pagedLanes.total === 0 && laneFilter !== '' && (
                        <p className="izy-muted">
                            No driver on the board matches “{laneFilter}”. {data.lanes.length} {data.lanes.length === 1 ? 'lane' : 'lanes'} in all.
                        </p>
                    )}
                    {/* ─── A COLUMN OF DRIVERS, NOT A WALL OF CARDS.
                        It was an auto-fill grid of 280px cards, one per
                        run, each holding its stops as further bordered
                        cards -- cards inside cards, three deep with the
                        stop's own actions. On a dispatcher's screen that
                        is twelve little boxes to read across before you
                        find the driver you are looking for, and on a
                        narrow one it is a single column anyway, just with
                        more borders.

                        Now each driver is a foldable section down the
                        page and each stop is a ROW inside it, the way the
                        driver roster does it. Folded, the header still
                        says who it is and how far through they are, which
                        is what the grid was really being read for.

                        THE DROP TARGET IS THE WRAPPER, not the section.
                        Section renders its own element and knows nothing
                        about dragging; wrapping it keeps the drag and
                        drop working without teaching a shared primitive
                        about this one screen. */}
                    <div className="izy-board-lanes">
                    {pagedLanes.rows.map((lane) => (
                        <div
                            key={lane.run.id}
                            onDragOver={(e) => { e.preventDefault(); }}
                            onDrop={(e) => { e.preventDefault(); if (dragging !== null) void assign(dragging, `run:${lane.run.id}`); setDragging(null); }}
                        >
                        <Section
                            /* Keyed by run, so folding one wave does not
                               fold the same driver's other one -- and so a
                               dispatcher who only watches three counters
                               can fold the rest once and have it stay. */
                            id={`uh.board.lane.${lane.run.id}`}
                            className="izy-lane"
                            title={twiceOver.has(lane.courier.username)
                                ? `${lane.courier.name} · ${runName(lane)}`
                                : lane.courier.name}
                            summary={(
                                <>
                                    {lane.counts.done} of {lane.counts.total} done
                                    {lane.counts.overdue > 0 && <span className="izy-stat-bad"> · {lane.counts.overdue} overdue</span>}
                                </>
                            )}
                            actions={(
                                <span className={`izy-pill ${lane.courier.onShift ? '' : 'muted'}`} title={lane.courier.lastSeenAt ?? 'never signed in'}>
                                    {/* The pill answers "is this person working", and the
                                        time answers "are they in touch". Separate, because
                                        a quiet phone is not a finished shift. */}
                                    {lane.courier.onShift
                                        ? (lane.courier.present ? 'on shift' : `on shift · ${seenLabel(lane.courier)}`)
                                        : `off shift · ${seenLabel(lane.courier)}`}
                                </span>
                            )}
                        >
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
                                <button className="izy-btn secondary small" type="button" disabled={busy || lane.counts.total === 0}
                                    onClick={() => { void autoSequence(lane.run.id, 'nearest'); }}>
                                    Sequence by distance
                                </button>
                                <button className="izy-btn secondary small" type="button" disabled={busy || lane.counts.total === 0}
                                    onClick={() => { void autoSequence(lane.run.id, 'due'); }}>
                                    Sequence by deadline
                                </button>
                            </div>

                            <LaneStops
                                lane={lane}
                                projectCode={code}
                                busy={busy}
                                onDragStart={setDragging}
                                unassign={unassign}
                            />
                        </Section>
                        </div>
                    ))}
                    </div>
                    <Pager
                        of={pagedLanes}
                        noun="drivers"
                        note={laneFilter === '' ? undefined : `filtered from ${data.lanes.length}`}
                    />

                    <Section
                        id="board-activity"
                        title="What just happened"
                        summary={data.activity.length === 0 ? 'nothing recorded yet' : `${data.activity.length} recent`}
                    >
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
                    </Section>

            </div>
        </>
    );
}

/* One pharmacy's waiting orders, paged.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TICKET 5.15 LEFT THE POOL WHOLE AND 7.8 PAGES IT. WHY THAT CHANGED.
 *
 * 5.15's reason was that a dispatcher drags cards out of here, and you
 * cannot drag a card that is on another page. That was true and is still
 * true. What it missed is that dragging was never the only way: every card
 * carries an "Assign to..." select covering the same ground, so paging
 * removes a shortcut and not a capability.
 *
 * Against that: Robert B. Green sends 241 a day, and the noon wave put all
 * of them in the document at once on a screen that re-renders every fifteen
 * seconds. Nobody reads 241 cards. They work the top of the pile.
 *
 * The count stays in the heading whatever page you are on, which is the part
 * that has to be true: a dispatcher must never be able to mistake a page of
 * eight for the whole of what is waiting.
 */
function PoolGroup({ group, projectCode, busy, laneOptions, onDragStart, assign }: {
    group: { site: SiteRef; orders: BoardOrder[]; overdue: number };
    projectCode: string;
    busy: boolean;
    laneOptions: Array<{ value: string; label: string }>;
    onDragStart: (id: number | null) => void;
    assign: (orderId: number, target: string) => void | Promise<void>;
}) {
    /* SIX, NOT THE USUAL EIGHT. Nine counters are nine of these stacked down
       one column, so the page size here multiplies by nine rather than
       standing alone. Six keeps a pharmacy's slice short enough that the
       counter below it is still on screen. */
    const paged = usePaged(group.orders, 6);
    return (
        <Section
            id={`uh.pool.${group.site.code ?? group.site.id}`}
            title={group.site.name}
            /* Folding is per counter and remembered, because a dispatcher
               working the Green wave does not want Wheatley's seven
               deliveries between them and the next card. */
            defaultOpen
            summary={`${group.orders.length} waiting${group.overdue > 0 ? `, ${group.overdue} overdue` : ''}`}
        >
            {paged.rows.map((o) => (
                <OrderCard
                    key={o.id}
                    order={o}
                    draggable
                    onDragStart={() => onDragStart(o.id)}
                    onDragEnd={() => onDragStart(null)}
                    projectCode={projectCode}
                    action={laneOptions.length === 0 ? null : (
                        <label className="izy-assign">
                            <span className="izy-visually-hidden">Assign order {o.id} to</span>
                            <select
                                aria-label={`Assign order ${o.id} to`}
                                value=""
                                disabled={busy}
                                onChange={(e) => { if (e.target.value) void assign(o.id, e.target.value); }}
                            >
                                <option value="">Assign to...</option>
                                {laneOptions.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                            </select>
                        </label>
                    )}
                />
            ))}
            <Pager of={paged} noun="waiting" />
        </Section>
    );
}

/* One courier's stops, paged.
 *
 * 5.15's other reason for leaving the board alone was that hiding stops nine
 * and up hides who is late. The lane header answers that directly -- it says
 * "x of y done" and the overdue count beside it, on every page -- so what is
 * off screen is stated rather than hidden. A lane of thirty cards was also
 * the reason a dispatcher had to scroll past one courier to reach the next.
 *
 * "Return to pool" is on every card, so reassigning across lanes works from
 * any page: it costs a return and an assign where a drag was one movement.
 */
function LaneStops({ lane, projectCode, busy, onDragStart, unassign }: {
    lane: Lane;
    projectCode: string;
    busy: boolean;
    onDragStart: (id: number | null) => void;
    unassign: (orderId: number, runId: number) => void | Promise<void>;
}) {
    const paged = usePaged(lane.stops);
    if (lane.stops.length === 0) return <div className="izy-muted">No stops yet.</div>;
    return (
        <>
            {paged.rows.map((stop) => (
                <OrderCard
                    key={stop.order.id}
                    order={stop.order}
                    sequence={stop.sequence}
                    current={lane.currentStop?.order.id === stop.order.id}
                    draggable
                    onDragStart={() => onDragStart(stop.order.id)}
                    onDragEnd={() => onDragStart(null)}
                    projectCode={projectCode}
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
            <Pager of={paged} noun="stops" />
        </>
    );
}

/* ONE DELIVERY, AS A ROW.
 *
 * It was a bordered card four lines tall inside a lane that was itself a
 * card inside a grid -- three depths of border around one address. A
 * dispatcher reads this list to find a stop and move it, which is a
 * scanning job, and scanning down aligned columns beats reading a stack
 * of boxes.
 *
 * THE COLUMNS, and why these: what it is, who and where, and the one
 * control. The deadline and the status ride with the address rather than
 * taking a column of their own, because they are read when the eye has
 * already stopped on the row, not while running down it.
 *
 * STILL DRAGGABLE, and still marked when it is the stop the courier is
 * working. Those are the two things the card shape was carrying that the
 * row has to keep.
 */
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
            className={`izy-stop-row${current ? ' is-current' : ''}`}
            draggable={draggable}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            <div className="izy-stop-row-what">
                {sequence !== undefined && <b>{sequence}. </b>}
                <Link to={`/projects/${projectCode}/orders/${order.id}`}>#{order.id}</Link>
                {' '}<span className="izy-muted">{order.serviceType}</span>
                {/* The zone was on the card only when there was not one:
                    "out of area" showed, zone 1 to 5 showed nothing. So the
                    board offered a zone filter while the cards a dispatcher
                    drags between vans never said which zone they were in,
                    which is the one thing you are splitting the work by. */}
                {order.zone === null
                    ? <> <span className="izy-pill warn">out of area</span></>
                    : <> <span className="izy-pill muted">zone {order.zone}</span></>}
                {label.text && <> <span className={`izy-pill ${label.tone === 'muted' ? 'muted' : label.tone}`}>{label.text}</span></>}
            </div>
            <div className="izy-stop-row-who">
                <div>{order.recipientName}</div>
                <div className="izy-muted">{order.address}, {order.city} {order.zip}</div>
                <div className="izy-muted">due {clock(order.dueAt)} · {order.status}</div>
            </div>
            <div className="izy-stop-row-do">{action}</div>
        </div>
    );
}

/** What a run is called on screen: its label, or its number when it has none. */
function runName(lane: { run: { id: number; label: string } }): string {
    return lane.run.label.trim() || `Run ${lane.run.id}`;
}
