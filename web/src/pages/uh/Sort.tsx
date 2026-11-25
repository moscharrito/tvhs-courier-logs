/* Which van does this package go in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE JOB, WHICH IS DONE STANDING UP WITH A PARCEL IN ONE HAND.
 *
 * Packages come off the pharmacy counter in a heap, each with our own
 * waybill taped to it. Somebody has to put each one in the right driver's
 * pile. Until the app clustered the day, that was done by reading the
 * address and remembering who covers that part of the city. Since
 * 21 November the rounds are built nearest-neighbour by the clusterer and
 * nobody can hold them in their head, so the sheet no longer tells you
 * whose it is.
 *
 * Point the camera at the patient's telephone number. Get back a name.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERYTHING ABOUT THIS PAGE IS SHAPED BY WHERE IT IS USED.
 *
 * One hand, bad light, a phone held at arm's length over a trolley. So:
 * the viewfinder is as large as the screen allows and sits in the middle,
 * the answer is in type you can read without bringing the phone closer.
 * No menus, no settings, no history.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND FROM 25 NOVEMBER, NOTHING TO PRESS AT ALL.
 *
 * There was a Scan button. It was the only control on the page and it
 * still cost a hand: the sorter is holding a parcel against a sheet with
 * the phone balanced in the other hand, and the press is what makes the
 * picture move at the moment it needs to be still. Worse, a press is a
 * single shot -- a frame that happened to be blurred was a failure the
 * sorter had to notice and repeat.
 *
 * So the page reads continuously. Hold the panel in the box and the
 * answer arrives; a blurred frame is simply the one before the next one.
 * Reading stops the moment there is something on screen to act on, and
 * starts again on Clear, because a page that kept scanning would read
 * the next sheet over the answer the sorter is still looking at.
 *
 * WHAT THAT COSTS, SAID PLAINLY. It is the camera and a megabyte of
 * WebAssembly working the whole time the page is open rather than for a
 * second per press, which is warm in the hand and real on a battery. It
 * is the right trade for a bench phone on a charger doing one job, and
 * the wrong one for a page left open all day -- which is why the loop
 * stops dead on a result and does not poll behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PICTURE NEVER LEAVES THE HANDSET.
 *
 * Reading is done in the browser. The frame is drawn to a canvas, read,
 * and dropped; what goes to the server is ten digits in the body of a
 * POST. No image is uploaded, which is the difference between this and
 * the obvious build -- send the photograph to a cloud reader -- because
 * the photograph is of a sheet carrying a patient's name, address and
 * medication, and the agreement signed on 20 November covers an address
 * lookup, not a document reader.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REMEMBERS NOTHING. No scan history, no counts, no last result. Close
 * the page and it is as if nobody had looked. That is what was asked for
 * and it is also the right answer: a log of who asked about which patient,
 * accumulated at a counter all day, would be a second contact register
 * that somebody would then have to look after.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, why } from '../../lib/api';
import { cameraAdvice } from '../../lib/browser';
import { findPhones } from '../../lib/phone-scan';
import { readDigits, scanSupported } from '../../lib/read-sheet';

interface Match {
    orderId: number;
    reference: string;
    patient: string;
    serviceDate: string;
    pharmacy: string;
    serviceType: string;
    status: string;
    handling: string[];
    driver: { username: string; name: string; run: string; stop: number | null } | null;
}

/**
 * Between one read and the next.
 *
 * A read is most of a second on a bench handset, so this is not the rate
 * -- it is the breathing room that keeps the main thread free enough for
 * the viewfinder to stay smooth while the worker chews. Long enough to
 * matter, short enough that a sorter holding a sheet steady never waits
 * for it on purpose.
 */
const GAP = 350;

/**
 * How many of the numbers on a panel get looked up.
 *
 * The route takes one at a time, so this is round trips on warehouse
 * wifi with a sorter stood waiting. Two is the real case -- a mobile and
 * a landline -- and three is the headroom for a reader that found an
 * extra. Beyond that the read was bad and more requests will not save
 * it. findPhones ranks the labelled ones first, so the cap cuts the
 * least likely.
 */
const MOST_NUMBERS = 3;

const pause = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/** 210-555-0147 out of 2105550147, for reading back off a screen. */
const pretty = (d: string): string => (d.length === 10
    ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
    : d);

export function Sort({ projectCode }: { projectCode: string }) {
    const video = useRef<HTMLVideoElement | null>(null);
    const stream = useRef<MediaStream | null>(null);

    const [live, setLive] = useState(false);
    const [busy, setBusy] = useState<'' | 'camera' | 'looking'>('');
    const [err, setErr] = useState('');
    /** More than one number on the sheet survived. The sorter picks. */
    /** Every number the sheet gave up, in the order they were asked. */
    const [asked, setAsked] = useState<string[]>([]);
    const [matches, setMatches] = useState<Match[] | null>(null);
    /** Deliveries with this number that are NOT on today's or tomorrow's
     *  list. Only ever filled when `matches` came back empty. */
    const [elsewhere, setElsewhere] = useState<Match[]>([]);
    /** A read came back with no number in it. Guidance, never an error. */
    const [missed, setMissed] = useState(false);

    /* THE CAMERA IS STOPPED WHEN THE PAGE GOES, and only then. There is
       no Stop button: this page is the camera, and a control whose whole
       effect is to make the one thing on the screen stop working is a
       control that only gets pressed by accident.

       The cleanup still matters. A track left running holds the hardware,
       and on Android the next app to want it gets nothing -- a sorter who
       leaves this page and then cannot take a photograph has been handed
       a worse problem than the one this solves. */
    const stop = useCallback(() => {
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = null;
        setLive(false);
    }, []);
    useEffect(() => stop, [stop]);

    const start = useCallback(async () => {
        setErr('');
        setBusy('camera');
        try {
            /* The back camera, because the sheet is on the bench and not
               in front of the sorter's face. `ideal` rather than `exact`:
               a tablet or a laptop at the counter has one camera and
               `exact` would refuse rather than use it. */
            const got = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
                audio: false,
            });
            stream.current = got;
            if (video.current) {
                video.current.srcObject = got;
                await video.current.play().catch(() => { /* autoplay, not fatal */ });
            }
            setLive(true);
        } catch (e) {
            /* cameraAdvice knows the one that catches people out: on an
               iPhone the camera is Safari's and nobody else's. */
            const advice = cameraAdvice();
            setErr(`${why(e, 'The camera would not start.')}${advice ? ` ${advice}` : ''}`);
        } finally {
            setBusy('');
        }
    }, []);

    /* IT STARTS ITSELF. The page has one purpose and the first thing
       anybody did on it was press Start, so the press was ceremony. The
       browser still asks for permission the first time, which is the
       prompt that actually matters and is not ours to skip. */
    useEffect(() => { void start(); }, [start]);

    /**
     * Look up every number the sheet offered, and show what comes back.
     *
     * ─────────────────────────────────────────────────────────────────
     * IT USED TO ASK, AND ASKING WAS THE WRONG SHAPE OF SAFE.
     *
     * Two numbers on a panel put a screen in the way: "which one is the
     * patient's?", two buttons, a tap. The reasoning was that guessing
     * between them could put a package in the wrong van. It could -- but
     * a sorter who has just been handed the question cannot answer it
     * either. They are holding a parcel, not the patient's file; the
     * mobile and the landline on that panel look exactly alike to them,
     * so the tap was a coin toss wearing a confirmation's clothes.
     *
     * So nothing is chosen. Every candidate is looked up and every
     * delivery that comes back is shown, each on its own card with the
     * patient named on it. The sorter reads the name against the sheet
     * in their other hand, which is a check they can actually make.
     *
     * THE SAFETY PROPERTY IS UNCHANGED and this is the part worth being
     * precise about: the page still never picks. It went from picking
     * for them badly to not picking at all.
     *
     * ── DEDUPED BY ORDER. Both numbers usually belong to one patient,
     * so both lookups return the same delivery. Two identical cards
     * would read as two packages.
     *
     * ── ONE REQUEST EACH, IN PARALLEL, CAPPED. The route takes one
     * number; four candidates would be four round trips on warehouse
     * wifi with a sorter stood waiting. findPhones ranks the labelled
     * ones first, so the cap takes from the good end.
     */
    const look = useCallback(async (numbers: string[]) => {
        const wanted = numbers.slice(0, MOST_NUMBERS);
        setBusy('looking');
        setErr('');
        setMatches(null);
        setElsewhere([]);
        setAsked(wanted);
        try {
            /* A POST, and the number is in the BODY. A telephone number
               identifies a patient, and a patient's identifier in a URL
               reaches browser history, proxies and every log that keeps a
               request line. See modules/uh/search.ts on the server. */
            const got = await Promise.all(wanted.map((phone) => api<{
                matches: Match[]; elsewhere?: Match[];
            }>(
                `/api/projects/${projectCode}/uh/sort/lookup`,
                { method: 'POST', json: { phone } },
            )));
            const byOrder = new Map<number, Match>();
            for (const one of got) for (const m of one.matches) byOrder.set(m.orderId, m);
            setMatches([...byOrder.values()]);
            /* ONLY WHEN TODAY HAS NOTHING, which is also the only time the
               server fills it. Two numbers can disagree -- the mobile on
               today's list and the landline on last week's -- and in that
               case the one in the pile wins and the other is noise.
               `?? []` because a browser holding a cached bundle can
               outlive the server that grew this field. */
            setElsewhere(byOrder.size > 0 ? [] : (() => {
                const past = new Map<number, Match>();
                for (const one of got) for (const m of one.elsewhere ?? []) past.set(m.orderId, m);
                return [...past.values()];
            })());
        } catch (e) {
            setErr(why(e, 'That number could not be looked up.'));
        } finally {
            setBusy('');
        }
    }, [projectCode]);

    /* THERE IS SOMETHING ON SCREEN TO ACT ON, so reading stops. Without
       this the next sheet on the bench would be read over the answer the
       sorter is still reading, and the page would be a slot machine. */
    const settled = matches !== null;

    /* ─────────────────────────── THE READING LOOP.
     *
     * One read at a time, never overlapping: the worker is single and a
     * second call would queue behind the first anyway, so firing on a
     * timer rather than awaiting would only build a backlog that keeps
     * answering with frames from ten seconds ago.
     *
     * `cancelled` rather than clearing a timer, because the await in the
     * middle can outlive the effect -- a sorter who navigates away mid
     * read must not come back to a setState on a dead component, and a
     * lookup must not fire for a page nobody is on.
     */
    useEffect(() => {
        if (!live || settled || err !== '' || !scanSupported()) return undefined;
        let cancelled = false;

        const run = async () => {
            while (!cancelled) {
                const el = video.current;
                /* The camera is attached but has not painted yet. Waiting
                   is the whole remedy; it is not worth a word on screen. */
                if (!el || el.videoWidth === 0) {
                    await pause(GAP);
                    continue;
                }
                try {
                    const text = await readDigits(el);
                    if (cancelled) return;
                    const found = findPhones(text);
                    /* ANY NUMBER AT ALL GOES STRAIGHT THROUGH, however
                       many there were. See look() for why two numbers
                       are no longer a question put to the sorter. */
                    if (found.length > 0) { await look(found.map((c) => c.digits)); return; }
                    setMissed(true);
                } catch (e) {
                    if (cancelled) return;
                    /* A READER THAT WILL NOT START DOES NOT GET TRIED
                       SIXTY TIMES A MINUTE. This is the blocked worker,
                       the missing core, the browser without WebAssembly:
                       none of them get better by being asked again, and
                       the loop would bury the handset. It is reported
                       once and the loop ends. */
                    setErr(why(e, 'The reader could not start.'));
                    return;
                }
                await pause(GAP);
            }
        };

        void run();
        return () => { cancelled = true; };
    }, [live, settled, err, look]);

    const clear = () => {
        setMatches(null); setElsewhere([]); setAsked([]); setErr(''); setMissed(false);
    };

    return (
        <div className="izy-sort">
            <header className="izy-sort-head">
                <h1>Sort a package</h1>
                <p className="izy-muted">
                    Hold the RECIPIENT panel in the green box. It reads by itself. Nothing is saved.
                </p>
            </header>

            {err !== '' && <div className="izy-alert error" role="alert">{err}</div>}

            {/* ── THE VIEWFINDER, which is most of the screen on purpose. */}
            <div className="izy-sort-view">
                <video
                    ref={video}
                    playsInline
                    muted
                    autoPlay
                    aria-label="Camera"
                    style={{ display: live ? 'block' : 'none' }}
                />
                {!live && (
                    <div className="izy-sort-off">
                        <p>Camera off</p>
                    </div>
                )}
                {/* The guide. A sorter who fills this with the RECIPIENT box
                    gives the reader a handful of characters instead of a
                    page of them, which is the difference between an answer
                    in under a second and a wrong one. It also keeps our own
                    number, printed large at the top of every sheet, out of
                    the frame entirely. */}
                {live && <div className="izy-sort-guide" aria-hidden="true" />}
            </div>

            {/* ── WHAT IT IS DOING, AND NOTHING TO PRESS.

                A page that reads by itself has to say so, or a sorter
                holding a sheet perfectly still in front of a silent
                screen concludes it is broken and goes looking for the
                button that is no longer there. This line is the whole
                of the feedback and it is never an alert: a read that
                found nothing is the ordinary state between two sheets,
                not a fault, and an error that flashes four times a
                second teaches people to ignore errors. */}
            <div className="izy-sort-do">
                {live ? (
                    <p className="izy-sort-state" role="status">
                        {busy === 'looking'
                            ? 'Looking that number up…'
                            : settled
                                ? 'Press Clear for the next package.'
                                : missed
                                    ? 'Fill the green box with the RECIPIENT panel, hold the sheet '
                                        + 'flat, and keep it still.'
                                    : 'Reading…'}
                    </p>
                ) : (
                    /* Only when there is no camera to read with -- a refused
                       permission, or another app holding it. Not a Start
                       button in the ordinary case: the page starts itself. */
                    <button
                        type="button"
                        className="izy-btn big"
                        disabled={busy !== ''}
                        onClick={() => { void start(); }}
                    >
                        {busy === 'camera' ? 'Starting…' : 'Try the camera again'}
                    </button>
                )}
            </div>

            {!scanSupported() && (
                <p className="izy-muted izy-sort-note">
                    This browser cannot run the reader. Open the page in Chrome on the bench phone.
                </p>
            )}

            {matches !== null && (
                <div className="izy-sort-out">
                    <div className="izy-sort-asked">
                        {/* EVERY NUMBER THAT WAS ASKED, not the one that
                            answered. A sorter checking a surprising
                            result needs to see what the camera took off
                            the sheet, and a panel with two numbers on it
                            is now two lookups behind one answer. */}
                        <span className="izy-muted">
                            {asked.length === 1 ? 'Looked up' : 'Looked up both'}
                        </span>
                        {' '}{asked.map(pretty).join(' · ')}
                        <button type="button" className="izy-btn secondary small" onClick={clear}>Clear</button>
                    </div>

                    {/* ── NOTHING TODAY, AND WHETHER WE KNOW THE NUMBER AT
                        ALL. One sentence used to cover both, and they are
                        different problems: a number nobody has ever sent
                        us is a bad read or the wrong package, and a
                        delivery that went out last Tuesday is a sorter
                        holding a sheet in front of a screen pretending
                        not to recognise it. */}
                    {matches.length === 0 && elsewhere.length === 0 && (
                        <p className="izy-alert warn" role="status">
                            No delivery with {asked.length === 1 ? 'that number' : 'either number'} is
                            on today’s or tomorrow’s list, and we have none on any other day
                            either. Check the digits against the sheet.
                        </p>
                    )}

                    {matches.length === 0 && elsewhere.length > 0 && (
                        <p className="izy-alert warn" role="status">
                            Not on today’s or tomorrow’s list. {elsewhere.length === 1
                                ? 'There is one delivery'
                                : `There are ${elsewhere.length} deliveries`} with
                            {' '}{asked.length === 1 ? 'that number' : 'one of those numbers'} on
                            another day, below. Do not put this package in a pile on
                            {' '}{elsewhere.length === 1 ? 'its' : 'their'} account.
                        </p>
                    )}

                    {matches.map((m) => <Found key={m.orderId} m={m} />)}
                    {elsewhere.map((m) => <Found key={m.orderId} m={m} otherDay />)}
                </div>
            )}
        </div>
    );
}

/**
 * One delivery that matched, as the bench reads it.
 *
 * `otherDay` is the same card for a delivery that is NOT on today's or
 * tomorrow's list. It says so on its face rather than relying on the
 * sentence above it, because the two lists are drawn one after the other
 * and the only thing standing between a sorter and putting last
 * Tuesday's package in today's pile is knowing which they are looking
 * at. The driver's name is deliberately not the big type on it: on this
 * card the date is the thing that matters.
 */
function Found({ m, otherDay = false }: { m: Match; otherDay?: boolean }) {
    return (
        <article className={`izy-sort-card${otherDay ? ' is-other-day' : ''}`}>
            {otherDay && (
                <p className="izy-sort-when">
                    <span className="izy-pill warn">another day</span>
                    {' '}{m.serviceDate}
                </p>
            )}
            {/* THE ANSWER, IN THE BIGGEST TYPE ON THE PAGE. It
                is read at arm's length over a trolley. */}
            {m.driver ? (
                <strong className="izy-sort-driver">{m.driver.name}</strong>
            ) : (
                <strong className="izy-sort-driver none">Not assigned yet</strong>
            )}
            {m.driver && m.driver.stop !== null && (
                <span className="izy-muted">
                    {m.driver.run} · stop {m.driver.stop}
                </span>
            )}
            {!m.driver && !otherDay && (
                <span className="izy-muted">
                    Nobody is carrying this one. Leave it out of the piles and tell dispatch.
                </span>
            )}
            {/* Enough to be sure it is the package in hand.
                The patient is named because a four-digit
                match is not unique and the sheet in the
                sorter's other hand has the name on it. No
                address: that is on the sheet too, and a
                screen in a warehouse is read over more
                shoulders than a sheet is. */}
            <dl className="izy-sort-facts">
                <div><dt>Patient</dt><dd>{m.patient}</dd></div>
                <div><dt>Pharmacy</dt><dd>{m.pharmacy}</dd></div>
                <div><dt>Date</dt><dd>{m.serviceDate}</dd></div>
                {m.reference !== '' && <div><dt>Ref</dt><dd>{m.reference}</dd></div>}
                <div><dt>State</dt><dd>{m.status}</dd></div>
            </dl>
            {m.handling.length > 0 && (
                <p className="izy-sort-flags">
                    {m.handling.map((f) => <span key={f} className="izy-pill warn">{f}</span>)}
                </p>
            )}
        </article>
    );
}
