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
import { Loading } from '../../app/Loading';
import { SignaturePad, pointCount, type SignatureStrokes } from './SignaturePad';

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

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');

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

/**
 * Put the photo in the bucket and return the file id.
 *
 * Three steps, in this order: ask for a signed URL, PUT the bytes straight to
 * S3, then tell the server the object is there. The bytes never pass through
 * our server, so a photo does not sit in a request log, and the file counts as
 * stored only once it actually is: the doorstep endpoint refuses a file that
 * was never confirmed, which is what keeps a proof of delivery honest when a
 * phone dies halfway through.
 */
async function uploadPhoto(code: string, orderId: number, photo: File): Promise<number> {
    const created = await api<{ id: number; upload: { url: string; method: string; headers: Record<string, string> } }>(
        `/api/projects/${code}/uh/files`,
        { method: 'POST', json: { kind: 'doorstep', contentType: photo.type, bytes: photo.size, orderId } },
    );
    // Straight to S3, so no credentials and no cookies go with it.
    const put = await fetch(created.upload.url, {
        method: created.upload.method,
        headers: created.upload.headers,
        body: photo,
        credentials: 'omit',
        mode: 'cors',
    });
    if (!put.ok) throw new ApiError(put.status, 'The photo did not upload. Check your signal and try again.');
    await api(`/api/projects/${code}/uh/files/${created.id}/stored`, { method: 'POST', json: { bytes: photo.size } });
    return created.id;
}

type Choice = null | 'deliver' | 'doorstep' | 'attempt';

export function Stop() {
    const { code = '', orderId = '' } = useParams();
    const base = `/api/projects/${code}/uh/orders/${orderId}`;

    const [order, setOrder] = useState<OrderDetail | null>(null);
    const [filesAvailable, setFilesAvailable] = useState<boolean | null>(null);
    const [choice, setChoice] = useState<Choice>(null);
    const [signedName, setSignedName] = useState('');
    const [strokes, setStrokes] = useState<SignatureStrokes>([]);
    const [noSignatureReason, setNoSignatureReason] = useState('');
    const [photo, setPhoto] = useState<File | null>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    const [reasons, setReasons] = useState<Record<number, { code: string; note: string }>>({});
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string; details?: string[] } | null>(null);

    const load = useCallback(async () => {
        try { setOrder(await api<OrderDetail>(base)); } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach dispatch.' });
        }
    }, [base]);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        api<{ available: boolean }>(`/api/projects/${code}/uh/files/status/check`)
            .then((s) => setFilesAvailable(s.available))
            .catch(() => setFilesAvailable(false));
    }, [code]);

    if (order === null) {
        return msg
            ? (<><h1>Stop</h1><div className="izy-alert error" role="alert">{msg.text}</div></>)
            : <div className="izy-card"><Loading label="Loading the stop" /></div>;
    }

    const needsSignature = order.signatureRequired || order.packages.some((p) => p.signatureRequired);
    const closed = ['delivered', 'failed', 'cancelled'].includes(order.status);

    async function post(path: string, body: Record<string, unknown>, ok: string) {
        setBusy(true);
        setMsg(null);
        const position = await currentPosition();
        try {
            await api(`${base}/${path}`, { method: 'POST', json: { ...body, ...(position ?? {}) } });
            setMsg({ kind: 'ok', text: ok });
            setChoice(null);
            setStrokes([]);
            setSignedName('');
            setPhoto(null);
            setNoSignatureReason('');
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'That did not save. Check your signal and try again.' });
        } finally {
            setBusy(false);
        }
    }

    const deliver = (e: FormEvent) => {
        e.preventDefault();
        void post('deliver', { signedName: signedName.trim(), strokes }, 'Delivered and signed for.');
    };

    const doorstep = async (e: FormEvent) => {
        e.preventDefault();
        if (!photo) return;
        setBusy(true);
        setMsg(null);
        try {
            const fileId = await uploadPhoto(code, order!.id, photo);
            // The photo exists before the delivery is claimed, never after.
            await post('doorstep', { fileId, noSignatureReason: noSignatureReason.trim() }, 'Left at the door and photographed.');
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'The photo did not upload. Check your signal and try again.' });
        } finally {
            setBusy(false);
        }
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

            {closed ? (
                <div className="izy-card">
                    <h2>Finished</h2>
                    <p>This stop is recorded as <b>{order.status}</b>.</p>
                    <Link className="izy-btn" to={`/projects/${code}/my-run`}>Back to today</Link>
                </div>
            ) : (
                <>
                    {order.arrivedAt === null && (
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

                    {choice === null && (
                        <div className="izy-card">
                            <h2>How did it go?</h2>
                            <div className="izy-row">
                                <button className="izy-btn" type="button" disabled={busy} onClick={() => setChoice('deliver')}>
                                    Handed over
                                </button>
                                {/* Only when the medication allows it (Scope 1.2.3). */}
                                {!needsSignature && (
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
                            <SignaturePad label="Recipient signature" strokes={strokes} onChange={setStrokes} disabled={busy} />
                            <div className="izy-row">
                                <button className="izy-btn" type="submit" disabled={busy || signedName.trim() === '' || pointCount(strokes) <= 2}>
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
