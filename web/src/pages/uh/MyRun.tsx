/* Today's run, on a courier's phone — in the browser, in the app's shape.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN WAS REBUILT, AND WHAT AGAINST.
 *
 * Every University Health driver works in the BROWSER for the first month
 * and only then moves to the phone app. Both existed, both worked, and they
 * were different products. app/src/screens/Run.tsx is a rideshare shape:
 * what is happening in the upper region, everything you can DO in a sheet at
 * the bottom where a thumb reaches without the hand moving, and every action
 * a card with a glyph, a verb and a sentence under it. This screen was a
 * console page — a 26px heading, a stack of bordered boxes, and a row of
 * small grey buttons at the end of it.
 *
 * So this is now that file, in HTML. Same regions, same order, same words,
 * same 64px on anything that records custody. A courier who learns this in
 * November and installs the app in December has nothing to relearn.
 *
 * WHAT MOVED, and it is worth being precise because the tests pinned some of
 * it to the old arrangement:
 *
 *   THE UPPER REGION IS INFORMATION. Where they are up to, what is next, how
 *   long it has. In a rideshare app this region is the map; there is nothing
 *   to draw here, because no order in this system has coordinates and
 *   getting them means sending a patient's address to a map provider, which
 *   ticket 1.4 refused until a BAA covers it. It is full size anyway, so a
 *   map drops in later rather than forcing a redesign.
 *
 *   THE SHEET IS ACTIONS. Collect, open the stop, directions, ring dispatch,
 *   the whole list, and the three things done once a day. Directions and
 *   "Open the stop" used to sit inside the next-stop card; they are controls,
 *   so they are in the sheet with the other controls, grouped and named
 *   "This stop".
 *
 * WHAT DID NOT CHANGE, because neither has anything to do with layout:
 *
 *   THE MAP CARRIES THE ADDRESS ONLY, never the patient's name. An address
 *   is what it takes to drive there; the name adds nothing to the navigation
 *   and everything to the disclosure. That holds whether the address goes
 *   out in a link the courier taps or into a frame this page draws, and
 *   which of those happens is decided on the server — see
 *   server/src/modules/uh/directions.ts, which keeps the in-app map behind
 *   its own switch because embedding makes US the sender of a patient's
 *   address to a vendor with no BAA.
 *
 *   NOTHING OF THE ROUND UNTIL IT IS COLLECTED. The long note further down
 *   still stands, and the app enforces the same rule in the same words.
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
import { CardAnchor, CardButton, CardLink, Chip, Context, Panel, Screen, ScreenHeader, Sheet } from '../../app/Glass';
import { BoxIcon, FlagIcon, HistoryIcon, NavigateIcon, PhoneIcon, PinIcon, ReturnIcon } from '../../app/Icons';

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
       down. The app's Run.tsx carries a long comment about the day this rule
       was learned the hard way: usePaged holds a page number in useState, it
       was called below three early returns, and the render after the run
       arrived ran one more hook than the render before it. React throws, the
       screen goes white, and it happens to every courier on every shift the
       moment their run loads. */
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
    const collectFirst = toCollect.length > 0;
    /* A courier with two runs in a day collects against each of them. */
    const waiting = data.runs.filter((r) => r.stops.some((s) => s.status === 'assigned'));
    /* Stripped so the phone's dialler accepts it. */
    const dial = data.dispatch.phone.replace(/[^0-9+]/g, '');
    const subtitle = [user?.name, data.serviceDate, `${done} of ${stops.length} done`]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');

    return (
        <Screen>
            {/* ─────────────────────────────────────────────────────────────
                THE UPPER REGION. See the header: the rideshare map slot,
                holding status until there is something to draw.
                ───────────────────────────────────────────────────────────── */}
            <Context>
                {/* FIRST, ABOVE EVERYTHING, because it gates the day. Dispatch
                    cannot assign to a courier who is not on shift, and the
                    escalation for unclaimed work looks for somebody who is —
                    so a driver who never finds this control is a driver the
                    board cannot use. The app keeps it above the tabs for the
                    same reason: there is no state in which it is empty. */}
                <ShiftBar code={code} onChanged={() => { void load(); }} />

                <ScreenHeader title="Today" subtitle={subtitle} />

                {/* NO PIN PROMPT HERE. It lived above the run between tickets
                    5.4 and this one, offering enrolment to anybody whose phone
                    was not set up. It is a setup task on a working screen: the
                    courier reading it is mid-round, it reappeared every day
                    until acted on, and the PIN is still discoverable from Your
                    account, which is where a setting belongs. University
                    Health drivers do not use a PIN at all. */}

                {collectFirst ? (
                    <Panel>
                        <h2 className="izy-lede-kicker">Collect first</h2>
                        <p className="izy-lede">
                            {toCollect.length} {toCollect.length === 1 ? 'order is' : 'orders are'} still at the pharmacy
                        </p>
                        {/* WHERE THEY ARE GOING IS NOT SHOWN UNTIL THEY HAVE
                            THE PACKAGES. The addresses, the names and the
                            deadlines all appear once the pickup is recorded. */}
                        <p className="izy-lede-note">
                            You cannot deliver what you have not taken custody of. Your stops appear
                            once you have recorded the pickup.
                        </p>
                    </Panel>
                ) : current !== null ? (
                    <Panel role="group" aria-label="Next stop">
                        <h2 className="izy-lede-kicker">Next: stop {current.sequence}</h2>
                        <p className="izy-lede">{current.recipientName}</p>
                        <p className="izy-lede-note">{current.address}<br />{current.city} {current.zip}</p>
                        {/* FOUR, and the pharmacy's reference is deliberately
                            not one of them. Every chip costs a line of a
                            region that has to hold the name, the address and
                            the deadline on a 375px screen — five of them
                            wrapped to three rows and pushed the panel past
                            the bottom of the region. The reference is
                            reference: it is on the row in the list below and
                            on the stop itself, and nobody drives to it. */}
                        <div className="izy-chips">
                            <Chip label={current.serviceType.toUpperCase()} />
                            <SlaChip sla={current.sla} />
                            {current.dueAt !== null && <Chip label={`due ${clock(current.dueAt)}`} />}
                            {current.zone === null
                                ? <Chip label="out of area" tone="warn" />
                                : <Chip label={`zone ${current.zone}`} />}
                        </div>
                    </Panel>
                ) : stops.length === 0 ? (
                    <Panel><p className="izy-lede-note">No stops assigned to you today.</p></Panel>
                ) : null}
            </Context>

            {/* ─────────────────────────────────────────────────────────────
                THE SHEET. Everything a courier can DO, under the thumb, in
                the half of the screen a hand already covers.
                ───────────────────────────────────────────────────────────── */}
            <Sheet>
                {error !== null && <div className="izy-alert warn" role="status">{error}</div>}

                {/* The run id used to be the label on this: "Pick up for run
                    10". A driver has no idea what run 10 is, and does not need
                    to — what they need is the pharmacy and how much is there.
                    The wave's name only appears when there are two of them to
                    tell apart. */}
                {waiting.map((r) => {
                    const count = r.stops.filter((s) => s.status === 'assigned').length;
                    return (
                        <CardLink
                            key={r.id}
                            to={`/projects/${code}/runs/${r.id}/pickup`}
                            title="Collect from a pharmacy"
                            Icon={BoxIcon}
                            tone="primary"
                            detail={`${count} ${count === 1 ? 'order is' : 'orders are'} waiting to be picked up`
                                + (waiting.length > 1 ? ` · ${r.label}` : '')}
                        />
                    );
                })}

                {/* ─────────────────────── NOTHING BELOW UNTIL IT IS COLLECTED
                 *
                 * The round used to be on screen from the moment dispatch
                 * assigned it: every name, every address, every deadline,
                 * while the medication was still behind the counter. Two
                 * reasons that is wrong, and the second is the one that
                 * matters.
                 *
                 * It invites the round to start in the wrong order. A courier
                 * reading "next: 4 Hickory, due 13:15" before they have been
                 * to the pharmacy is being shown a destination they cannot
                 * serve.
                 *
                 * And it is a patient list on a screen, for work that has not
                 * begun. A phone open at a counter, a browser on a shared
                 * machine — the names and addresses of people expecting
                 * medication, belonging to a round the courier is not yet
                 * carrying. Custody is the line: once they have signed for
                 * the packages the round is theirs and they need every detail
                 * of it. Before that they need one instruction, which is to
                 * go and collect.
                 *
                 * Deliberately ALL or nothing, not "hide the uncollected
                 * ones". A partial list is the same disclosure made quieter,
                 * and a courier part-way through a pickup should be finishing
                 * it. */}
                {!collectFirst && current !== null && (
                    <div role="group" aria-label="This stop">
                        <CardLink
                            to={`/projects/${code}/orders/${current.orderId}/stop`}
                            title="Open the stop"
                            Icon={PinIcon}
                            tone="primary"
                            detail={`Stop ${current.sequence} for ${current.recipientName}`}
                        />
                        <Directions
                            code={code}
                            orderId={current.orderId}
                            embed={embed}
                            className="izy-card-btn is-quiet"
                            mapsUrl={mapsUrl(current)}
                            Icon={NavigateIcon}
                            detail="Opens your own maps app with the address only"
                        />
                        {/* The stop is the work. Details is for looking
                            something up, so it is the quiet, short one. */}
                        <CardLink
                            to={`/projects/${code}/orders/${current.orderId}`}
                            title="Details"
                            tone="quiet"
                            compact
                            detail="Everything recorded against this delivery"
                        />
                    </div>
                )}

                {/* THE NUMBER IS WRITTEN OUT, NOT ONLY LINKED.
                 *
                 * `tel:` is a tap on a phone and nothing at all in a desktop
                 * browser: the button is there, you click it, and the page
                 * sits where it was. Drivers work in the browser for the
                 * first month and some of them will be at a laptop, so the
                 * one piece of information on this control — the number —
                 * has to be readable rather than only dialable. It is also
                 * the number somebody writes on their hand before the phone
                 * dies.
                 *
                 * The button, or nothing at all. The missing branch used to
                 * explain the absence — "an administrator adds one in the
                 * project's operating settings" — which is an instruction
                 * addressed to somebody who is not holding this phone, on
                 * the screen a driver works from. The absence is now silent
                 * here and loud where it can be acted on: set-dispatch.mjs
                 * prints it, and the operating settings screen says it. */}
                {dial !== '' && (
                    <CardAnchor
                        href={`tel:${dial}`}
                        title={`Call ${data.dispatch.name}`}
                        Icon={PhoneIcon}
                        tone="quiet"
                        detail={data.dispatch.phone}
                    />
                )}

                {!collectFirst && stops.length > 0 && (
                    /* THE ONLY THING ON THIS SCREEN THAT FOLDS.
                       Collect-first is a blocker and the next stop is the
                       work; folding either would hide the reason a driver
                       opened the page. The whole list is reference once the
                       next stop is on screen, and a driver who has memorised
                       their round should be able to put it away and have it
                       stay away. */
                    <Section
                        id="myrun-all-stops"
                        title="All stops"
                        summary={`${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}${done > 0 ? `, ${done} done` : ''}`}
                    >
                        <ol className="izy-run-stops">
                            {pagedStops.rows.map((s) => (
                                <li key={s.orderId} className={DONE.includes(s.status) ? 'is-done' : undefined}>
                                    <div className="izy-row-between">
                                        {/* The sequence stays inside its own
                                            element: a bare "1. " text node
                                            beside the name would make the
                                            row's text "1. Ines Vargas", and
                                            the name is what anybody — a test
                                            or a screen reader hunting for a
                                            person — looks for. */}
                                        <span className="izy-run-stop-name"><b>{s.sequence}.</b> {s.recipientName}</span>
                                        {DONE.includes(s.status)
                                            ? <Chip label={s.status} />
                                            : <SlaChip sla={s.sla} />}
                                    </div>
                                    <div className="izy-run-stop-meta">{s.address}, {s.city} {s.zip}</div>
                                    <div className="izy-run-stop-meta">
                                        due {clock(s.dueAt)}
                                        {/* The chip above already carries the
                                            status on a finished stop. */}
                                        {!DONE.includes(s.status) && <> · {s.status}</>}
                                        {s.zone === null ? ' · out of area' : ` · zone ${s.zone}`}
                                    </div>
                                    <div className="izy-run-stop-actions">
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
                )}

                {/* The three things done once a day rather than once a stop,
                    compact so they read as routine beside the cards above. */}
                {/* Always offered, not only when today's run has a failure on
                    it: a package can sit in a van overnight, and a screen
                    that hides the way to hand it back is how it stays there. */}
                <CardLink
                    to={`/projects/${code}/returns`}
                    title="Take back undelivered"
                    Icon={ReturnIcon}
                    tone="quiet"
                    compact
                    detail="To the pharmacy it came from"
                />
                {/* The shadow week only works if the people at the door can
                    file what they see (ticket 5.2). This is their only
                    screen. */}
                <CardLink
                    to={`/projects/${code}/discrepancies`}
                    title="Something did not match"
                    Icon={FlagIcon}
                    tone="quiet"
                    compact
                    detail="Wrong name, wrong count, nobody in"
                />
                {/* Their own record: what they have delivered by day, month
                    and year, and what it comes to. It is also the History
                    tab, and it stays here because at desktop width there is
                    no tab bar. */}
                <CardLink
                    to={`/projects/${code}/my-deliveries`}
                    title="My deliveries"
                    Icon={HistoryIcon}
                    tone="quiet"
                    compact
                    detail="Everything you have finished"
                />
                {/* The app pulls down to refresh. A browser has no such
                    gesture to borrow, so it is a control. */}
                <CardButton
                    title="Refresh"
                    tone="quiet"
                    compact
                    onClick={() => { void load(); }}
                    detail="Ask dispatch for the latest"
                />
            </Sheet>
        </Screen>
    );
}

/** How long this stop has, in the words the orders list uses. */
function SlaChip({ sla }: { sla: Sla }) {
    const label = slaLabel(sla);
    if (!label.text) return null;
    const tone = label.tone === 'off' ? 'bad' : label.tone === 'ok' ? 'good' : label.tone === 'warn' ? 'warn' : 'neutral';
    return <Chip label={label.text} tone={tone} />;
}
