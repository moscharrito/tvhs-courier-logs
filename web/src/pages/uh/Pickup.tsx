/* Collecting a batch at the pharmacy counter.
 *
 * One pharmacy at a time, because that is where the courier is standing, and
 * one signature for the batch, because a technician handing over forty
 * packages signs once.
 *
 * The count is asked for rather than shown: pre-filling it with the expected
 * number would turn "confirm the count" into "tap continue", which is the
 * failure this screen exists to prevent. A mismatch needs a reason and is
 * then allowed through, because a short handover is a real thing that has to
 * reach the record rather than be argued with on a phone.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { SignaturePad, pointCount, type SignatureStrokes } from './SignaturePad';
import { sendOrQueue } from '../../lib/outbox';

interface WaitingOrder { orderId: number; sequence: number; recipientName: string; externalRef: string; packages: number }
interface SiteGroup { site: { id: number; code: string; name: string }; orders: WaitingOrder[]; packages: number }
interface Waiting { runId: number; courierUsername: string; sites: SiteGroup[]; totals: { orders: number; packages: number } }

interface PickupResult {
    collected: number[];
    refused: Array<{ orderId: number; error: string }>;
    expectedPackages: number;
    countedPackages: number;
    discrepancy: number;
    notes: string[];
    remaining: SiteGroup[];
}

/** Ask the phone where it is, and carry on without it if it says no. */
async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
        const done = (value: { lat: number; lng: number } | null) => resolve(value);
        const timer = setTimeout(() => done(null), 8000);
        navigator.geolocation.getCurrentPosition(
            (pos) => { clearTimeout(timer); done({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
            () => { clearTimeout(timer); done(null); },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
        );
    });
}

export function Pickup() {
    const { code = '', runId = '' } = useParams();
    const [params] = useSearchParams();
    const base = `/api/projects/${code}/uh/runs/${runId}`;

    const [waiting, setWaiting] = useState<Waiting | null>(null);
    const [siteId, setSiteId] = useState<number | ''>(params.get('siteId') ? Number(params.get('siteId')) : '');
    const [signedName, setSignedName] = useState('');
    const [strokes, setStrokes] = useState<SignatureStrokes>([]);
    const [counted, setCounted] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<PickupResult | null>(null);
    const [queued, setQueued] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string; details?: string[] } | null>(null);

    const load = useCallback(async () => {
        try {
            const w = await api<Waiting>(`${base}/pickup`);
            setWaiting(w);
            setSiteId((current) => (current === '' && w.sites.length === 1 ? w.sites[0]!.site.id : current));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach dispatch.' });
            setWaiting({ runId: Number(runId), courierUsername: '', sites: [], totals: { orders: 0, packages: 0 } });
        }
    }, [base, runId]);
    useEffect(() => { void load(); }, [load]);

    if (waiting === null) return <div className="izy-card"><Loading label="Loading the pickup" /></div>;

    const group = waiting.sites.find((s) => s.site.id === siteId) ?? null;
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
            /* Through the outbox: pharmacy counters are indoors, often in a
               basement, and a courier who cannot record a pickup cannot start
               the run. */
            const outcome = await sendOrQueue({
                url: `${base}/pickup`,
                body: {
                    siteId: group.site.id,
                    signedName: signedName.trim(),
                    strokes,
                    countedPackages: countedNumber,
                    note: note.trim(),
                    ...(position ?? {}),
                },
                label: `Pickup at ${group.site.name}`,
                orderId: null,
            });
            if (outcome.sent) {
                setDone(outcome.body as unknown as PickupResult);
            } else {
                setQueued(true);
            }
            setStrokes([]);
            setSignedName('');
            setCounted('');
            setNote('');
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not record the pickup. Try again.' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <h1>Pick up</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}/my-run`}>Today</Link> · run {runId}
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {done && (
                <div className="izy-alert ok" role="status">
                    Collected {done.collected.length} {done.collected.length === 1 ? 'order' : 'orders'}.
                    {done.notes.length > 0 && <ul>{done.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                </div>
            )}

            {queued && (
                <div className="izy-alert warn" role="status">
                    Saved on this phone. The pickup will be sent as soon as you have signal, and the list
                    above will catch up then. Load the vehicle and go.
                </div>
            )}

            {waiting.sites.length === 0 ? (
                <div className="izy-card">
                    <p>Nothing left to collect on this run.</p>
                    <Link className="izy-btn" to={`/projects/${code}/my-run`}>Back to today</Link>
                </div>
            ) : (
                <form onSubmit={(e) => { void submit(e); }}>
                    <div className="izy-card">
                        <h2>Which pharmacy</h2>
                        <label className="izy-field">Pharmacy
                            <select value={siteId} onChange={(e) => { setSiteId(e.target.value === '' ? '' : Number(e.target.value)); setCounted(''); }}>
                                <option value="">Choose where you are</option>
                                {waiting.sites.map((s) => (
                                    <option key={s.site.id} value={s.site.id}>
                                        {s.site.name} ({s.orders.length} {s.orders.length === 1 ? 'order' : 'orders'}, {s.packages} packages)
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>

                    {group && (
                        <>
                            <div className="izy-card">
                                <h2>Count the packages</h2>
                                <p className="izy-muted">
                                    {group.orders.length} {group.orders.length === 1 ? 'order' : 'orders'} for this pharmacy.
                                    Count what you are actually given and type it in.
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
                                        The list expects {expected}. Say why the count is different before you continue.
                                        <label className="izy-field" style={{ marginTop: 8 }}>Reason
                                            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="One item not ready" />
                                        </label>
                                    </div>
                                )}
                                <details>
                                    <summary>What is in this batch</summary>
                                    <ul className="izy-plain-list">
                                        {group.orders.map((o) => (
                                            <li key={o.orderId}>
                                                {o.recipientName} · {o.packages} {o.packages === 1 ? 'package' : 'packages'}
                                                {o.externalRef && <> · {o.externalRef}</>}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            </div>

                            <div className="izy-card">
                                <h2>Pharmacy signature</h2>
                                <p className="izy-muted">
                                    The printed name and the signature of the person handing the packages over.
                                    The contract asks for both.
                                </p>
                                <label className="izy-field">Printed name
                                    <input value={signedName} onChange={(e) => setSignedName(e.target.value)} required placeholder="Name of the pharmacy staff member" />
                                </label>
                                <SignaturePad label="Pharmacy signature" strokes={strokes} onChange={setStrokes} disabled={busy} />
                            </div>

                            <div className="izy-card">
                                <button className="izy-btn" type="submit" disabled={!ready || busy}>
                                    {busy ? 'Recording' : `Take custody of ${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`}
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
