/* Project settings: the operating parameters of one contract.

   Every member can read them, because a dispatcher needs to know what clock
   they are working against. Only an admin or ops manager can change them.

   Each value is shown next to its contract default and marked when someone
   has overridden it, so nobody has to guess whether a number came from
   Addendum 1 or from a colleague. The worked examples underneath restate the
   current rules as real due times, which is the form a mistake shows up in. */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { clockFor } from '../lib/when';
import { Loading } from '../app/Loading';

interface Sla {
    clockStart: 'receipt' | 'pickup';
    scheduledMinutes: number;
    statMinutes: number;
    statFromPickupMinutes: number;
    adhocMinutes: number;
}
interface Settings {
    sla: Sla;
    businessHours: { start: string; end: string; days: number[] };
    listRelease: { earliest: string; latest: string };
    pricing: { afterHoursStart: string; afterHoursEnd: string; dryRunReplacesBase: boolean };
    /** The number the courier app's call button dials, and what it calls them.
     *  Optional on the wire only so a client older than the server does not
     *  crash on a payload that predates it. */
    dispatch?: { phone: string; name: string };
}
/** Settings with every section present, which is what the screen works on
 *  and what the server always sends. */
type Resolved = Omit<Settings, 'dispatch'> & { dispatch: { phone: string; name: string } };

interface Example {
    serviceType: string; receivedAt: string; dueAt: string | null;
    minutes: number; from: string; pending: boolean; basis: string;
}
interface Payload {
    timezone: string;
    settings: Settings;
    defaults: Settings;
    overridden: string[];
    canManage: boolean;
    example: Example[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ProjectSettings({ projectCode }: { projectCode: string }) {
    const base = `/api/projects/${projectCode}/settings`;
    const [data, setData] = useState<Payload | null>(null);
    const [draft, setDraft] = useState<(Resolved & { timezone: string }) | null>(null);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] } | null>(null);

    const load = useCallback(async () => {
        try { setData(await api<Payload>(base)); } catch { setData(null); }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

    if (data === null) return <div className="izy-card"><Loading label="Loading settings" /></div>;

    /* The server resolves every section against the contract defaults before
       it answers, so all of these are always present. Guarded anyway: a
       client left open across a deploy that adds a section would otherwise
       take the whole project page down over a missing phone number, and this
       card sits above the sites, the pricing and the dispatch links. */
    const s: Resolved = { ...data.settings, dispatch: data.settings.dispatch ?? { phone: '', name: 'Dispatch' } };
    /* The page says "Times are {data.timezone}" a few lines down, and the
       worked examples underneath it have to be in the zone it just named. */
    const clock = clockFor(data.timezone);
    const isOverridden = (path: string) => data.overridden.includes(path);
    const mark = (path: string) => (isOverridden(path)
        ? <span className="izy-pill warn" title="Changed from the contract default">changed</span>
        : null);

    const startEdit = () => {
        setDraft({ ...s, timezone: data.timezone });
        setMsg(null);
        setEditing(true);
    };

    const save = async (e: FormEvent) => {
        e.preventDefault();
        if (!draft) return;
        setBusy(true);
        setMsg(null);
        try {
            const next = await api<Payload>(base, {
                method: 'PATCH',
                json: {
                    timezone: draft.timezone,
                    sla: draft.sla,
                    businessHours: draft.businessHours,
                    listRelease: draft.listRelease,
                    pricing: draft.pricing,
                    dispatch: draft.dispatch,
                },
            });
            setData(next);
            setEditing(false);
            setMsg({ kind: 'ok', text: 'Settings saved.' });
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not save settings' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="izy-card">
            <div className="izy-row-between">
                <h2>Operating settings</h2>
                {data.canManage && !editing && <button className="izy-btn secondary" onClick={startEdit}>Edit</button>}
            </div>
            <p className="izy-muted">
                Contract parameters for this project. Defaults come from Addendum 1 and the Scope of Services;
                anything a person changed is marked. Times are {data.timezone}.
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {!editing || !draft ? (
                <>
                    <table className="izy-table">
                        <thead><tr><th>Setting</th><th>Value</th><th>Contract default</th></tr></thead>
                        <tbody>
                            <tr>
                                <td>Scheduled clock starts at {mark('sla.clockStart')}</td>
                                <td>{s.sla.clockStart === 'receipt' ? 'list received' : 'courier pickup'}</td>
                                <td>list received</td>
                            </tr>
                            <tr><td>Scheduled window {mark('sla.scheduledMinutes')}</td><td>{s.sla.scheduledMinutes} min</td><td>120 min</td></tr>
                            <tr><td>STAT, overall {mark('sla.statMinutes')}</td><td>{s.sla.statMinutes} min from request</td><td>120 min</td></tr>
                            <tr><td>STAT, after pickup {mark('sla.statFromPickupMinutes')}</td><td>{s.sla.statFromPickupMinutes} min from pickup</td><td>60 min</td></tr>
                            <tr><td>Ad hoc {mark('sla.adhocMinutes')}</td><td>{s.sla.adhocMinutes} min from request</td><td>240 min</td></tr>
                            <tr>
                                <td>Business hours {mark('businessHours.start')}{mark('businessHours.end')}</td>
                                <td>{s.businessHours.start} to {s.businessHours.end}</td>
                                <td>08:00 to 20:00</td>
                            </tr>
                            <tr>
                                <td>Days served {mark('businessHours.days')}</td>
                                <td>{s.businessHours.days.length === 7 ? 'every day' : s.businessHours.days.map((d) => DAYS[d]).join(', ')}</td>
                                <td>every day</td>
                            </tr>
                            <tr>
                                <td>Daily list arrives {mark('listRelease.earliest')}{mark('listRelease.latest')}</td>
                                <td>{s.listRelease.earliest} to {s.listRelease.latest}</td>
                                <td>12:00 to 14:00</td>
                            </tr>
                            <tr>
                                <td>After hours {mark('pricing.afterHoursStart')}{mark('pricing.afterHoursEnd')}</td>
                                <td>{s.pricing.afterHoursStart} to {s.pricing.afterHoursEnd}</td>
                                <td>20:00 to 07:00</td>
                            </tr>
                            <tr>
                                <td>Dry run {mark('pricing.dryRunReplacesBase')}</td>
                                <td>{s.pricing.dryRunReplacesBase ? 'replaces the delivery charge' : 'adds to the delivery charge'}</td>
                                <td>replaces</td>
                            </tr>
                            <tr>
                                {/* The courier app's call button. Empty until
                                    somebody sets it, and a courier standing at
                                    a door with a problem is exactly who needs
                                    it, so it is on this table rather than
                                    buried. */}
                                <td>Dispatch number {mark('dispatch.phone')}</td>
                                <td>
                                    {s.dispatch.phone
                                        ? <>{s.dispatch.phone} <span className="izy-muted">as {s.dispatch.name}</span></>
                                        : <span className="izy-stat-warn">not set, so couriers have no call button</span>}
                                </td>
                                <td>not in the contract</td>
                            </tr>
                            <tr><td>Timezone {mark('timezone')}</td><td>{data.timezone}</td><td>America/Chicago</td></tr>
                        </tbody>
                    </table>

                    <h3 style={{ marginTop: 18 }}>What that means for an order received now</h3>
                    <ul className="izy-plain-list">
                        {data.example.map((e) => (
                            <li key={e.serviceType}>
                                <b>{e.serviceType === 'adhoc' ? 'Ad hoc' : e.serviceType === 'stat' ? 'STAT' : 'Scheduled'}</b>
                                {' — '}
                                <span className="izy-muted">{e.basis}</span>
                                {e.dueAt && <> Due {clock(e.dueAt)}.</>}
                            </li>
                        ))}
                    </ul>
                </>
            ) : (
                <form onSubmit={(e) => { void save(e); }}>
                    <div className="izy-row">
                        <label className="izy-field">Scheduled clock starts at
                            <select value={draft.sla.clockStart} onChange={(e) => setDraft({ ...draft, sla: { ...draft.sla, clockStart: e.target.value as Sla['clockStart'] } })}>
                                <option value="receipt">list received</option>
                                <option value="pickup">courier pickup</option>
                            </select>
                        </label>
                        <label className="izy-field">Scheduled window (min)
                            <input type="number" min={1} max={1440} value={draft.sla.scheduledMinutes} onChange={(e) => setDraft({ ...draft, sla: { ...draft.sla, scheduledMinutes: Number(e.target.value) } })} />
                        </label>
                        <label className="izy-field">STAT overall (min)
                            <input type="number" min={1} max={1440} value={draft.sla.statMinutes} onChange={(e) => setDraft({ ...draft, sla: { ...draft.sla, statMinutes: Number(e.target.value) } })} />
                        </label>
                        <label className="izy-field">STAT after pickup (min)
                            <input type="number" min={1} max={1440} value={draft.sla.statFromPickupMinutes} onChange={(e) => setDraft({ ...draft, sla: { ...draft.sla, statFromPickupMinutes: Number(e.target.value) } })} />
                        </label>
                        <label className="izy-field">Ad hoc (min)
                            <input type="number" min={1} max={1440} value={draft.sla.adhocMinutes} onChange={(e) => setDraft({ ...draft, sla: { ...draft.sla, adhocMinutes: Number(e.target.value) } })} />
                        </label>
                    </div>

                    <div className="izy-row">
                        <label className="izy-field">Business hours start
                            <input type="time" value={draft.businessHours.start} onChange={(e) => setDraft({ ...draft, businessHours: { ...draft.businessHours, start: e.target.value } })} />
                        </label>
                        <label className="izy-field">Business hours end
                            <input type="time" value={draft.businessHours.end} onChange={(e) => setDraft({ ...draft, businessHours: { ...draft.businessHours, end: e.target.value } })} />
                        </label>
                        <label className="izy-field">List arrives, earliest
                            <input type="time" value={draft.listRelease.earliest} onChange={(e) => setDraft({ ...draft, listRelease: { ...draft.listRelease, earliest: e.target.value } })} />
                        </label>
                        <label className="izy-field">List arrives, latest
                            <input type="time" value={draft.listRelease.latest} onChange={(e) => setDraft({ ...draft, listRelease: { ...draft.listRelease, latest: e.target.value } })} />
                        </label>
                    </div>

                    <fieldset className="izy-fieldset">
                        <legend>Days served</legend>
                        {DAYS.map((label, day) => (
                            <label key={label} className="izy-check">
                                <input
                                    type="checkbox"
                                    checked={draft.businessHours.days.includes(day)}
                                    onChange={(e) => setDraft({
                                        ...draft,
                                        businessHours: {
                                            ...draft.businessHours,
                                            days: e.target.checked
                                                ? [...draft.businessHours.days, day].sort((a, b) => a - b)
                                                : draft.businessHours.days.filter((d) => d !== day),
                                        },
                                    })}
                                /> {label}
                            </label>
                        ))}
                    </fieldset>

                    <div className="izy-row">
                        <label className="izy-field">After hours start
                            <input type="time" value={draft.pricing.afterHoursStart} onChange={(e) => setDraft({ ...draft, pricing: { ...draft.pricing, afterHoursStart: e.target.value } })} />
                        </label>
                        <label className="izy-field">After hours end
                            <input type="time" value={draft.pricing.afterHoursEnd} onChange={(e) => setDraft({ ...draft, pricing: { ...draft.pricing, afterHoursEnd: e.target.value } })} />
                        </label>
                        <label className="izy-field">Dry run
                            <select value={draft.pricing.dryRunReplacesBase ? 'replace' : 'add'} onChange={(e) => setDraft({ ...draft, pricing: { ...draft.pricing, dryRunReplacesBase: e.target.value === 'replace' } })}>
                                <option value="replace">replaces the delivery charge</option>
                                <option value="add">adds to the delivery charge</option>
                            </select>
                        </label>
                        <label className="izy-field">Timezone
                            <input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} placeholder="America/Chicago" />
                        </label>
                    </div>

                    {/* Not a contract parameter, which is why it sat unset with
                        no way to set it: the courier app has had a call button
                        since the run screen existed and nothing anywhere could
                        give it a number. */}
                    <div className="izy-row">
                        <label className="izy-field">Dispatch number
                            <input
                                type="tel"
                                value={draft.dispatch.phone}
                                onChange={(e) => setDraft({ ...draft, dispatch: { ...draft.dispatch, phone: e.target.value } })}
                                placeholder="210-555-0100"
                            />
                        </label>
                        <label className="izy-field">What couriers call them
                            <input
                                value={draft.dispatch.name}
                                onChange={(e) => setDraft({ ...draft, dispatch: { ...draft.dispatch, name: e.target.value } })}
                                placeholder="Dispatch"
                            />
                        </label>
                    </div>
                    <p className="izy-muted">
                        The number a courier&rsquo;s <b>Call {draft.dispatch.name || 'Dispatch'}</b> button dials. Leave it empty and
                        there is no button, which is a courier at a door with a problem and no way to raise it.
                    </p>

                    <p className="izy-muted">
                        Changing the after-hours window or the dry-run rule changes what UH is billed.
                        Every change is recorded in the audit log with its old and new value.
                    </p>
                    <div className="izy-row">
                        <button className="izy-btn" type="submit" disabled={busy}>{busy ? 'Saving' : 'Save settings'}</button>
                        <button className="izy-btn secondary" type="button" onClick={() => { setEditing(false); setMsg(null); }} disabled={busy}>Cancel</button>
                    </div>
                </form>
            )}
        </div>
    );
}
