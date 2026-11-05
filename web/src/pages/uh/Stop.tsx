/* The stop, on a courier's phone.
 *
 * One decision at a time. Arrive is its own tap because the arrival time is
 * what the deadline is measured against, and burying it inside the outcome
 * would lose it whenever a courier is quick. After that there are exactly
 * three ways a stop can end, and the screen offers only the ones the contract
 * allows for this package.
 *
 * Doorstep is hidden, not disabled-with-a-warning, when any package needs a
 * signature. A control a courier can see is a control a courier will try, and
 * arguing with a phone at somebody's front door is not a good use of the two
 * hours the delivery has.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { useProjectTimezone } from '../../app/auth';
import { Loading } from '../../app/Loading';
import { sendOrQueue, pendingFor, type QueuedPhoto } from '../../lib/outbox';
import { PHOTO_ACCEPT, photoProblem, photoType } from '../../lib/photos';
import { CardButton, CardLink, Chip, Context, Panel, Screen, ScreenHeader, Sheet } from '../../app/Glass';
import { NavigateIcon, PhoneIcon, PinIcon, RouteIcon } from '../../app/Icons';

interface Package {
    id: number; description: string; quantity: number;
    signatureRequired: boolean; outcome: string;
}

interface OrderDetail {
    id: number;
    recipientName: string;
    recipientPhone: string;
    address: string;
    city: string;
    zip: string;
    status: string;
    serviceType: string;
    dueAt: string | null;
    arrivedAt: string | null;
    deliveryNotes: string;
    signatureRequired: boolean;
    /** Ticket 7.13: this handover needs both parties to sign. */
    controlled?: boolean;
    /** The pharmacy stamped this one: no identification, no delivery. The
     *  server refuses it outright, so the screen has to offer the camera. */
    idRequired?: boolean;
    packages: Package[];
}

/** Addendum 1's own list of what a dry run covers, in its own terms. */
const DRY_RUN_REASONS: Array<{ code: string; label: string }> = [
    { code: 'recipient_not_located', label: 'Could not find the recipient' },
    { code: 'incorrect_address', label: 'Address is wrong' },
    { code: 'no_access', label: 'Could not get access' },
    { code: 'incomplete_shipment', label: 'Shipment incomplete or wrong' },
    { code: 'refused', label: 'Recipient refused it' },
    { code: 'other', label: 'Something else' },
];

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

/** What the file service accepts. A phone that offers anything else is
 *  told so before the courier waits on an upload that cannot succeed. */
/* PHOTO_TYPES and MAX_PHOTO_BYTES moved to lib/photos.ts, along with the
   rule that decides a camera's content type rather than trusting it. */

/** What a queued entry is called when the courier reads the list back. */
const LABELS: Record<string, string> = {
    arrive: 'Arrival', deliver: 'Delivery', doorstep: 'Doorstep delivery', attempt: 'Attempt',
};

type Choice = null | 'deliver' | 'doorstep' | 'attempt';

export function Stop() {
    const { code = '', orderId = '' } = useParams();
    const navigate = useNavigate();
    const base = `/api/projects/${code}/uh/orders/${orderId}`;
    /* The deadline this stop is measured against is a wall-clock time in the
       project's zone, so it is shown in that zone and not the phone's. */
    const clock = clockFor(useProjectTimezone(code));

    const [order, setOrder] = useState<OrderDetail | null>(null);
    const [filesAvailable, setFilesAvailable] = useState<boolean | null>(null);
    /* Amending a stop that already has an outcome: which photograph is
       being replaced, and the file picked for it. Null when the driver has
       not asked to replace anything, which is nearly always. */
    const [amend, setAmend] = useState<'courier_form' | 'patient_id' | 'stamped_receipt' | null>(null);
    const [amendPhoto, setAmendPhoto] = useState<File | null>(null);
    /* ADDENDUM 2 CLAUSE 4. University Health forbid leaving a package
       anywhere unattended, and a delivery is not complete until a person has
       received it. The server refuses the doorstep endpoint outright; without
       this the screen would still offer the button, and a courier would
       photograph a porch, type a reason, submit, and be told no. Null while
       it loads, and the button stays hidden until the answer arrives: better
       a control that appears a moment late than one that cannot work. */
    const [handoverOnly, setHandoverOnly] = useState<boolean | null>(null);
    const [params, setParams] = useSearchParams();
    const [choice, setChoice] = useState<Choice>(null);
    const [signedName, setSignedName] = useState('');
    /* The courier's own mark, on a controlled drug (7.13). This form is the
       one dispatch uses when a phone has died, so whoever is signed in here
       is the person attesting; the server takes the printed name from their
       session rather than from this page. */
    const [noSignatureReason, setNoSignatureReason] = useState('');
    const [photo, setPhoto] = useState<File | null>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    /* THE SIGNATURE MOVED ONTO PAPER, and then off the screen entirely.
       The pharmacy's own form is signed at the door and photographed, and
       that photograph is now the only proof a delivery can carry: no pad,
       no generated mark, no typed reason in place of one.
       Identification is its own photograph and only where the form was
       stamped. Both ride in the outbox with the delivery, so a courier with
       no signal records the handover and the evidence together. */
    const [formPhoto, setFormPhoto] = useState<File | null>(null);
    const [idPhoto, setIdPhoto] = useState<File | null>(null);
    /* The stamped receipt that travels with a controlled item. Its own
       photograph, not a second use of the form slot: see FILE_KINDS. */
    const [receiptPhoto, setReceiptPhoto] = useState<File | null>(null);
    /* Its own, not the doorstep branch's: two forms sharing one box means
       typing in one silently fills the other. */
    const [reasons, setReasons] = useState<Record<number, { code: string; note: string }>>({});
    const [busy, setBusy] = useState(false);
    const [queuedHere, setQueuedHere] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string; details?: string[] } | null>(null);

    const load = useCallback(async () => {
        try { setOrder(await api<OrderDetail>(base)); } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach dispatch.' });
        }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

    /* ?handover=1 OPENS STRAIGHT ON THE HANDOVER FORM.
     *
     * One caller: a driver who got back to a door and tapped Handed over
     * on the stop they came from. Making them tap it again on the
     * delivery that tap created is a step that asks nothing.
     *
     * AN EFFECT, NOT A useState INITIALISER, which is where this was
     * first written and did nothing. Both stops are the same route, so
     * React Router keeps the component mounted across the navigation and
     * an initialiser never runs a second time: the URL said handover=1
     * and the screen showed the menu anyway.
     *
     * THE PARAMETER IS DROPPED ONCE IT HAS BEEN USED, with replace so it
     * leaves no history entry. Otherwise Back out of the form reads the
     * flag again and puts them right back in it, which is a screen with
     * no way out of itself. */
    useEffect(() => {
        if (params.get('handover') !== '1') return;
        setChoice('deliver');
        setParams(new URLSearchParams(), { replace: true });
    }, [params, setParams]);
    /* EACH OF THESE THREE GUARDS AGAINST RESOLVING AFTER UNMOUNT, and that
       is a fix rather than a precaution: the first one was setting state into
       a torn-down React and taking the whole web suite's exit code with it.
       An unhandled rejection reading "window is not defined" out of
       dispatchSetState, intermittent, and attributed to this file while
       nothing in this file looked wrong -- a courier leaving a stop before
       the outbox lookup resolves is the same race in the field, where it is
       a console error nobody sees.

       The idiom is the `live` flag used in app/src/App.tsx. Not AbortSignal:
       pendingFor reads IndexedDB and does not take one, so the cheap thing
       that covers all three is to stop writing rather than to stop asking. */
    /* A stop whose outcome is queued must not offer the outcome again: the
       courier would record it twice and see two entries waiting. */
    useEffect(() => {
        let live = true;
        void pendingFor(Number(orderId)).then((q) => { if (live) setQueuedHere(q); });
        return () => { live = false; };
    }, [orderId]);
    useEffect(() => {
        let live = true;
        api<{ available: boolean }>(`/api/projects/${code}/uh/files/status/check`)
            .then((s) => { if (live) setFilesAvailable(s.available); })
            .catch(() => { if (live) setFilesAvailable(false); });
        return () => { live = false; };
    }, [code]);
    useEffect(() => {
        let live = true;
        /* Fails closed. If this cannot be read, assume the stricter contract:
           refusing a doorstep that was allowed is a phone call, and recording
           one that was forbidden is a breach. */
        api<{ settings: { delivery?: { personalHandoverOnly?: boolean } } }>(`/api/projects/${code}/settings`)
            .then((r) => { if (live) setHandoverOnly(r.settings.delivery?.personalHandoverOnly !== false); })
            .catch(() => { if (live) setHandoverOnly(true); });
        return () => { live = false; };
    }, [code]);

    if (order === null) {
        return msg
            ? (<><h1>Stop</h1><div className="izy-alert error" role="alert">{msg.text}</div></>)
            : <div className="izy-card"><Loading label="Loading the stop" /></div>;
    }

    const needsSignature = order.signatureRequired || order.packages.some((p) => p.signatureRequired);
    const closed = ['delivered', 'failed', 'cancelled'].includes(order.status);
    /* Cancelled is not amendable: it was called off before anybody had the
       package, so there is no photograph of a handover to improve and no
       door to have gone back to. The server refuses both routes for it. */
    const amendable = order.status === 'delivered' || order.status === 'failed';

    /**
     * Record what happened.
     *
     * Through the outbox, never straight at fetch. A courier standing in a
     * stairwell has still made the delivery, and being told to "check your
     * signal and try again" would mean doing it again later from memory, or
     * not at all.
     */
    async function post(path: string, body: Record<string, unknown>, ok: string, photo?: File, photos?: QueuedPhoto[]) {
        setBusy(true);
        setMsg(null);
        const position = await currentPosition();
        try {
            const result = await sendOrQueue({
                url: `${base}/${path}`,
                body: { ...body, ...(position ?? {}) },
                label: `${LABELS[path] ?? path} for ${order!.recipientName}`,
                orderId: order!.id,
                ...(photo ? { photo: { blob: photo, contentType: photoType(photo) ?? "image/jpeg", kind: 'doorstep', bodyKey: 'fileId' } } : {}),
                ...(photos?.length ? { photos } : {}),
            });
            if (result.sent) {
                setMsg({ kind: 'ok', text: ok });
            } else {
                /* Truthful either way. A doorstep delivery always goes
                   through the queue, because the photo has to reach the bucket
                   before the event does, so "waiting for signal" would be a
                   lie when the phone has five bars. */
                setMsg({
                    kind: 'warn',
                    text: navigator.onLine === false
                        ? 'Saved on this phone. It will be sent as soon as you have signal.'
                        : 'Saved on this phone and sending now.',
                });
                setQueuedHere(true);
            }
            setChoice(null);
            setSignedName('');
            setPhoto(null);
            setNoSignatureReason('');
            await load();
        } catch (err) {
            /* ANY error with something to say, not only an ApiError. The file
               service's refusals are plain Errors carrying the server's own
               words -- putPhoto goes to some trouble to keep them -- and this
               line dropped every one of them on the floor in favour of "That
               did not save. Try again.", which is the sentence a driver
               reported on 3 November after a photograph would not upload.
               Same mistake as the one putPhoto's own comment describes, one
               layer up. */
            const said = err instanceof Error ? err.message.trim() : '';
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: said === '' ? 'That did not save. Try again.' : said });
        } finally {
            setBusy(false);
        }
    }

    const deliver = (e: FormEvent) => {
        e.preventDefault();
        /* Checked here as well as on the server. The server's refusal is the
           one that counts, but a courier who only learns at the door that
           they needed a photograph has already handed the packages over. */
        if (order.idRequired === true && idPhoto === null) {
            setMsg({ kind: 'error', text: 'This delivery is marked ID Required. Photograph the identification before recording it.' });
            return;
        }
        /* ─────────────────────────────────────────────────────────────────
         * THE PHOTOGRAPHS GO THROUGH THE QUEUE, NOT AHEAD OF IT.
         *
         * They used to be uploaded here, before the delivery was sent, and a
         * failure recorded nothing. Once the photograph became compulsory on
         * every delivery that made a courier with no signal unable to record
         * one at all -- in a system whose whole offline promise is "keep
         * working, nothing is lost", and whose own install sheet says so.
         *
         * The outbox already knew how to put a picture in the bucket and
         * drop the file id into the body before sending; it just had to be
         * handed both of them. Offline, the delivery and its evidence wait
         * together and go up in order when the signal returns. ────────── */
        const photos: QueuedPhoto[] = [];
        if (formPhoto !== null) {
            photos.push({ blob: formPhoto, contentType: photoType(formPhoto) ?? "image/jpeg", kind: 'courier_form', bodyKey: 'courierFormFileId' });
        }
        if (idPhoto !== null) {
            photos.push({ blob: idPhoto, contentType: photoType(idPhoto) ?? "image/jpeg", kind: 'patient_id', bodyKey: 'patientIdFileId' });
        }
        if (receiptPhoto !== null) {
            photos.push({ blob: receiptPhoto, contentType: photoType(receiptPhoto) ?? "image/jpeg", kind: 'stamped_receipt', bodyKey: 'stampedReceiptFileId' });
        }
        /* WHAT TO DO NEXT, not what just happened. "Delivered and
           recorded" describes our filing; the driver is standing at a
           door wanting to know whether they can walk away. */
        void post('deliver', { signedName: signedName.trim() }, 'Successful. Proceed to your next stop.', undefined, photos);
    };

    const doorstep = (e: FormEvent) => {
        e.preventDefault();
        if (!photo) return;
        /* The photo travels with the event rather than being uploaded first.
           The queue puts it in the bucket and only then sends the delivery, so
           a doorstep drop is never claimed without the photo behind it, on a
           signal or off one. */
        void post('doorstep', { noSignatureReason: noSignatureReason.trim() }, 'Successful. Proceed to your next stop.', photo);
    };

    const attempt = (e: FormEvent) => {
        e.preventDefault();
        const packages = order.packages
            .filter((p) => reasons[p.id]?.code)
            .map((p) => ({ packageId: p.id, reasonCode: reasons[p.id]!.code, note: reasons[p.id]!.note ?? '' }));
        void post('attempt', { packages }, 'Successful. Proceed to your next stop.');
    };

    /* ─────────────── A STOP THAT ALREADY HAS AN OUTCOME (4 November)
     *
     * Until now this screen said "Finished" and offered a link back to the
     * round, and the run list did not even link to a finished stop. Two
     * things happen on the road often enough that the gate cost more than
     * it protected.
     *
     * THE PHOTOGRAPH WAS NO GOOD. The handover happened and the record of
     * it is right; the form came out blurred or a thumb covered the
     * signature. A better one is appended -- the proof of delivery takes
     * the newest of each kind -- and nothing about the outcome moves.
     *
     * THE DOOR OPENED AFTER ALL. A dry run at 15:40, the patient rings the
     * pharmacy back, the driver is there again at 16:25. The only way
     * through that was a phone call to somebody holding the admin role, so
     * the delivery that really happened went unrecorded or got recorded as
     * a fiction on another stop.
     *
     * THE SERVER HAS HAD BOTH SINCE 4 NOVEMBER and the Expo app has had
     * the buttons. Nobody was reaching them: the drivers are on the web.
     */
    const sendEvidence = (e: FormEvent) => {
        e.preventDefault();
        if (amend === null || amendPhoto === null) return;
        void post(
            'evidence',
            { kind: amend },
            /* NOT "proceed to your next stop": this one is an old
               delivery being tidied up, and there is no next stop on a
               day that finished last week. */
            'Successful. The photo is on the delivery.',
            undefined,
            [{
                blob: amendPhoto,
                contentType: photoType(amendPhoto) ?? 'image/jpeg',
                kind: amend,
                bodyKey: 'fileId',
            }],
        ).then(() => { setAmend(null); setAmendPhoto(null); });
    };

    /* NOT THROUGH post(), which queues. A queued second attempt that fired
       twice would be two couriers sent to one door, and the server's own
       guard against that answers 409 -- which a driver should see now,
       standing there, rather than three streets later. The photograph
       amendment above does queue, because appending a picture twice is
       harmless and losing it to a basement is not. */
    const redeliver = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const made = await api<{ id: number }>(`${base}/redeliver`, { method: 'POST', json: {} });
            /* Straight onto the second attempt rather than back to the
               list: the stop they are looking at is the first one and is
               finished, and hunting a round for a row that was not there a
               moment ago is how the wrong stop gets recorded. */
            navigate(`/projects/${code}/orders/${made.id}/stop?handover=1`);
        } catch (err) {
            setMsg({
                kind: 'error',
                text: err instanceof ApiError
                    ? err.message
                    : 'Could not reach dispatch. Nothing was recorded. Try again when you have signal.',
            });
        } finally {
            setBusy(false);
        }
    };

    const attemptReady = order.packages.length > 0
        && order.packages.every((p) => reasons[p.id]?.code)
        && order.packages.every((p) => reasons[p.id]?.code !== 'other' || (reasons[p.id]?.note ?? '').trim() !== '');

    return (
        <Screen>
            {/* WHO AND WHERE, AND IT STAYS ON SCREEN.
                The app puts the name and the address at the top of this
                screen and the work underneath, and the reason shows up the
                moment somebody uses it: a courier filling in the printed
                name is standing at the door reading it off the person in
                front of them, and the address is what they check they are at
                the right one. In the sheet shape the region does not scroll
                away while the form is being filled in, which the old stack
                of cards did. */}
            <Context>
                <ScreenHeader
                    title="Stop"
                    subtitle={<><Link to={`/projects/${code}/my-run`}>Today</Link> · order {order.id} · {order.serviceType}</>}
                />
                {/* `izy-stop-head`, scoped the way the next-stop panel is.
                    This region does not scroll away, so every pixel it takes
                    is a pixel the form below never gets on a phone -- and
                    what it has to do is confirm the driver is at the right
                    door, which is a name, a street and the handling chips.
                    .izy-lede itself is left alone: it is shared with the
                    earnings panel, where the size is right. */}
                <Panel role="group" aria-label="This delivery" className="izy-stop-head">
                    {/* THE CALL SITS ON THE NAME'S LINE, far right.
                        It was a card of its own below the fold-line of this
                        region, which is two problems: it took a full row of
                        the sheet away from the three endings a driver came
                        here to choose between, and it was separated from
                        the one thing that says who would answer. Ringing
                        somebody is a thing you do to a person, so it reads
                        better beside their name than under it.

                        THE NUMBER IS NOT PRINTED. The button is the whole
                        of it: this panel does not scroll away, so a line
                        that only repeats what the control beside it already
                        carries is a line the form below never gets.

                        It is still reachable without dialling. The button's
                        accessible name is "Call <who> on <number>", so a
                        screen reader announces it and it is on the control
                        for anybody who wants to check what they are about
                        to ring. If drivers turn out to need it in print --
                        reading it back to dispatch, or checking it against
                        the person at the door, which is the third of the
                        three identifiers University Health asks for -- it
                        goes under the address as plain text, never as a
                        second link: one action, one control. */}
                    <div className="izy-stop-head-top">
                        <p className="izy-lede">{order.recipientName}</p>
                        {order.recipientPhone && (
                            <a
                                className="izy-call"
                                href={`tel:${order.recipientPhone}`}
                                aria-label={`Call ${order.recipientName} on ${order.recipientPhone}`}
                            >
                                <PhoneIcon />
                                <span>Call</span>
                            </a>
                        )}
                    </div>
                    <p className="izy-lede-note">{order.address}, {order.city} {order.zip}</p>
                    <div className="izy-chips">
                        <Chip label={`due ${clock(order.dueAt)}`} />
                        {order.arrivedAt && <Chip label={`arrived ${clock(order.arrivedAt)}`} tone="good" />}
                        {/* HOW THE PHARMACY SENT IT, before the knock rather
                            than beside the signature box. A courier reads
                            this or they read nothing, and it changes what
                            they do: whether to go back to the van for the
                            cooler, and whether the person opening the door
                            is allowed to take this at all. */}
                        {needsSignature && <Chip label="signature required" tone="warn" />}
                        {order.idRequired === true && <Chip label="ID required" tone="warn" />}
                        {order.controlled === true && <Chip label="controlled" tone="bad" />}
                    </div>
                    {order.deliveryNotes && <p className="izy-lede-note">{order.deliveryNotes}</p>}
                </Panel>
            </Context>

            <Sheet>
            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {queuedHere && !closed && (
                <div className="izy-card">
                    {/* WORDED AS DONE, ON PURPOSE, AND IT IS NOT THE WHOLE
                        TRUTH. This card shows when the record is in the
                        outbox and has not reached dispatch, and it used to
                        say so: "saved on this phone and has not reached
                        dispatch yet". Drivers read that as a failure and
                        recorded the stop a second time, which is the one
                        thing this card exists to prevent. Changed 3 November
                        on instruction. The outbox sends it by itself, so for
                        the driver there is genuinely nothing left to do --
                        but if anybody is ever chasing a delivery dispatch
                        cannot see, this screen is why the driver will say
                        they sent it. */}
                    <h2>Recorded</h2>
                    <p>What you saved is recorded and sent to dispatch.</p>
                    <CardLink to={`/projects/${code}/my-run`} title="Back to today" Icon={RouteIcon} tone="primary" compact />
                </div>
            )}

            {closed ? (
                /* ─── A STOP THAT IS ALREADY RECORDED, PLAINLY.
                 *
                 * It opened as a wall of prose: a sentence under the
                 * heading explaining the record, a sentence under every
                 * button explaining the button, and the words "second
                 * attempt" twice. A driver at a door reads none of it,
                 * and a screen that has to be read before it can be used
                 * is slower than one that cannot. What it is, and what
                 * can be done about it. The explanations are gone, not
                 * the controls.
                 *
                 * "HANDED OVER" RATHER THAN "I DELIVERED IT AFTER ALL",
                 * and nothing on screen says reattempt. Underneath it is
                 * still a second delivery -- the first attempt keeps its
                 * outcome, its place in the completion rate and its
                 * invoice line, which is the whole argument of
                 * reattempt.ts -- but that is a fact about our records,
                 * not about the driver's afternoon. They handed it over;
                 * the button says so, and ?handover=1 lands them on the
                 * form rather than on a menu asking what they just said
                 * they were doing. */
                <div className="izy-card">
                    <h2>
                        {order.status === 'delivered' ? 'Delivered'
                            : order.status === 'failed' ? 'Not delivered' : 'Cancelled'}
                    </h2>

                    {amendable && amend === null && (
                        <>
                            {order.status === 'failed' && (
                                <CardButton
                                    title="Handed over"
                                    tone="primary"
                                    compact
                                    busy={busy}
                                    onClick={() => { void redeliver(); }}
                                />
                            )}
                            {filesAvailable === false ? (
                                <p className="izy-muted">Photo storage is off, so there is nowhere to put a new picture.</p>
                            ) : (
                                <>
                                    <CardButton
                                        title="Replace the signed form"
                                        tone="secondary"
                                        compact
                                        disabled={busy}
                                        onClick={() => { setAmend('courier_form'); setAmendPhoto(null); }}
                                    />
                                    {(order.idRequired === true || order.controlled === true) && (
                                        <CardButton
                                            title="Replace the ID photo"
                                            tone="secondary"
                                            compact
                                            disabled={busy}
                                            onClick={() => { setAmend('patient_id'); setAmendPhoto(null); }}
                                        />
                                    )}
                                    {/* ADDING ONE IS THE POINT, not only
                                        replacing one. A courier who was
                                        handed a stamped receipt at the door
                                        and could not photograph it there --
                                        or who recorded the delivery before
                                        the pharmacy stamped anything -- has
                                        no other way to attach it, and the
                                        evidence route appends rather than
                                        overwrites. */}
                                    {order.controlled === true && (
                                        <CardButton
                                            title="Add or replace the stamped receipt"
                                            tone="secondary"
                                            compact
                                            disabled={busy}
                                            onClick={() => { setAmend('stamped_receipt'); setAmendPhoto(null); }}
                                        />
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {amendable && amend !== null && (
                        <form onSubmit={sendEvidence}>
                            <label className="izy-field">
                                {amend === 'courier_form'
                                    ? 'The signed form'
                                    : amend === 'stamped_receipt' ? 'The stamped receipt' : 'The identification'}
                                <input
                                    type="file"
                                    accept={PHOTO_ACCEPT}
                                    capture="environment"
                                    disabled={busy}
                                    onChange={(e) => {
                                        /* The same check the delivery form makes, and for the
                                           same reason: a camera often reports image/jpg or
                                           nothing at all, so lib/photos.ts decides the type
                                           rather than trusting the browser's guess. */
                                        const picked = e.target.files?.[0] ?? null;
                                        const problem = picked === null ? null : photoProblem(picked);
                                        if (problem !== null) {
                                            setMsg({ kind: 'error', text: problem });
                                            setAmendPhoto(null);
                                            return;
                                        }
                                        setMsg(null);
                                        setAmendPhoto(picked);
                                    }}
                                />
                            </label>
                            <CardButton
                                submit
                                title="Add this photo"
                                tone="primary"
                                compact
                                busy={busy}
                                disabled={amendPhoto === null}
                            />
                            <CardButton
                                title="Back"
                                tone="quiet"
                                compact
                                disabled={busy}
                                onClick={() => { setAmend(null); setAmendPhoto(null); }}
                            />
                        </form>
                    )}

                    <CardLink to={`/projects/${code}/my-run`} title="Back to today" Icon={RouteIcon} tone="quiet" compact />
                </div>
            ) : (
                <>
                    {order.arrivedAt === null && !queuedHere && (
                        /* FIRST, AND ON ITS OWN. The deadline is measured
                           against this and it counts even when nobody answers
                           the door, so it is the primary card and nothing
                           shares the row with it.

                           `busy` is wired through rather than swapping the
                           label: fixing a position can take several seconds
                           on a phone with a poor view of the sky, and a
                           button that looks inert is a button a courier taps
                           twice. */
                        <CardButton
                            title="I have arrived"
                            Icon={PinIcon}
                            tone="primary"
                            /* COMPACT, AND STILL 56px. See Glass.tsx: compact
                               is about visual weight, never about being
                               harder to hit with a thumb in a van. Four
                               full-height slabs ran the sheet off the bottom
                               of a phone, so the choice a driver came here
                               to make needed a scroll to see all of. */
                            compact
                            busy={busy}
                            onClick={() => { void post('arrive', {}, 'Arrival recorded.'); }}
                        />
                    )}

                    {choice === null && !queuedHere && (
                        <div className="izy-card">
                            <h2>How did it go?</h2>
                            {/* Cards rather than a row of three pills. These
                                are the three endings a delivery can have and
                                they are not interchangeable: one of them is
                                leaving medication on a step. A line of
                                explanation under each is what makes the
                                difference readable to somebody choosing with
                                one hand in the rain. */}
                            {/* SECONDARY, with "I have arrived" above it in
                                green. Both are on screen at once until the
                                arrival is recorded, and two primary slabs
                                competing is a screen that says nothing — the
                                app makes the same call for the same reason.
                                Arrival is the one with a deadline attached. */}
                            <CardButton
                                title="Handed over"
                                compact
                                tone="secondary"
                                disabled={busy}
                                onClick={() => setChoice('deliver')}
                            />
                            {/* Only when the medication allows it (Scope 1.2.3) AND the
                                contract does (Addendum 2 clause 4, which supersedes it
                                for University Health). */}
                            {!needsSignature && handoverOnly === false && (
                                <CardButton
                                    title="Left at the door"
                                    compact
                                    tone="quiet"
                                    disabled={busy}
                                    onClick={() => setChoice('doorstep')}
                                />
                            )}
                            <CardButton
                                title="Could not deliver"
                                compact
                                tone="calmDanger"
                                disabled={busy}
                                onClick={() => setChoice('attempt')}
                            />
                            {/* ONE LINE, NOT TWO SENTENCES. It explains an
                                absent button, which is worth saying -- a
                                courier looking for "Left at the door" should
                                learn why it is not there rather than hunt --
                                but the second sentence told them to use a
                                button they are already looking at. */}
                            {needsSignature && (
                                <p className="izy-muted">Needs a signature, so it cannot be left at the door.</p>
                            )}
                        </div>
                    )}

                    {choice === 'deliver' && (
                        <form className="izy-card" onSubmit={deliver}>
                            <h2>Handed over</h2>
                            <label className="izy-field">Printed name of the person receiving it
                                <input value={signedName} onChange={(e) => setSignedName(e.target.value)} required />
                            </label>
                            {/* THE PAPER IS THE PROOF, AND THE ONLY ONE.
                                A photograph of a signed form is weaker
                                evidence than the movement of a pen, and it
                                is what the client's own document gives us.
                                The trade was made knowingly; what is not
                                acceptable is a generated mark standing in
                                for either. See the Deliver schema in
                                stop.ts. */}
                            <label className="izy-field">Photo of the signed form
                                <input
                                    type="file"
                                    accept={PHOTO_ACCEPT}
                                    disabled={busy}
                                    /* This field took whatever it was handed and
                                       checked nothing -- the doorstep path below
                                       validated and this, the path EVERY ordinary
                                       delivery goes down, did not. A file too
                                       large or plainly not a photograph became a
                                       four-hundred after the upload instead of a
                                       sentence before it. */
                                    onChange={(e) => {
                                        const picked = e.target.files?.[0] ?? null;
                                        const problem = picked === null ? null : photoProblem(picked);
                                        if (problem !== null) { setMsg({ kind: 'error', text: problem }); setFormPhoto(null); return; }
                                        setMsg(null);
                                        setFormPhoto(picked);
                                    }}
                                />
                                <span className="izy-muted izy-field-note">
                                    {formPhoto === null
                                        ? 'The pharmacy form the recipient signed. Take one now, or choose one you already have.'
                                        : `Ready to send: ${formPhoto.name}`}
                                </span>
                            </label>

                            {/* ── THE CONTROLLED PAPERWORK ─────────────────────
                                Asked for by the drivers on 4 November: a
                                controlled item travels with an ID check and
                                a stamped receipt, and the screen gave them
                                one slot for the signed form and nowhere to
                                put either.

                                SHOWN ON `controlled`, NOT ON `idRequired`.
                                idRequired comes from a column in the
                                pharmacy's spreadsheet and is almost never
                                set, because the real signal is a stamp on
                                the paper in the courier's hand. `controlled`
                                IS on the record, so it is the flag that can
                                actually open the slots.

                                BOTH OPTIONAL. A delivery records on the
                                signed form alone. A courier who cannot get a
                                third photograph -- dark porch, dying phone,
                                a receipt nobody stamped -- must still be
                                able to say what they did, because an
                                unrecorded handover is worse evidence than a
                                missing picture of a receipt.

                                The ID slot below stays COMPULSORY where the
                                form is stamped ID Required. That rule is the
                                contract's and is not ours to relax; the two
                                blocks are separate so neither can quietly
                                turn into the other. */}
                            {order.controlled === true && order.idRequired !== true && (
                                <div className="izy-card izy-controlled-papers">
                                    <p className="izy-muted izy-field-note">
                                        This is a controlled drug. If you were handed identification or a
                                        stamped receipt, photograph them here. Both are optional &mdash; the
                                        delivery records without them.
                                    </p>
                                    <label className="izy-field">Photo of the identification (optional)
                                        <input
                                            type="file"
                                            accept={PHOTO_ACCEPT}
                                            disabled={busy}
                                            onChange={(e) => {
                                                const picked = e.target.files?.[0] ?? null;
                                                const problem = picked === null ? null : photoProblem(picked);
                                                if (problem !== null) { setMsg({ kind: 'error', text: problem }); setIdPhoto(null); return; }
                                                setMsg(null);
                                                setIdPhoto(picked);
                                            }}
                                        />
                                        <span className="izy-muted izy-field-note">
                                            {idPhoto === null
                                                ? 'Only if you were shown one.'
                                                : `Ready to send: ${idPhoto.name}`}
                                        </span>
                                    </label>
                                    <label className="izy-field">Photo of the stamped receipt (optional)
                                        <input
                                            type="file"
                                            accept={PHOTO_ACCEPT}
                                            disabled={busy}
                                            onChange={(e) => {
                                                const picked = e.target.files?.[0] ?? null;
                                                const problem = picked === null ? null : photoProblem(picked);
                                                if (problem !== null) { setMsg({ kind: 'error', text: problem }); setReceiptPhoto(null); return; }
                                                setMsg(null);
                                                setReceiptPhoto(picked);
                                            }}
                                        />
                                        <span className="izy-muted izy-field-note">
                                            {receiptPhoto === null
                                                ? 'Only if the receipt was stamped.'
                                                : `Ready to send: ${receiptPhoto.name}`}
                                        </span>
                                    </label>
                                </div>
                            )}

                            {order.idRequired === true && (
                                <div className="izy-card izy-id-required">
                                    <div className="izy-alert warn" role="status">
                                        This delivery is marked <b>ID Required</b>. The pharmacy stamped it
                                        because this medication may only go to someone who proved who they
                                        are. Photograph the identification before recording it.
                                    </div>
                                    <label className="izy-field">Photo of the identification
                                        <input
                                            type="file"
                                            accept={PHOTO_ACCEPT}
                                            disabled={busy}
                                            onChange={(e) => {
                                                const picked = e.target.files?.[0] ?? null;
                                                const problem = picked === null ? null : photoProblem(picked);
                                                if (problem !== null) { setMsg({ kind: 'error', text: problem }); setIdPhoto(null); return; }
                                                setMsg(null);
                                                setIdPhoto(picked);
                                            }}
                                        />
                                        <span className="izy-muted izy-field-note">
                                            {idPhoto === null
                                                ? 'Required for this delivery. Take one now, or choose one you already have.'
                                                : `Ready to send: ${idPhoto.name}`}
                                        </span>
                                    </label>
                                    {/* A delivery can be both. The receipt
                                        belongs with the rest of the
                                        paperwork rather than in a second
                                        panel further down, and it stays
                                        optional even here: only the ID is
                                        compulsory on an ID Required stop. */}
                                    {order.controlled === true && (
                                        <label className="izy-field">Photo of the stamped receipt (optional)
                                            <input
                                                type="file"
                                                accept={PHOTO_ACCEPT}
                                                disabled={busy}
                                                onChange={(e) => {
                                                    const picked = e.target.files?.[0] ?? null;
                                                    const problem = picked === null ? null : photoProblem(picked);
                                                    if (problem !== null) { setMsg({ kind: 'error', text: problem }); setReceiptPhoto(null); return; }
                                                    setMsg(null);
                                                    setReceiptPhoto(picked);
                                                }}
                                            />
                                            <span className="izy-muted izy-field-note">
                                                {receiptPhoto === null
                                                    ? 'Only if the receipt was stamped.'
                                                    : `Ready to send: ${receiptPhoto.name}`}
                                            </span>
                                        </label>
                                    )}
                                </div>
                            )}

                            {/* NO SIGNATURE, AND NO WAY ROUND THE PHOTOGRAPH.
                                The pad went when the pharmacy's own form
                                became the thing that gets signed. What has
                                gone now is the escape beside it: a typed
                                reason used to stand in for the photograph,
                                and `strokes` was still being sent empty.

                                The server requires courierFormFileId on
                                every delivery, controlled or not, so there
                                is nothing for this screen to offer instead.
                                A courier who cannot photograph the form has
                                not missed a field -- they cannot evidence
                                the handover, and "could not deliver" with a
                                reason is the honest record of that. */}

                            {/* CONTROLLED DRUG: BOTH PARTIES SIGN.

                                §6 of the courier offer letter. This form is
                                for recording a handover dispatch did not
                                make, so the second mark is whoever is signed
                                in here attesting to it, and the printed name
                                comes from their session rather than from a
                                box on this page that could say anybody. */}
                            {/* CONTROLLED: THE PHOTOGRAPH IS NOT OPTIONAL.
                                Both signatures are on the paper, so the photo
                                of it is what documents the two-signature
                                handoff §6 promises. This is the one place the
                                "say why there is no form" escape does not
                                apply: an ordinary counter may genuinely have
                                no form, a controlled item does not move
                                without one. The pad that stood here asked the
                                courier to sign a second time for the same
                                handover. */}
                            {order.controlled === true && (
                                <div className="izy-alert warn" role="status">
                                    This is a controlled drug. The photograph of the signed form is
                                    required: it carries both signatures, the person receiving it and yours.
                                </div>
                            )}

                            {/* The same three branches the server checks: a
                                photographed form, or a reason for not having
                                one. Plus the ID where the pharmacy stamped
                                it, and the courier's own mark on a controlled
                                handover, which has no escape. `detail` names
                                whichever is missing, which the grey sentence
                                under the old button never did here. */}
                            <CardButton
                                submit
                                title="Record the delivery"
                                tone="primary"
                                busy={busy}
                                disabled={signedName.trim() === ''
                                    || formPhoto === null
                                    || (order.idRequired === true && idPhoto === null)}
                                detail={[
                                    signedName.trim() === '' ? 'Add the printed name.' : '',
                                    formPhoto === null ? 'Photograph the signed form.' : '',
                                    order.idRequired === true && idPhoto === null ? 'Photograph the identification.' : '',
                                ].filter(Boolean).join(' ') || `Handed to ${signedName.trim()}`}
                            />
                            <CardButton title="Back" tone="quiet" compact disabled={busy} onClick={() => setChoice(null)} />
                        </form>
                    )}

                    {choice === 'doorstep' && (
                        <form className="izy-card" onSubmit={(e) => { void doorstep(e); }}>
                            <h2>Left at the door</h2>
                            {filesAvailable === false ? (
                                <div className="izy-alert warn" role="status">
                                    A doorstep delivery needs a photo, and photo storage is not switched on yet,
                                    so this cannot be recorded. Hand it over, or record it as could not deliver.
                                </div>
                            ) : (
                                <p className="izy-muted">
                                    Photograph where you left it, then say why nobody signed. Both are the proof
                                    of delivery for this stop, so neither is optional.
                                </p>
                            )}
                            <label className="izy-field">Photo of where you left it
                                <input
                                    ref={photoInput}
                                    type="file"
                                    accept={PHOTO_ACCEPT}
                                    /* NO `capture` ATTRIBUTE, DELIBERATELY.
                                     *
                                     * It used to read capture="environment",
                                     * which does two things: it opens the
                                     * rear camera straight away, and it
                                     * REMOVES the choice -- no photo library,
                                     * no file. One tap, no way round it.
                                     *
                                     * Reported from a real handset on 30
                                     * October: the in-page camera opened to a
                                     * black frame and would not show or take
                                     * anything. That sheet is the browser's,
                                     * not ours, and when it misbehaves -- the
                                     * camera held by another app, a
                                     * permission that needs re-granting, iOS
                                     * being iOS -- a courier at a door has no
                                     * second option and the delivery cannot
                                     * be recorded at all.
                                     *
                                     * Without the attribute the phone offers
                                     * its own chooser: Take Photo, Photo
                                     * Library, Browse. The camera is still
                                     * one tap away and it is now the phone's
                                     * own camera app rather than an embedded
                                     * sheet, which is the more reliable path.
                                     *
                                     * WHAT IT COSTS, SAID PLAINLY: a
                                     * photograph chosen from the library is
                                     * not necessarily of this doorstep today.
                                     * `capture` was never proof of that
                                     * either -- it is a hint a determined
                                     * person can sidestep -- but it did make
                                     * the lazy path the honest one. What
                                     * stands behind the photograph now is the
                                     * custody record: who recorded it, when,
                                     * and where, written at the moment of the
                                     * handover and append-only afterwards. */
                                    disabled={busy || filesAvailable === false}
                                    onChange={(e) => {
                                        /* THE CHECK THAT REFUSED THE CAMERA.
                                         *
                                         * This read `PHOTO_TYPES.includes(picked.type)`, and
                                         * `picked.type` is the browser's guess. A file from the
                                         * photo library carries a good one; a file from a camera
                                         * often carries `image/jpg`, which is not a registered
                                         * type, or nothing at all. So the courier took a
                                         * photograph and was told it was not a photo.
                                         *
                                         * lib/photos.ts decides the type instead of trusting it,
                                         * and answers null only when nothing can. */
                                        const picked = e.target.files?.[0] ?? null;
                                        const problem = picked === null ? null : photoProblem(picked);
                                        if (problem !== null) {
                                            setMsg({ kind: 'error', text: problem });
                                            setPhoto(null);
                                            return;
                                        }
                                        setMsg(null);
                                        setPhoto(picked);
                                    }}
                                />
                            </label>
                            {photo && <p className="izy-muted">Photo ready, {Math.round(photo.size / 1024)} KB.</p>}
                            <label className="izy-field">Why nobody signed
                                <input value={noSignatureReason} onChange={(e) => setNoSignatureReason(e.target.value)}
                                    placeholder="Nobody answered, left inside the screen door" required minLength={3} />
                            </label>
                            <CardButton
                                submit
                                title="Record the delivery"
                                tone="primary"
                                busy={busy}
                                disabled={photo === null || noSignatureReason.trim().length < 3 || filesAvailable === false}
                                detail={[
                                    photo === null ? 'Photograph where you left it.' : '',
                                    noSignatureReason.trim().length < 3 ? 'Say why nobody signed.' : '',
                                ].filter(Boolean).join(' ') || 'Both the photo and the reason are the proof for this stop'}
                            />
                            <CardButton
                                title="Back"
                                tone="quiet"
                                compact
                                disabled={busy}
                                onClick={() => { setChoice(null); setPhoto(null); if (photoInput.current) photoInput.current.value = ''; }}
                            />
                        </form>
                    )}

                    {choice === 'attempt' && (
                        <form className="izy-card" onSubmit={attempt}>
                            <h2>Could not deliver</h2>
                            <p className="izy-muted">
                                Say what happened to each item. The contract charges a flat fee per item for an
                                attempted delivery, so the reason is what the invoice line rests on.
                            </p>
                            {order.packages.map((p) => (
                                <div key={p.id} className="izy-stop">
                                    <div><b>{p.description || 'Package'}</b> · {p.quantity} {p.quantity === 1 ? 'item' : 'items'}</div>
                                    <label className="izy-field">Reason
                                        <select
                                            aria-label={`Reason for package ${p.id}`}
                                            value={reasons[p.id]?.code ?? ''}
                                            onChange={(e) => setReasons({ ...reasons, [p.id]: { code: e.target.value, note: reasons[p.id]?.note ?? '' } })}
                                        >
                                            <option value="">Choose a reason</option>
                                            {DRY_RUN_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                                        </select>
                                    </label>
                                    {reasons[p.id]?.code === 'other' && (
                                        <label className="izy-field">What happened
                                            <input
                                                aria-label={`Note for package ${p.id}`}
                                                value={reasons[p.id]?.note ?? ''}
                                                onChange={(e) => setReasons({ ...reasons, [p.id]: { code: 'other', note: e.target.value } })}
                                            />
                                        </label>
                                    )}
                                </div>
                            ))}
                            <CardButton
                                submit
                                title="Record the attempt"
                                tone="calmDanger"
                                busy={busy}
                                disabled={!attemptReady}
                                detail={attemptReady
                                    ? 'The contract charges per item attempted, so the reason is the invoice line'
                                    : 'Choose a reason for every item first'}
                            />
                            <CardButton title="Back" tone="quiet" compact disabled={busy} onClick={() => setChoice(null)} />
                        </form>
                    )}
                </>
            )}
            </Sheet>
        </Screen>
    );
}
