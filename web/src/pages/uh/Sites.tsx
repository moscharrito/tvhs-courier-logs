/* UH sites: the pharmacies that release daily lists. Read-only for any
   member; admins and ops managers can add, edit and remove. */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { todayIn } from '../../lib/when';
import { useProjectTimezone } from '../../app/auth';
import { api, ApiError, why } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';

export interface Site {
    id: number;
    code: string;
    name: string;
    type: 'pharmacy' | 'hospital' | 'other';
    addressLine: string;
    city: string;
    state: string;
    zip: string;
    fullAddress: string;
    lat: number | null;
    lng: number | null;
    geocodeStatus: 'pending' | 'ok' | 'failed' | 'manual';
    releasesList: boolean;
    status: 'active' | 'inactive';
    notes: string;
}

const EMPTY = { code: '', name: '', type: 'pharmacy' as Site['type'], addressLine: '', city: 'San Antonio', state: 'TX', zip: '', notes: '' };

export function Sites({ projectCode, canManage }: { projectCode: string; canManage: boolean }) {
    const timezone = useProjectTimezone(projectCode);
    const base = `/api/projects/${projectCode}/uh/sites`;
    const [sites, setSites] = useState<Site[] | null>(null);
    const [msg, setMsg] = useState<
        /* 'warn' since the geocode button: a run that located six of
           nine is neither a success nor a failure, and colouring it
           either way hides half of what happened. */
        { kind: 'ok' | 'warn' | 'error'; text: string; details?: string[] } | null>(null);
    const [form, setForm] = useState(EMPTY);
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState(false);
    /** Null until the status endpoint answers; false on an older server. */
    const [deliveryLookup, setDeliveryLookup] = useState<boolean | null>(null);
    /* ── THE PROJECT'S DAY, NOT THE BROWSER'S. This was
       `new Date().toISOString().slice(0, 10)`, which is UTC: from 6pm in
       San Antonio onwards it offered TOMORROW, and the button under it
       looks up delivery addresses for whatever day is in the box. Nothing
       failed loudly -- it looked up a day with no deliveries on it and
       reported that they all had a point already. todayIn resolves the
       day where the work happens, which is the whole reason it exists. */
    const [deliveryDate, setDeliveryDate] = useState(() => todayIn(timezone));
    const [deliveryBusy, setDeliveryBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            setSites(await api<Site[]>(base));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load sites' });
            setSites([]);
        }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

    /* WHETHER THIS DEPLOYMENT MAY LOOK UP DELIVERY ADDRESSES AT ALL.
       Asked rather than assumed, because the answer is an environment
       variable on the server and a button that always refuses is worse
       than no button. A failure here means "no", which is the safe way
       round. */
    useEffect(() => {
        let gone = false;
        (async () => {
            try {
                const got = await api<{ patientAddresses?: { lookedUp?: boolean } }>(
                    `/api/projects/${projectCode}/uh/geocode`,
                );
                if (!gone) setDeliveryLookup(got.patientAddresses?.lookedUp === true);
            } catch {
                if (!gone) setDeliveryLookup(false);
            }
        })();
        return () => { gone = true; };
    }, [projectCode]);

    const create = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
            await api(base, { method: 'POST', json: form });
            setForm(EMPTY);
            setAdding(false);
            setMsg({ kind: 'ok', text: 'Site added' });
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError ? { kind: 'error', text: err.message, details: err.details } : { kind: 'error', text: 'Could not add site' });
        } finally {
            setBusy(false);
        }
    };

    const remove = async (site: Site) => {
        if (!confirm(`Remove ${site.name}?`)) return;
        setMsg(null);
        try {
            await api(`${base}/${site.id}`, { method: 'DELETE' });
            setMsg({ kind: 'ok', text: `Removed ${site.name}` });
            await load();
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not remove site' });
        }
    };

    const pendingGeocode = sites?.filter((s) => s.lat === null).length ?? 0;
    const paged = usePaged(sites ?? []);

    /* ───────────────────── LOOKING THE PHARMACIES UP
     *
     * POST /uh/geocode/sites has existed since ticket 1.4 and NOTHING HAS
     * EVER CALLED IT. That is why the nine counters still have no
     * coordinates: not a missing key, not a refusal, simply no button. The
     * summary line above has been reporting "9 without coordinates" to
     * anybody who expanded this section, with no way to act on it.
     *
     * WHAT IT UNBLOCKS. The counters are the yardstick everything else is
     * measured against: load-zip-points.mjs refuses to load a ZIP centre it
     * cannot check against the nearest pharmacy, and without those centres
     * the route planner groups by zone band instead of real distance. One
     * press here is the first link in that chain.
     *
     * A PHARMACY IS A BUSINESS ADDRESS, which is the whole reason this is
     * allowed to be a button at all. A patient's delivery address is
     * protected health information and travels a different path with
     * different rules; see the header of modules/uh/geocode.ts. Nothing
     * here reads an order.
     */
    const [locating, setLocating] = useState(false);
    const locate = async () => {
        setLocating(true);
        setMsg(null);
        try {
            const out = await api<{
                pending: number;
                located: Array<{ code: string; quality: string }>;
                failed: Array<{ code: string; reason: string }>;
                stopped: string | null;
            }>(`/api/projects/${projectCode}/uh/geocode/sites`, { method: 'POST' });

            const done = out.located.length;
            if (out.stopped) {
                setMsg({
                    kind: 'warn',
                    text: `${done} located, then the lookup stopped: ${out.stopped}`,
                });
            } else if (out.failed.length > 0) {
                /* Named rather than counted. A pharmacy that will not
                   geocode usually has a typo in its own address row, and
                   the reason says which. */
                setMsg({
                    kind: done > 0 ? 'warn' : 'error',
                    text: `${done} located, ${out.failed.length} could not be.`,
                    details: out.failed.map((f) => `${f.code}: ${f.reason}`),
                });
            } else if (done === 0) {
                setMsg({ kind: 'ok', text: 'Every pharmacy already has coordinates.' });
            } else {
                setMsg({
                    kind: 'ok',
                    text: `${done} ${done === 1 ? 'pharmacy' : 'pharmacies'} located. `
                        + 'ZIP centres can be loaded now, which is what the route planner '
                        + 'measures distance with.',
                });
            }
            await load();
        } catch (e) {
            setMsg({ kind: 'error', text: why(e, 'The lookup could not be run.') });
        } finally {
            setLocating(false);
        }
    };

    /* ───────────────── LOOKING THE DELIVERY ADDRESSES UP
     *
     * A DIFFERENT THING FROM THE BUTTON ABOVE, under different rules, and
     * that is why it is a separate control with its own sentence rather
     * than a second mode of the same one. A pharmacy is a business
     * address. A patient's delivery address is protected health
     * information, and sending one anywhere is permitted only by the
     * business associate agreement signed on 20 November 2026.
     *
     * ONE DAY AT A TIME. The server insists on it and so does this: over
     * this contract "look up everything" is tens of thousands of
     * disclosures on one click, and nobody pressing a button has that in
     * mind. A dispatcher wants tomorrow's list routable.
     *
     * WHAT IT UNBLOCKS: the Cluster dialog puts each round in driving
     * order -- nearest stop first from the counter -- as soon as every
     * stop on it has a point. Until then it falls back to deadline order
     * and says so on the round.
     */
    const locateDeliveries = async () => {
        setDeliveryBusy(true);
        setMsg(null);
        try {
            const out = await api<{
                pending: number;
                located: Array<{ orderId: number; cached: boolean }>;
                failed: Array<{ orderId: number; reason: string }>;
                stopped: string | null;
            }>(`/api/projects/${projectCode}/uh/geocode/orders?serviceDate=${deliveryDate}`, { method: 'POST' });

            const done = out.located.length;
            if (out.stopped) {
                setMsg({ kind: 'warn', text: `${done} located, then the lookup stopped: ${out.stopped}` });
            } else if (out.pending === 0) {
                setMsg({ kind: 'ok', text: `Every delivery on ${deliveryDate} already has a point.` });
            } else if (out.failed.length > 0) {
                /* COUNTED, NOT NAMED. The sites version lists which ones
                   and why, because a pharmacy code is not somebody's
                   address. Here the reason is the same for all of them
                   and the identifiers are patients'. */
                setMsg({
                    kind: done > 0 ? 'warn' : 'error',
                    text: `${done} of ${out.pending} located. ${out.failed.length} could not be: `
                        + `${out.failed[0]?.reason ?? 'the lookup refused.'}`,
                });
            } else {
                setMsg({
                    kind: 'ok',
                    text: `${done} ${done === 1 ? 'delivery' : 'deliveries'} located. Rounds for `
                        + `${deliveryDate} can be put in driving order now.`,
                });
            }
        } catch (e) {
            setMsg({ kind: 'error', text: why(e, 'The delivery lookup could not be run.') });
        } finally {
            setDeliveryBusy(false);
        }
    };

    return (
        <Section
            id="uh.sites"
            title="Pickup locations"
            defaultOpen={false}
            summary={sites === null
                ? undefined
                : `${sites.length} ${sites.length === 1 ? 'pharmacy' : 'pharmacies'}`
                    + (pendingGeocode > 0 ? `, ${pendingGeocode} without coordinates` : '')}
            /* Adding a site was its own card, which put a button nobody
               presses monthly on the same footing as the day's work. It
               belongs to this list, so it sits on this list's header. */
            actions={(expand) => (canManage && !adding
                ? (
                    <>
                        {/* Only when there is something to look up, so the
                            control is absent rather than inert on the usual
                            day when every counter already has its point. */}
                        {pendingGeocode > 0 && (
                            <button
                                className="izy-btn"
                                type="button"
                                disabled={locating}
                                onClick={() => { expand(); void locate(); }}
                            >
                                {locating
                                    ? 'Looking them up\u2026'
                                    : `Look up ${pendingGeocode} ${pendingGeocode === 1 ? 'address' : 'addresses'}`}
                            </button>
                        )}
                        <button className="izy-btn secondary" type="button" onClick={() => { expand(); setAdding(true); }}>New site</button>
                    </>
                )
                : undefined)}
        >
                {msg && (
                    <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                        {msg.text}
                        {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                    </div>
                )}
            {/* Delivery addresses, which are not what this panel is about
                and sit at the bottom for that reason. Admins only, and
                only where the deployment is permitted at all. */}
            {canManage && deliveryLookup === true && (
                <form
                    className="izy-row"
                    style={{ marginTop: 12, alignItems: 'flex-end' }}
                    onSubmit={(e) => { e.preventDefault(); void locateDeliveries(); }}
                >
                    <label className="izy-field">
                        Delivery addresses for
                        <input
                            type="date"
                            value={deliveryDate}
                            onChange={(e) => setDeliveryDate(e.target.value)}
                            required
                        />
                    </label>
                    <button className="izy-btn secondary" type="submit" disabled={deliveryBusy}>
                        {deliveryBusy ? 'Looking them up…' : 'Look up that day'}
                    </button>
                    <span className="izy-muted">
                        Patient addresses, under the agreement signed with the provider. Doing this lets
                        the Cluster dialog put each round in driving order instead of deadline order.
                    </span>
                </form>
            )}

            {/* Directly under the header, because the button that opens it
               is on the header. Below a nine-row table it would look like
               nothing had happened. */}
            {canManage && adding && (
            <form className="izy-row" onSubmit={(e) => { void create(e); }}>
                <label className="izy-field">Code<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required placeholder="palo.alto" /></label>
                <label className="izy-field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
                <label className="izy-field">Type
                    <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Site['type'] })}>
                        <option value="pharmacy">pharmacy</option>
                        <option value="hospital">hospital</option>
                        <option value="other">other</option>
                    </select>
                </label>
                <label className="izy-field">Street address<input value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} required /></label>
                <label className="izy-field">City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} required /></label>
                <label className="izy-field">State<input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} required maxLength={2} /></label>
                <label className="izy-field">ZIP<input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} required placeholder="78229" /></label>
                <button className="izy-btn" type="submit" disabled={busy}>Add</button>
                <button className="izy-btn secondary" type="button" onClick={() => { setAdding(false); setForm(EMPTY); }}>Cancel</button>
            </form>
            )}
                {sites === null ? <Loading label="Loading sites" /> : (
                    <>
                        {pendingGeocode > 0 && (
                            <div className="izy-alert" style={{ background: 'var(--izy-warn-soft)', color: '#92400e' }}>
                                {pendingGeocode} of {sites.length} sites have no coordinates yet. Zone pricing needs them, and they are filled once address lookup is switched on.
                            </div>
                        )}
                        <table className="izy-table">
                            <thead>
                                <tr><th>Site</th><th>Address</th><th>Type</th><th>Daily list</th><th>Coordinates</th>{canManage && <th />}</tr>
                            </thead>
                            <tbody>
                                {paged.rows.map((s) => (
                                    <tr key={s.id}>
                                        <td>
                                            <b>{s.name}</b>
                                            <div className="izy-muted"><code>{s.code}</code>{s.status === 'inactive' && <span className="izy-pill off" style={{ marginLeft: 6 }}>inactive</span>}</div>
                                            {s.notes && <div className="izy-muted">{s.notes}</div>}
                                        </td>
                                        <td>{s.addressLine}<div className="izy-muted">{s.city}, {s.state} {s.zip}</div></td>
                                        <td>{s.type}</td>
                                        <td>{s.releasesList ? 'yes' : 'no'}</td>
                                        <td>
                                            {s.lat === null
                                                ? <span className="izy-pill warn">pending</span>
                                                : <><code>{s.lat.toFixed(5)}, {s.lng?.toFixed(5)}</code> <span className="izy-pill">{s.geocodeStatus}</span></>}
                                        </td>
                                        {canManage && <td style={{ textAlign: 'right' }}><button className="izy-btn danger small" type="button" onClick={() => { void remove(s); }}>Remove</button></td>}
                                    </tr>
                                ))}
                                {sites.length === 0 && <tr><td colSpan={canManage ? 6 : 5} className="izy-muted">No sites yet.</td></tr>}
                            </tbody>
                        </table>
                        <Pager of={paged} noun="pharmacies" />
                    </>
                )}

        </Section>
    );
}
