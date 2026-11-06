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
import { handleUnder } from '../../lib/people';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { daysBeforeIn, todayIn } from '../../lib/when';
import type { Site } from './Sites';

interface PayLine {
    label: string; delivered: number; rateCents: number; payCents: number | null;
    /** Attempted and not completed. Paid at the same rate since 5 November.
     *  Optional only so a fixture or an older server does not fail to type. */
    failed?: number;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NO PAY IS SHOWN, IN THE TERMS THE PROJECT ACTUALLY PAYS IN.
 *
 * This banner used to read "the per-delivery rate is not set for every
 * SERVICE LEVEL" whatever the project paid on, so a contract paying by zone
 * was sent to study the wrong half of the rate card. driver-pay.ts is
 * explicit that a reader must never be shown service levels when the basis
 * is zones, and this was the screen doing it.
 *
 * IT ALSO COVERED TWO DIFFERENT PROBLEMS WITH ONE SENTENCE:
 *
 *   a rate that is still zero, which somebody fixes on the settings screen;
 *
 *   a stop whose destination ZIP is not on the zone map, for which NO RATE
 *   EXISTS AND NONE CAN BE SET -- perZoneCents holds zones 1 to 5 and there
 *   is no out-of-zone figure. The gap is in the zone list, not the card.
 *
 * The second one is the cruel case: one unzoned stop withholds the pay for
 * the WHOLE range, and somebody told "a rate is not set" will search the
 * settings screen for a field that does not exist. driver-pay.ts keys that
 * line 'unzoned' precisely so it can be told apart, and nothing read it.
 *
 * DERIVED FROM `lines`, NOT FROM A SECOND FLAG. The server already says
 * which lines have no rate; a parallel boolean is how the two come to
 * disagree. It also means a site manager, whose money fields the server
 * strips, now gets no banner at all -- `!rateSet` on a deleted field was
 * `!undefined`, so they were being told pay was unset when it was merely
 * hidden from them.
 */
export function RateNote({ basis, lines }: {
    basis: 'serviceType' | 'zone';
    lines?: Record<string, PayLine> | undefined;
}) {
    const unpaid = Object.entries(lines ?? {}).filter(([, l]) => l.rateCents <= 0);
    if (unpaid.length === 0) return null;

    const noZone = unpaid.find(([key]) => key === 'unzoned')?.[1];
    const unset = unpaid.filter(([key]) => key !== 'unzoned').map(([, l]) => l.label);
    const stops = noZone ? noZone.delivered + (noZone.failed ?? 0) : 0;
    const one = stops === 1;

    return (
        <div className="izy-alert warn" role="status">
            {unset.length > 0 && (
                <p>
                    No pay is shown because the per-delivery rate is not set for every{' '}
                    {basis === 'zone' ? 'zone' : 'service level'} worked in this range:{' '}
                    <strong>{unset.join(', ')}</strong>. The delivery counts are complete and
                    correct; the money is waiting on the rate card in this project&apos;s settings.
                </p>
            )}
            {noZone && (
                <p>
                    {unset.length === 0 && 'Every rate on the rate card is set. '}
                    {one ? 'One delivery' : `${stops} deliveries`} went to a ZIP that is not on the
                    zone map, and <strong>there is no rate for that, nor one that can be set</strong>
                    {' '}&mdash; the card holds zones 1 to 5 and nothing else. A single such stop
                    withholds the pay for the whole range, so the fix is to add the ZIP to the zone
                    list rather than to hunt for a missing rate.
                </p>
            )}
        </div>
    );
}

/* IS THERE MONEY IN THIS ANSWER AT ALL?
 *
 * From ticket 7.20 the site manager reads this page with the pay fields
 * removed by the server. The screen asks the DATA rather than the role: a
 * component that re-decides who may see money is a second copy of the rule,
 * and the copy that drifts is the one that shows it to somebody. If the
 * field is absent, there is no column. */
const hasMoney = (d: { currency?: string | undefined }) => d.currency !== undefined;

interface Totals {
    delivered: number;
    failed: number;
    payCents: number | null;
    /** Days on which every assigned stop was finished, and what they came
     *  to. Reported apart from payCents so a reader can always see which
     *  part of a total is deliveries and which is the completion bonus --
     *  the person checking a disbursement needs the split, not the sum. */
    bonusDays?: number;
    bonusCents?: number;
    rateSet: boolean;
    /** What the lines are keyed on, so the column can be headed honestly. */
    basis: 'serviceType' | 'zone';
    lines: Record<string, PayLine>;
}

interface DriverRow extends Totals {
    username: string;
    name: string;
    daysWorked: number;
}

interface Everyone {
    from: string; to: string; timezone: string;
    /* Absent for the site manager: the server strips it with the pay
       fields, and its absence is what `hasMoney` reads. */
    currency?: string;
    rateSet: boolean;
    /** The pharmacy the figures were narrowed to, echoed by the server, or
     *  null for the whole contract. Read from the RESPONSE rather than from
     *  the URL: the banner below must describe the numbers on screen, and
     *  those are the ones the server built.
     *
     *  OPTIONAL, because a server that predates the filter does not send it
     *  at all. See `narrowed` below for why that distinction is not
     *  academic. */
    siteId?: number | null;
    drivers: DriverRow[];
    totals: Totals;
}

/** Cents as money, once, at the edge. Null is not nought and never renders
 *  as one: see the header. */
export function money(cents: number | null, currency: string): string {
    if (cents === null) return 'rate not set';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function Drivers() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const [params, setParams] = useSearchParams();

    /* Both ends resolved in the PROJECT's zone, not the device's and not
       UTC. The pay figures below are read from this window, and a window
       that moves with the time of day is a figure that moves with it.
       See lib/when.ts. */
    const timezone = useProjectTimezone(code);
    const from = params.get('from') ?? daysBeforeIn(timezone, 30);
    const to = params.get('to') ?? todayIn(timezone);
    const siteId = params.get('siteId') ?? '';

    const [data, setData] = useState<Everyone | null>(null);
    const [sites, setSites] = useState<Site[]>([]);
    const [msg, setMsg] = useState<string | null>(null);

    /* One string for the request and the workbook link, so the file is what
       is on screen -- including which pharmacy. */
    const query = `from=${from}&to=${to}${siteId === '' ? '' : `&siteId=${siteId}`}`;

    const load = useCallback(async () => {
        setMsg(null);
        try {
            setData(await api<Everyone>(`/api/projects/${code}/uh/drivers?${query}`));
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not load the drivers.');
        }
    }, [code, query]);
    useEffect(() => { void load(); }, [load]);

    useEffect(() => {
        /* Silent on failure: without the list the filter offers nothing and
           the payment run still loads, which is what matters on this page. */
        void api<Site[]>(`/api/projects/${code}/uh/sites`).then(setSites).catch(() => setSites([]));
    }, [code]);

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        if (value === '') next.delete(key); else next.set(key, value);
        setParams(next, { replace: true });
    };

    const paged = usePaged(data?.drivers ?? []);

    /* ADMIN AND LEAD, which is what the server allows.
     *
     * This read `role !== 'admin'`, so a site manager following the Drivers
     * record link from their own project page landed on "Not available".
     * The link was offered to them and went nowhere.
     *
     * modules/uh/driver-records.ts admits both and strips the money on the
     * way out for anybody who may not see it -- deliberately, from ticket
     * 7.20: a site manager liaises with drivers daily and needs to know who
     * is carrying what, while what each driver is paid is commercial and is
     * not theirs. The screen asks the DATA whether there is money in it
     * (see hasMoney above) rather than re-deciding the rule, so opening
     * this to leads shows them exactly what the server sent and no more. */
    if (!project || (project.role !== 'admin' && project.role !== 'lead')) {
        return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    }
    if (data === null) {
        return msg
            ? (<><h1>Drivers</h1><div className="izy-alert error" role="alert">{msg}</div></>)
            : <div className="izy-card"><Loading label="Loading the drivers" /></div>;
    }

    /* ARE THESE NUMBERS A SLICE? Asked once, here, and never re-derived.
     *
     * It was `data.siteId !== null`, which is true for `undefined` -- and
     * `undefined` is exactly what a server that predates this filter sends
     * back. The page then captioned a full, correct payment run as "one
     * pharmacy only" and renamed the disbursement total, which is the same
     * class of wrong number this screen exists to avoid, pointed the other
     * way. Found by opening the page against an older server, not by a test:
     * every fixture set the field, so every fixture agreed with itself.
     *
     * A POSITIVE WHOLE NUMBER OR NOTHING. Absent, null, 0 and a string all
     * mean the whole contract, which is the answer that is safe to be wrong
     * about: it shows the real payment run without a caption, rather than
     * hiding a caption that was needed. */
    const narrowed = typeof data.siteId === 'number' && Number.isInteger(data.siteId) && data.siteId > 0;
    const narrowedTo = narrowed
        ? sites.find((st) => st.id === data.siteId)?.name ?? `pharmacy ${data.siteId}`
        : null;

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
            <RateNote basis={data.totals.basis} lines={data.totals.lines} />

            <div className="izy-card">
                <div className="izy-row">
                    <label className="izy-field">From
                        <input type="date" value={from} onChange={(e) => set('from', e.target.value)} />
                    </label>
                    <label className="izy-field">To
                        <input type="date" value={to} onChange={(e) => set('to', e.target.value)} />
                    </label>
                    {/* WHICH PHARMACY THEY DELIVERED FOR.

                        Added because every other screen on the portal now
                        answers "that counter, that day" and this one could
                        only answer "everybody, that month" -- the wrong
                        shape for the question a site manager brings to it.

                        EMPTY IS THE DEFAULT AND MUST STAY SO. Read the
                        banner below for what choosing one does to the pay
                        column. */}
                    <label className="izy-field">Pharmacy
                        <select value={siteId} onChange={(e) => set('siteId', e.target.value)}>
                            <option value="">Every pharmacy</option>
                            {sites.map((st) => <option key={st.id} value={String(st.id)}>{st.name}</option>)}
                        </select>
                    </label>
                    <button className="izy-btn secondary" type="button" onClick={() => { void load(); }}>
                        Refresh
                    </button>
                    {/* A plain link carrying the same range the table was
                        built from, so the file is what is on screen. Not a
                        fetch and a blob: the browser knows how to save a
                        download, and a blob URL would keep a copy of the
                        payment run alive in the tab until it was closed. */}
                    <a className="izy-btn secondary" href={`/api/projects/${code}/uh/drivers/export.xlsx?${query}`}>
                        Export to Excel
                    </a>
                </div>
            </div>

            {/* A SLICE IS NOT A PAYMENT RUN.

                This file opens by saying the one thing this screen must
                never do is show a confident wrong number, and a pharmacy
                filter is the easiest way to make it do exactly that: pay is
                per delivery, so one counter's figure is real, correct, and
                not what anybody is owed. Somebody will screenshot it.

                SAID ONCE AND LOUDLY, above the totals rather than as a
                footnote under the table, and driven by what the SERVER
                echoed back rather than by the URL, so it cannot appear over
                unfiltered numbers or fail to appear over filtered ones. */}
            {narrowed && (
                <div className="izy-alert warn" role="status">
                    <b>{narrowedTo} only.</b>{' '}
                    These counts{hasMoney(data) ? ' and pay figures' : ''} cover that pharmacy&apos;s
                    deliveries. What a driver is owed is their work across every pharmacy, so choose
                    every pharmacy before disbursing from this screen.
                </div>
            )}

            <div className="izy-card">
                <h2>
                    {from} to {to}
                    {narrowed && <> &middot; {narrowedTo}</>}
                </h2>
                <div className="izy-stats">
                    <div><b>{data.drivers.length}</b><span>drivers</span></div>
                    <div><b>{data.totals.delivered}</b><span>delivered</span></div>
                    <div className={data.totals.failed > 0 ? 'izy-stat-bad' : undefined}>
                        <b>{data.totals.failed}</b><span>not delivered</span>
                    </div>
                    {/* Shown only once it is switched on, so a contract that
                        does not pay a bonus is not given a column of noughts
                        to explain. */}
                    {hasMoney(data) && (data.totals.bonusDays ?? 0) > 0 && (
                        <div>
                            <b>{money(data.totals.bonusCents ?? 0, data.currency!)}</b>
                            <span>completion bonus · {data.totals.bonusDays} {data.totals.bonusDays === 1 ? 'day' : 'days'}</span>
                        </div>
                    )}
                    {hasMoney(data) && (
                        /* The LABEL changes with the filter, not just the
                           figure. "To disburse" under one pharmacy is a
                           sentence that is false, and the tile is the part
                           that gets read when the banner above it does
                           not. */
                        <div>
                            <b>{money(data.totals.payCents, data.currency!)}</b>
                            <span>{narrowed ? 'for this pharmacy' : 'to disburse'}</span>
                        </div>
                    )}
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
                                    {hasMoney(data) && <th className="izy-num">Pay</th>}
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
                                            {/* Only when it says something the name does
                                                not. A driver's username is their email
                                                address, and printing it here put a personal
                                                address under every row of a screen a room
                                                can see. See lib/people.ts. */}
                                            {handleUnder(d) !== null && (
                                                <div className="izy-muted">{handleUnder(d)}</div>
                                            )}
                                        </td>
                                        <td className="izy-num">{d.daysWorked}</td>
                                        <td className="izy-num">{d.delivered}</td>
                                        <td className={`izy-num${d.failed > 0 ? ' izy-stat-bad' : ''}`}>{d.failed}</td>
                                        {hasMoney(data) && (
                                            <td className="izy-num">{money(d.payCents, data.currency!)}</td>
                                        )}
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
