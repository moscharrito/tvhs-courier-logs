/* How the contract is going.
 *
 * The screen leads with the one number University Health holds us to, against
 * the figure they hold us to, because that is the question every other number
 * here is context for. The definitions are on the page rather than behind a
 * link: a rate whose basis is a click away is a rate somebody will quote
 * without reading the basis.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { todayIn } from '../../lib/when';

interface Totals {
    orders: number; delivered: number; notDelivered: number; cancelled: number;
    stillOpen: number; attempts: number; onTimeMet: number; onTimeMissed: number; notMeasured: number;
}
interface Rates {
    completionRate: number | null; onTimeRate: number | null;
    dryRunRate: number | null; literalScopeRatio: number | null;
}
interface Slice { key: string; label: string; totals: Totals; rates: Rates }

interface Report {
    from: string; to: string; grouping: string; timezone: string; generatedAt: string;
    totals: Totals; rates: Rates;
    target: { completion: number; internalGoal: number };
    meetsContract: boolean | null;
    byPeriod: Slice[]; byServiceType: Slice[]; bySite: Slice[]; byZone: Slice[]; byDayType: Slice[];
    definitions: Array<{ measure: string; definition: string; note: string }>;
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(1)}%`);

const GROUPINGS = [
    { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' },
];

/** The last N days, as service dates in the project's zone.
 *
 * Not UTC. From 7pm in Chicago onwards `toISOString()` is already tomorrow,
 * so the range this page opened on ended on a day that had not happened and
 * the header said so. Service dates are questions about San Antonio. */
function defaultRange(days: number, timezone: string): { from: string; to: string } {
    const now = Date.now();
    return {
        from: todayIn(timezone, new Date(now - (days - 1) * 86400000)),
        to: todayIn(timezone),
    };
}

export function Reports() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const [params, setParams] = useSearchParams();
    const [report, setReport] = useState<Report | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    const fallback = defaultRange(30, useProjectTimezone(code));
    const from = params.get('from') ?? fallback.from;
    const to = params.get('to') ?? fallback.to;
    const groupBy = params.get('groupBy') ?? 'week';
    const query = `from=${from}&to=${to}&groupBy=${groupBy}`;

    const load = useCallback(async () => {
        setMsg(null);
        try {
            setReport(await api<Report>(`/api/projects/${code}/uh/reports/sla?${query}`));
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not build the report.');
        }
    }, [code, query]);
    useEffect(() => { void load(); }, [load]);

    if (!project) return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    if (report === null) {
        return msg
            ? (<><h1>Performance</h1><div className="izy-alert error" role="alert">{msg}</div></>)
            : <div className="izy-card"><Loading label="Building the report" /></div>;
    }

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        next.set('from', from);
        next.set('to', to);
        next.set('groupBy', groupBy);
        next.set(key, value);
        setParams(next, { replace: true });
    };

    const table = (title: string, first: string, slices: Slice[]) => (
        <div className="izy-card" key={title}>
            <h2>{title}</h2>
            {slices.length === 0 ? <p className="izy-muted">Nothing in this range.</p> : (
                <table className="izy-table">
                    <thead>
                        <tr>
                            <th>{first}</th><th>Deliveries</th><th>Attempted</th><th>Delivered</th>
                            <th>Not delivered</th><th>Completion</th><th>On time</th>
                        </tr>
                    </thead>
                    <tbody>
                        {slices.map((s) => (
                            <tr key={s.key}>
                                <td>{s.label}</td>
                                <td>{s.totals.orders}</td>
                                <td>{s.totals.attempts}</td>
                                <td>{s.totals.delivered}</td>
                                <td>{s.totals.notDelivered}</td>
                                <td className={s.rates.completionRate !== null && s.rates.completionRate < report.target.completion ? 'izy-stat-bad' : undefined}>
                                    {pct(s.rates.completionRate)}
                                </td>
                                <td>{pct(s.rates.onTimeRate)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );

    return (
        <>
            <h1>Performance</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}`}>{project.name}</Link> · {report.from} to {report.to} · {report.timezone}
            </p>

            {msg && <div className="izy-alert error" role="alert">{msg}</div>}

            <div className="izy-card">
                <div className="izy-row">
                    <label className="izy-field">From
                        <input type="date" value={from} onChange={(e) => set('from', e.target.value)} />
                    </label>
                    <label className="izy-field">To
                        <input type="date" value={to} onChange={(e) => set('to', e.target.value)} />
                    </label>
                    <label className="izy-field">Group by
                        <select value={groupBy} onChange={(e) => set('groupBy', e.target.value)}>
                            {GROUPINGS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                        </select>
                    </label>
                    {/* A plain link: the browser downloads it and no copy of
                        the workbook is held in the tab. */}
                    <a className="izy-btn" href={`/api/projects/${code}/uh/reports/sla.xlsx?${query}`}>
                        Export to Excel
                    </a>
                </div>
            </div>

            <div className="izy-card">
                <h2>Against the contract</h2>
                <div className="izy-stats">
                    <div className={report.meetsContract === false ? 'izy-stat-bad' : undefined}>
                        <b>{pct(report.rates.completionRate)}</b>
                        <span>completion rate</span>
                    </div>
                    <div><b>{report.target.completion}%</b><span>contract requires</span></div>
                    <div><b>{report.target.internalGoal}%</b><span>internal goal</span></div>
                    <div><b>{pct(report.rates.onTimeRate)}</b><span>arrived on time</span></div>
                    <div><b>{pct(report.rates.dryRunRate)}</b><span>dry runs</span></div>
                </div>
                <p className="izy-muted">
                    {report.totals.delivered} delivered and {report.totals.notDelivered} not delivered,
                    out of {report.totals.attempts} attempted.
                    {report.totals.stillOpen > 0 && <> {report.totals.stillOpen} still open and left out of every rate.</>}
                    {report.totals.cancelled > 0 && <> {report.totals.cancelled} cancelled and excluded.</>}
                    {report.totals.notMeasured > 0 && <> {report.totals.notMeasured} could not be timed.</>}
                </p>
                {report.meetsContract === false && (
                    <div className="izy-alert warn" role="status">
                        Below the {report.target.completion} per cent the contract requires for this range.
                    </div>
                )}
            </div>

            {table('By period', report.grouping === 'day' ? 'Service date' : 'Period', report.byPeriod)}
            {table('By service type', 'Service type', report.byServiceType)}
            {table('By pharmacy', 'Pharmacy', report.bySite)}
            {table('By zone', 'Zone', report.byZone)}
            {table('By day type', 'Day type', report.byDayType)}

            <div className="izy-card">
                <h2>What these numbers mean</h2>
                {/* On the page, not behind a link. A rate whose basis is a
                    click away is a rate somebody quotes without the basis. */}
                <table className="izy-table">
                    <thead><tr><th>Measure</th><th>Definition</th><th>Note</th></tr></thead>
                    <tbody>
                        {report.definitions.map((d) => (
                            <tr key={d.measure}>
                                <td><b>{d.measure}</b></td>
                                <td>{d.definition}</td>
                                <td className="izy-muted">{d.note}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {report.rates.literalScopeRatio !== null && (
                    <p className="izy-muted">
                        Scope 1.2.5 as literally written (attempts divided by successful deliveries) gives{' '}
                        {report.rates.literalScopeRatio.toFixed(3)} for this range, which cannot be a percentage.
                        Raise it with University Health before the first quarterly review.
                    </p>
                )}
            </div>
        </>
    );
}
