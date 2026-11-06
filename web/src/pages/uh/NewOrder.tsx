/* A STAT or ad hoc order taken by hand.
 *
 * Scheduled work arrives on a daily list and is imported; this is the phone
 * call. The form shows the deadline the chosen service type implies before
 * anything is saved, because a dispatcher taking a STAT call needs to know
 * they have one hour from pickup and two from the request, not afterwards.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clockFor, todayIn } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import type { Site } from './Sites';

interface Created {
    id: number;
    serviceType: string;
    status: string;
    zone: number | null;
    dueAt: string | null;
    recipientName: string;
}

/** One row of the hand-taken orders list, as GET /orders returns it. */
interface Taken {
    id: number;
    externalRef: string;
    serviceType: string;
    status: string;
    recipientName: string;
    address: string;
    zip: string;
    dueAt: string | null;
    siteId: number;
    assignedTo: string | null;
}

/** What the delete actually removed, so the screen can say it. */
interface Removed {
    id: number;
    was: { reference: string; status: string };
    onInvoices: string[];
    filesDeleted: number;
    runsRemoved: number;
}

const EMPTY = {
    serviceType: 'stat' as 'stat' | 'adhoc',
    recipientName: '', recipientPhone: '',
    addressLine: '', addressLine2: '', city: 'San Antonio', state: 'TX', zip: '',
    description: '', quantity: '1', deliveryNotes: '', externalRef: '',
    signatureRequired: true,
};

/** Minutes each service type allows, from the request. Matches the contract
 *  defaults in core/projects/settings; the server is the authority. */
const WINDOW_MINUTES: Record<string, number> = { stat: 120, adhoc: 240 };

export function NewOrder({ projectCode, timezone, canCreate }: {
    projectCode: string; timezone: string; canCreate: boolean;
}) {
    const base = `/api/projects/${projectCode}/uh/orders`;
    /* "Due by 4:01 PM" is a promise made to whoever is on the phone, so it is
       said in the project's zone and not in the zone this machine happens to
       be set to. */
    const clock = clockFor(timezone);
    const [sites, setSites] = useState<Site[] | null>(null);
    const [siteId, setSiteId] = useState<number | ''>('');
    const [form, setForm] = useState(EMPTY);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] } | null>(null);

    /* ─────────────────────────── FINDING ONE AGAIN, TO TAKE IT BACK OFF
     *
     * An order typed by hand is the one most likely to be wrong: the wrong
     * pharmacy picked from nine, a call logged twice because two people
     * answered it, a patient who rang back. Cancelling leaves the row on
     * the board's history, in the day's counts and in the next duplicate
     * check, so dispatch asked to be able to remove it outright.
     *
     * NARROWED TO HAND-TAKEN WORK, by pharmacy and by day. Scheduled
     * deliveries are not offered here at all -- they arrive on a list and
     * the whole list is withdrawn together on the import screen, which
     * counts what goes and says so. Mixing the two would put a button
     * beside a hundred imported rows that nobody meant to touch.
     *
     * The day defaults to today and the pharmacy to all of them, which is
     * the question somebody actually has: "what did we take just now".
     */
    const [filterSite, setFilterSite] = useState<number | ''>('');
    const [filterDate, setFilterDate] = useState(() => todayIn(timezone));
    const [filterService, setFilterService] = useState<'stat,adhoc' | 'stat' | 'adhoc'>('stat,adhoc');
    const [taken, setTaken] = useState<Taken[] | null>(null);
    /* How many there are against how many came back. The list endpoint
       sends both and says why: "a caller that ignores both is at least no
       longer being told a short list is the whole list." Fifty is plenty
       for a day of phone calls and the cap will almost never bite, but a
       dispatcher hunting the order they just took must not be shown
       forty-nine of fifty-one and conclude it is not there. */
    const [total, setTotal] = useState(0);
    const [looking, setLooking] = useState(false);
    const [confirming, setConfirming] = useState<number | null>(null);

    const loadSites = useCallback(async () => {
        try { setSites(await api<Site[]>(`/api/projects/${projectCode}/uh/sites`)); } catch { setSites([]); }
    }, [projectCode]);
    useEffect(() => { void loadSites(); }, [loadSites]);

    const find = useCallback(async () => {
        setLooking(true);
        setConfirming(null);
        try {
            const q = new URLSearchParams({ serviceType: filterService, limit: '50' });
            if (filterDate !== '') q.set('serviceDate', filterDate);
            if (filterSite !== '') q.set('siteId', String(filterSite));
            const got = await api<{ orders: Taken[]; total: number }>(`${base}?${q.toString()}`);
            setTaken(got.orders ?? []);
            setTotal(Number(got.total ?? (got.orders ?? []).length));
        } catch (err) {
            setTaken([]);
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not read the orders' });
        } finally {
            setLooking(false);
        }
    }, [base, filterService, filterDate, filterSite]);

    const remove = async (order: Taken) => {
        setBusy(true);
        setMsg(null);
        try {
            const gone = await api<Removed>(`${base}/${order.id}`, { method: 'DELETE', json: {} });
            const invoiced = gone.onInvoices.length > 0
                ? ` It was on ${gone.onInvoices.length === 1 ? 'an invoice' : 'invoices'}, which is now short a line.`
                : '';
            const files = gone.filesDeleted > 0
                ? ` ${gone.filesDeleted} ${gone.filesDeleted === 1 ? 'photograph' : 'photographs'} went with it.`
                : '';
            setMsg({
                kind: 'ok',
                text: `Order ${gone.id}${gone.was.reference ? ` (${gone.was.reference})` : ''} deleted permanently.${invoiced}${files}`,
            });
            setConfirming(null);
            /* Re-read rather than splicing it out: the delete can empty a
               planned run, and the list should show what is actually there
               rather than what this screen thinks is left. */
            await find();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not delete that order' });
        } finally {
            setBusy(false);
        }
    };

    if (!canCreate) return null;
    if (sites === null) return <div className="izy-card"><Loading label="Loading sites" /></div>;

    const siteName = (id: number) => sites.find((s) => s.id === id)?.name ?? `site ${id}`;

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (siteId === '') return;
        setBusy(true);
        setMsg(null);
        try {
            const created = await api<Created>(base, {
                method: 'POST',
                json: {
                    siteId: Number(siteId),
                    serviceType: form.serviceType,
                    recipientName: form.recipientName,
                    recipientPhone: form.recipientPhone,
                    addressLine: form.addressLine,
                    addressLine2: form.addressLine2,
                    city: form.city,
                    state: form.state,
                    zip: form.zip,
                    deliveryNotes: form.deliveryNotes,
                    description: form.description,
                    quantity: Number(form.quantity) || 1,
                    signatureRequired: form.signatureRequired,
                    externalRef: form.externalRef,
                },
            });
            const due = created.dueAt ? ` Due ${clock(created.dueAt)}.` : '';
            const zone = created.zone === null ? ' Out of area, so it needs a distance before it can be priced.' : ` Zone ${created.zone}.`;
            setMsg({ kind: 'ok', text: `Order ${created.id} created and ready for dispatch.${due}${zone}` });
            setForm(EMPTY);
            setOpen(false);
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not create the order' });
        } finally {
            setBusy(false);
        }
    };

    const dueIfSavedNow = new Date(Date.now() + (WINDOW_MINUTES[form.serviceType] ?? 120) * 60_000);

    return (
        <Section
            id="uh.neworder"
            title="STAT or ad hoc order"
            defaultOpen={false}
            summary="for a phone call, not for scheduled work"
            actions={(expand) => (!open && canCreate
                ? <button className="izy-btn" type="button" onClick={() => { expand(); setOpen(true); setMsg(null); }}>Take an order</button>
                : undefined)}
            intro={'For a phone call, not for scheduled work. Scheduled deliveries come in on a pharmacy’s daily '
                + 'list, where they are checked for duplicates first.'}
        >

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {open && (
                <form onSubmit={(e) => { void submit(e); }}>
                    <div className="izy-row">
                        <label className="izy-field">Pharmacy
                            <select value={siteId} onChange={(e) => setSiteId(e.target.value === '' ? '' : Number(e.target.value))} required>
                                <option value="">Choose a site</option>
                                {sites.filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                        <label className="izy-field">Service
                            <select value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value as 'stat' | 'adhoc' })}>
                                <option value="stat">STAT</option>
                                <option value="adhoc">ad hoc</option>
                            </select>
                        </label>
                        <label className="izy-field">Reference<input value={form.externalRef} onChange={(e) => setForm({ ...form, externalRef: e.target.value })} placeholder="Rx number, optional" /></label>
                    </div>

                    <div className="izy-row">
                        <label className="izy-field">Recipient<input value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} required /></label>
                        <label className="izy-field">Phone<input value={form.recipientPhone} onChange={(e) => setForm({ ...form, recipientPhone: e.target.value })} inputMode="tel" /></label>
                    </div>

                    <div className="izy-row">
                        <label className="izy-field" style={{ minWidth: 240 }}>Address<input value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} required /></label>
                        <label className="izy-field">Apt or unit<input value={form.addressLine2} onChange={(e) => setForm({ ...form, addressLine2: e.target.value })} /></label>
                        <label className="izy-field">City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label>
                        <label className="izy-field" style={{ minWidth: 80 }}>State<input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} maxLength={2} /></label>
                        <label className="izy-field" style={{ minWidth: 110 }}>ZIP<input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} required placeholder="78229" /></label>
                    </div>

                    <div className="izy-row">
                        <label className="izy-field" style={{ minWidth: 220 }}>Package description<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Cold pack, oral solids" /></label>
                        <label className="izy-field" style={{ minWidth: 90 }}>Quantity<input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} inputMode="numeric" /></label>
                        <label className="izy-field" style={{ minWidth: 200 }}>Signature
                            <span><input type="checkbox" checked={form.signatureRequired} onChange={(e) => setForm({ ...form, signatureRequired: e.target.checked })} /> required at the door</span>
                        </label>
                        <label className="izy-field" style={{ minWidth: 240 }}>Notes<input value={form.deliveryNotes} onChange={(e) => setForm({ ...form, deliveryNotes: e.target.value })} /></label>
                    </div>

                    <p className="izy-muted">
                        Saved now, this is due by {clock(dueIfSavedNow.toISOString())}.
                        {form.serviceType === 'stat' && ' STAT also has to be delivered within one hour of pickup.'}
                    </p>

                    <div className="izy-row">
                        <button className="izy-btn" type="submit" disabled={busy}>{busy ? 'Saving' : 'Create order'}</button>
                        <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(EMPTY); setMsg(null); }}>Cancel</button>
                    </div>
                </form>
            )}

            {/* ───────────────────────── THE ONES ALREADY TAKEN, AND A WAY BACK.

                Hand-taken orders only, by pharmacy and by day. A scheduled
                delivery is never listed here: it came in on a list, and the
                list is withdrawn as a whole on the import screen where the
                count of what goes is shown first. */}
            <h3 style={{ marginTop: 20 }}>Orders taken by hand</h3>
            <div className="izy-row">
                {/* "At pharmacy", not "Pharmacy": the form above this has a
                    Pharmacy select of its own, and two controls with the same
                    label in one panel is a screen reader reading out the same
                    name twice for two different things. */}
                <label className="izy-field">At pharmacy
                    <select value={filterSite} onChange={(e) => setFilterSite(e.target.value === '' ? '' : Number(e.target.value))}>
                        <option value="">any</option>
                        {sites.filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </label>
                <label className="izy-field">On day
                    <input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} />
                </label>
                <label className="izy-field">Service level
                    <select value={filterService} onChange={(e) => setFilterService(e.target.value as typeof filterService)}>
                        <option value="stat,adhoc">STAT and ad hoc</option>
                        <option value="stat">STAT</option>
                        <option value="adhoc">ad hoc</option>
                    </select>
                </label>
                <button className="izy-btn secondary" type="button" disabled={looking} onClick={() => { void find(); }}>
                    {looking ? 'Looking' : 'Find orders'}
                </button>
            </div>

            {taken !== null && taken.length === 0 && (
                <p className="izy-muted">
                    No STAT or ad hoc order at {filterSite === '' ? 'any pharmacy' : siteName(Number(filterSite))}
                    {filterDate === '' ? '' : ` on ${filterDate}`}. Scheduled deliveries are not listed here —
                    those come in on a list and are withdrawn from the import screen.
                </p>
            )}

            {taken !== null && total > taken.length && (
                <p className="izy-muted">
                    Showing {taken.length} of {total}. Narrow it by pharmacy or day to see the rest.
                </p>
            )}

            {taken !== null && taken.length > 0 && (
                <table className="izy-table">
                    <thead>
                        <tr>
                            <th scope="col">Order</th>
                            <th scope="col">Service</th>
                            <th scope="col">Recipient</th>
                            <th scope="col">Pharmacy</th>
                            <th scope="col">Status</th>
                            <th scope="col">Due</th>
                            <th scope="col"><span className="izy-visually-hidden">Remove</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {taken.map((o) => (
                            <tr key={o.id}>
                                <td>#{o.id}{o.externalRef ? ` · ${o.externalRef}` : ''}</td>
                                <td>{o.serviceType === 'stat' ? 'STAT' : 'ad hoc'}</td>
                                <td>{o.recipientName}<br /><span className="izy-muted">{o.address} {o.zip}</span></td>
                                <td>{siteName(o.siteId)}</td>
                                <td>{o.status}{o.assignedTo ? ` · ${o.assignedTo}` : ''}</td>
                                <td>{o.dueAt ? clock(o.dueAt) : ''}</td>
                                <td>
                                    {confirming === o.id ? (
                                        /* TWO STEPS, AND THE SECOND ONE SAYS WHAT GOES.

                                           A single order is not a list: the thing about
                                           to be destroyed fits on the screen, so the
                                           person can be made to read it rather than
                                           warned in the abstract. The status is in the
                                           sentence because deleting a delivered stop is
                                           a different act from deleting one nobody has
                                           touched, and only the operator can tell which
                                           one this is. */
                                        <>
                                            <span className="izy-muted">
                                                Delete #{o.id} for {o.recipientName}
                                                {o.status === 'delivered' || o.status === 'failed'
                                                    ? `, which is already ${o.status}, `
                                                    : ' '}
                                                permanently? There is no undo.
                                            </span>
                                            {' '}
                                            <button className="izy-btn danger" type="button" disabled={busy} onClick={() => { void remove(o); }}>
                                                Delete permanently
                                            </button>
                                            {' '}
                                            <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => setConfirming(null)}>
                                                Keep
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            className="izy-btn secondary"
                                            type="button"
                                            disabled={busy}
                                            aria-label={`Delete order ${o.id} for ${o.recipientName}`}
                                            onClick={() => { setConfirming(o.id); setMsg(null); }}
                                        >
                                            Delete
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Section>
    );
}
