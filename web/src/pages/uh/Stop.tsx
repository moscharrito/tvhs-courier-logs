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
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { useProjectTimezone } from '../../app/auth';
import { Loading } from '../../app/Loading';
import { SignaturePad, pointCount, type SignatureStrokes } from './SignaturePad';
import { sendOrQueue, pendingFor, uploadPhotoNow } from '../../lib/outbox';

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
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** What a queued entry is called when the courier reads the list back. */
const LABELS: Record<string, string> = {
    arrive: 'Arrival', deliver: 'Delivery', doorstep: 'Doorstep delivery', attempt: 'Attempt',
};

type Choice = null | 'deliver' | 'doorstep' | 'attempt';

export function Stop() {
    const { code = '', orderId = '' } = useParams();
    const base = `/api/projects/${code}/uh/orders/${orderId}`;
    /* The deadline this stop is measured against is a wall-clock time in the
       project's zone, so it is shown in that zone and not the phone's. */
    const clock = clockFor(useProjectTimezone(code));

    const [order, setOrder] = useState<OrderDetail | null>(null);
    const [filesAvailable, setFilesAvailable] = useState<boolean | null>(null);
    /* ADDENDUM 2 CLAUSE 4. University Health forbid leaving a package
       anywhere unattended, and a delivery is not complete until a person has
       received it. The server refuses the doorstep endpoint outright; without
       this the screen would still offer the button, and a courier would
       photograph a porch, type a reason, submit, and be told no. Null while
       it loads, and the button stays hidden until the answer arrives: better
       a control that appears a moment late than one that cannot work. */
    const [handoverOnly, setHandoverOnly] = useState<boolean | null>(null);
    const [choice, setChoice] = useState<Choice>(null);
    const [signedName, setSignedName] = useState('');
    const [strokes, setStrokes] = useState<SignatureStrokes>([]);
    /* The courier's own mark, on a controlled drug (7.13). This form is the
       one dispatch uses when a phone has died, so whoever is signed in here
       is the person attesting; the server takes the printed name from their
       session rather than from this page. */
    const [noSignatureReason, setNoSignatureReason] = useState('');
    const [photo, setPhoto] = useState<File | null>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    /* THE SIGNATURE MOVED ONTO PAPER, and this screen was the last place
       still asking for it on glass. The pharmacy's own form is signed at the
       door and photographed; the strokes below stay as optional history.
       Identification is its own photograph and only where the form was
       stamped. Both are uploaded BEFORE the delivery is recorded -- see
       uploadPhotoNow for why that differs from the doorstep photo. */
    const [formPhoto, setFormPhoto] = useState<File | null>(null);
    const [idPhoto, setIdPhoto] = useState<File | null>(null);
    /* Its own, not the doorstep branch's: two forms sharing one box means
       typing in one silently fills the other. */
    const [noFormReason, setNoFormReason] = useState('');
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

    /**
     * Record what happened.
     *
     * Through the outbox, never straight at fetch. A courier standing in a
     * stairwell has still made the delivery, and being told to "check your
     * signal and try again" would mean doing it again later from memory, or
     * not at all.
     */
    async function post(path: string, body: Record<string, unknown>, ok: string, photo?: File) {
        setBusy(true);
        setMsg(null);
        const position = await currentPosition();
        try {
            const result = await sendOrQueue({
                url: `${base}/${path}`,
                body: { ...body, ...(position ?? {}) },
                label: `${LABELS[path] ?? path} for ${order!.recipientName}`,
                orderId: order!.id,
                ...(photo ? { photo: { blob: photo, contentType: photo.type, kind: 'doorstep', bodyKey: 'fileId' } } : {}),
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
            setStrokes([]);
            setSignedName('');
            setPhoto(null);
            setNoSignatureReason('');
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'That did not save. Try again.' });
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
        void (async () => {
            setBusy(true);
            setMsg(null);
            const ids: Record<string, number> = {};
            try {
                for (const [file, kind, key, label] of [
                    [formPhoto, 'courier_form', 'courierFormFileId', 'signed form'],
                    [idPhoto, 'patient_id', 'patientIdFileId', 'identification'],
                ] as const) {
                    if (file === null) continue;
                    ids[key] = await uploadPhotoNow({
                        module: `/api/projects/${code}/uh`, orderId: order.id, blob: file,
                        contentType: file.type, kind,
                        idemKey: `${order.id}-${kind}-${file.size}-${file.lastModified}`,
                    });
                }
            } catch (err) {
                setBusy(false);
                /* NOTHING IS RECORDED. A handover whose proof did not upload
                   is one we cannot evidence, and where the form was stamped
                   it is one the pharmacy forbade outright. */
                setMsg({
                    kind: 'error',
                    text: `The photo could not be sent: ${err instanceof Error ? err.message : 'unknown error'}. `
                        + 'Nothing was recorded. Try again, or record this as could not deliver.',
                });
                return;
            }
            setBusy(false);
            void post('deliver', {
                signedName: signedName.trim(),
                strokes,
                ...(formPhoto === null ? { noSignatureReason: noFormReason.trim() } : {}),
                ...ids,
            }, 'Delivered and recorded.');
        })();
    };

    const doorstep = (e: FormEvent) => {
        e.preventDefault();
        if (!photo) return;
        /* The photo travels with the event rather than being uploaded first.
           The queue puts it in the bucket and only then sends the delivery, so
           a doorstep drop is never claimed without the photo behind it, on a
           signal or off one. */
        void post('doorstep', { noSignatureReason: noSignatureReason.trim() }, 'Left at the door and photographed.', photo);
    };

    const attempt = (e: FormEvent) => {
        e.preventDefault();
        const packages = order.packages
            .filter((p) => reasons[p.id]?.code)
            .map((p) => ({ packageId: p.id, reasonCode: reasons[p.id]!.code, note: reasons[p.id]!.note ?? '' }));
        void post('attempt', { packages }, 'Recorded as a dry run.');
    };

    const attemptReady = order.packages.length > 0
        && order.packages.every((p) => reasons[p.id]?.code)
        && order.packages.every((p) => reasons[p.id]?.code !== 'other' || (reasons[p.id]?.note ?? '').trim() !== '');

    return (
        <>
            <h1>Stop</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}/my-run`}>Today</Link> · order {order.id} · {order.serviceType}
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            <div className="izy-card izy-next">
                <p className="izy-next-name">{order.recipientName}</p>
                <p className="izy-next-address">{order.address}<br />{order.city} {order.zip}</p>
                <p className="izy-muted">
                    due {clock(order.dueAt)}
                    {order.arrivedAt && <> · arrived {clock(order.arrivedAt)}</>}
                    {needsSignature && <> · <b>signature required</b></>}
                </p>
                {order.deliveryNotes && <p>{order.deliveryNotes}</p>}
                {order.recipientPhone && <a className="izy-btn secondary" href={`tel:${order.recipientPhone}`}>Call recipient</a>}
            </div>

            {queuedHere && !closed && (
                <div className="izy-card">
                    <h2>Waiting to send</h2>
                    <p>
                        What you recorded at this stop is saved on this phone and has not reached dispatch
                        yet. It will go as soon as you have signal. There is nothing else to do here.
                    </p>
                    <Link className="izy-btn" to={`/projects/${code}/my-run`}>Back to today</Link>
                </div>
            )}

            {closed ? (
                <div className="izy-card">
                    <h2>Finished</h2>
                    <p>This stop is recorded as <b>{order.status}</b>.</p>
                    <Link className="izy-btn" to={`/projects/${code}/my-run`}>Back to today</Link>
                </div>
            ) : (
                <>
                    {order.arrivedAt === null && !queuedHere && (
                        <div className="izy-card">
                            <h2>Arrived?</h2>
                            <p className="izy-muted">
                                Tap this when you reach the address. It is the time the delivery is measured
                                against, so it counts even if nobody answers.
                            </p>
                            {/* Says it is working. Fixing a position can take
                                several seconds on a phone with a poor view of
                                the sky, and a button that looks inert is a
                                button a courier taps twice. */}
                            <button className="izy-btn" type="button" disabled={busy}
                                onClick={() => { void post('arrive', {}, 'Arrival recorded.'); }}>
                                {busy ? 'Recording' : 'I have arrived'}
                            </button>
                        </div>
                    )}

                    {choice === null && !queuedHere && (
                        <div className="izy-card">
                            <h2>How did it go?</h2>
                            <div className="izy-row">
                                <button className="izy-btn" type="button" disabled={busy} onClick={() => setChoice('deliver')}>
                                    Handed over
                                </button>
                                {/* Only when the medication allows it (Scope 1.2.3) AND the
                                    contract does (Addendum 2 clause 4, which supersedes it
                                    for University Health). */}
                                {!needsSignature && handoverOnly === false && (
                                    <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => setChoice('doorstep')}>
                                        Left at the door
                                    </button>
                                )}
                                <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => setChoice('attempt')}>
                                    Could not deliver
                                </button>
                            </div>
                            {needsSignature && (
                                <p className="izy-muted">
                                    This one needs a signature, so it cannot be left at the door.
                                    If nobody can sign, record it as could not deliver.
                                </p>
                            )}
                        </div>
                    )}

                    {choice === 'deliver' && (
                        <form className="izy-card" onSubmit={deliver}>
                            <h2>Handed over</h2>
                            <label className="izy-field">Printed name of the person receiving it
                                <input value={signedName} onChange={(e) => setSignedName(e.target.value)} required />
                            </label>
                            {/* THE PAPER IS THE PROOF NOW. The pharmacy's own
                                form is signed at the door and photographed;
                                these strokes are optional history. That is a
                                downgrade in evidence quality -- a photograph
                                of a form is a photograph, where strokes were
                                the movement of the pen -- made knowingly
                                because the client's own document is the
                                record. See the Deliver schema in stop.ts. */}
                            <label className="izy-field">Photo of the signed form
                                <input
                                    type="file"
                                    accept={PHOTO_TYPES.join(',')}
                                    capture="environment"
                                    disabled={busy}
                                    onChange={(e) => setFormPhoto(e.target.files?.[0] ?? null)}
                                />
                                <span className="izy-muted izy-field-note">
                                    {formPhoto === null
                                        ? 'The pharmacy form the recipient signed.'
                                        : `Ready to send: ${formPhoto.name}`}
                                </span>
                            </label>

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
                                            accept={PHOTO_TYPES.join(',')}
                                            capture="environment"
                                            disabled={busy}
                                            onChange={(e) => setIdPhoto(e.target.files?.[0] ?? null)}
                                        />
                                        <span className="izy-muted izy-field-note">
                                            {idPhoto === null ? 'Required for this delivery.' : `Ready to send: ${idPhoto.name}`}
                                        </span>
                                    </label>
                                </div>
                            )}

                            {/* THE RECIPIENT'S SIGNATURE PAD IS GONE.
                                The pharmacy's form is signed on paper and
                                photographed above, so asking for a scrawl on
                                glass as well was asking the same person to
                                sign twice. The server accepts a photographed
                                form, strokes, or a stated reason -- see
                                deliver.noProof in stop.ts -- and this screen
                                now offers the first and the third.

                                `strokes` is still sent, always empty, rather
                                than removed: the column and the capture
                                method are history for every delivery already
                                recorded with one. */}
                            {formPhoto === null && (
                                <label className="izy-field">If there is no signed form, say why
                                    <input
                                        value={noFormReason}
                                        onChange={(e) => setNoFormReason(e.target.value)}
                                        placeholder="e.g. the pharmacy sent no form with this one"
                                        disabled={busy}
                                    />
                                    <span className="izy-muted izy-field-note">
                                        A delivery with no proof and no explanation is a gap nobody can
                                        account for a year later.
                                    </span>
                                </label>
                            )}

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

                            <div className="izy-row">
                                <button
                                    className="izy-btn"
                                    type="submit"
                                    /* The same three branches the server
                                       checks: a photographed form, or a
                                       reason for not having one. Plus the ID
                                       where the pharmacy stamped it, and the
                                       courier's own mark on a controlled
                                       handover, which has no escape. */
                                    disabled={busy || signedName.trim() === ''
                                        || (formPhoto === null && noFormReason.trim().length < 3)
                                        || (order.idRequired === true && idPhoto === null)
                                        || (order.controlled === true && formPhoto === null)}
                                >
                                    {busy ? 'Saving' : 'Record the delivery'}
                                </button>
                                <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => setChoice(null)}>Back</button>
                            </div>
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
                                    accept={PHOTO_TYPES.join(',')}
                                    /* Opens the camera on a phone rather than the photo library. */
                                    capture="environment"
                                    disabled={busy || filesAvailable === false}
                                    onChange={(e) => {
                                        const picked = e.target.files?.[0] ?? null;
                                        if (picked && !PHOTO_TYPES.includes(picked.type)) {
                                            setMsg({ kind: 'error', text: 'That is not a photo this app can store. Use the camera.' });
                                            setPhoto(null);
                                            return;
                                        }
                                        if (picked && picked.size > MAX_PHOTO_BYTES) {
                                            setMsg({ kind: 'error', text: 'That photo is too large to send. Take another.' });
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
                            <div className="izy-row">
                                <button className="izy-btn" type="submit"
                                    disabled={busy || photo === null || noSignatureReason.trim().length < 3 || filesAvailable === false}>
                                    {busy ? 'Sending the photo' : 'Record the delivery'}
                                </button>
                                <button className="izy-btn secondary" type="button" disabled={busy}
                                    onClick={() => { setChoice(null); setPhoto(null); if (photoInput.current) photoInput.current.value = ''; }}>
                                    Back
                                </button>
                            </div>
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
                            <div className="izy-row">
                                <button className="izy-btn" type="submit" disabled={busy || !attemptReady}>
                                    {busy ? 'Saving' : 'Record the attempt'}
                                </button>
                                <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => setChoice(null)}>Back</button>
                            </div>
                        </form>
                    )}
                </>
            )}
        </>
    );
}
