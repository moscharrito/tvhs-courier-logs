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
import { Escalation } from './Escalation';
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
    /** On shift under a membership that is not courier or lead. */
    offRoster: boolean;
    /** Disabled mid-shift. They may still be carrying. */
    inactive: boolean;
    /** Where they were when they last sent an event. Null if never. */
    position: Position | null;
}

interface ProposedRun {
    kind: 'stat' | 'standard';
    orderIds: number[];
    zips: string[];
    siteIds: number[];
    earliestDueAt: string | null;
}

/** Who the server suggests for a run, and on what grounds. */
interface Suggested {
    username: string;
    name: string;
    why: 'home' | 'floater' | 'cover';
}

interface Proposal {
    serviceDate: string;
    settings: { drivers: number; maxStopsPerRun: number; maxSitesPerRun: number; maxStopsPerStatRun: number };
    runs: ProposedRun[];
    unplaced: Array<{ orderId: number; why: string }>;
    notes: string[];
    driversNeeded: number;
    /* OPTIONAL, ALL FOUR, and not because the server might omit them: it
       always sends them. A deployed bundle can be talking to the previous
       server for the minute or two a deploy takes, and the board is the one
       screen where a missing field must degrade to a missing sentence
       rather than to a white page. */
    /** Parallel to `runs`. Null where nobody was left. */
    suggested?: Array<Suggested | null>;
    /** On shift and not needed by this plan. */
    spare?: Array<{ username: string; name: string; homeSiteId: number | null }>;
    /** Whether it was built from people on shift or from the roster list. */
    planningFrom?: 'onShift' | 'roster';
    fleet?: { onShift: number; roster: number };
    /** The pharmacy this plan is for, or null for the whole day. */
    site?: { id: number; code: string; name: string } | null;
    /** 'site' is that counter's own drivers, 'anyDriver' the widened list. */
    scope?: 'all' | 'site' | 'anyDriver';
    /** Why the list is short. Counts, so the screen can say it in words. */
    excluded?: { held: number; otherSite: number; offShift: number };
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
    const [proposal, setProposal] = useState<Proposal | null>(null);
    /* Eighteen on paper. A dispatcher with fifteen on shift needs to see
       what fifteen looks like before they start ringing people, so it is a
       box on the screen and not a setting in a file. */
    /* Typed by hand until 17 October, defaulting to eighteen -- the number in
       the contract rather than the number standing in a car park. Proposing a
       wave for eighteen drivers when five are on shift produces a plan that
       cannot be driven, and the dispatcher finds out by assigning it. */
    const [fleet, setFleet] = useState('');
    /* Narrows the lanes below. Not in the URL: it is a glance at one
       driver during a wave, not a view somebody links to. */
    const [laneFilter, setLaneFilter] = useState('');
    const [fleetTouched, setFleetTouched] = useState(false);
    /* WHICH COUNTER THIS WAVE IS FOR. Empty is the whole day, which is what
       it did before and still the right answer for a quiet afternoon.
       University Health drops a list per pharmacy, so the ordinary morning
       is one of these at a time, staffed by the people hired to drive from
       there. */
    const [planSite, setPlanSite] = useState('');
    /* The way past that counter's own roster, for the morning when its
       drivers are all off and the work still has to move. Deliberately not
       a fallback: widening is an act the dispatcher takes and can see they
       took. Reset whenever the counter changes, so it cannot be left on
       from a previous pharmacy. */
    const [anyDriver, setAnyDriver] = useState(false);
    const [takeWith, setTakeWith] = useState<Record<number, string>>({});
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
    /* The proposal's own runs. Eighteen on a good day and nearer thirty-five
       on a Tuesday, each with a courier picker beside it, which was a long
       scroll in a panel that is meant to be read quickly at noon. */
    const pagedProposal = usePaged(proposal?.runs ?? []);
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

    /* The proposal is held, not refetched on every render: it is a
       suggestion a dispatcher is reading and comparing against the board,
       and having it change underneath them on the fifteen-second poll is
       the one thing it must not do. It is cleared when one is taken, so
       what is on screen is never a plan that has already half happened. */
    /* THE FLEET SIZE IS THE SERVER'S ANSWER UNLESS SOMEBODY OVERRODE IT.
       It used to be this box, always, pre-filled by counting onShift on the
       client. The server now reads the shifts table itself and staffs the
       plan from it, so sending a number we counted here would override the
       better answer with a worse one. `?drivers=` is kept for the "what
       would ten look like" question, which is what the box is now for. */
    /* `widen` is an ARGUMENT and not read from state, because the button
       that widens also sets it, and a setState has not landed by the time
       the handler runs. Reading the state here would send the OLD value and
       the dispatcher would have to press it twice. */
    const proposeRoutes = (widen = anyDriver) => act(
        () => api<Proposal>(`${base}/runs/propose?${new URLSearchParams({
            ...(fleetTouched && fleet !== '' ? { drivers: fleet } : {}),
            ...(data?.serviceDate ? { serviceDate: data.serviceDate } : {}),
            ...(planSite !== '' ? { site: planSite } : {}),
            ...(planSite !== '' && widen ? { anyDriver: '1' } : {}),
        }).toString()}`).then((p) => {
            setProposal(p);
            /* Preselect the server's suggestion so the ordinary case is one
               click. A dispatcher who disagrees changes the dropdown; the
               suggestion is a default and never an assignment. */
            setTakeWith(Object.fromEntries(
                (p.suggested ?? []).map((s, i) => [i, s?.username ?? '']).filter(([, u]) => u !== ''),
            ));
        }),
        'Routes proposed. Nothing is assigned yet.',
    );

    /* `suggested` is parallel to `runs` and `takeWith` is keyed by position,
       so removing a run has to move all three or the names slide onto the
       wrong routes -- and each one still looks individually plausible,
       which is the kind of mistake nobody catches by reading the screen. */
    const dropProposed = (taken: ProposedRun[]) => {
        const gone = new Set(taken);
        setProposal((p) => {
            if (p === null) return null;
            const keep = p.runs.map((r, i) => ({ r, s: (p.suggested ?? [])[i] ?? null })).filter(({ r }) => !gone.has(r));
            setTakeWith(Object.fromEntries(keep.map(({ s }, i) => [i, s?.username ?? ''])));
            return { ...p, runs: keep.map(({ r }) => r), suggested: keep.map(({ s }) => s) };
        });
    };

    /* One proposed run becomes a real one through POST /runs with its
       orderIds -- the path the board already uses, with the lifecycle
       checks and the audit trail it already has. */
    const takeProposed = (run: ProposedRun, index: number, courier: string) => act(
        () => api(`${base}/runs`, {
            method: 'POST',
            json: {
                courierUsername: courier,
                label: run.kind === 'stat' ? 'STAT' : `Wave ${index + 1}`,
                serviceDate: data?.serviceDate,
                orderIds: run.orderIds,
            },
        }),
        `Run created for ${courier} with ${run.orderIds.length} ${run.orderIds.length === 1 ? 'stop' : 'stops'}.`,
    ).then(() => dropProposed([run]));

    /* ─────────────────────────────────────────── the whole wave at once
     *
     * Twenty-three runs created one dropdown at a time is the slowest part
     * of the morning, and it is the part happening while deadlines run.
     *
     * SEQUENTIAL, NOT Promise.all. Each POST /runs takes custody of its
     * orders and the lifecycle checks behind it are not written to run
     * against themselves twenty-three times over. It also means a failure
     * halfway leaves the runs before it created and the rest still on the
     * proposal, which is a state a dispatcher can read and finish by hand.
     *
     * Only runs with a driver. A run whose dropdown is empty stays on the
     * proposal rather than being quietly skipped and forgotten. */
    const createAllRuns = () => {
        const pending = (proposal?.runs ?? [])
            .map((run, index) => ({ run, index, courier: takeWith[index] ?? '' }))
            .filter((x) => x.courier !== '');
        if (pending.length === 0) return;

        setBusy(true);
        void (async () => {
            const made: ProposedRun[] = [];
            try {
                for (const { run, index, courier } of pending) {
                    await api(`${base}/runs`, {
                        method: 'POST',
                        json: {
                            courierUsername: courier,
                            label: run.kind === 'stat' ? 'STAT' : `Wave ${index + 1}`,
                            serviceDate: data?.serviceDate,
                            orderIds: run.orderIds,
                        },
                    });
                    made.push(run);
                }
                setMsg({ kind: 'ok', text: `${made.length} ${made.length === 1 ? 'run' : 'runs'} created.` });
            } catch (err) {
                /* Names how far it got. "Could not create the runs" after
                   nine of them were created is worse than no message. */
                setMsg({
                    kind: 'error',
                    text: `${made.length} of ${pending.length} runs created, then: `
                        + (err instanceof ApiError ? err.message : 'the request failed'),
                    details: err instanceof ApiError ? err.details : [],
                });
            } finally {
                dropProposed(made);
                setBusy(false);
                void load(true);
            }
        })();
    };

    const startRun = () => act(
        () => api(`${base}/runs`, { method: 'POST', json: { courierUsername: newRunCourier, label: 'Wave', serviceDate: data?.serviceDate } }),
        `Run started for ${newRunCourier}.`,
    ).then(() => setNewRunCourier(''));

    const laneOptions = (data?.lanes ?? []).map((l) => ({
        id: l.run.id,
        label: `${l.courier.name}${l.run.label ? ` (${l.run.label})` : ''}`,
    }));

    /* ON SHIFT, FROM THE SHIFTS TABLE. Not `present`, which is "used the app
       in the last ten minutes" -- a driver halfway between two addresses is
       on shift and quiet, and both panels below would be wrong about them.
       See courierNote() for the same distinction on the lane pills. */
    const onShift = (data?.couriers ?? []).filter((c) => c.onShift);
    const onShiftCount = onShift.length;
    /* Somebody who can be given a run right now: on shift, and without one. */
    const startable = (data?.idleCouriers ?? []).filter((c) => c.onShift);

    if (data === null) return <div className="izy-card"><Loading label="Loading the board" /></div>;

    /* Couriers carrying more than one run today. Their lanes say which. */
    const runsPer = new Map<string, number>();
    for (const lane of data.lanes) {
        runsPer.set(lane.courier.username, (runsPer.get(lane.courier.username) ?? 0) + 1);
    }
    const twiceOver = new Set([...runsPer].filter(([, n]) => n > 1).map(([u]) => u));

    const s = data.summary;
    /* Follows the roster until somebody types over it. Planning for a number
       nobody chose is how a proposal gets built for a fleet that is not
       there. */
    const fleetValue = fleetTouched ? fleet : String(onShiftCount);

    /* The pharmacy a run collects from, by name. `bySite` is every counter
       with work today, which is every counter a proposed run can name. */
    const siteNames = new Map(data.bySite.map((b) => [b.site.id, b.site.name]));
    const siteName = (id: number) => siteNames.get(id) ?? sites.find((x) => x.id === id)?.name ?? `site ${id}`;

    /* WHO MAY BE PICKED FOR A PROPOSED ROUTE.
       `idleCouriers` is everyone without a run, which is the right default
       and is not quite enough: the server staffs from the on-shift roster,
       and somebody it suggested may have picked up a run since the proposal
       was fetched. Dropping them from the list would blank a dropdown that
       already had the right answer in it. So: idle, plus anybody suggested,
       in roster order. */
    const suggestedNames = new Map(
        (proposal?.suggested ?? []).filter((x): x is Suggested => x !== null)
            .map((x) => [x.username, x.name]),
    );
    /* How many of the proposed runs have a driver chosen. The Create-all
       button names it rather than saying "Create all" over a plan where
       three routes have nobody. */
    const readyToCreate = (proposal?.runs ?? []).filter((_, i) => (takeWith[i] ?? '') !== '').length;

    const courierChoices: Array<{ username: string; name: string } & Partial<Courier>> = [
        ...data.idleCouriers,
        ...[...suggestedNames]
            .filter(([u]) => !data.idleCouriers.some((c) => c.username === u))
            .map(([username, name]) => ({ username, name })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    /* Split for the picker. Somebody the server suggested but whom the board
       holds no record for counts as working: it staffed the plan from the
       shift table, so it knows something this list does not. */
    const chooseFrom = {
        working: courierChoices.filter((c) => c.onShift !== false),
        away: courierChoices.filter((c) => c.onShift === false),
    };

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
            {project.role === 'admin' && <Escalation projectCode={code} />}

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
                            laneOptions={laneOptions}
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

                    {/* THE NOON WAVE, BEFORE IT IS ANYBODY'S DAY.

                        Nine counters release by noon and a Tuesday is 1,417
                        deliveries. Moving those onto runs a card at a time
                        is the afternoon this gives back.

                        It proposes and stops. Nothing here is assigned
                        until a courier is chosen against a run, because
                        what is being suggested is where eighteen people
                        spend their day, and a suggestion that has already
                        happened is not one. Folded by default: it has
                        nothing to say until it is asked. */}
                    <Section
                        id="uh.board.propose"
                        /* Not "Propose routes", which is the button inside
                           it. A panel and its own button reading the same
                           words is two controls a screen reader cannot tell
                           apart, and a sighted reader clicks the wrong one. */
                        title="Plan the wave"
                        defaultOpen={false}
                        summary={proposal === null
                            ? 'group the unassigned work into runs'
                            : `${proposal.runs.length} proposed, ${proposal.unplaced.length} with no driver`}
                    >
                        <div className="izy-row">
                            {/* THE PHARMACY THIS WAVE IS FOR, first in the
                                row because it changes what every other
                                control means. Picking one plans that
                                counter's list with that counter's drivers;
                                leaving it on the whole day is what this
                                panel did before. */}
                            <label className="izy-field" style={{ maxWidth: 260 }}>Pharmacy
                                <select
                                    value={planSite}
                                    aria-label="Pharmacy to plan for"
                                    onChange={(e) => { setPlanSite(e.target.value); setAnyDriver(false); }}
                                >
                                    <option value="">The whole day, every pharmacy</option>
                                    {sites.map((st) => (
                                        <option key={st.code} value={st.code}>{st.name}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="izy-field" style={{ maxWidth: 170 }}>Drivers on shift
                                <input
                                    value={fleetValue}
                                    onChange={(e) => { setFleetTouched(true); setFleet(e.target.value.replace(/[^0-9]/g, '')); }}
                                    inputMode="numeric"
                                    aria-label="Drivers on shift"
                                />
                                {/* What the roster actually says, beside the
                                    box, so an overridden number is visibly an
                                    override rather than a fact. */}
                                <span className="izy-muted izy-field-note">
                                    {onShiftCount === 0
                                        ? 'nobody is on shift'
                                        : `${onShiftCount} on shift now`}
                                    {fleetTouched && fleetValue !== String(onShiftCount) ? ' — overridden' : ''}
                                </span>
                            </label>
                            {/* ZERO ON SHIFT IS NOT A REASON TO REFUSE.
                                This was disabled whenever the box read '0',
                                which at 11:55 -- before anybody has tapped
                                Go on shift -- is every morning. The server
                                plans from the roster in that case and says
                                it did; disabling the button put that behind
                                a door the dispatcher could not open.

                                Refused only when somebody TYPED a zero,
                                which is a request for a plan for nobody. */}
                            <button className="izy-btn" type="button" disabled={busy || (fleetTouched && fleet === '0')}
                                onClick={() => { void proposeRoutes(); }}>
                                {proposal === null ? 'Propose routes' : 'Propose again'}
                            </button>
                            {proposal !== null && (
                                <button className="izy-btn secondary" type="button" disabled={busy}
                                    onClick={() => { setProposal(null); setTakeWith({}); }}>
                                    Discard
                                </button>
                            )}
                        </div>

                        {proposal !== null && (
                            <>
                                {/* Said before the runs, not after them. A
                                    dispatcher who can see at 12:05 that the
                                    day needs six more drivers can do
                                    something about it; one who finds out at
                                    four o'clock cannot. */}
                                {proposal.notes.map((n) => (
                                    <div key={n} className="izy-alert warn" role="status">{n}</div>
                                ))}

                                {proposal.runs.length === 0 ? (
                                    <p className="izy-muted">Nothing left to group.</p>
                                ) : (
                                    <>
                                    {/* ─────────── ACCEPT THE PLAN IN ONE GO.
                                        Twenty-three dropdowns one at a time is
                                        the slowest part of the morning. Every
                                        run still has its own Create button, for
                                        the dispatcher who wants to send four
                                        and think about the rest. */}
                                    <div className="izy-row-between">
                                        <button
                                            className="izy-btn"
                                            type="button"
                                            disabled={busy || readyToCreate === 0}
                                            onClick={createAllRuns}
                                        >
                                            {/* "Create all 1 runs" was on screen for a
                                                single-route wave, which is most of a
                                                quiet morning. One route is not a set to
                                                say "all" about. */}
                                            {readyToCreate === proposal.runs.length
                                                ? (readyToCreate === 1 ? 'Create the run' : `Create all ${readyToCreate} runs`)
                                                : `Create ${readyToCreate} of ${proposal.runs.length} ${proposal.runs.length === 1 ? 'run' : 'runs'}`}
                                        </button>
                                        {/* Said plainly, because it is the
                                            difference between a plan built from
                                            people and one built from a list of
                                            who normally drives.

                                            Rendered only when the server sent
                                            it. A bundle can be newer than the
                                            server it is talking to for the few
                                            minutes a deploy takes, and reading
                                            through an absent `fleet` would turn
                                            that into a blank board rather than
                                            a missing sentence. */}
                                        {proposal.fleet !== undefined && (
                                            <span className="izy-muted">
                                                {proposal.site ? `${proposal.site.name}: ` : ''}
                                                {proposal.planningFrom === 'onShift'
                                                    ? `staffed from ${proposal.fleet.onShift} on shift of ${proposal.fleet.roster} on the roster`
                                                    : `nobody on shift — staffed from the ${proposal.fleet.roster}-driver roster`}
                                            </span>
                                        )}
                                        {/* THE WIDENING, OFFERED WHERE IT IS
                                            NEEDED AND NOWHERE ELSE.

                                            A counter whose drivers are all
                                            off cannot be planned, and the
                                            dispatcher's next question is
                                            always "then who can take it".
                                            Answering it costs one click
                                            here; the alternative is leaving
                                            them to work out that the
                                            pharmacy dropdown is the thing
                                            standing in their way.

                                            It is a button and not a
                                            fallback: anybody it brings in
                                            is driving from somebody else's
                                            counter, which the plan marks
                                            cover, and that is worth a
                                            deliberate act. */}
                                        {proposal.scope === 'site' && proposal.fleet?.onShift === 0 && (
                                            <button
                                                className="izy-btn secondary"
                                                type="button"
                                                disabled={busy}
                                                onClick={() => { setAnyDriver(true); void proposeRoutes(true); }}
                                            >
                                                Widen to everyone on shift
                                            </button>
                                        )}
                                        {proposal.excluded !== undefined && proposal.excluded.held > 0 && (
                                            <span className="izy-muted">
                                                {proposal.excluded.held}{' '}
                                                {proposal.excluded.held === 1 ? 'driver has' : 'drivers have'} no
                                                pharmacy yet and {proposal.excluded.held === 1 ? 'is' : 'are'} not
                                                offered here. <Link to={`/projects/${code}/roster`}>Assign them</Link>
                                            </span>
                                        )}
                                    </div>
                                    <table className="izy-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Route</th>
                                                <th scope="col">Stops</th>
                                                <th scope="col">Where</th>
                                                <th scope="col">First due</th>
                                                <th scope="col">Give it to</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {pagedProposal.rows.map((run, onPage) => {
                                                /* THE INDEX HAS TO BE THE ONE IN
                                                   proposal.runs, NOT THE ONE ON
                                                   THIS PAGE. takeWith is keyed by
                                                   position and `suggested` is
                                                   parallel to the full array, so
                                                   page two starting again at nought
                                                   collides with page one -- every
                                                   row still looking perfectly
                                                   plausible while the names sit on
                                                   the wrong routes. */
                                                const i = pagedProposal.from - 1 + onPage;
                                                const picked = takeWith[i] ?? '';
                                                const hint = (proposal.suggested ?? [])[i] ?? null;
                                                return (
                                                <tr key={run.orderIds.join(',')}>
                                                    <td>
                                                        {run.kind === 'stat'
                                                            ? <span className="izy-pill">STAT</span>
                                                            : `Wave ${i + 1}`}
                                                    </td>
                                                    <td>{run.orderIds.length}</td>
                                                    <td>
                                                        {/* The pharmacy by name, because that is
                                                            what a driver is assigned to and what
                                                            the suggestion below is reasoning
                                                            about. The ZIPs are the detail. */}
                                                        {run.siteIds.map((id) => siteName(id)).join(' + ')}
                                                        <br />
                                                        <span className="izy-muted">{run.zips.join(', ')}</span>
                                                    </td>
                                                    <td>{run.earliestDueAt === null
                                                        ? <span className="izy-muted">not set</span>
                                                        : clock(run.earliestDueAt)}</td>
                                                    <td>
                                                        <div className="izy-row">
                                                            <select
                                                                aria-label={`Courier for proposed route ${i + 1}`}
                                                                value={picked}
                                                                onChange={(e) => setTakeWith({ ...takeWith, [i]: e.target.value })}
                                                            >
                                                                <option value="">Choose a courier</option>
                                                                {/* ON SHIFT FIRST, IN THEIR OWN GROUP.
                                                                    Flat, this was thirty-two names in
                                                                    alphabetical order with the six people
                                                                    actually working scattered through
                                                                    them -- so changing a suggestion meant
                                                                    scrolling past twenty-five drivers who
                                                                    are at home. The group label does the
                                                                    work "(not on shift)" was doing one
                                                                    row at a time. */}
                                                                {chooseFrom.working.length > 0 && (
                                                                    <optgroup label="On shift">
                                                                        {chooseFrom.working.map((c) => (
                                                                            <option key={c.username} value={c.username}>
                                                                                {c.name}{courierNote(c)}
                                                                            </option>
                                                                        ))}
                                                                    </optgroup>
                                                                )}
                                                                {chooseFrom.away.length > 0 && (
                                                                    /* Still offered. A dispatcher ringing
                                                                       somebody to come in needs to put the
                                                                       run on them before they arrive. */
                                                                    <optgroup label="Not on shift">
                                                                        {chooseFrom.away.map((c) => (
                                                                            <option key={c.username} value={c.username}>
                                                                                {c.name}
                                                                            </option>
                                                                        ))}
                                                                    </optgroup>
                                                                )}
                                                            </select>
                                                            <button
                                                                className="izy-btn secondary small"
                                                                type="button"
                                                                disabled={busy || picked === ''}
                                                                onClick={() => { void takeProposed(run, i, picked); }}
                                                            >
                                                                Create run
                                                            </button>
                                                        </div>
                                                        {/* WHY THIS NAME, in one word. `cover`
                                                            is the one that matters: it means
                                                            nobody from that counter was left,
                                                            which is a thing to notice before
                                                            the wave goes out. */}
                                                        {hint !== null && picked === hint.username && (
                                                            <span className={`izy-muted izy-field-note${hint.why === 'cover' ? ' izy-stat-warn' : ''}`}>
                                                                {hint.why === 'home' ? 'drives this pharmacy'
                                                                    : hint.why === 'floater' ? 'no home pharmacy set'
                                                                        : 'covering another pharmacy'}
                                                            </span>
                                                        )}
                                                        {hint !== null && picked !== '' && picked !== hint.username && (
                                                            <span className="izy-muted izy-field-note">
                                                                changed from {hint.name}
                                                            </span>
                                                        )}
                                                    </td>
                                                </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    </>
                                )}
                                <Pager of={pagedProposal} noun="routes" />
                            </>
                        )}
                    </Section>

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
                    <div className="izy-lanes">
                    {pagedLanes.rows.map((lane) => (
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
                                <span className={`izy-pill ${lane.courier.onShift ? '' : 'muted'}`} title={lane.courier.lastSeenAt ?? 'never signed in'}>
                                    {/* The pill answers "is this person working", and the
                                        time answers "are they in touch". Separate, because
                                        a quiet phone is not a finished shift. */}
                                    {lane.courier.onShift
                                        ? (lane.courier.present ? 'on shift' : `on shift · ${seenLabel(lane.courier)}`)
                                        : `off shift · ${seenLabel(lane.courier)}`}
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

                            <LaneStops
                                lane={lane}
                                projectCode={code}
                                busy={busy}
                                onDragStart={setDragging}
                                unassign={unassign}
                            />
                        </section>
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
    laneOptions: Array<{ id: number; label: string }>;
    onDragStart: (id: number | null) => void;
    assign: (orderId: number, runId: number) => void | Promise<void>;
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
                                onChange={(e) => { if (e.target.value) void assign(o.id, Number(e.target.value)); }}
                            >
                                <option value="">Assign to...</option>
                                {laneOptions.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
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
