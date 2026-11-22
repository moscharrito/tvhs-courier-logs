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
 * the answer is in type you can read without bringing the phone closer,
 * and there is exactly one button under the thumb. No menus, no settings,
 * no history.
 *
 * AND IT ALWAYS HAS A WAY THROUGH. The camera will fail -- a creased
 * sheet, a dark room, a handset that will not give up its camera. There
 * is a keypad on the same screen, never behind a tab, because a sorter
 * who cannot get past this page stops using it for good and goes back to
 * reading addresses.
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
import { findPhones, type PhoneCandidate } from '../../lib/phone-scan';
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

/** 210-555-0147 out of 2105550147, for reading back off a screen. */
const pretty = (d: string): string => (d.length === 10
    ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
    : d);

export function Sort({ projectCode }: { projectCode: string }) {
    const video = useRef<HTMLVideoElement | null>(null);
    const stream = useRef<MediaStream | null>(null);

    const [live, setLive] = useState(false);
    const [busy, setBusy] = useState<'' | 'camera' | 'reading' | 'looking'>('');
    const [err, setErr] = useState('');
    /** More than one number on the sheet survived. The sorter picks. */
    const [choices, setChoices] = useState<PhoneCandidate[]>([]);
    const [asked, setAsked] = useState('');
    const [matches, setMatches] = useState<Match[] | null>(null);

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

    const look = useCallback(async (digits: string) => {
        setBusy('looking');
        setErr('');
        setChoices([]);
        setMatches(null);
        setAsked(digits);
        try {
            /* A POST, and the number is in the BODY. A telephone number
               identifies a patient, and a patient's identifier in a URL
               reaches browser history, proxies and every log that keeps a
               request line. See modules/uh/search.ts on the server. */
            const got = await api<{ matches: Match[] }>(
                `/api/projects/${projectCode}/uh/sort/lookup`,
                { method: 'POST', json: { phone: digits } },
            );
            setMatches(got.matches);
        } catch (e) {
            setErr(why(e, 'That number could not be looked up.'));
        } finally {
            setBusy('');
        }
    }, [projectCode]);

    const scan = useCallback(async () => {
        const el = video.current;
        if (!el || !live) return;
        setBusy('reading');
        setErr('');
        setChoices([]);
        setMatches(null);
        try {
            const text = await readDigits(el);
            const found = findPhones(text);
            if (found.length === 0) {
                setErr('No telephone number could be read off that. Fill the green box with the '
                    + 'RECIPIENT panel, hold the sheet flat, and keep it still.');
                return;
            }
            /* ONE ANSWER GOES STRAIGHT THROUGH. Two or more and the sorter
               picks: guessing between them would eventually put a package
               in the wrong van, which costs a redelivery and a telephone
               call from somebody who did not get their medication. */
            if (found.length === 1) { await look(found[0]!.digits); return; }
            setChoices(found);
        } catch (e) {
            setErr(why(e, 'The reader could not start.'));
        } finally {
            setBusy('');
        }
    }, [live, look]);

    const clear = () => { setMatches(null); setChoices([]); setAsked(''); setErr(''); };

    return (
        <div className="izy-sort">
            <header className="izy-sort-head">
                <h1>Sort a package</h1>
                <p className="izy-muted">
                    Fill the green box with the RECIPIENT panel, then press Scan. Nothing is saved.
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

            {/* ONE BUTTON, IN THE MIDDLE, UNDER THE THUMB. It is pressed
                one-handed with a parcel in the other, by somebody who is
                not looking at the screen until after the press. A second
                control beside it is a control that gets hit by mistake. */}
            <div className="izy-sort-do">
                {live ? (
                    <button
                        type="button"
                        className="izy-btn big"
                        disabled={busy !== ''}
                        onClick={() => { void scan(); }}
                    >
                        {busy === 'reading' ? 'Reading…' : busy === 'looking' ? 'Looking…' : 'Scan'}
                    </button>
                ) : (
                    /* Only when there is no camera to scan with -- a refused
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

            {choices.length > 0 && (
                <div className="izy-sort-pick">
                    <h2>Which number is the patient’s?</h2>
                    <p className="izy-muted">More than one was on the sheet.</p>
                    {choices.map((c) => (
                        <button
                            key={c.digits}
                            type="button"
                            className="izy-btn secondary big"
                            onClick={() => { void look(c.digits); }}
                        >
                            {pretty(c.digits)}
                        </button>
                    ))}
                </div>
            )}

            {matches !== null && (
                <div className="izy-sort-out">
                    <div className="izy-sort-asked">
                        <span className="izy-muted">Looked up</span> {pretty(asked)}
                        <button type="button" className="izy-btn secondary small" onClick={clear}>Clear</button>
                    </div>

                    {matches.length === 0 && (
                        <p className="izy-alert warn" role="status">
                            No delivery with that number is on today’s or tomorrow’s list. Check the
                            digits, or the package is for a later day.
                        </p>
                    )}

                    {matches.map((m) => (
                        <article key={m.orderId} className="izy-sort-card">
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
                            {!m.driver && (
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
                    ))}
                </div>
            )}
        </div>
    );
}
