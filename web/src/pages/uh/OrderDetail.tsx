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
import { stampFor } from '../../lib/when';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { Loading } from '../../app/Loading';
import { Pager, usePaged } from '../../app/Pager';
import { Thread } from '../../app/Thread';
import { Section } from '../../app/Section';
import { slaLabel, type OrderRow, type Sla } from './Orders';
import { CardAnchor, Chip, Context, Panel, Screen, ScreenHeader, Sheet } from '../../app/Glass';
import { displayName, handleUnder } from '../../lib/people';

interface Package { id: number; description: string; quantity: number; signatureRequired: boolean; outcome: string }

interface CustodyEvent {
    id: number; packageId: number | null; type: string; at: string; actor: string; actorName: string;
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
    /* How the pharmacy handed it over (drizzle/0051), already phrased by the
       server so dispatch reads the same sentence the courier was given. */
    signingInstruction?: string;
    handlingFlags?: string[];
    authorisedSigners?: string;
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
    /* Absent for a courier. The server withholds it rather than the screen
       hiding it, so this is undefined rather than a blank card. */
    pricing?: Pricing;
    allowed: string[];
}

const usd = (n: number | undefined) => (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const EVENT_LABEL: Record<string, string> = {
    created: 'Created', released: 'Released', assigned: 'Assigned', unassigned: 'Unassigned',
    picked_up: 'Picked up', arrived: 'Arrived', delivered: 'Delivered',
    attempted: 'Attempted', returned: 'Returned', cancelled: 'Cancelled', note: 'Note',
};

export function OrderDetail() {
    const { code = '', orderId = '' } = useParams();
    /* This page is the one somebody opens to answer "was it on time", so its
       times have to be the ones the deadline was set in. */
    const stamp = stampFor(useProjectTimezone(code));

    /* WHERE BACK GOES DEPENDS ON WHO IS READING.
     *
     * This always pointed at the orders console, which is a dispatch screen:
     * a filter naming every counter on the contract, a box for looking up
     * another courier, and Export to Excel. A driver reaches this page from
     * the Details link on their own stop, so Back was handing them the one
     * screen they had no business on -- and on the web, where every driver
     * works for the first month, that was the way in.
     *
     * Their run is where they came from and where they want to be. */
    const { projects } = useAuth();
    const isCourier = projects.find((p) => p.code === code)?.role === 'courier';
    const backTo = isCourier ? `/projects/${code}/my-run` : `/projects/${code}/orders`;
    const backLabel = isCourier ? 'Back to today' : 'Orders';
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

    /* Above every early return. Hooks run in the same order on every render
       or React loses track of which state belongs to which call, and this
       component returns early twice. */
    const pagedPackages = usePaged(order?.packages ?? []);
    const pagedCustody = usePaged(order?.custody ?? []);

    if (error) {
        return (
            <>
                <h1>Order not available</h1>
                <p className="izy-sub">{error}</p>
                <Link className="izy-btn secondary" to={backTo}>{backLabel}</Link>
            </>
        );
    }
    if (order === null) return <div className="izy-card"><Loading label="Loading order" /></div>;

    const sla = slaLabel(order.sla);
    const p = order.pricing;

    /* ONE SCREEN, TWO SHAPES, and this one is the lookup rather than the
       work. A courier opens it from Details on their own stop to settle a
       question -- was it on time, what did the pharmacy say, who signed --
       so it gets the app's frame with the answer to "which delivery is
       this" pinned above the record. Dispatch opens it to read the whole
       record at a desk and keeps the console. Same body, same tables, same
       `isCourier` that already decides where Back goes. */
    const page = (
        <>

            {/* HOW THE PHARMACY SENT IT, before the proof-of-delivery link.
            
                A dispatcher answering "why was this one refused at the door"
                or "can we re-deliver to the son" needs the rule before the
                outcome, and in the same words the courier had. Rendered from
                the server's phrasing rather than rebuilt here: three
                codebases describing one rule is how they end up disagreeing.
            
                Hidden entirely on an ordinary delivery, which is most of
                them, so the page does not grow a line reading "Anyone at
                this address may sign." */}
            {((order.handlingFlags ?? []).length > 0
                || (order.authorisedSigners ?? '') !== '') && (
                <div className="izy-card">
                    <h2>How the pharmacy sent it</h2>
                    <p>
                        {(order.handlingFlags ?? []).map((f) => (
                            <span key={f} className={`izy-pill ${f === 'Fridge' ? 'warn' : ''}`}>{f}</span>
                        ))}
                    </p>
                    {order.signingInstruction && <p>{order.signingInstruction}</p>}
                </div>
            )}

            {/* Our copy of the proof of delivery: the same document the client
                gets, with our couriers named in full. A plain link, because the
                browser already knows how to open a PDF. */}
            {/* Our copy of the proof of delivery: the same document the
                client gets, with our couriers named in full. A card rather
                than a grey pill, because on a phone it is the one thing on
                this screen somebody is usually here to open. */}
            <CardAnchor
                href={`/api/projects/${code}/uh/orders/${order.id}/pod.pdf`}
                external
                title="Proof of delivery (PDF)"
                tone="quiet"
                compact
                detail="The signed record for this delivery"
            />

            <div className="izy-card">
                <div className="izy-row-between">
                    <h2>Delivery</h2>
                    {sla.text && <span className={`izy-pill ${sla.tone === 'muted' ? 'muted' : sla.tone}`}>{sla.text}</span>}
                </div>
                <table className="izy-table">
                    <tbody>
                        {/* A courier reads these off the panel above, which
                            does not scroll away. Printing them again four
                            rows later is the duplication the panel exists to
                            remove; a dispatcher has no panel, so they stay. */}
                        {isCourier
                            ? (order.recipientPhone ? <tr><th>Phone</th><td>{order.recipientPhone}</td></tr> : null)
                            : <>
                                <tr><th>Recipient</th><td>{order.recipientName}{order.recipientPhone && <> · {order.recipientPhone}</>}</td></tr>
                                <tr><th>Address</th><td>{order.address}<br />{order.city} {order.state} {order.zip}</td></tr>
                            </>}
                        <tr>
                            <th>Zone</th>
                            <td>{order.zone === null ? <span className="izy-pill warn">out of area, needs a distance</span> : `Zone ${order.zone}`}</td>
                        </tr>
                        <tr><th>Status</th><td>{order.status}{order.failureReason && <> · {order.failureReason}</>}</td></tr>
                        {/* The person, not the key. `assignedTo` is a username, which on this
                            contract is the driver's email address; the server now sends
                            the name beside it. See lib/people.ts. */}
                        <tr><th>Courier</th><td>
                            {order.assignedTo === null || order.assignedTo === undefined
                                ? <span className="izy-muted">unassigned</span>
                                : <>
                                    {displayName({ name: order.assignedToName ?? '', username: order.assignedTo })}
                                    {handleUnder({ name: order.assignedToName ?? '', username: order.assignedTo }) !== null && (
                                        <div className="izy-muted">{handleUnder({ name: order.assignedToName ?? '', username: order.assignedTo })}</div>
                                    )}
                                </>}
                        </td></tr>
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

            <Section
                id="uh.order.packages"
                title="Packages"
                summary={`${order.packages.length} ${order.packages.length === 1 ? 'item' : 'items'}`}
            >
                <table className="izy-table">
                    <thead><tr><th>Description</th><th>Quantity</th><th>Signature</th><th>Outcome</th></tr></thead>
                    <tbody>
                        {pagedPackages.rows.map((pkg) => (
                            <tr key={pkg.id}>
                                <td>{pkg.description || <span className="izy-muted">none recorded</span>}</td>
                                <td>{pkg.quantity}</td>
                                <td>{pkg.signatureRequired ? 'required' : 'doorstep allowed'}</td>
                                <td>{pkg.outcome}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <Pager of={pagedPackages} noun="packages" />
            </Section>

            {p && (
            <Section
                id="uh.order.pricing"
                title="What it bills at"
                summary={p.available ? usd(p.total) : 'not priced'}
                actions={p.available && p.provisional ? <span className="izy-pill muted">provisional</span> : undefined}
            >
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
            </Section>
            )}

            {/* Folded. It is the longest thing on the page and the one read
                least often: an audit record, opened when somebody disputes
                what happened, not when somebody is checking an address. */}
            <Section
                id="uh.order.custody"
                title="Chain of custody"
                defaultOpen={false}
                summary={`${order.custody.length} events, append-only`}
                intro={'Append-only: these rows cannot be edited or deleted, which is what makes them usable '
                    + 'for a regulatory audit. Ordered as they were recorded.'}
            >
                <table className="izy-table">
                    <thead><tr><th>When</th><th>Event</th><th>By</th><th>Signed</th><th>Detail</th></tr></thead>
                    <tbody>
                        {pagedCustody.rows.map((e) => (
                            <tr key={e.id}>
                                <td>{stamp(e.at)}</td>
                                <td>
                                    {EVENT_LABEL[e.type] ?? e.type}
                                    {e.from !== e.to && e.to && <><br /><span className="izy-muted">{e.from || 'new'} to {e.to}</span></>}
                                </td>
                                {/* The person, then their username only when
                                    it says something their name does not. The
                                    username here is usually an email address,
                                    and a chain of custody read out in an audit
                                    was a column of personal addresses. The row
                                    itself still stores the username: see the
                                    note on the query in modules/uh/orders.ts. */}
                                <td>
                                    {displayName({ name: e.actorName, username: e.actor })}
                                    {handleUnder({ name: e.actorName, username: e.actor }) !== null && (
                                        <div className="izy-muted">{handleUnder({ name: e.actorName, username: e.actor })}</div>
                                    )}
                                </td>
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
                <Pager of={pagedCustody} noun="events" />
            </Section>

            {/* Beside the custody trail, not in a separate inbox. What was
                SAID about a delivery and what HAPPENED to it are read
                together when somebody is working out which of the two is
                wrong. */}
            <Section
                id="uh.order.thread"
                title="Messages"
                summary="with the pharmacy, about this delivery"
            >
                <Thread base={`/api/projects/${code}/uh`} orderId={order.id} label="" />
            </Section>
        </>
    );

    if (isCourier) {
        return (
            <Screen>
                <Context>
                    <ScreenHeader
                        title={`Order #${order.id}`}
                        subtitle={<><Link to={backTo}>{backLabel}</Link> · {order.serviceType} · {order.serviceDate}</>}
                    />
                    {/* WHICH DELIVERY THIS IS, and nothing a courier has to
                        scroll for. The handling flags are deliberately NOT
                        here: they have their own panel at the top of the
                        sheet, in the server's own phrasing, and saying them
                        twice in two different shapes is how two codebases
                        end up describing one rule differently. */}
                    <Panel role="group" aria-label="This delivery">
                        <p className="izy-lede">{order.recipientName}</p>
                        <p className="izy-lede-note">{order.address}<br />{order.city} {order.state} {order.zip}</p>
                        <div className="izy-chips">
                            <Chip label={order.status} tone={order.status === 'delivered' ? 'good' : order.status === 'failed' ? 'bad' : 'neutral'} />
                            {sla.text && (
                                <Chip
                                    label={sla.text}
                                    tone={sla.tone === 'off' ? 'bad' : sla.tone === 'ok' ? 'good' : sla.tone === 'warn' ? 'warn' : 'neutral'}
                                />
                            )}
                            {order.zone === null && <Chip label="out of area" tone="warn" />}
                            {order.externalRef && <Chip label={order.externalRef} />}
                        </div>
                    </Panel>
                </Context>
                <Sheet>{page}</Sheet>
            </Screen>
        );
    }

    return (
        <>
            <h1>Order #{order.id}</h1>
            <p className="izy-sub">
                <Link to={backTo}>{backLabel}</Link> · {order.serviceType} · {order.serviceDate}
                {order.externalRef && <> · <code>{order.externalRef}</code></>}
                {order.dailyListId !== null && <> · from list {order.dailyListId}</>}
            </p>
            {page}
        </>
    );
}
