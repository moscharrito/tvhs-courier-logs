/* What each driver delivered, and what it comes to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIRST SCREEN IN THIS SYSTEM SOMEBODY IS PAID FROM.
 *
 * So the thing it must never do is show a confident wrong number. The server
 * withholds a figure rather than giving a partial one when a rate is unset
 * (modules/uh/driver-pay.ts), and this screen's job is to render that absence
 * as an absence. `rateSet: false` becomes "rate not set", never a dash and
 * never $0.00: a nought beside 241 deliveries looks like an answer and
 * somebody will quote it at a courier.
 *
 * NO PATIENT IS NAMED HERE, because the server does not send one. A pay record
 * is counts, dates, pharmacies and money, which is what makes it safe to
 * export and send to a bookkeeper. The pharmacy IS named: that is the
 * "delivered for" the question asked about, and a pharmacy is a business
 * address.
 *
 * Failures are shown beside the paid deliveries rather than dropped. They pay
 * nothing today and nobody has actually decided that they should not; a
 * courier who drove to a door and found nobody in has done real work. Showing
 * the count keeps the question somewhere a person will see it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { Pager, usePaged } from '../../app/Pager';
import { useAuth } from '../../app/auth';

interface PayLine { delivered: number; rateCents: number; payCents: number | null }

interface Totals {
    delivered: number;
    failed: number;
    payCents: number | null;
    rateSet: boolean;
    byServiceType: Record<string, PayLine>;
}

interface DriverRow extends Totals {
    username: string;
    name: string;
    daysWorked: number;
}

interface Everyone {
    from: string; to: string; timezone: string; currency: string;
    rateSet: boolean;
    drivers: DriverRow[];
    totals: Totals;
}

/** Cents as money, once, at the edge. Null is not nought and never renders
 *  as one: see the header. */
export function money(cents: number | null, currency: string): string {
    if (cents === null) return 'rate not set';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Thirty days back, which is the window somebody checking a payment run is
 *  usually looking at. */
const isoDay = (offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return d.toISOString().slice(0, 10);
};

export function Drivers() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const [params, setParams] = useSearchParams();

    const from = params.get('from') ?? isoDay(30);
    const to = params.get('to') ?? isoDay(0);

    const [data, setData] = useState<Everyone | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    const load = useCallback(async () => {
        setMsg(null);
        try {
            setData(await api<Everyone>(`/api/projects/${code}/uh/drivers?from=${from}&to=${to}`));
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not load the drivers.');
        }
    }, [code, from, to]);
    useEffect(() => { void load(); }, [load]);

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        if (value === '') next.delete(key); else next.set(key, value);
        setParams(next, { replace: true });
    };

    const paged = usePaged(data?.drivers ?? []);

    if (!project || project.role !== 'admin') {
        return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    }
    if (data === null) {
        return msg
            ? (<><h1>Drivers</h1><div className="izy-alert error" role="alert">{msg}</div></>)
            : <div className="izy-card"><Loading label="Loading the drivers" /></div>;
    }

    return (
        <>
            <h1>Drivers</h1>
            <p className="izy-sub">
                What each driver delivered, and what it comes to · times in {data.timezone}
            </p>

            {msg && <div className="izy-alert error" role="alert">{msg}</div>}

            {/* Said once, at the top, rather than as a dash in forty cells.
                Somebody looking at this screen for the first time needs to
                know whether they are looking at a payment run or at a
                delivery count. */}
            {!data.rateSet && (
                <div className="izy-alert warn" role="status">
                    No pay is shown because the per-delivery rates are not set for every service level
                    that was worked. The delivery counts below are complete and correct; the money is
                    waiting on the rate card in this project&apos;s settings.
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
                    <button className="izy-btn secondary" type="button" onClick={() => { void load(); }}>
                        Refresh
                    </button>
                    {/* A plain link carrying the same range the table was
                        built from, so the file is what is on screen. Not a
                        fetch and a blob: the browser knows how to save a
                        download, and a blob URL would keep a copy of the
                        payment run alive in the tab until it was closed. */}
                    <a className="izy-btn secondary" href={`/api/projects/${code}/uh/drivers/export.xlsx?from=${from}&to=${to}`}>
                        Export to Excel
                    </a>
                </div>
            </div>

            <div className="izy-card">
                <h2>{from} to {to}</h2>
                <div className="izy-stats">
                    <div><b>{data.drivers.length}</b><span>drivers</span></div>
                    <div><b>{data.totals.delivered}</b><span>delivered</span></div>
                    <div className={data.totals.failed > 0 ? 'izy-stat-bad' : undefined}>
                        <b>{data.totals.failed}</b><span>not delivered</span>
                    </div>
                    <div><b>{money(data.totals.payCents, data.currency)}</b><span>to disburse</span></div>
                </div>
            </div>

            <div className="izy-card">
                <h2>By driver</h2>
                {data.drivers.length === 0 ? (
                    <p className="izy-muted">Nobody delivered in this range.</p>
                ) : (
                    <>
                        <table className="izy-table">
                            <thead>
                                {/* izy-num on everything countable: right
                                    aligned with tabular figures, so a column
                                    of numbers reads as a column rather than
                                    as ragged text. It is the difference
                                    between a table somebody scans and one
                                    they have to read. */}
                                <tr>
                                    <th>Driver</th>
                                    <th className="izy-num">Days worked</th>
                                    <th className="izy-num">Delivered</th>
                                    <th className="izy-num">Not delivered</th>
                                    <th className="izy-num">Pay</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paged.rows.map((d) => (
                                    <tr key={d.username}>
                                        <td>
                                            {/* Through to their own record, which is where
                                                the dates and pharmacies are. */}
                                            <Link to={`/projects/${code}/drivers/${d.username}?from=${from}&to=${to}`}>
                                                {d.name}
                                            </Link>
                                            <div className="izy-muted">{d.username}</div>
                                        </td>
                                        <td className="izy-num">{d.daysWorked}</td>
                                        <td className="izy-num">{d.delivered}</td>
                                        <td className={`izy-num${d.failed > 0 ? ' izy-stat-bad' : ''}`}>{d.failed}</td>
                                        <td className="izy-num">{money(d.payCents, data.currency)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <Pager of={paged} noun="drivers" />
                        <p className="izy-muted">
                            Pay is per completed delivery. A delivery that was attempted and not
                            completed pays nothing and is counted in the column beside it.
                        </p>
                    </>
                )}
            </div>
        </>
    );
}
