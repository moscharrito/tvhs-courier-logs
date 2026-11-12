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
 *   THE SHEET IS ACTIONS. Collect, open the stop, directions,
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
import { ShiftBar } from './ShiftBar';
import { Section } from '../../app/Section';
import { CardLink, Chip, Context, Panel, Screen, ScreenHeader, Sheet } from '../../app/Glass';
import { CalendarIcon, HistoryIcon } from '../../app/Icons';

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
    /** The offer letter's band, which is what this stop pays. NOT `zone`.
     *
     *  OPTIONAL, AND THAT IS NOT TIDINESS. A phone holds this screen's
     *  JavaScript in cache and a courier may be running yesterday's bundle
     *  against today's server, or today's against a payload from before
     *  these fields existed. Typed `| null` and read as if it could not be
     *  undefined, `.toFixed()` threw and took the whole run screen white --
     *  on the one screen somebody is standing in a car park looking at. */
    payZone?: number | null;
    /** One-way miles from the counter, so the band can be checked. */
    payMiles?: number | null;
    /** THE BAND THIS STOP IS PAID ON, which is what belongs on the chip.
     *
     *  Since 12 November it is the HIGHER of `payZone` and University
     *  Health's band, so the stops where UH's map runs long did not take a
     *  cut when the first measurement landed. Usually the same number as
     *  `payZone`; when it is not, `payHeld` is true and the miles beside it
     *  will not add up to the band on their own, so the chip says why.
     *
     *  Optional for the same cache reason as the two above. */
    paidZone?: number | null;
    /** True when `paidZone` is higher than the miles alone would give. */
    payHeld?: boolean;
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
    /* ─────────────────────── WHICH DAY'S ROUND IS ON SCREEN
     *
     * Null means today, and today is the SERVER'S, not this phone's. The
     * endpoint already defaults to todayIn(project.timezone) and tells us
     * in its answer which day that was, so asking for no day at all is the
     * only way to be sure a handset whose clock is an hour out, or which
     * has crossed into tomorrow UTC while it is still Tuesday in San
     * Antonio, sees the round it is actually driving. Reading a date off
     * the browser and sending that would introduce the bug this avoids.
     *
     * It stays null until the driver picks a day. That is the "fixates on
     * today" part: a refresh, a shift toggle, coming back to the tab in
     * the afternoon -- all of them land on today again, because nothing
     * ever quietly wrote a date into this.
     *
     * WHY A DRIVER NEEDS LAST TUESDAY AT ALL: a photograph of the signed
     * form that came out blurred is found later, and the stop it belongs
     * to is on the day it happened. Amending it is what this screen now
     * reaches (see Stop.tsx), and without a way back to that day there was
     * nothing to open. */
    const [day, setDay] = useState<string | null>(null);
    /* What the server called today, learned from the first unfiltered
       load. Null until then, which is why isToday below treats "not known
       yet" as today rather than as a different day. */
    const [today, setToday] = useState<string | null>(null);

    /* Declared before the early returns below, which is why it takes the
       stops off `data` defensively rather than off the list computed further
       down. The app's Run.tsx carries a long comment about the day this rule
       was learned the hard way: usePaged holds a page number in useState, it
       was called below three early returns, and the render after the run
       arrived ran one more hook than the render before it. React throws, the
       screen goes white, and it happens to every courier on every shift the
       moment their run loads. */
    /* FIVE HERE, EIGHT EVERYWHERE ELSE, asked for from a handset on
       1 November and right for a reason worth writing down.
       Eight is a page of a dispatcher's TABLE: eight rows of one line each,
       on a wide screen, read by somebody sitting down. A stop on this screen
       is a card -- name, address, due time, zone, and three controls -- and
       eight of them is a long scroll inside a sheet that is already sharing
       a 375px screen with the context above it. The courier's question is
       always "what are the next few", never "show me all forty", and the
       answer to the second one is a scroll they do with their thumb while
       holding a package. */
    const pagedStops = usePaged(data?.runs.flatMap((r) => r.stops) ?? [], 5);

    const load = useCallback(async () => {
        setError(null);
        try {
            const asked = day === null ? '' : `?serviceDate=${encodeURIComponent(day)}`;
            const got = await api<MineResponse>(`/api/projects/${code}/uh/runs/mine${asked}`);
            setData(got);
            /* Only from an unfiltered load: the answer to "what day is it"
               comes from the request that did not name one. */
            if (day === null) setToday(got.serviceDate);
        } catch (err) {
            // A courier is often somewhere with no signal. Say that plainly
            // rather than showing an empty run, which would read as "no work".
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch. Check your signal and try again.');
        }
    }, [code, day]);
    useEffect(() => { void load(); }, [load]);
    /* THE SHIFT CONTROL MOVED INTO THE TOP BAR, which the shell renders and
       which knows nothing about a run. What a courier may do changes the
       moment a shift opens, so this listens for the toggle rather than being
       handed a callback by it. */
    useEffect(() => {
        const again = () => { void load(); };
        window.addEventListener('izy:shift-changed', again);
        return () => { window.removeEventListener('izy:shift-changed', again); };
    }, [load]);

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
    /* Carrying it beats still at the counter, then sequence. The preference
       survives the collect gate going: a courier holding packages should
       deliver those before driving back for more. */
    const current = remaining.find((s) => s.status !== 'assigned') ?? remaining[0] ?? null;
    const done = stops.length - remaining.length;
    /* Defaults to the link-out. A server that has not been told about maps,
       which is every server until somebody sets UH_MAPS_EMBED, behaves the
       way it did before ticket 5.13. */
    const embed = data.directions?.embed === true;
    /* The day actually on screen is whatever the server answered with,
       never what was asked for: those agree, and if they ever stop
       agreeing the screen should say what it is showing. */
    const viewing = data.serviceDate;
    /* Unknown counts as today. The first load has not come back yet in
       that window, and the alternative -- treating it as "some other day"
       -- would flash the back-to-today banner on every cold start. */
    const isToday = today === null || viewing === today;
    /* ─── THE PICKER STANDS WHERE THE DATE USED TO BE PRINTED.
     *
     * The heading line read "Mo · 2026-11-03 · 19 of 20 done" with a
     * separate pill underneath holding the control. Two places saying
     * which day, one of them inert. The raw date is gone and the picker
     * is in its slot, so the line that tells a driver which day they are
     * looking at is the thing that changes it.
     *
     * The title no longer repeats it either. "Today" while it is today,
     * and "Earlier day" when it is not -- two words that say what kind of
     * day this is, with the picker beside them saying which. The date
     * itself is in one place on the screen now instead of three. */
    const subtitle = (
        <>
            {user?.name !== undefined && user.name !== '' && <>{user.name} · </>}
            <label className="izy-daypick">
                <CalendarIcon size={14} />
                <span className="izy-visually-hidden">Show the round for a day</span>
                <input
                    type="date"
                    value={viewing}
                    max={today ?? viewing}
                    onChange={(e) => setDay(e.target.value === '' ? null : e.target.value)}
                />
            </label>
            {' · '}{done} of {stops.length} done
            {!isToday && (
                <>
                    {' · '}
                    <button type="button" className="izy-linkish" onClick={() => setDay(null)}>Back to today</button>
                </>
            )}
        </>
    );

    return (
        <Screen>
            {/* ─────────────────────────────────────────────────────────────
                THE UPPER REGION. See the header: the rideshare map slot,
                holding status until there is something to draw.
                ───────────────────────────────────────────────────────────── */}
            <Context>
                {/* THE SHIFT CONTROL RIDES THE HEADING, right-hand side.
                    It spent an afternoon in the top bar beside Sign out,
                    which put it on every screen but also beside the one
                    button a courier must never hit by accident at the end of
                    a round. On the heading row it is next to the day it
                    belongs to, and the thing immediately under it is the
                    work the shift is for. */}
                {/* THE TITLE IS THE DAY. "Today" while on today, and the
                    date itself the moment it is not -- because every other
                    thing on this screen (the counts, the next stop, the
                    list) is about the day being looked at, and a heading
                    that said "Today" over last Tuesday's round would be the
                    single most misleading word on the page. */}
                <ScreenHeader
                    title={isToday ? 'Today' : 'Earlier day'}
                    subtitle={subtitle}
                    right={<ShiftBar code={code} />}
                />



                {/* NO PIN PROMPT HERE. It lived above the run between tickets
                    5.4 and this one, offering enrolment to anybody whose phone
                    was not set up. It is a setup task on a working screen: the
                    courier reading it is mid-round, it reappeared every day
                    until acted on, and the PIN is still discoverable from Your
                    account, which is where a setting belongs. University
                    Health drivers do not use a PIN at all. */}

                {/* THE NEXT STOP IS A TODAY IDEA. On a day that has gone
                    there is no "next": anything still open on it was missed,
                    not queued, and a card saying Next over it would send a
                    driver to a door they are not due at. The list below
                    still shows everything, which is what the day is being
                    opened for. */}
                {!isToday ? null : current !== null ? (
                    <Panel role="group" aria-label="Next stop" className="izy-next">
                        <h2 className="izy-lede-kicker">Next: stop {current.sequence}</h2>
                        <p className="izy-lede">{current.recipientName}</p>
                        {/* ONE LINE, NOT TWO. The <br /> cost a whole line
                            of the one region that has to hold the name, the
                            address and the chips above the fold on a 375px
                            phone -- and a driver reading "where next" reads
                            the street; the city is San Antonio on every stop
                            this contract has. It still wraps when it has to,
                            which is the same two lines as before and only
                            for the addresses that need them. */}
                        <p className="izy-lede-note">{current.address}, {current.city} {current.zip}</p>
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
                            {/* THE COURIER'S BAND, NOT UNIVERSITY HEALTH'S.
                                This chip showed `zone` -- the destination
                                ZIP's band on UH's bid table, which prices
                                their invoice and has nothing to do with
                                what the person reading it earns. A stop
                                fourteen road miles out said "zone 1",
                                which on their offer letter is 5.00, while
                                the letter bands it at 7.25. A driver
                                checked it against a map on 9 November.

                                The miles are on the chip because that is
                                what makes it checkable, and a band nobody
                                can check is how this went unnoticed since
                                go-live. */}
                            {/* `== null`, which catches undefined too: see the
                                note on the field. */}
                            {current.payZone == null
                                ? <Chip label={current.zone == null ? 'out of area' : 'zone not measured'} tone="warn" />
                                : <Chip label={payChip(current)} />}
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

                {/* NO "COLLECT FROM A PHARMACY". Drivers stopped recording
                    collections on 3 November -- the server writes the
                    custody event itself when a courier first acts on a
                    delivery -- so a card that opened a collection screen
                    was offering a step that no longer exists. The screen
                    and its endpoint went with it. */}

                {/* ───────────────── THE ROUND IS ON SCREEN ONCE IT IS ASSIGNED
                 *
                 * Until 3 November nothing below appeared until the pickup
                 * was recorded: the whole list was replaced by "Collect
                 * first", on the reasoning that showing names, addresses and
                 * deadlines for medication still behind a counter is a
                 * patient list on a screen for work that has not begun, and
                 * that custody is the line.
                 *
                 * What changed is who draws the line. That gate was built
                 * when the sweep assigned work on its own, so an unrecorded
                 * pickup was the only evidence a courier had not started.
                 * Dispatch now assigns every delivery by hand, to a named
                 * driver on shift at that pharmacy -- the assignment IS the
                 * decision the gate was standing in for, and the driver it
                 * was hiding the round from is the one person who was told
                 * to drive it.
                 *
                 * Removed on the drivers' own feedback. Collect from a
                 * pharmacy is still offered above, and is still the only way
                 * into the pickup screen; it no longer stands in front of
                 * the work. */}
                {/* NO "OPEN THE STOP", "DIRECTIONS" OR "DETAILS" HERE.
                    All three acted on the next stop, and all three are on
                    every row of All stops below -- including that same next
                    stop, which is row one. Three cards to reach what a link
                    eight lines down already reaches.

                    All stops opens by default, so the links are on screen
                    when a driver lands here. It does remember being folded,
                    which is the one case where this costs a tap: the section
                    header is still the first thing under the panel. */}

                {stops.length > 0 && (
                    /* THE ONLY THING ON THIS SCREEN THAT FOLDS. The next
                       stop is the work; folding it would hide the reason a
                       driver opened the page. The whole list is reference
                       once the next stop is on screen, and a driver who has
                       memorised their round should be able to put it away
                       and have it stay away. */
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
                                        {/* The courier's band here too, for the
                                            same reason as the panel above. */}
                                        {s.payZone == null
                                            ? (s.zone == null ? ' · out of area' : ' · zone not measured')
                                            : <> · zone {s.paidZone ?? s.payZone}{s.payHeld === true && ' (held higher)'}</>}
                                    </div>
                                    <div className="izy-run-stop-actions">
                                        <Directions code={code} orderId={s.orderId} embed={embed} className="izy-btn secondary" mapsUrl={mapsUrl(s)} />
                                        {/* A FINISHED STOP OPENS TOO, since
                                            4 November. It had no link at
                                            all, which is the same gate the
                                            app had and the same cost: a
                                            blurred photograph of the signed
                                            form, or a dry run where the
                                            patient rang the pharmacy back
                                            and the driver got there again
                                            an hour later, were both a
                                            telephone call to dispatch or
                                            went unrecorded.

                                            The row still reads as finished
                                            -- greyed, with its status chip
                                            -- and the stop screen opens on
                                            what the record says rather than
                                            on the delivery form. The label
                                            says which of the two it is, so
                                            nobody taps "Open the stop" on a
                                            delivered row expecting to
                                            record one. */}
                                        <Link className="izy-btn secondary" to={`/projects/${code}/orders/${s.orderId}/stop`}>
                                            {DONE.includes(s.status) ? 'Open the record' : 'Open the stop'}
                                        </Link>
                                        <Link className="izy-btn secondary" to={`/projects/${code}/orders/${s.orderId}`}>Details</Link>
                                    </div>
                                </li>
                            ))}
                        </ol>
                        <Pager of={pagedStops} noun="stops" />
                    </Section>
                )}

                {/* TAKE BACK UNDELIVERED AND SOMETHING DID NOT MATCH ARE NOT
                    HERE ANY MORE. Today is the stops; these two are the
                    once-a-day jobs and they were competing with the work.
                    Take back now sits under the earnings on My deliveries,
                    which is the screen a courier opens at the end of a round
                    with packages still in the van; the discrepancy form sits
                    on You, with the other things that are about them rather
                    than about a stop. Both routes are unchanged. */}
                {/* Their own record: what they have delivered by day, month
                    and year, and what it comes to.

                    HIDDEN WHERE THE TAB BAR EXISTS, which is the whole of
                    the phone. This is the History tab’s destination exactly,
                    so on a phone it was the same door twice on one screen.
                    It is NOT deleted, because the tab bar only appears below
                    901px: on a desktop there is no History tab and this card
                    is the only way to reach the page. The breakpoint here is
                    the tab bar’s own, and the two have to stay in step. */}
                <div className="izy-only-no-tabbar">
                    <CardLink
                        to={`/projects/${code}/my-deliveries`}
                        title="My deliveries"
                        Icon={HistoryIcon}
                        tone="quiet"
                        compact
                        detail="Everything you have finished"
                    />
                </div>
                {/* NO REFRESH BUTTON. It was here because the app pulls
                    down and a browser has no gesture to borrow -- but a
                    browser has a reload, every screen already re-reads when
                    a shift changes or a stop is recorded, and a button whose
                    whole job is “try that again” teaches a courier that the
                    screen cannot be trusted without it. */}
            </Sheet>
        </Screen>
    );
}

/**
 * WHAT THE COURIER IS PAID FOR THIS STOP, on the chip they can check.
 *
 * `paidZone` and not `payZone`: the first is the band the money is worked
 * out on, the second is what the measured distance bands to, and since
 * 12 November they differ on the stops where University Health's map runs
 * longer than the road does. Those stops keep the higher band rather than
 * taking a cut, so the chip has to show the one that is paid.
 *
 * FALLING BACK TO `payZone` IS DELIBERATE. A phone holds this bundle in
 * cache; one running against a server that predates `paidZone` would
 * otherwise show no band at all on the one screen somebody is reading in a
 * car park. The old field is the right answer on an old payload.
 *
 * AND IT SAYS "HELD HIGHER" WHEN THE MILES DO NOT ADD UP TO THE BAND, which
 * they will not on a held stop -- 8.7 miles beside "zone 3" reads like the
 * system is wrong about their work, which is the exact complaint that began
 * all of this, pointing the other way. Saying so turns it into a number in
 * their favour that they can see.
 */
function payChip(s: { payZone?: number | null; payMiles?: number | null; paidZone?: number | null; payHeld?: boolean }): string {
    const band = s.paidZone ?? s.payZone;
    const miles = s.payMiles == null ? '' : ` · ${s.payMiles.toFixed(1)} mi`;
    return `zone ${band}${miles}${s.payHeld === true ? ' · held higher' : ''}`;
}

/** How long this stop has, in the words the orders list uses. */
function SlaChip({ sla }: { sla: Sla }) {
    const label = slaLabel(sla);
    if (!label.text) return null;
    const tone = label.tone === 'off' ? 'bad' : label.tone === 'ok' ? 'good' : label.tone === 'warn' ? 'warn' : 'neutral';
    return <Chip label={label.text} tone={tone} />;
}
