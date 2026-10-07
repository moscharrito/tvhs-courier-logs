/* One driver's record: by day, by month, by year.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE SCREEN, TWO READERS, AND THE SERVER DECIDES WHICH.
 *
 * A courier opens their own and dispatch opens anybody's. The difference is
 * the route it asks for, never a flag on this page: /drivers/me takes the
 * username off the session and there is no parameter that changes it, while
 * /drivers/:username is gated on the project admin role. A page that chose
 * between them from a prop would be one mistaken prop away from a courier
 * reading where every other courier went, which is a list of patient
 * addresses wearing a payslip.
 *
 * So the route is chosen from the URL this page was mounted at, and if the
 * reader is not entitled to it the server answers 403 and this renders that.
 *
 * WHAT IT IS FOR. Daily, monthly and yearly totals, so a payment run can be
 * checked and disbursed. The pharmacies each period's work was for, because
 * "delivered for" is part of the question. No patient and no address, because
 * the server does not send them and a pay record should not carry them.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { useAuth } from '../../app/auth';
import { money } from './Drivers';

interface PayLine { delivered: number; rateCents: number; payCents: number | null }

interface Totals {
    delivered: number;
    failed: number;
    payCents: number | null;
    rateSet: boolean;
    byServiceType: Record<string, PayLine>;
}

interface Period extends Totals {
    period: string;
    pharmacies: Array<{ name: string; delivered: number; failed: number }>;
}

interface Record_ {
    from: string; to: string; timezone: string; currency: string;
    username: string; name: string;
    grouping: 'day' | 'month' | 'year';
    periods: Period[];
    totals: Totals;
}

const GROUPINGS = [
    { value: 'day', label: 'Day' },
    { value: 'month', label: 'Month' },
    { value: 'year', label: 'Year' },
];

const isoDay = (offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return d.toISOString().slice(0, 10);
};

/** `mine` is set by the route, not by a prop a caller could get wrong. */
export function DriverRecord({ mine = false }: { mine?: boolean }) {
    const { code = '', username = '' } = useParams();
    const { projects, user } = useAuth();
    const project = projects.find((p) => p.code === code);
    const [params, setParams] = useSearchParams();

    const from = params.get('from') ?? isoDay(30);
    const to = params.get('to') ?? isoDay(0);
    const groupBy = params.get('groupBy') ?? 'day';

    const [data, setData] = useState<Record_ | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    /* The route is the authorization, so it is built here from which page
       this is rather than from anything the reader can influence. */
    const who = mine ? 'me' : encodeURIComponent(username);

    const load = useCallback(async () => {
        setMsg(null);
        try {
            setData(await api<Record_>(
                `/api/projects/${code}/uh/drivers/${who}?from=${from}&to=${to}&groupBy=${groupBy}`,
            ));
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not load the record.');
        }
    }, [code, who, from, to, groupBy]);
    useEffect(() => { void load(); }, [load]);

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        if (value === '') next.delete(key); else next.set(key, value);
        setParams(next, { replace: true });
    };

    if (!project) {
        return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    }
    if (data === null) {
        return msg
            ? (<><h1>Deliveries</h1><div className="izy-alert error" role="alert">{msg}</div></>)
            : <div className="izy-card"><Loading label="Loading the record" /></div>;
    }

    const title = mine ? 'Your deliveries' : data.name;

    return (
        <>
            <h1>{title}</h1>
            <p className="izy-sub">
                {mine ? user?.username : data.username} · times in {data.timezone}
            </p>

            {msg && <div className="izy-alert error" role="alert">{msg}</div>}

            {!mine && (
                <p>
                    <Link className="izy-btn secondary" to={`/projects/${code}/drivers?from=${from}&to=${to}`}>
                        Back to all drivers
                    </Link>
                </p>
            )}

            {/* Said once rather than as a dash in every row. */}
            {!data.totals.rateSet && (
                <div className="izy-alert warn" role="status">
                    No pay is shown because the per-delivery rate is not set for every service level
                    worked in this range. The counts below are complete; the money is waiting on the
                    rate card.
                </div>
            )}

            <div className="izy-card">
                <div className="izy-row">
                    <label className="izy-field">From
                        <input type="date" value={from} onChange={(e) => set('from', e.target.value)} />
                    </label>
                    <label className="izy-field">To
                        <input type="date" value={to} onChange={(e) => set('to', e.target.value)} />
                    </label>
                    <label className="izy-field">Grouped by
                        <select value={groupBy} onChange={(e) => set('groupBy', e.target.value)}>
                            {GROUPINGS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                        </select>
                    </label>
                </div>
            </div>

            <div className="izy-card">
                <h2>{from} to {to}</h2>
                <div className="izy-stats">
                    <div><b>{data.totals.delivered}</b><span>delivered</span></div>
                    <div className={data.totals.failed > 0 ? 'izy-stat-bad' : undefined}>
                        <b>{data.totals.failed}</b><span>not delivered</span>
                    </div>
                    <div><b>{data.periods.length}</b><span>{groupBy === 'day' ? 'days' : `${groupBy}s`}</span></div>
                    <div><b>{money(data.totals.payCents, data.currency)}</b><span>{mine ? 'earned' : 'to disburse'}</span></div>
                </div>
            </div>

            {data.periods.length === 0 ? (
                <div className="izy-card"><p className="izy-muted">Nothing delivered in this range.</p></div>
            ) : data.periods.map((p) => (
                <Section
                    key={p.period}
                    id={`driver-period-${p.period}`}
                    title={p.period}
                    summary={`${p.delivered} delivered${p.failed > 0 ? `, ${p.failed} not` : ''} · ${money(p.payCents, data.currency)}`}
                >
                    <table className="izy-table">
                        <thead><tr><th>Pharmacy</th><th>Delivered</th><th>Not delivered</th></tr></thead>
                        <tbody>
                            {p.pharmacies.map((ph) => (
                                <tr key={ph.name}>
                                    <td>{ph.name}</td>
                                    <td>{ph.delivered}</td>
                                    <td className={ph.failed > 0 ? 'izy-stat-bad' : undefined}>{ph.failed}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {Object.keys(p.byServiceType).length > 0 && (
                        <table className="izy-table">
                            <thead><tr><th>Service level</th><th>Delivered</th><th>Rate</th><th>Pay</th></tr></thead>
                            <tbody>
                                {Object.entries(p.byServiceType).map(([type, line]) => (
                                    <tr key={type}>
                                        <td>{type}</td>
                                        <td>{line.delivered}</td>
                                        <td>{line.rateCents > 0 ? money(line.rateCents, data.currency) : 'not set'}</td>
                                        <td>{money(line.payCents, data.currency)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Section>
            ))}
        </>
    );
}
