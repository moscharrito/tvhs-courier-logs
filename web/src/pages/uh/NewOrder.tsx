/* A STAT or ad hoc order taken by hand.
 *
 * Scheduled work arrives on a daily list and is imported; this is the phone
 * call. The form shows the deadline the chosen service type implies before
 * anything is saved, because a dispatcher taking a STAT call needs to know
 * they have one hour from pickup and two from the request, not afterwards.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { Loading } from '../../app/Loading';
import type { Site } from './Sites';

interface Created {
    id: number;
    serviceType: string;
    status: string;
    zone: number | null;
    dueAt: string | null;
    recipientName: string;
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

    const loadSites = useCallback(async () => {
        try { setSites(await api<Site[]>(`/api/projects/${projectCode}/uh/sites`)); } catch { setSites([]); }
    }, [projectCode]);
    useEffect(() => { void loadSites(); }, [loadSites]);

    if (!canCreate) return null;
    if (sites === null) return <div className="izy-card"><Loading label="Loading sites" /></div>;

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
        <div className="izy-card">
            <div className="izy-row-between">
                <h2>STAT or ad hoc order</h2>
                {!open && <button className="izy-btn" type="button" onClick={() => { setOpen(true); setMsg(null); }}>Take an order</button>}
            </div>
            <p className="izy-muted">
                For a phone call, not for scheduled work. Scheduled deliveries come in on a pharmacy's daily list,
                where they are checked for duplicates first.
            </p>

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
        </div>
    );
}
