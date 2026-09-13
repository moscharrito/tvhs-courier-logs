/* One order: what it is, what it bills at, and everything that happened to
   it.

   The custody timeline is the part that matters. Scope 1.2.7 requires the
   chain to be available for regulatory audit and 1.2.8 requires the printed
   names of the sending and receiving personnel on a proof of delivery, so
   this screen shows the signatures rather than summarising them away. It is
   read-only: events are recorded by the dispatch board and the courier app,
   and the record itself cannot be edited at all. */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { slaLabel, type OrderRow, type Sla } from './Orders';

interface Package { id: number; description: string; quantity: number; signatureRequired: boolean; outcome: string }

interface CustodyEvent {
    id: number; packageId: number | null; type: string; at: string; actor: string;
    from: string; to: string; signedName: string; signatureKey: string;
    reason: string; lat: number | null; lng: number | null; describes: string;
}

interface Pricing {
    available: boolean;
    reason?: string;
    zone?: number | null;
    base?: number; statSurcharge?: number; afterHoursSurcharge?: number; dryRunFee?: number;
    outOfArea?: { miles: number; perMile: number; amount: number };
    total?: number; effectiveFrom?: string; notes?: string[];
    afterHours?: boolean; measuredAt?: string; measuredFrom?: string; provisional?: boolean;
}

interface Detail extends OrderRow {
    recipientPhone: string;
    addressLine: string;
    addressLine2: string;
    state: string;
    deliveryNotes: string;
    signatureRequired: boolean;
    geocodeStatus: string;
    receivedAt: string;
    pickupDueAt: string | null;
    pickupAt: string | null;
    arrivedAt: string | null;
    deliveredAt: string | null;
    returnedAt: string | null;
    assignedAt: string | null;
    pickedUpBy: string;
    receivedBy: string;
    failureReason: string;
    dailyListId: number | null;
    sla: Sla;
    packages: Package[];
    custody: CustodyEvent[];
    pricing: Pricing;
    allowed: string[];
}

const usd = (n: number | undefined) => (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

const EVENT_LABEL: Record<string, string> = {
    created: 'Created', released: 'Released', assigned: 'Assigned', unassigned: 'Unassigned',
    picked_up: 'Picked up', arrived: 'Arrived', delivered: 'Delivered',
    attempted: 'Attempted', returned: 'Returned', cancelled: 'Cancelled', note: 'Note',
};

export function OrderDetail() {
    const { code = '', orderId = '' } = useParams();
    const [order, setOrder] = useState<Detail | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setOrder(await api<Detail>(`/api/projects/${code}/uh/orders/${orderId}`));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not load this order');
        }
    }, [code, orderId]);
    useEffect(() => { void load(); }, [load]);

    if (error) {
        return (
            <>
                <h1>Order not available</h1>
                <p className="izy-sub">{error}</p>
                <Link className="izy-btn secondary" to={`/projects/${code}/orders`}>Back to orders</Link>
            </>
        );
    }
    if (order === null) return <div className="izy-card"><Loading label="Loading order" /></div>;

    const sla = slaLabel(order.sla);
    const p = order.pricing;

    return (
        <>
            <h1>Order #{order.id}</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}/orders`}>Orders</Link> · {order.serviceType} · {order.serviceDate}
                {order.externalRef && <> · <code>{order.externalRef}</code></>}
                {order.dailyListId !== null && <> · from list {order.dailyListId}</>}
            </p>

            {/* Our copy of the proof of delivery: the same document the client
                gets, with our couriers named in full. A plain link, because the
                browser already knows how to open a PDF. */}
            <p>
                <a className="izy-btn secondary" href={`/api/projects/${code}/uh/orders/${order.id}/pod.pdf`} target="_blank" rel="noreferrer">
                    Proof of delivery (PDF)
                </a>
            </p>

            <div className="izy-card">
                <div className="izy-row-between">
                    <h2>Delivery</h2>
                    {sla.text && <span className={`izy-pill ${sla.tone === 'muted' ? 'muted' : sla.tone}`}>{sla.text}</span>}
                </div>
                <table className="izy-table">
                    <tbody>
                        <tr><th>Recipient</th><td>{order.recipientName}{order.recipientPhone && <> · {order.recipientPhone}</>}</td></tr>
                        <tr><th>Address</th><td>{order.address}<br />{order.city} {order.state} {order.zip}</td></tr>
                        <tr>
                            <th>Zone</th>
                            <td>{order.zone === null ? <span className="izy-pill warn">out of area, needs a distance</span> : `Zone ${order.zone}`}</td>
                        </tr>
                        <tr><th>Status</th><td>{order.status}{order.failureReason && <> · {order.failureReason}</>}</td></tr>
                        <tr><th>Courier</th><td>{order.assignedTo ?? <span className="izy-muted">unassigned</span>}</td></tr>
                        <tr><th>Requested</th><td>{stamp(order.receivedAt)}</td></tr>
                        <tr>
                            <th>Due</th>
                            <td>
                                {stamp(order.dueAt)}
                                {order.pickupDueAt && <><br /><span className="izy-muted">and within an hour of pickup: {stamp(order.pickupDueAt)}</span></>}
                            </td>
                        </tr>
                        {order.arrivedAt && (
                            <tr>
                                <th>Arrived</th>
                                <td>{stamp(order.arrivedAt)} <span className="izy-muted">which is what the deadline is measured against</span></td>
                            </tr>
                        )}
                        {order.deliveredAt && <tr><th>Delivered</th><td>{stamp(order.deliveredAt)} · signed {order.receivedBy}</td></tr>}
                        {order.returnedAt && <tr><th>Returned</th><td>{stamp(order.returnedAt)}</td></tr>}
                        {order.deliveryNotes && <tr><th>Notes</th><td>{order.deliveryNotes}</td></tr>}
                    </tbody>
                </table>
            </div>

            <div className="izy-card">
                <h2>Packages</h2>
                <table className="izy-table">
                    <thead><tr><th>Description</th><th>Quantity</th><th>Signature</th><th>Outcome</th></tr></thead>
                    <tbody>
                        {order.packages.map((pkg) => (
                            <tr key={pkg.id}>
                                <td>{pkg.description || <span className="izy-muted">none recorded</span>}</td>
                                <td>{pkg.quantity}</td>
                                <td>{pkg.signatureRequired ? 'required' : 'doorstep allowed'}</td>
                                <td>{pkg.outcome}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="izy-card">
                <div className="izy-row-between">
                    <h2>What it bills at</h2>
                    {p.available && p.provisional && <span className="izy-pill muted">provisional</span>}
                </div>
                {!p.available ? <div className="izy-muted">{p.reason}</div> : (
                    <>
                        <table className="izy-table">
                            <tbody>
                                {(p.base ?? 0) > 0 && <tr><th>Zone {p.zone} delivery</th><td>{usd(p.base)}</td></tr>}
                                {(p.statSurcharge ?? 0) > 0 && <tr><th>STAT surcharge</th><td>{usd(p.statSurcharge)}</td></tr>}
                                {(p.afterHoursSurcharge ?? 0) > 0 && <tr><th>After hours surcharge</th><td>{usd(p.afterHoursSurcharge)}</td></tr>}
                                {(p.dryRunFee ?? 0) > 0 && <tr><th>Dry run</th><td>{usd(p.dryRunFee)}</td></tr>}
                                {(p.outOfArea?.amount ?? 0) > 0 && <tr><th>{p.outOfArea?.miles} miles out of area</th><td>{usd(p.outOfArea?.amount)}</td></tr>}
                                <tr><th>Total</th><td><b>{usd(p.total)}</b></td></tr>
                            </tbody>
                        </table>
                        <p className="izy-muted" style={{ marginTop: 8 }}>
                            Priced on the schedule in effect from {p.effectiveFrom}, measured at the {p.measuredFrom} time
                            ({stamp(p.measuredAt ?? null)}){p.afterHours ? ', which is after hours' : ''}.
                        </p>
                        {p.notes && p.notes.length > 0 && (
                            <ul className="izy-plain-list">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                        )}
                    </>
                )}
            </div>

            <div className="izy-card">
                <h2>Chain of custody</h2>
                <p className="izy-muted">
                    Append-only: these rows cannot be edited or deleted, which is what makes them usable
                    for a regulatory audit. Ordered as they were recorded.
                </p>
                <table className="izy-table">
                    <thead><tr><th>When</th><th>Event</th><th>By</th><th>Signed</th><th>Detail</th></tr></thead>
                    <tbody>
                        {order.custody.map((e) => (
                            <tr key={e.id}>
                                <td>{stamp(e.at)}</td>
                                <td>
                                    {EVENT_LABEL[e.type] ?? e.type}
                                    {e.from !== e.to && e.to && <><br /><span className="izy-muted">{e.from || 'new'} to {e.to}</span></>}
                                </td>
                                <td>{e.actor}</td>
                                <td>{e.signedName || <span className="izy-muted">-</span>}</td>
                                <td>
                                    {e.reason && <div>{e.reason}</div>}
                                    {e.packageId !== null && <div className="izy-muted">package {e.packageId}</div>}
                                    {e.lat !== null && <div className="izy-muted">{e.lat?.toFixed(4)}, {e.lng?.toFixed(4)}</div>}
                                    {!e.reason && e.packageId === null && e.lat === null && <span className="izy-muted">{e.describes}</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
