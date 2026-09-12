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
 * needs a reason and is then allowed through. A courier holding medication
 * they cannot hand back is worse than a record with an explanation on it.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { SignaturePad, pointCount, type SignatureStrokes } from './SignaturePad';

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
    const base = `/api/projects/${code}/uh/returns`;

    const [load, setLoad] = useState<Load | null>(null);
    const [siteId, setSiteId] = useState<number | ''>('');
    const [signedName, setSignedName] = useState('');
    const [strokes, setStrokes] = useState<SignatureStrokes>([]);
    const [counted, setCounted] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<ReturnResult | null>(null);
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

    if (load === null) return <div className="izy-card"><Loading label="Loading what you are carrying" /></div>;

    const group = load.destinations.find((d) => d.site.id === siteId) ?? null;
    const expected = group?.packages ?? 0;
    const countedNumber = counted === '' ? null : Number(counted);
    const mismatch = countedNumber !== null && countedNumber !== expected;
    const ready = group !== null && signedName.trim() !== '' && pointCount(strokes) > 2 && countedNumber !== null
        && (!mismatch || note.trim() !== '');

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!ready || group === null) return;
        setBusy(true);
        setMsg(null);
        const position = await currentPosition();
        try {
            const result = await api<ReturnResult>(base, {
                method: 'POST',
                json: {
                    siteId: group.site.id,
                    signedName: signedName.trim(),
                    strokes,
                    countedPackages: countedNumber,
                    /* The orders are named explicitly. The courier is looking
                       at a list and handing over that list; letting the server
                       recompute the batch between the two would hand back
                       something the courier never saw. */
                    orderIds: group.orders.map((o) => o.orderId),
                    note: note.trim(),
                    ...(position ?? {}),
                },
            });
            setDone(result);
            setStrokes([]);
            setSignedName('');
            setCounted('');
            setNote('');
            setSiteId('');
            await refresh();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not record the return. Check your signal and try again.' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <h1>Take back</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}/my-run`}>Today</Link> · undelivered packages
            </p>

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

            {load.destinations.length === 0 ? (
                <div className="izy-card">
                    <p>Nothing undelivered is still with you.</p>
                    <Link className="izy-btn" to={`/projects/${code}/my-run`}>Back to today</Link>
                </div>
            ) : (
                <form onSubmit={(e) => { void submit(e); }}>
                    <div className="izy-card">
                        <h2>Still with you</h2>
                        <p className="izy-muted">
                            {load.totals.orders} {load.totals.orders === 1 ? 'order' : 'orders'},
                            {' '}{load.totals.packages} {load.totals.packages === 1 ? 'package' : 'packages'}.
                            These still count as attempted: taking them back does not change that.
                        </p>
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
                                <details>
                                    <summary>What you are handing back</summary>
                                    <ul className="izy-plain-list">
                                        {group.orders.map((o) => (
                                            <li key={o.orderId}>
                                                {o.recipientName} · {o.packages} {o.packages === 1 ? 'package' : 'packages'}
                                                {o.externalRef && <> · {o.externalRef}</>}
                                                <br />
                                                <span className="izy-muted">from {o.from}{o.failureReason && <> · {o.failureReason}</>}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            </div>

                            <div className="izy-card">
                                <h2>Pharmacy signature</h2>
                                <p className="izy-muted">
                                    The printed name and signature of the person taking them back. The contract asks
                                    for both on every handover, not only at delivery.
                                </p>
                                <label className="izy-field">Printed name
                                    <input value={signedName} onChange={(e) => setSignedName(e.target.value)} required placeholder="Name of the pharmacy staff member" />
                                </label>
                                <SignaturePad label="Pharmacy signature" strokes={strokes} onChange={setStrokes} disabled={busy} />
                            </div>

                            <div className="izy-card">
                                <button className="izy-btn" type="submit" disabled={!ready || busy}>
                                    {busy ? 'Recording' : `Hand back ${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`}
                                </button>
                                {!ready && (
                                    <p className="izy-muted">
                                        {signedName.trim() === '' && 'Add the printed name. '}
                                        {pointCount(strokes) <= 2 && 'Add the signature. '}
                                        {countedNumber === null && 'Count the packages. '}
                                        {mismatch && note.trim() === '' && 'Say why the count is different.'}
                                    </p>
                                )}
                            </div>
                        </>
                    )}
                </form>
            )}
        </>
    );
}
