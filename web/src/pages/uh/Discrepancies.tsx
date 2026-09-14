/* What did not match, during the shadow week.
 *
 * Ticket 5.2. Two audiences on one screen, because they are doing two halves
 * of the same job:
 *
 *   Anybody, including a courier: report one. The form is first and short,
 *   because it is filled in by somebody who has just noticed something and
 *   has a van running outside.
 *
 *   Staff: read the log and close things. Open and worst at the top, since
 *   that is the order they get dealt with in.
 *
 * The go-live panel deliberately does not show a green tick when the board is
 * clean. A clean board is necessary and not sufficient, a person decides, and
 * a tick would invite somebody to treat it as the decision.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Discrepancy, type DiscrepancySummary } from '../../lib/api';
import { momentFor } from '../../lib/when';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { Loading } from '../../app/Loading';

const KINDS: Array<{ value: string; label: string }> = [
    { value: 'delivery', label: 'What was recorded at the door' },
    { value: 'import', label: 'The list, or what it created' },
    { value: 'assignment', label: 'Who the system says has it' },
    { value: 'timing', label: 'Times, or the SLA answer' },
    { value: 'billing', label: 'What it would be charged' },
    { value: 'system', label: 'The app itself' },
    { value: 'other', label: 'Something else' },
];

const SEVERITIES: Array<{ value: string; label: string; help: string }> = [
    { value: 'critical', label: 'Critical', help: 'A delivery record is wrong or missing. This stops go-live on its own.' },
    { value: 'major', label: 'Major', help: 'Wrong, but caught and put right within the day.' },
    { value: 'minor', label: 'Minor', help: 'Awkward, slow or confusing. Nothing was recorded wrongly.' },
];

const today = () => new Date().toISOString().slice(0, 10);

export function Discrepancies() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const canReview = project !== undefined && project.role !== 'courier' && project.role !== 'client_viewer';
    const base = `/api/projects/${code}/uh/discrepancies`;
    /* When a courier filed it, in the zone the day it is about was worked
       in. This is evidence for a go-live decision and it is read later. */
    const when = momentFor(useProjectTimezone(code));

    const [list, setList] = useState<Discrepancy[] | null>(null);
    const [summary, setSummary] = useState<DiscrepancySummary | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const [serviceDate, setServiceDate] = useState(today());
    const [kind, setKind] = useState('delivery');
    const [severity, setSeverity] = useState('major');
    const [reference, setReference] = useState('');
    const [expected, setExpected] = useState('');
    const [actual, setActual] = useState('');

    const load = useCallback(async () => {
        if (!canReview) return;
        try {
            const [l, s] = await Promise.all([
                api<Discrepancy[]>(`${base}?status=open`),
                api<DiscrepancySummary>(`${base}/summary`),
            ]);
            setList(l);
            setSummary(s);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load the log' });
        }
    }, [base, canReview]);
    useEffect(() => { void load(); }, [load]);

    const report = (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        void (async () => {
            try {
                await api(base, {
                    method: 'POST',
                    json: {
                        serviceDate, kind, severity, expected, actual,
                        ...(reference.trim() ? { orderId: Number(reference.trim()) } : {}),
                    },
                });
                setExpected(''); setActual(''); setReference('');
                setMsg({ kind: 'ok', text: 'Filed. Thank you: a week with no reports means nobody was looking.' });
                await load();
            } catch (err) {
                setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not file it' });
            } finally {
                setBusy(false);
            }
        })();
    };

    const close = (id: number, status: 'resolved' | 'accepted') => {
        const resolution = window.prompt(
            status === 'resolved'
                ? 'What was changed? Code, data, process, or what somebody was taught.'
                : 'Why does nothing need changing?',
        );
        if (resolution === null) return;
        void (async () => {
            try {
                await api(`${base}/${id}`, { method: 'PATCH', json: { status, resolution } });
                await load();
            } catch (err) {
                setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not close it' });
            }
        })();
    };

    if (!project) return (<><h1>Project not available</h1><Link className="izy-btn secondary" to="/">Back to projects</Link></>);

    return (
        <>
            <h1>Discrepancies</h1>
            <p className="izy-sub">
                Anything where this system and what actually happened disagree. When in doubt, file it:
                a duplicate costs a minute, a missed one costs the go-live decision.
            </p>
            {msg && <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

            <form className="izy-card" onSubmit={report}>
                <h2>Report one</h2>
                <label className="izy-field">Which day it was about
                    <input type="date" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} required />
                </label>
                <label className="izy-field">What it is about
                    <select value={kind} onChange={(e) => setKind(e.target.value)}>
                        {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                </label>
                <label className="izy-field">How bad
                    <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                        {SEVERITIES.map((sv) => <option key={sv.value} value={sv.value}>{sv.label}</option>)}
                    </select>
                </label>
                <p className="izy-muted">{SEVERITIES.find((sv) => sv.value === severity)?.help}</p>

                <label className="izy-field">Delivery number, if it is about one
                    <input inputMode="numeric" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="4182" />
                </label>
                {/* Said on the screen, because somebody under time pressure
                    will otherwise identify a delivery the quick way. */}
                <p className="izy-muted">
                    Point at a delivery by its number. Please do not type a patient&apos;s name in the boxes below.
                </p>

                <label className="izy-field">What the system said
                    <textarea rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} required minLength={3} />
                </label>
                <label className="izy-field">What actually happened
                    <textarea rows={2} value={actual} onChange={(e) => setActual(e.target.value)} required minLength={3} />
                </label>
                <button className="izy-btn" type="submit" disabled={busy}>{busy ? 'Filing' : 'File it'}</button>
            </form>

            {!canReview && (
                <p className="izy-muted">
                    Dispatch reviews these at the end of each day. You will hear what was found.
                </p>
            )}

            {canReview && summary && (
                <div className="izy-card">
                    <h2>Where the week stands</h2>
                    <div className="izy-stats">
                        <div className={summary.goLive.openCritical > 0 ? 'izy-stat-bad' : undefined}>
                            <b>{summary.goLive.openCritical}</b><span>critical, open</span>
                        </div>
                        <div><b>{summary.totals.open}</b><span>open</span></div>
                        <div><b>{summary.totals.resolved}</b><span>resolved</span></div>
                        <div><b>{summary.totals.accepted}</b><span>accepted</span></div>
                    </div>
                    {/* No green tick. A clean board is not a decision. */}
                    <p>{summary.goLive.why}</p>
                    {summary.days.length > 0 && (
                        <table className="izy-table">
                            <thead><tr><th>Day</th><th>Open</th><th>Resolved</th><th>Accepted</th><th>Critical</th></tr></thead>
                            <tbody>
                                {summary.days.map((d) => (
                                    <tr key={d.serviceDate}>
                                        <td>{d.serviceDate}</td><td>{d.open}</td><td>{d.resolved}</td>
                                        <td>{d.accepted}</td><td>{d.critical}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {canReview && (
                <div className="izy-card">
                    <h2>Still open</h2>
                    {list === null ? <Loading label="Loading the log" /> : list.length === 0 ? (
                        <div className="izy-muted">Nothing open.</div>
                    ) : list.map((d) => (
                        <div key={d.id} className="izy-pool-group">
                            <div>
                                <span className={`izy-pill ${d.severity === 'critical' ? 'izy-stat-bad' : ''}`}>{d.severity}</span>
                                {' '}<b>{d.kind}</b>{' · '}{d.serviceDate}
                                {d.reference && <>{' · '}{d.reference}</>}
                                <div className="izy-muted">
                                    {d.reportedBy}, {when(d.reportedAt)}
                                </div>
                            </div>
                            <p><b>System:</b> {d.expected}</p>
                            <p><b>Actually:</b> {d.actual}</p>
                            <div className="izy-row">
                                <button className="izy-btn small" type="button" onClick={() => close(d.id, 'resolved')}>
                                    Something was changed
                                </button>
                                <button className="izy-btn secondary small" type="button" onClick={() => close(d.id, 'accepted')}>
                                    Nothing needs changing
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
