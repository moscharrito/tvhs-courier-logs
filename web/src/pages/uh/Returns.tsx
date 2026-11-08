/* Taking undelivered medication back.
 *
 * The screen leads with the question a courier at the end of a shift actually
 * has: what is still in my van, and where does it go. The destination is the
 * heading, not a field to fill in, because the rule already knows: origin
 * while that pharmacy is open, the after-hours pharmacy once it has shut.
 *
 * The count is asked for and not pre-filled, the same as a pickup, and for the
 * same reason: a pre-filled number turns "confirm the count" into "tap
 * continue". A mismatch, or a load brought somewhere the rule did not expect,
 * a reason and is then allowed through. A courier holding medication
 * they cannot hand back is worse than a record with an explanation on it.
 *
 * -------------------------------------------------------------------------
 * TWO READERS, AND ONLY ONE OF THEM COULD OPEN IT.
 *
 * A courier gets their own load with no argument. Staff have to name whose
 * load they mean -- the server has always insisted, because the alternative
 * is answering "what is in the van" with every undelivered package in the
 * project -- and this screen never asked, so an administrator or a site
 * manager clicking Returns got a 400 and a page with no counter and no slot
 * to photograph the signed form into. Taking undelivered items off a driver
 * is half of what the site manager role was created for (ticket 7.20).
 *
 * So for staff the screen opens on WHO IS STILL CARRYING SOMETHING, from
 * GET /outstanding, and picking somebody loads their van. Not a list of
 * every driver: thirty-seven names of which two have anything out makes
 * somebody check the other thirty-five one at a time, and the question at
 * the end of a shift is which medication is unaccounted for.
 *
 * NOTHING ABOUT THE COURIER OWN PATH CHANGES. They never see the picker.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Loading } from '../../app/Loading';
import { Pager, usePaged } from '../../app/Pager';
import { Section } from '../../app/Section';
import { sendOrQueue, uploadPhotoNow, type QueuedPhoto } from '../../lib/outbox';
import { PHOTO_ACCEPT, photoType, photoProblem } from '../../lib/photos';
import { CardButton, CardLink, Chip, Context, Panel, Screen, ScreenHeader, Sheet } from '../../app/Glass';
import { ReturnIcon, RouteIcon } from '../../app/Icons';

interface CarriedOrder {
    orderId: number; recipientName: string; externalRef: string;
    packages: number; from: string; failureReason: string;
}
interface Destination {
    site: { id: number; code: string; name: string };
    reason: 'origin' | 'after_hours' | 'after_hours_site_missing';
    why: string;
    orders: CarriedOrder[];
    packages: number;
}
interface Load {
    courierUsername: string;
    destinations: Destination[];
    totals: { orders: number; packages: number };
    notes: string[];
}
/** One courier with something still in a van. GET /outstanding. */
interface Carrying { username: string; name: string; orders: number; packages: number }
interface Outstanding {
    couriers: Carrying[];
    totals: { couriers: number; orders: number; packages: number };
    notes: string[];
}
interface ReturnResult {
    returned: number[];
    refused: Array<{ orderId: number; error: string }>;
    discrepancy: number;
    notes: string[];
}

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

export function Returns() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const role = projects.find((p) => p.code === code)?.role ?? '';
    /* The two roles the server lets record somebody else's hand-back. A
       pharmacy account never reaches this route at all. */
    const staff = role === 'admin' || role === 'lead';
    const [whose, setWhose] = useState<Carrying | null>(null);

    if (staff && whose === null) return <WhoIsCarrying code={code} onPick={setWhose} />;
    return <TakeBack code={code} forCourier={staff ? whose : null} onBack={staff ? () => setWhose(null) : null} />;
}

/**
 * Whose van, for staff. The list is who is carrying, not who drives.
 */
function WhoIsCarrying({ code, onPick }: { code: string; onPick: (c: Carrying) => void }) {
    const [out, setOut] = useState<Outstanding | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        api<Outstanding>(`/api/projects/${code}/uh/returns/outstanding`)
            .then((o) => { if (live) setOut(o); })
            .catch((err) => {
                if (!live) return;
                setMsg(err instanceof ApiError ? err.message : 'Cannot reach dispatch.');
                setOut({ couriers: [], totals: { couriers: 0, orders: 0, packages: 0 }, notes: [] });
            });
        return () => { live = false; };
    }, [code]);

    if (out === null) return <div className="izy-card"><Loading label="Loading what is still out" /></div>;

    return (
        <Screen>
            <Context>
                <ScreenHeader
                    title="Take back"
                    subtitle={<><Link to={`/projects/${code}`}>Contract</Link> &middot; undelivered packages still out</>}
                />
                <Panel>
                    <h2 className="izy-lede-kicker">Still out</h2>
                    <p className="izy-lede">
                        {out.totals.orders} {out.totals.orders === 1 ? 'order' : 'orders'}
                    </p>
                    <p className="izy-lede-note">
                        {out.couriers.length === 0
                            ? 'Nothing undelivered is still out with a courier.'
                            : 'Choose whose load you are taking back over the counter.'}
                    </p>
                    {out.couriers.length > 0 && (
                        <div className="izy-chips">
                            <Chip label={`${out.totals.packages} ${out.totals.packages === 1 ? 'package' : 'packages'}`} />
                            <Chip
                                label={`${out.totals.couriers} ${out.totals.couriers === 1 ? 'courier' : 'couriers'}`}
                                tone="warn"
                            />
                        </div>
                    )}
                </Panel>
            </Context>
            <Sheet>
                {msg && <div className="izy-alert error" role="alert">{msg}</div>}
                {out.couriers.map((c) => (
                    <CardButton
                        key={c.username}
                        title={c.name}
                        Icon={ReturnIcon}
                        tone="quiet"
                        onClick={() => onPick(c)}
                        detail={`${c.orders} ${c.orders === 1 ? 'order' : 'orders'} / ${c.packages} ${c.packages === 1 ? 'package' : 'packages'}`}
                    />
                ))}
                {out.couriers.length === 0 && (
                    <CardLink
                        to={`/projects/${code}`}
                        title="Back to the contract"
                        Icon={RouteIcon}
                        tone="primary"
                        detail="Nothing is waiting to come back"
                    />
                )}
            </Sheet>
        </Screen>
    );
}

/**
 * The hand-back itself: the counter, the count, the name and the photograph.
 *
 * `forCourier` is null for a courier recording their own load, which is the
 * shape the server reads with no argument. Staff pass the person they chose.
 */
function TakeBack({ code, forCourier, onBack }: {
    code: string;
    forCourier: Carrying | null;
    onBack: (() => void) | null;
}) {
    /* The courier query is part of the URL the outbox queues, deliberately:
       a hand-back saved on a phone with no signal has to reach the same
       load when it fires, not whoever the screen is showing by then. */
    const base = forCourier === null
        ? `/api/projects/${code}/uh/returns`
        : `/api/projects/${code}/uh/returns?courier=${encodeURIComponent(forCourier.username)}`;

    const [load, setLoad] = useState<Load | null>(null);
    const [siteId, setSiteId] = useState<number | ''>('');
    const [signedName, setSignedName] = useState('');
    /* Part 3, photographed. One form covers everything going back. */
    const [formPhoto, setFormPhoto] = useState<File | null>(null);
    const [counted, setCounted] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<ReturnResult | null>(null);
    const [queued, setQueued] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string; details?: string[] } | null>(null);

    const refresh = useCallback(async () => {
        try {
            const l = await api<Load>(base);
            setLoad(l);
            setSiteId((current) => (current === '' && l.destinations.length === 1 ? l.destinations[0]!.site.id : current));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach dispatch.' });
            setLoad({ courierUsername: '', destinations: [], totals: { orders: 0, packages: 0 }, notes: [] });
        }
    }, [base]);
    useEffect(() => { void refresh(); }, [refresh]);

    /* ABOVE THE EARLY RETURN. The first render has no `load` and takes the
       spinner branch; a hook called only on the second is one React did not
       see on the first, and that is a white screen rather than a bad list.
       Same note as Pickup.tsx and app/src/screens/Run.tsx. */
    const handingBack = usePaged(load?.destinations.find((d) => d.site.id === siteId)?.orders ?? []);

    if (load === null) return <div className="izy-card"><Loading label="Loading what you are carrying" /></div>;

    const group = load.destinations.find((d) => d.site.id === siteId) ?? null;
    const expected = group?.packages ?? 0;
    const countedNumber = counted === '' ? null : Number(counted);
    const mismatch = countedNumber !== null && countedNumber !== expected;
    const ready = group !== null && signedName.trim() !== '' && formPhoto !== null && countedNumber !== null
        && (!mismatch || note.trim() !== '');

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!ready || group === null) return;
        setBusy(true);
        setMsg(null);
        const position = await currentPosition();

        /* LIVE FIRST, QUEUE ONLY IF LIVE WAS NOT POSSIBLE.
         *
         * Two things have to be true at once here and they pull apart.
         *
         * THE SERVER'S REFUSALS ARE CORRECTABLE AND THE COURIER IS AT THE
         * COUNTER. "2 of these should have gone somewhere else, add a note
         * saying why they came here" is returns.ts asking for one sentence
         * from somebody who is standing in the pharmacy with the packages
         * in their hands. It has to land on this screen, now. Routing it
         * into the outbox turns a thirty-second fix into a rejected entry
         * discovered by whoever reads the queue, hours after the courier
         * drove home.
         *
         * AND A RETURN MUST STILL BE RECORDABLE WITH NO SIGNAL. A return
         * happens inside a pharmacy -- the one place on a round with a
         * concrete stockroom between the phone and the sky -- and at the
         * end of a shift, when there is no second chance to come back and
         * try again.
         *
         * sendOrQueue cannot do both: it queues unconditionally whenever
         * photos are attached, so every refusal would go to the queue. And
         * the code this replaces could do neither -- it called
         * uploadPhotoNow directly and returned early when that threw, so
         * with no signal nothing was queued and the courier was told to
         * try again and could not hand the medication back at all. The
         * comment on it claimed this was "the same rule the door and the
         * counter follow", which it was not: the door hands its
         * photographs to sendOrQueue and lets the outbox wait.
         *
         * So: try it live, show a 4xx, and fall back to the queue for
         * everything else -- no signal, a network that is up and dead, a
         * 502 from a restart.
         *
         * A LOST RESPONSE CANNOT DOUBLE-RECORD. If the POST is processed
         * and the answer never arrives, the fallback queues it and the
         * flush posts again -- but carrying() selects on
         * `returned_at IS NULL`, so the second attempt finds nothing of
         * that batch still out and records a hand-back of nothing. The
         * orders come back under `refused` rather than returned twice.
         */
        const photos: QueuedPhoto[] = [{
            blob: formPhoto!,
            contentType: photoType(formPhoto!) ?? 'image/jpeg',
            kind: 'courier_form',
            bodyKey: 'courierFormFileId',
        }];

        /* The orders are named explicitly. The courier is looking at a list
           and handing over that list; letting the server recompute the batch
           between the two would hand back something the courier never saw. */
        const payload = {
            siteId: group.site.id,
            signedName: signedName.trim(),
            countedPackages: countedNumber,
            orderIds: group.orders.map((o) => o.orderId),
            note: note.trim(),
            ...(position ?? {}),
        };

        const clear = () => {
            setFormPhoto(null);
            setSignedName('');
            setCounted('');
            setNote('');
            setSiteId('');
        };

        try {
            const fileId = await uploadPhotoNow({
                module: `/api/projects/${code}/uh`,
                /* null, because one sheet covers everything in this batch:
                   the file belongs to the hand-back, not to any single
                   delivery in it. courier_form is a BATCH_KIND in
                   core/files/routes.ts for exactly this. */
                orderId: null,
                blob: formPhoto!,
                contentType: photoType(formPhoto!) ?? 'image/jpeg',
                kind: 'courier_form',
                idemKey: `return-${group.site.id}-${formPhoto!.size}-${formPhoto!.lastModified}`,
            });
            const result = await api<ReturnResult>(base, {
                method: 'POST',
                json: { ...payload, courierFormFileId: fileId },
            });
            setDone(result);
            clear();
            await refresh();
            return;
        } catch (err) {
            /* A 4xx is this courier's to fix and says how. Anything else --
               a fetch that never left the building, a 5xx, a photograph the
               file service could not be asked about -- is not about what
               was typed, and falls through to the queue below. */
            const status = typeof err === 'object' && err !== null && 'status' in err
                ? Number((err as { status: unknown }).status)
                : 0;
            if (status >= 400 && status < 500) {
                setBusy(false);
                setMsg(err instanceof ApiError
                    ? { kind: 'error', text: err.message, details: err.details }
                    : { kind: 'error', text: err instanceof Error && err.message.trim() !== ''
                        ? err.message
                        : 'That was refused. Check the count and the note.' });
                return;
            }
        }

        try {
            await sendOrQueue({
                url: base,
                label: `Return at ${group.site.name}`,
                orderId: null,
                photos,
                body: payload,
            });
            setQueued(true);
            clear();
            await refresh();
        } catch (err) {
            /* The queue refused it too, which on a phone with no room and
               no signal is the honest end of the road. sendOrQueue's own
               message says which, so it is not replaced here. */
            const said = err instanceof Error ? err.message.trim() : '';
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: said === '' ? 'Could not record the return. Try again.' : said });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Screen>
            <Context>
                {/* WHERE BACK GOES DEPENDS ON WHO IS READING. A courier
                    came from their round; staff came from the list of who
                    is carrying, and sending them to a courier round they do
                    not have is a dead link on the one screen somebody opens
                    while standing at a counter. */}
                <ScreenHeader
                    title="Take back"
                    subtitle={onBack !== null
                        ? <>
                            <button type="button" className="izy-linkish" onClick={onBack}>Whose load</button>
                            {' · '}{forCourier?.name}
                        </>
                        : <><Link to={`/projects/${code}/my-run`}>Today</Link>{' · '}undelivered packages</>}
                />
                <Panel>
                    <h2 className="izy-lede-kicker">
                        {forCourier === null ? 'Still with you' : `Still with ${forCourier.name}`}
                    </h2>
                    <p className="izy-lede">
                        {load.totals.orders} {load.totals.orders === 1 ? 'order' : 'orders'}
                    </p>
                    <p className="izy-lede-note">
                        {load.destinations.length === 0
                            ? (forCourier === null
                                ? 'Nothing undelivered is still with you.'
                                : 'Nothing undelivered is still with them.')
                            : 'These still count as attempted. Taking them back does not change that.'}
                    </p>
                    {load.destinations.length > 0 && (
                        <div className="izy-chips">
                            <Chip label={`${load.totals.packages} ${load.totals.packages === 1 ? 'package' : 'packages'}`} />
                            <Chip
                                label={`${load.destinations.length} ${load.destinations.length === 1 ? 'counter' : 'counters'}`}
                                tone="warn"
                            />
                        </div>
                    )}
                </Panel>
            </Context>

            <Sheet>
            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {done && (
                <div className="izy-alert ok" role="status">
                    Handed back {done.returned.length} {done.returned.length === 1 ? 'order' : 'orders'}.
                    {done.notes.length > 0 && <ul>{done.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                </div>
            )}

            {queued && (
                /* TRUTHFUL EITHER WAY, same as the stop screen. This path is
                   now only reached when sending live did not work, so
                   "waiting for signal" is usually right -- but a 502 from a
                   restart lands here too, and that sentence would be a lie
                   on a phone with five bars. */
                <div className="izy-alert warn" role="status">
                    {navigator.onLine === false
                        ? 'Saved on this phone. The handover will be sent as soon as you have signal, and this list will catch up then.'
                        : 'Saved on this phone and sending now. This list will catch up when it goes through.'}
                </div>
            )}

            {load.destinations.length === 0 ? (
                onBack !== null
                    ? <CardButton title="Whose load" Icon={RouteIcon} tone="primary" onClick={onBack} detail="Everyone still carrying something" />
                    : <CardLink to={`/projects/${code}/my-run`} title="Back to today" Icon={RouteIcon} tone="primary" detail="Your round, and the next stop on it" />
            ) : (
                <form onSubmit={(e) => { void submit(e); }}>
                    <div className="izy-card">
                        {/* The count and the sentence moved into the panel
                            above: they say what this screen is for, and they
                            have to stay on screen while the form below is
                            filled in. What is left here is the choice. */}
                        <h2>Which counter</h2>
                        {load.destinations.map((d) => (
                            <label key={d.site.id} className="izy-choice">
                                <input
                                    type="radio"
                                    name="destination"
                                    value={d.site.id}
                                    /* Named explicitly. Without this the browser
                                       reads the site id off the value attribute
                                       and announces "6", which tells a courier
                                       using a screen reader nothing. */
                                    aria-label={`${d.site.name}, ${d.orders.length} ${d.orders.length === 1 ? 'order' : 'orders'}, ${d.packages} ${d.packages === 1 ? 'package' : 'packages'}. ${d.why}`}
                                    checked={siteId === d.site.id}
                                    onChange={() => { setSiteId(d.site.id); setCounted(''); setNote(''); }}
                                />
                                <span>
                                    <b>{d.site.name}</b>
                                    {' · '}{d.orders.length} {d.orders.length === 1 ? 'order' : 'orders'}
                                    {' · '}{d.packages} {d.packages === 1 ? 'package' : 'packages'}
                                    <br />
                                    <span className="izy-muted">{d.why}</span>
                                </span>
                            </label>
                        ))}
                        {load.destinations.some((d) => d.reason === 'after_hours_site_missing') && (
                            <div className="izy-alert warn" role="status">
                                No after-hours pharmacy is set for this project, so these fall back to where they came
                                from. If that pharmacy is shut, call dispatch rather than leaving them in the van.
                            </div>
                        )}
                    </div>

                    {group && (
                        <>
                            <div className="izy-card">
                                <h2>Count the packages</h2>
                                <p className="izy-muted">
                                    Count what you actually hand over the counter and type it in.
                                </p>
                                <label className="izy-field" style={{ maxWidth: 180 }}>Packages counted
                                    <input
                                        value={counted}
                                        onChange={(e) => setCounted(e.target.value.replace(/[^0-9]/g, ''))}
                                        inputMode="numeric"
                                        placeholder="0"
                                        required
                                    />
                                </label>
                                {mismatch && (
                                    <div className="izy-alert warn" role="status">
                                        These orders cover {expected}. Say why the count is different before you continue.
                                        <label className="izy-field" style={{ marginTop: 8 }}>Reason
                                            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="One box stayed at the front desk" />
                                        </label>
                                    </div>
                                )}
                                {/* Folded and paged, as on the pickup
                                    screen and for the same reason: at the
                                    counter the courier is counting boxes,
                                    and the names are what settles an
                                    argument about one of them. */}
                                <Section
                                    id="uh.returns.batch"
                                    title="What you are handing back"
                                    defaultOpen={false}
                                    summary={`${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`}
                                >
                                    <ul className="izy-plain-list">
                                        {handingBack.rows.map((o) => (
                                            <li key={o.orderId}>
                                                {o.recipientName} · {o.packages} {o.packages === 1 ? 'package' : 'packages'}
                                                {o.externalRef && <> · {o.externalRef}</>}
                                                <br />
                                                <span className="izy-muted">from {o.from}{o.failureReason && <> · {o.failureReason}</>}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <Pager of={handingBack} noun="orders" />
                                </Section>
                            </div>

                            <div className="izy-card">
                                <h2>The signed form</h2>
                                <p className="izy-muted">
                                    The printed name of the person taking them back, and a photograph of part 3
                                    of the docket they signed. One photograph covers everything going back.
                                </p>
                                <label className="izy-field">Printed name
                                    <input value={signedName} onChange={(e) => setSignedName(e.target.value)} required placeholder="Name of the pharmacy staff member" />
                                </label>

                                {/* THE PAD WENT ON 19 OCTOBER. Part 3 of the
                                    docket carries "PHARMACY USE ONLY - IF THIS
                                    DELIVERY WAS NOT COMPLETED" with the staff
                                    signature, date and time. That is what the
                                    counter signs when medication comes back,
                                    so a drawn mark here was a second
                                    signature for one handover. */}
                                <label className="izy-field">Photo of the signed form
                                    <input
                                        type="file"
                                        accept={PHOTO_ACCEPT}
                                        disabled={busy}
                                        onChange={(e) => {
                                        /* Caught here rather than by the
                                           server after the upload: a
                                           refusal at a counter should
                                           name the file, not arrive as
                                           a four-hundred. */
                                        const picked = e.target.files?.[0] ?? null;
                                        const problem = picked === null ? null : photoProblem(picked);
                                        if (problem !== null) {
                                            setMsg({ kind: 'error', text: problem });
                                            setFormPhoto(null);
                                            return;
                                        }
                                        setMsg(null);
                                        setFormPhoto(picked);
                                        }}
                                    />
                                    <span className="izy-muted izy-field-note">
                                        {formPhoto === null
                                            ? 'Part 3, signed by the pharmacy. Take one now, or choose one you already have.'
                                            : `Ready to send: ${formPhoto.name}`}
                                    </span>
                                </label>
                            </div>

                            <CardButton
                                submit
                                title={`Hand back ${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`}
                                Icon={ReturnIcon}
                                tone="primary"
                                busy={busy}
                                disabled={!ready}
                                detail={ready
                                    ? `${counted} packages over the counter to ${signedName.trim()}`
                                    : [
                                        signedName.trim() === '' ? 'Add the printed name.' : '',
                                        formPhoto === null ? 'Photograph the signed form.' : '',
                                        countedNumber === null ? 'Count the packages.' : '',
                                        mismatch && note.trim() === '' ? 'Say why the count is different.' : '',
                                    ].filter(Boolean).join(' ')}
                            />
                        </>
                    )}
                </form>
            )}
            </Sheet>
        </Screen>
    );
}
