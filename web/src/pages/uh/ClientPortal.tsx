/* What a University Health pharmacist sees.
 *
 * The screen answers the question a pharmacist actually rings us about: where
 * is the medication I sent this morning, and what happened to the one that did
 * not arrive. So today is the default, the counts are at the top, and anything
 * that failed is at the top of the list rather than sorted by time with the
 * failures buried in the middle.
 *
 * It shows their own pharmacies only, and nothing about our couriers beyond a
 * first name. Both of those are enforced by the server; this screen never
 * receives the rest, which is why it cannot leak it by accident later.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { useAuth } from '../../app/auth';
import { slaLabel, type Sla } from './Orders';

interface Pharmacy { id: number; code: string; name: string }

interface ClientOrder {
    id: number; reference: string; serviceType: string; serviceDate: string;
    pharmacy: string; recipientName: string; address: string; city: string; zip: string;
    status: string; receivedAt: string; dueAt: string | null; pickedUpAt: string | null;
    arrivedAt: string | null; deliveredAt: string | null; returnedAt: string | null;
    receivedBy: string; noSignatureReason: string; failureReason: string;
    courier: string; sla: Sla;
}

interface ListResponse {
    from: string; to: string; pharmacies: Pharmacy[];
    orders: ClientOrder[]; truncated: boolean; notes: string[];
}

interface SummaryResponse {
    serviceDate: string; timezone: string; pharmacies: Pharmacy[];
    byStatus: Record<string, number>; total: number;
    outstanding: number; delivered: number; notDelivered: number; notes: string[];
}

const STATUS_LABEL: Record<string, string> = {
    pending: 'Received by us', ready: 'Waiting for a courier', assigned: 'Courier assigned',
    picked_up: 'On the way', delivered: 'Delivered', failed: 'Not delivered', cancelled: 'Cancelled',
};

const clock = (iso: string | null) =>
    (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');

/** Failures first: they are the only rows that need a person to do something. */
const needsAttention = (o: ClientOrder) => o.status === 'failed' || o.sla.state === 'overdue';

export function ClientPortal() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const [params, setParams] = useSearchParams();
    const base = `/api/projects/${code}/uh/client`;

    const [summary, setSummary] = useState<SummaryResponse | null>(null);
    const [list, setList] = useState<ListResponse | null>(null);
    const [open, setOpen] = useState<number | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    const status = params.get('status') ?? '';
    const reference = params.get('reference') ?? '';
    const siteId = params.get('siteId') ?? '';

    const query = new URLSearchParams();
    if (from) query.set('from', from);
    if (to) query.set('to', to || from);
    if (status) query.set('status', status);
    if (reference) query.set('reference', reference);
    if (siteId) query.set('siteId', siteId);
    const qs = query.toString();

    const load = useCallback(async () => {
        setMsg(null);
        try {
            const [s, l] = await Promise.all([
                api<SummaryResponse>(`${base}/summary`),
                api<ListResponse>(`${base}/orders${qs ? `?${qs}` : ''}`),
            ]);
            setSummary(s);
            setList(l);
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not load your deliveries.');
        }
    }, [base, qs]);
    useEffect(() => { void load(); }, [load]);

    if (!project) {
        return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    }
    if (summary === null || list === null) {
        return msg
            ? (<><h1>Deliveries</h1><div className="izy-alert error" role="alert">{msg}</div></>)
            : <div className="izy-card"><Loading label="Loading your deliveries" /></div>;
    }

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        if (value === '') next.delete(key); else next.set(key, value);
        setParams(next, { replace: true });
    };

    const rows = [...list.orders].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
    const detail = rows.find((o) => o.id === open) ?? null;

    return (
        <>
            <h1>Deliveries</h1>
            <p className="izy-sub">
                {summary.pharmacies.map((p) => p.name).join(', ') || 'No pharmacies assigned'}
                {' · '}{summary.serviceDate}
            </p>

            {msg && <div className="izy-alert error" role="alert">{msg}</div>}
            {summary.notes.map((n) => (
                <div key={n} className="izy-alert warn" role="status">{n}</div>
            ))}

            <div className="izy-card">
                <h2>Today</h2>
                <div className="izy-stats">
                    <div><b>{summary.total}</b><span>sent to us</span></div>
                    <div><b>{summary.outstanding}</b><span>still out</span></div>
                    <div><b>{summary.delivered}</b><span>delivered</span></div>
                    <div className={summary.notDelivered > 0 ? 'izy-stat-bad' : undefined}>
                        <b>{summary.notDelivered}</b><span>not delivered</span>
                    </div>
                </div>
            </div>

            <div className="izy-card">
                <div className="izy-row">
                    <label className="izy-field">From
                        <input type="date" value={from} onChange={(e) => set('from', e.target.value)} />
                    </label>
                    <label className="izy-field">To
                        <input type="date" value={to} onChange={(e) => set('to', e.target.value)} />
                    </label>
                    <label className="izy-field">Status
                        <select value={status} onChange={(e) => set('status', e.target.value)}>
                            <option value="">any</option>
                            {Object.entries(STATUS_LABEL).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                            ))}
                        </select>
                    </label>
                    {summary.pharmacies.length > 1 && (
                        <label className="izy-field">Pharmacy
                            <select value={siteId} onChange={(e) => set('siteId', e.target.value)}>
                                <option value="">any</option>
                                {summary.pharmacies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </label>
                    )}
                    <label className="izy-field">Your reference
                        <input
                            value={reference}
                            onChange={(e) => set('reference', e.target.value)}
                            placeholder="RX-1234"
                        />
                    </label>
                    <button className="izy-btn secondary" type="button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                        Clear
                    </button>
                </div>
                {/* Said plainly, because a pharmacist will otherwise try it and
                    assume the system is broken when it returns nothing. */}
                <p className="izy-muted">
                    Search by your own reference. Patient names are deliberately not searchable:
                    a name typed into a search box ends up in browser history and server logs.
                </p>
            </div>

            <div className="izy-card">
                <div className="izy-row-between">
                    <h2>{list.from === list.to ? list.from : `${list.from} to ${list.to}`}</h2>
                    <span className="izy-muted">{rows.length} {rows.length === 1 ? 'delivery' : 'deliveries'}</span>
                </div>
                {list.truncated && (
                    <div className="izy-alert warn" role="status">
                        Showing the first 500. Narrow the dates to see the rest.
                    </div>
                )}
                {rows.length === 0 ? (
                    <p className="izy-muted">Nothing for this day.</p>
                ) : (
                    <table className="izy-table">
                        <thead>
                            <tr>
                                <th>Patient</th><th>Address</th><th>Status</th><th>Times</th><th>Courier</th><th />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((o) => (
                                <tr key={o.id} className={needsAttention(o) ? 'izy-row-bad' : undefined}>
                                    <td>
                                        {o.recipientName}
                                        {o.reference && <><br /><code>{o.reference}</code></>}
                                    </td>
                                    <td>{o.address}<br /><span className="izy-muted">{o.city} {o.zip}</span></td>
                                    <td>
                                        {STATUS_LABEL[o.status] ?? o.status}
                                        {o.status === 'failed' && o.failureReason && (
                                            <><br /><span className="izy-muted">{o.failureReason.replace(/_/g, ' ')}</span></>
                                        )}
                                        {o.status !== 'delivered' && o.status !== 'failed' && (
                                            <><br /><span className="izy-muted">{slaLabel(o.sla).text}</span></>
                                        )}
                                    </td>
                                    <td className="izy-muted">
                                        {o.pickedUpAt && <>collected {clock(o.pickedUpAt)}<br /></>}
                                        {o.arrivedAt && <>arrived {clock(o.arrivedAt)}<br /></>}
                                        {o.deliveredAt && <>delivered {clock(o.deliveredAt)}</>}
                                        {!o.pickedUpAt && <>due {clock(o.dueAt)}</>}
                                    </td>
                                    <td>{o.courier || <span className="izy-muted">not yet</span>}</td>
                                    <td>
                                        <button className="izy-btn secondary small" type="button" onClick={() => setOpen(o.id === open ? null : o.id)}>
                                            {o.id === open ? 'Hide' : 'Proof'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {detail && <ProofOfDelivery code={code} order={detail} onClose={() => setOpen(null)} />}
        </>
    );
}

interface DetailResponse extends ClientOrder {
    packages: Array<{ description: string; quantity: number; signatureRequired: boolean; outcome: string; failureReason: string; failureNote: string }>;
    timeline: Array<{ type: string; at: string; by: string; signedName: string; reason: string }>;
    proofOfDelivery: { available: boolean; reason: string };
}

const EVENT_LABEL: Record<string, string> = {
    picked_up: 'Collected from the pharmacy', arrived: 'Courier arrived',
    delivered: 'Handed over', attempted: 'Could not deliver', returned: 'Returned to the pharmacy',
};

/** The proof of delivery, on screen. The printable document is ticket 3.2. */
function ProofOfDelivery({ code, order, onClose }: { code: string; order: ClientOrder; onClose: () => void }) {
    const [detail, setDetail] = useState<DetailResponse | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    useEffect(() => {
        setDetail(null);
        api<DetailResponse>(`/api/projects/${code}/uh/client/orders/${order.id}`)
            .then(setDetail)
            .catch((err: unknown) => setMsg(err instanceof ApiError ? err.message : 'Could not load that delivery.'));
    }, [code, order.id]);

    return (
        /* A section, not a div: a div with an aria-label has no role, so the
           label names nothing and a screen reader user cannot jump to it. */
        <section className="izy-card izy-next" aria-label={`Proof of delivery for ${order.recipientName}`}>
            <div className="izy-row-between">
                <h2>{order.recipientName}</h2>
                <button className="izy-btn secondary small" type="button" onClick={onClose}>Close</button>
            </div>
            {msg && <div className="izy-alert error" role="alert">{msg}</div>}
            {!detail ? <Loading label="Loading the proof of delivery" /> : (
                <>
                    <table className="izy-table">
                        <tbody>
                            <tr><th>Your reference</th><td>{detail.reference || 'none'}</td></tr>
                            <tr><th>From</th><td>{detail.pharmacy}</td></tr>
                            <tr><th>To</th><td>{detail.address}, {detail.city} {detail.zip}</td></tr>
                            <tr><th>Service</th><td>{detail.serviceType}</td></tr>
                            <tr><th>Status</th><td>{STATUS_LABEL[detail.status] ?? detail.status}</td></tr>
                            {detail.receivedBy && <tr><th>Signed for by</th><td>{detail.receivedBy}</td></tr>}
                            {detail.noSignatureReason && <tr><th>Left without a signature</th><td>{detail.noSignatureReason}</td></tr>}
                            <tr><th>Courier</th><td>{detail.courier || 'not yet assigned'}</td></tr>
                        </tbody>
                    </table>

                    <h3>What was sent</h3>
                    <ul className="izy-plain-list">
                        {detail.packages.map((p, i) => (
                            <li key={i}>
                                {p.quantity} × {p.description}
                                {p.signatureRequired && <> · signature required</>}
                                {p.outcome === 'failed' && p.failureReason && (
                                    <> · <span className="izy-stat-bad">{p.failureReason.replace(/_/g, ' ')}</span>
                                        {p.failureNote && <> ({p.failureNote})</>}
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>

                    <h3>What happened</h3>
                    <ol className="izy-feed">
                        {detail.timeline.map((e, i) => (
                            <li key={i}>
                                <span className="izy-feed-when">{clock(e.at)}</span>
                                <span>
                                    {EVENT_LABEL[e.type] ?? e.type}
                                    {e.by && <> · {e.by}</>}
                                    {e.signedName && <> · signed {e.signedName}</>}
                                    {e.reason && <div className="izy-muted">{e.reason.replace(/_/g, ' ')}</div>}
                                </span>
                            </li>
                        ))}
                    </ol>

                    {!detail.proofOfDelivery.available && (
                        <p className="izy-muted">{detail.proofOfDelivery.reason}</p>
                    )}
                </>
            )}
        </section>
    );
}
