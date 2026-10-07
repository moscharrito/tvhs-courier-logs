/* The performance report, read by University Health themselves.
 *
 * Karthik Munnam's list of 29 September 2026, in his order and close to his
 * words, so somebody holding that email can tick down the page:
 *
 *   Total number of deliveries
 *   Completed and on-time deliveries
 *   Delayed and failed deliveries
 *   Reasons for failed or unsuccessful deliveries
 *   Delivery turnaround times
 *   Deliveries by location, service level, and date range
 *   Reattempted, cancelled, or returned deliveries
 *   Report frequency, customization options
 *
 * The last of those is the date range and the grouping: a client who can ask
 * for last quarter by month does not need us to run anything for them.
 *
 * SCOPED BY THE SERVER, NOT BY THIS PAGE. Everything here is whatever the
 * viewer's membership entitles them to. A pharmacist at one counter sees
 * their own numbers, a contract manager scoped to every pharmacy sees the
 * contract, and neither can change that from a browser.
 *
 * EVERY RATE CARRIES ITS DEFINITION, on the page rather than behind a link.
 * A rate whose basis is a click away is a rate somebody quotes without the
 * basis, and that argument then happens in a contract meeting.
 *
 * NO MONEY. He did not ask for any, and what a delivery cost belongs on an
 * invoice somebody has checked rather than in a screen where a figure could
 * be quoted back at us as a bill.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY COUNT IS A LINK TO THE DELIVERIES IT COUNTED.
 *
 * This page and the deliveries page were both finished and there was no way
 * down between them. Somebody reading "Robert B. Green: 3 not delivered" knew
 * three existed and not which three, and getting to them meant reproducing
 * the question by hand on the other page: the dates, the pharmacy, the
 * status, and a hope that they had set the same three things. Most people
 * ring us instead, which is the work the portal was built to remove.
 *
 * The range behind each link is CLAMPED to the window this report ran over,
 * in lib/drilldown.ts, which is where the arithmetic and its tests live. A
 * calendar month bucket off a report run over half a month would otherwise
 * link to more rows than the figure above it, and then two numbers disagree
 * and one of them gets quoted in a contract meeting.
 */

import { useCallback, useEffect, useState } from 'react';
import { Section } from '../../app/Section';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import {
    clampToWindow, drillQuery, rangeOfBucket, siteIdOfSliceKey, type Grouping,
} from '../../lib/drilldown';

interface Slice {
    key: string;
    label: string;
    totals: { orders: number; delivered: number; notDelivered: number; stillOpen: number; attempts: number };
    rates: { completionRate: number | null; completionRateAdjusted: number | null; onTimeRate: number | null; dryRunRate: number | null };
}

interface Report {
    from: string; to: string; grouping: string; timezone: string;
    pharmacies: string[];
    notes: string[];
    totals: {
        orders: number; delivered: number; notDelivered: number; cancelled: number;
        stillOpen: number; attempts: number; onTimeMet: number; onTimeMissed: number; notMeasured: number; notDeliveredPharmacyFault: number;
    };
    rates: { completionRate: number | null; completionRateAdjusted: number | null; onTimeRate: number | null; dryRunRate: number | null };
    turnaround: {
        inOurHands: { count: number; medianMinutes: number | null; p90Minutes: number | null };
        endToEnd: { count: number; medianMinutes: number | null; p90Minutes: number | null };
    };
    byPeriod: Slice[]; byServiceType: Slice[]; bySite: Slice[];
    failureReasons: Array<{ code: string; label: string; packages: number; orders: number }>;
    followUp: { reattempts: number; returned: number; awaitingReturn: number };
    target: number;
    definitions: Array<{ measure: string; definition: string; note: string }>;
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(1)}%`);

/** Minutes as something a person reads. 95 is an hour and thirty-five. */
const mins = (v: number | null) => {
    if (v === null) return 'n/a';
    if (v < 60) return `${v} min`;
    const h = Math.floor(v / 60);
    const m = v % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
};

/* A headline figure: a link when there is something behind it, the number
   on its own when there is not. Nought deliveries is not a thing to open. */
function Stat({ n, to }: { n: number; to: string }) {
    return n === 0 ? <>{n}</> : <Link to={to}>{n}</Link>;
}

const GROUPINGS = [
    { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' },
];

/** Thirty days back, as a sensible opening window. */
const isoDay = (offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return d.toISOString().slice(0, 10);
};

export function ClientReports() {
    const { code = 'uh' } = useParams();
    const [from, setFrom] = useState(isoDay(29));
    const [to, setTo] = useState(isoDay(0));
    const [groupBy, setGroupBy] = useState('day');
    const [report, setReport] = useState<Report | null>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        setMsg(null);
        try {
            setReport(await api<Report>(
                `/api/projects/${code}/uh/client/reports?from=${from}&to=${to}&groupBy=${groupBy}`,
            ));
        } catch (err) {
            setMsg(err instanceof Error ? err.message : 'The report could not be loaded.');
        } finally {
            setBusy(false);
        }
    }, [code, from, to, groupBy]);

    useEffect(() => { void load(); }, [load]);

    const deliveries = `/projects/${code}/client`;

    /* The window every link is narrowed to. Null until the report lands. */
    const ran: { from: string; to: string } | null = report
        ? { from: report.from, to: report.to }
        : null;

    /**
     * What one slice row drills into, or null when it cannot drill.
     *
     * Null is a real answer and is rendered as plain text: a bucket whose key
     * this version does not recognise, or one that does not overlap the
     * window, must produce no link rather than a link to the wrong fortnight.
     */
    const drillFor = (dimension: 'period' | 'site' | 'serviceType', s: Slice, status?: string): string | null => {
        if (!ran) return null;
        if (dimension === 'period') {
            const bucket = rangeOfBucket(s.key, (report?.grouping ?? 'day') as Grouping);
            if (!bucket) return null;
            const window = clampToWindow(bucket, ran);
            return window ? drillQuery({ window, ...(status === undefined ? {} : { status }) }) : null;
        }
        if (dimension === 'site') {
            const siteId = siteIdOfSliceKey(s.key);
            if (siteId === null) return null;
            return drillQuery({ window: ran, siteId, ...(status === undefined ? {} : { status }) });
        }
        return drillQuery({ window: ran, serviceType: s.key, ...(status === undefined ? {} : { status }) });
    };

    /* A count, as a link when there is something to look at and as plain text
       when there is not. A link to nought rows is a promise the next screen
       cannot keep, and a zero is not a thing anybody wants to drill into. */
    const count = (n: number, query: string | null, what: string, label: string) => {
        if (n === 0 || query === null) return <td>{n}</td>;
        return (
            <td>
                <Link to={`${deliveries}?${query}`} aria-label={`${n} ${what} for ${label}`}>{n}</Link>
            </td>
        );
    };

    /* Folded panels say what is inside, so a pharmacist can skip one without
       opening it. The id is the storage key and must stay stable. */
    const table = (title: string, first: string, slices: Slice[], dimension: 'period' | 'site' | 'serviceType') => (
        <Section
            key={title}
            id={`client-report-${first.toLowerCase().replace(/\W+/g, '-')}`}
            title={title}
            summary={slices.length === 0 ? 'nothing in this range' : `${slices.length} ${slices.length === 1 ? 'row' : 'rows'}`}
        >
            {slices.length === 0 ? <p className="izy-muted">Nothing in this range.</p> : (
                <>
                    <table className="izy-table">
                        <thead>
                            <tr>
                                <th>{first}</th><th>Deliveries</th><th>Completed</th>
                                <th>Not delivered</th><th>Still open</th><th>Completion</th><th>On time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {slices.map((s) => {
                                const all = drillFor(dimension, s);
                                return (
                                    <tr key={s.key}>
                                        <td>
                                            {all === null
                                                ? s.label
                                                : <Link to={`${deliveries}?${all}`}>{s.label}</Link>}
                                        </td>
                                        {count(s.totals.orders, all, 'deliveries', s.label)}
                                        {count(s.totals.delivered, drillFor(dimension, s, 'delivered'), 'completed', s.label)}
                                        {count(s.totals.notDelivered, drillFor(dimension, s, 'failed'), 'not delivered', s.label)}
                                        {count(s.totals.stillOpen, drillFor(dimension, s, 'open'), 'still out', s.label)}
                                        <td>{pct(s.rates.completionRate)}</td>
                                        <td>{pct(s.rates.onTimeRate)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <p className="izy-muted">
                        Any figure in this table opens the deliveries behind it, for the same dates
                        this report covers.
                    </p>
                </>
            )}
        </Section>
    );

    return (
        <>
            <h1>Performance</h1>
            <p className="izy-sub">
                {(report?.pharmacies ?? []).join(', ') || 'No pharmacies assigned'}
                {report ? ` · times in ${report.timezone}` : ''}
            </p>

            {msg && <div className="izy-alert error" role="alert">{msg}</div>}
            {(report?.notes ?? []).map((n) => (
                <div key={n} className="izy-alert warn" role="status">{n}</div>
            ))}

            {/* "Report frequency, customization options": the window and how it
                is broken up, chosen by the reader rather than by us. */}
            <div className="izy-card">
                <div className="izy-filters">
                    <label className="izy-field">From
                        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                    </label>
                    <label className="izy-field">To
                        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                    </label>
                    <label className="izy-field">Grouped by
                        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                            {GROUPINGS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                        </select>
                    </label>
                    <button className="izy-btn secondary" type="button" onClick={() => { void load(); }} disabled={busy}>
                        {busy ? 'Loading' : 'Refresh'}
                    </button>
                </div>
            </div>

            {report && (
                <>
                    <div className="izy-card">
                        <h2>{report.from === report.to ? report.from : `${report.from} to ${report.to}`}</h2>
                        {/* The whole-range figures, and the three of them that
                            map onto a status the list can filter by are links.
                            On time and delayed are not: the list has no
                            lateness filter, and inventing a link that quietly
                            showed all the completed ones instead would be
                            worse than no link. */}
                        <div className="izy-stats">
                            <div><b><Stat n={report.totals.orders} to={`${deliveries}?${drillQuery({ window: { from: report.from, to: report.to } })}`} /></b><span>deliveries</span></div>
                            <div><b><Stat n={report.totals.delivered} to={`${deliveries}?${drillQuery({ window: { from: report.from, to: report.to }, status: 'delivered' })}`} /></b><span>completed</span></div>
                            <div><b>{report.totals.onTimeMet}</b><span>on time</span></div>
                            <div className={report.totals.onTimeMissed > 0 ? 'izy-stat-bad' : undefined}>
                                <b>{report.totals.onTimeMissed}</b><span>delayed</span>
                            </div>
                            <div className={report.totals.notDelivered > 0 ? 'izy-stat-bad' : undefined}>
                                <b><Stat n={report.totals.notDelivered} to={`${deliveries}?${drillQuery({ window: { from: report.from, to: report.to }, status: 'failed' })}`} /></b>
                                <span>failed</span>
                            </div>
                            <div>
                                <b><Stat n={report.totals.stillOpen} to={`${deliveries}?${drillQuery({ window: { from: report.from, to: report.to }, status: 'open' })}`} /></b>
                                <span>still out</span>
                            </div>
                            <div><b><Stat n={report.totals.cancelled} to={`${deliveries}?${drillQuery({ window: { from: report.from, to: report.to }, status: 'cancelled' })}`} /></b><span>cancelled</span></div>
                        </div>
                        <table className="izy-table">
                            <tbody>
                                <tr>
                                    <td>Completion rate</td>
                                    <td><b>{pct(report.rates.completionRate)}</b></td>
                                    <td className="izy-muted">everything attempted</td>
                                </tr>
                                {/* SHOWN BESIDE IT, NOT INSTEAD OF IT. One of
                                    these is the truth about the day and the
                                    other is the truth about the courier, and
                                    replacing the first with the second would
                                    be marking our own homework. */}
                                <tr>
                                    <td>Completion, excluding pharmacy errors</td>
                                    <td><b>{pct(report.rates.completionRateAdjusted)}</b></td>
                                    <td className="izy-muted">
                                        expected {report.target}%
                                        {report.totals.notDeliveredPharmacyFault > 0 && (
                                            <> &middot; {report.totals.notDeliveredPharmacyFault} excluded</>
                                        )}
                                    </td>
                                </tr>
                                <tr>
                                    <td>On-time rate</td>
                                    <td><b>{pct(report.rates.onTimeRate)}</b></td>
                                    <td />
                                </tr>
                            </tbody>
                        </table>
                        {report.rates.completionRateAdjusted !== null
                            && report.rates.completionRateAdjusted < report.target && (
                            <div className="izy-alert warn" role="status">
                                Below the {report.target} per cent expected for this range, after
                                setting aside deliveries that could not be made because of the
                                information supplied.
                            </div>
                        )}
                    </div>

                    <Section
                        id="client-report-turnaround"
                        title="How long deliveries took"
                        summary={`median ${mins(report.turnaround.inOurHands.medianMinutes)} in our hands`}
                    >
                        <table className="izy-table">
                            <thead>
                                <tr><th>Span</th><th>Median</th><th>90th percentile</th><th>Measured over</th></tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>Collection to handover</td>
                                    <td>{mins(report.turnaround.inOurHands.medianMinutes)}</td>
                                    <td>{mins(report.turnaround.inOurHands.p90Minutes)}</td>
                                    <td>{report.turnaround.inOurHands.count}</td>
                                </tr>
                                <tr>
                                    <td>Request to handover</td>
                                    <td>{mins(report.turnaround.endToEnd.medianMinutes)}</td>
                                    <td>{mins(report.turnaround.endToEnd.p90Minutes)}</td>
                                    <td>{report.turnaround.endToEnd.count}</td>
                                </tr>
                            </tbody>
                        </table>
                        <p className="izy-muted">
                            Delivered orders only. A failed attempt has no handover to measure to,
                            and counting one as nil would flatter the figure.
                        </p>
                    </Section>

                    <Section
                        id="client-report-failures"
                        title="Why deliveries failed"
                        summary={report.failureReasons.length === 0
                            ? 'none in this range'
                            : `${report.failureReasons.length} ${report.failureReasons.length === 1 ? 'reason' : 'reasons'}`}
                    >
                        {report.failureReasons.length === 0
                            ? <p className="izy-muted">No failed deliveries in this range.</p>
                            : (
                                <>
                                    <table className="izy-table">
                                        <thead><tr><th>Reason</th><th>Packages</th><th>Deliveries affected</th></tr></thead>
                                        <tbody>
                                            {report.failureReasons.map((r) => (
                                                <tr key={r.code}>
                                                    <td>{r.label}</td><td>{r.packages}</td><td>{r.orders}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    <p className="izy-muted">
                                        Counted per package: three items at one door can fail for three reasons,
                                        and a courier records each.
                                    </p>
                                    {/* ONE LINK UNDER THE TABLE RATHER THAN
                                        ONE PER ROW. The list cannot filter by
                                        failure reason, so a link on each row
                                        would go to the same place and imply it
                                        went somewhere different. This one says
                                        where it goes. */}
                                    <p>
                                        <Link
                                            className="izy-btn secondary"
                                            to={`${deliveries}?${drillQuery({ window: { from: report.from, to: report.to }, status: 'failed' })}`}
                                        >
                                            Open all {report.totals.notDelivered} failed deliveries
                                        </Link>
                                    </p>
                                </>
                            )}
                    </Section>

                    <Section
                        id="client-report-reattempts"
                        title="Reattempted, cancelled and returned"
                    >
                        <div className="izy-stats">
                            <div><b>{report.followUp.reattempts}</b><span>reattempted</span></div>
                            <div><b>{report.totals.cancelled}</b><span>cancelled</span></div>
                            <div><b>{report.followUp.returned}</b><span>returned to the pharmacy</span></div>
                            <div className={report.followUp.awaitingReturn > 0 ? 'izy-stat-bad' : undefined}>
                                <b>{report.followUp.awaitingReturn}</b><span>not yet returned</span>
                            </div>
                        </div>
                        <p className="izy-muted">
                            Not yet returned is medication that failed and is still in a van.
                        </p>
                    </Section>

                    {table('By pharmacy', 'Pharmacy', report.bySite, 'site')}
                    {table('By service level', 'Service level', report.byServiceType, 'serviceType')}
                    {table(
                        report.grouping === 'day' ? 'By day' : `By ${report.grouping}`,
                        report.grouping === 'day' ? 'Service date' : 'Period',
                        report.byPeriod,
                        'period',
                    )}

                    <Section
                        id="client-report-glossary"
                        title="What these numbers mean"
                        summary="how each figure is counted"
                       
                    >
                        <table className="izy-table">
                            <thead><tr><th>Measure</th><th>Definition</th><th>Note</th></tr></thead>
                            <tbody>
                                {report.definitions.map((d) => (
                                    <tr key={d.measure}>
                                        <td>{d.measure}</td>
                                        <td>{d.definition}</td>
                                        <td className="izy-muted">{d.note}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </Section>
                </>
            )}
        </>
    );
}
