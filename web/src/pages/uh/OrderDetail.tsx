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
    /* Pricing's `zone` is the BILLING band, and stays that way: this block
       is the invoice to University Health. The courier's band is payZone on
       the order itself. */
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
    /* The signed part 3, proving undelivered medication reached a counter.
       Three states: available, nothing came back, or photographed but this
       server cannot serve it. Optional because a browser holding a cached
       bundle can outlive the server that grew the field. */
    returnForm?: { available: boolean; reason: string };
    /** The signed sheet for the attempt, uploaded by the courier. Optional on
     *  the stop, so `available: false` with an empty reason is the ordinary
     *  case and means only that nobody took one. */
    attemptPhoto?: { available: boolean; reason: string };
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

            {/* PROOF THE MEDICATION GOT BACK.

                The pharmacy's portal grew this first, and our copy of a
                delivery is supposed to show the same facts as theirs: the
                last time one side learned about a photograph and the other
                did not, dispatch spent a fortnight downloading a proof of
                delivery with nothing in it to look at.

                Inline rather than only in the PDF, because the question it
                answers -- "did that actually come back?" -- gets asked on
                the phone while somebody is looking at this screen. */}
            {/* ───────── WHY IT COULD NOT BE DELIVERED
                Before the return form, because the door came first and
                these two read as the sequence they are: the stop failed,
                then the medication went back.

                NO CARD WHEN THERE IS NO PICTURE. The slot on the driver's
                screen is optional -- there is nothing to photograph at an
                address that does not exist -- so an absence is the ordinary
                case and a card announcing it on every dry run is a card
                people learn to read past. The server sends an empty reason
                for that and words only for a photograph it cannot serve,
                which is a fault on this server rather than a fact about the
                stop. See attemptPhotoStatus. */}
            {order.attemptPhoto?.available && (
                <div className="izy-card">
                    <h2>The signed sheet for the attempt</h2>
                    <figure className="izy-pod-photo">
                        <img
                            src={`/api/projects/${code}/uh/orders/${order.id}/attempt-photo`}
                            alt="The signed sheet the courier uploaded when the delivery was attempted"
                            loading="lazy"
                        />
                        <figcaption className="izy-muted">
                            Uploaded by the courier when the delivery was recorded as attempted. The
                            contract bills every item on an attempted delivery, so this is the evidence
                            behind that line.
                        </figcaption>
                    </figure>
                </div>
            )}
            {order.attemptPhoto && !order.attemptPhoto.available && order.attemptPhoto.reason && (
                <div className="izy-card">
                    <h2>The signed sheet for the attempt</h2>
                    <p className="izy-muted">{order.attemptPhoto.reason}</p>
                </div>
            )}

            {order.returnForm?.available && (
                <div className="izy-card">
                    <h2>The signed sheet for the return attempt</h2>
                    <figure className="izy-pod-photo">
                        <img
                            src={`/api/projects/${code}/uh/orders/${order.id}/return-form`}
                            alt="The signed sheet for the return attempt on this delivery"
                            loading="lazy"
                        />
                        <figcaption className="izy-muted">
                            Part 3 of the docket, signed at the counter when the packages were handed
                            back and photographed by the courier. One form covers everything returned
                            together, so it may list other deliveries brought back at the same time.
                        </figcaption>
                    </figure>
                </div>
            )}
            {order.returnForm && !order.returnForm.available && order.returnForm.reason && (
                <div className="izy-card">
                    <h2>The signed sheet for the return attempt</h2>
                    <p className="izy-muted">{order.returnForm.reason}</p>
                    {/* THE UPLOAD THAT WAS HERE CAME OFF ON 9 NOVEMBER, at
                        the operator's instruction: photographs are taken by
                        the courier, on the courier's screen, and this page
                        reports.

                        WHAT THAT COSTS, written down because it is the hole
                        this control was added to close. The return screen
                        is built from what is still in a van, and recording
                        a hand-back is exactly what takes an order out of
                        that query. So a return recorded without its
                        photograph -- an upload that failed at the counter
                        while the courier was offered the choice to carry on
                        rather than stand there holding medication -- can no
                        longer be given one from any screen. The server
                        still takes it: POST /orders/:id/evidence with kind
                        `return_form`, refused unless something actually
                        came back (evidence.notReturned). */}
                </div>
            )}

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
                        {/* ── TWO ZONES, BOTH NAMED ────────────────────────────
                            This row said "Zone" and showed the billing band,
                            which is the ambiguity that underpaid a fourteen-mile
                            stop as zone 1 for a week: 78247 is zone 1 on
                            University Health's bid table and fourteen road miles
                            from the counter it left. This is the page somebody
                            opens when a courier disputes their pay, so an
                            unlabelled "Zone 1" here reads as the answer to a
                            question it is not about.

                            Both now say whose zone they are, and the pay row
                            carries the miles, because a band nobody can check
                            against their offer letter is how this went unseen
                            since go-live. */}
                        <tr>
                            <th>Zone (billing)</th>
                            <td>
                                {order.zone === null ? <span className="izy-pill warn">out of area, needs a distance</span> : `Zone ${order.zone}`}
                                <div className="izy-muted izy-field-note">University Health's band for this ZIP. Not what the courier is paid on.</div>
                            </td>
                        </tr>
                        <tr>
                            <th>Zone (pay)</th>
                            <td>
                                {/* `== null` catches undefined, for an older
                                    server that does not send the field at all. */}
                                {order.payZone == null
                                    ? <>
                                        <span className="izy-pill warn">not measured</span>
                                        <div className="izy-muted izy-field-note">
                                            {order.zone === null
                                                ? 'Outside every zone, so there is no distance to band.'
                                                : `Paying the billing band (Zone ${order.zone}) until the distance from the pharmacy is measured.`}
                                        </div>
                                      </>
                                    : <>
                                        {`Zone ${order.payZone}`}
                                        {order.payMiles != null && ` · ${order.payMiles.toFixed(1)} mi`}
                                        <div className="izy-muted izy-field-note">
                                            Distance from the pickup pharmacy, banded as the offer letter bands it
                                            {order.payBasis === 'straight-line' && ' (straight line, not a road route)'}.
                                        </div>
                                      </>}
                            </td>
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
            {/* ── DISPATCH'S WAY IN, WHICH ONLY EVER NEEDED A LINK ──────────
                The stop screen has always accepted a lead: the server's guard
                is requireProjectRole('admin','lead','courier') and the "not
                your order" refusal applies to couriers alone, because a site
                manager covering a route is a stated part of that job. The
                route carries no guard either. The only thing missing was a
                way to reach it without typing a URL -- MyRun was the sole
                link, and that is a courier's own run.

                THIS IS THE ALTERNATIVE TO SHARING A DRIVER'S PASSWORD, and
                it is better than one rather than merely safer. A delivery
                recorded here stays assigned to the courier, so their pay and
                their completion bonus are untouched, while the custody event
                records who actually pressed the button. Signing in as the
                driver would collapse those into one claim that the driver
                filed it from their own phone -- and the driver install sheet
                promises the opposite: "every delivery is recorded against
                whoever is signed in, and that record is what protects you in
                a dispute".

                The stop screen takes a time, so a round that happened on
                Monday is recorded as Monday (stop.ts refuses only FUTURE
                times). Backdating is the point of this for a backlog. */}
            <p>
                <Link className="izy-btn secondary" to={`/projects/${code}/orders/${order.id}/stop`}>
                    {order.status === 'delivered' || order.status === 'failed'
                        ? 'Open the stop screen to add or amend proof'
                        : 'Record this delivery on the courier’s behalf'}
                </Link>
            </p>
            {page}
        </>
    );
}
