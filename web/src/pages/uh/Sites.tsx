/* UH sites: the pharmacies that release daily lists. Read-only for any
   member; admins and ops managers can add, edit and remove. */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
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

    const load = useCallback(async () => {
        try {
            setSites(await api<Site[]>(base));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load sites' });
            setSites([]);
        }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

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
