/* The staff order screen.
 *
 * A dispatcher's questions are "what is late", "what has this pharmacy sent
 * today", "where is the order this caller is asking about". So the filters
 * are the first thing on the page and the time remaining is the first thing
 * on a row: a list sorted by id would be a list nobody can act on.
 *
 * The summary counts come from the server over the same filtered set, so the
 * header cannot disagree with the table under it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { Pager, usePaged } from '../../app/Pager';
import { useAuth, useProjectTimezone } from '../../app/auth';
import type { Site } from './Sites';
import { displayName } from '../../lib/people';

export interface Sla {
    state: 'open' | 'due_soon' | 'overdue' | 'met' | 'missed' | 'not_applicable';
    minutesToDue: number | null;
    onTime: boolean | null;
    measuredAt: string | null;
    measuredFrom: 'arrived' | 'delivered' | null;
}

export interface OrderRow {
    id: number;
    siteId: number;
    externalRef: string;
    serviceType: string;
    serviceDate: string;
    recipientName: string;
    address: string;
    city: string;
    zip: string;
    /** UNIVERSITY HEALTH'S BAND for the destination ZIP, which is what they
     *  are invoiced on. Not what the courier is paid on: see payZone. */
    zone: number | null;
    /** THE COURIER'S BAND -- the offer letter's distance from the pickup
     *  pharmacy, in miles, banded 0-10 / 11-25 / 26-50 / 51+.
     *
     *  Optional because a server older than this build does not send it, and
     *  null when the pharmacy-and-ZIP pair has no measured distance. Neither
     *  may be rendered as zone 1: paying the bottom band for an unmeasured
     *  stop is the fault this field exists to end. */
    payZone?: number | null;
    payMiles?: number | null;
    /** 'road' or 'straight-line'. A straight line understates a drive, so a
     *  screen quoting the miles should say which kind they are. */
    payBasis?: string | null;
    status: string;
    dueAt: string | null;
    assignedTo: string | null;
    /** The courier's name. Optional: a server older than this build does
     *  not send it, and the row falls back to the username. */
    assignedToName?: string | null;
    sla: Sla;
}

/** One page of the list, and how much of the whole it is. */
interface OrderPage {
    orders: OrderRow[];
    total: number;
    returned: number;
    nextCursor: string | null;
}

interface Summary {
    total: number;
    byStatus: Record<string, number>;
    overdue: number;
    onTime: { met: number; missed: number; measured: number; rate: number | null };
}

const STATUSES = ['pending', 'ready', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'];
const STATUS_LABEL: Record<string, string> = {
    pending: 'Pending', ready: 'Ready', assigned: 'Assigned', picked_up: 'Picked up',
    delivered: 'Delivered', failed: 'Failed', cancelled: 'Cancelled',
};

/** Time left, or how late it is. The thing a dispatcher reads first. */
export function slaLabel(sla: Sla): { text: string; tone: 'ok' | 'warn' | 'off' | 'muted' } {
    switch (sla.state) {
        case 'overdue': return { text: `${Math.abs(sla.minutesToDue ?? 0)} min late`, tone: 'off' };
        case 'due_soon': return { text: `${sla.minutesToDue} min left`, tone: 'warn' };
        case 'open': return { text: `${sla.minutesToDue} min left`, tone: 'muted' };
        case 'met': return { text: 'on time', tone: 'ok' };
        case 'missed': return { text: `late by ${Math.abs(sla.minutesToDue ?? 0)} min`, tone: 'off' };
        default: return { text: '', tone: 'muted' };
    }
}

export function Orders() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    /* The header already names the project's zone; these times are in it. */
    const clock = clockFor(useProjectTimezone(code));
    const [params, setParams] = useSearchParams();

    const [orders, setOrders] = useState<OrderRow[] | null>(null);
    const [summary, setSummary] = useState<Summary | null>(null);
    const [sites, setSites] = useState<Site[]>([]);
    const [error, setError] = useState<string | null>(null);
    /* How many exist against how many are loaded, and where to continue from.
       University Health run up to 1,500 deliveries a day; this screen used to
       request 200, page through them client-side, and give a dispatcher no
       way to tell that was not the day. */
    const [total, setTotal] = useState(0);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);

    /* ── THE ONE FILTER THAT IS NOT IN THE URL ────────────────────────────
     *
     * Every other filter lives in the query string, which is what makes a
     * dispatcher's view shareable and survivable across a refresh. A
     * patient's name may not: an address bar reaches browser history, the
     * referrer header sent to anything this page loads, proxies and access
     * logs, and the warning printed above these boxes has said so since the
     * screen was built.
     *
     * So this one is component state and goes to the server in a POST body.
     * It is lost on a refresh, which is a cost and is the right way round --
     * a name that survives a reload is a name written down somewhere. */
    const [recipientName, setRecipientName] = useState('');
    const [searchingFor, setSearchingFor] = useState('');

    const query = params.toString();
    const base = `/api/projects/${code}/uh/orders`;

    const load = useCallback(async () => {
        setError(null);
        try {
            if (searchingFor !== '') {
                /* One request, carrying its own counts: the summary route is
                   a GET and cannot be told the name, and a header reading
                   "2962 orders" over a table of three is worse than no
                   header at all. */
                const page = await api<OrderPage & { summary: Summary }>(`${base}/search`, {
                    method: 'POST',
                    json: Object.fromEntries([...params, ['recipientName', searchingFor]]),
                });
                setOrders(page.orders);
                setTotal(page.total);
                setCursor(page.nextCursor);
                setSummary(page.summary);
                return;
            }
            const [page, sum] = await Promise.all([
                api<OrderPage>(`${base}${query ? `?${query}` : ''}`),
                api<Summary>(`${base}/summary${query ? `?${query}` : ''}`),
            ]);
            setOrders(page.orders);
            setTotal(page.total);
            setCursor(page.nextCursor);
            setSummary(sum);
        } catch {
            setError('Could not load orders.');
            setOrders([]);
            setTotal(0);
            setCursor(null);
        }
    }, [base, query, params, searchingFor]);

    /* Appends rather than replaces, so the rows already on screen keep their
       place while a dispatcher is reading them. */
    const loadMore = useCallback(async () => {
        if (!cursor || loadingMore) return;
        setLoadingMore(true);
        try {
            /* THE SECOND PAGE OF A NAME SEARCH IS STILL A NAME SEARCH. A
               GET here would quietly page through the unfiltered day and
               append it under the three rows somebody was reading. */
            const page = searchingFor !== ''
                ? await api<OrderPage>(`${base}/search`, {
                    method: 'POST',
                    json: Object.fromEntries([...params, ['recipientName', searchingFor], ['cursor', cursor]]),
                })
                : await api<OrderPage>(`${base}?${query ? `${query}&` : ''}cursor=${encodeURIComponent(cursor)}`);
            setOrders((prev) => [...(prev ?? []), ...page.orders]);
            setTotal(page.total);
            setCursor(page.nextCursor);
        } catch {
            setError('Could not load the rest of the orders.');
        } finally {
            setLoadingMore(false);
        }
    }, [base, query, params, searchingFor, cursor, loadingMore]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        api<Site[]>(`/api/projects/${code}/uh/sites`).then(setSites).catch(() => setSites([]));
    }, [code]);

    /* Above the early returns: it holds state, so it has to run every render
       whether or not this member can see the project. */
    const paged = usePaged(orders ?? []);

    if (!project) {
        return (
            <>
                <h1>Project not available</h1>
                <Link className="izy-btn secondary" to="/">Back to projects</Link>
            </>
        );
    }

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params);
        if (value === '') next.delete(key); else next.set(key, value);
        setParams(next, { replace: true });
    };
    const get = (key: string) => params.get(key) ?? '';

    return (
        <>
            <h1>Orders</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}`}>{project.name}</Link> · {project.timezone}
            </p>

            <div className="izy-card">
                {/* ONE BOX ABOVE THE DROPDOWNS, not instead of them. Somebody
                    with a reference or a pharmacy in front of them types it
                    here and does not have to work out which filter it belongs
                    to; somebody narrowing a day still wants the dropdowns.
                    What it may look at is an allow list on the server
                    (modules/uh/search.ts) and a patient name is not on it. */}
                <div className="izy-row">
                    <label className="izy-field" style={{ minWidth: 320 }}>Search
                        <input
                            value={get('q')}
                            onChange={(e) => set('q', e.target.value)}
                            placeholder="reference, pharmacy, status, courier, zone"
                        />
                    </label>
                </div>
                <p className="izy-muted">
                    Patient names and addresses are deliberately not searchable: a name typed into a
                    search box ends up in the URL, and URLs reach browser history, proxies and logs.
                </p>
                <div className="izy-row">
                    <label className="izy-field">Service date
                        <input type="date" value={get('serviceDate')} onChange={(e) => set('serviceDate', e.target.value)} />
                    </label>
                    <label className="izy-field">Pharmacy
                        <select value={get('siteId')} onChange={(e) => set('siteId', e.target.value)}>
                            <option value="">any</option>
                            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </label>
                    <label className="izy-field">Status
                        <select value={get('status')} onChange={(e) => set('status', e.target.value)}>
                            <option value="">any</option>
                            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                    </label>
                    <label className="izy-field">Service
                        <select value={get('serviceType')} onChange={(e) => set('serviceType', e.target.value)}>
                            <option value="">any</option>
                            <option value="scheduled">scheduled</option>
                            <option value="stat">STAT</option>
                            <option value="adhoc">ad hoc</option>
                        </select>
                    </label>
                    {/* The placeholder says what it now accepts. It matched a
                        username exactly and case sensitively while the table
                        beside it printed names, so the one word a dispatcher
                        could read off a row was the one word that returned
                        nothing. See couriersMatching in modules/uh/orders.ts. */}
                    <label className="izy-field">Courier
                        <input value={get('assignedTo')} onChange={(e) => set('assignedTo', e.target.value)} placeholder="name or username, or unassigned" />
                    </label>
                    <label className="izy-field">Reference
                        <input value={get('ref')} onChange={(e) => set('ref', e.target.value)} placeholder="Rx number" />
                    </label>
                    <label className="izy-field" style={{ minWidth: 150 }}>Late only
                        <span><input type="checkbox" checked={get('overdue') === 'true'} onChange={(e) => set('overdue', e.target.checked ? 'true' : '')} /> past due</span>
                    </label>
                    <button
                        className="izy-btn secondary"
                        type="button"
                        onClick={() => {
                            setParams(new URLSearchParams(), { replace: true });
                            setRecipientName('');
                            setSearchingFor('');
                        }}
                    >Clear</button>
                    {/* Carries the same query the list was built from, so the
                        file is what is on screen. A plain link rather than a
                        fetch and a blob: a blob URL would keep a copy of a
                        spreadsheet full of patient names alive in the tab
                        until it was closed. */}
                    {/* OFF WHILE A NAME SEARCH IS RUNNING. The export is a
                        plain link carrying the query string, which is the
                        whole reason it can claim to be "what is on screen" --
                        and a name is deliberately not in that query string.
                        Left enabled it would hand somebody a spreadsheet of
                        the whole day labelled as their search. */}
                    {searchingFor === '' ? (
                        <a className="izy-btn secondary" href={`/api/projects/${code}/uh/orders/export.xlsx${query ? `?${query}` : ''}`}>
                            Export to Excel
                        </a>
                    ) : (
                        <span className="izy-muted">Export is off while searching by name</span>
                    )}
                    <button className="izy-btn secondary" type="button" onClick={() => { void load(); }}>Refresh</button>
                </div>
                {/* ── BY PATIENT NAME, AND NOT IN THE ADDRESS BAR ───────────
                    Its own row with its own button, because it does not
                    behave like the filters above it: those update the URL as
                    you type and survive a reload, and this one deliberately
                    does neither. Typing into it changes nothing until it is
                    submitted, and a refresh forgets it. */}
                <form
                    className="izy-row"
                    style={{ marginTop: 8 }}
                    onSubmit={(e) => { e.preventDefault(); setSearchingFor(recipientName.trim()); }}
                >
                    <label className="izy-field" style={{ minWidth: 260 }}>Recipient name
                        <input
                            value={recipientName}
                            onChange={(e) => setRecipientName(e.target.value)}
                            placeholder="a name a caller read out"
                        />
                    </label>
                    <button className="izy-btn secondary" type="submit">Find</button>
                    {/* ── WHAT IS ACTUALLY BEING SEARCHED FOR ──────────────
                        The box and the live search are two different things:
                        typing changes the box, pressing Find changes the
                        search. Emptying the box therefore does NOT stop the
                        search, and the first time that happened it looked
                        like the Courier filter was broken -- a courier typed
                        beside a forgotten name returns nothing, and nothing
                        on screen said a name was still in play.

                        So the term is printed. A filter whose value cannot
                        be seen is a filter that gets blamed on the filter
                        next to it. */}
                    {searchingFor !== '' && (
                        <>
                            <span className="izy-pill warn">
                                also matching “{searchingFor}”
                            </span>
                            <button
                                className="izy-btn secondary"
                                type="button"
                                onClick={() => { setRecipientName(''); setSearchingFor(''); }}
                            >Stop searching by name</button>
                        </>
                    )}
                </form>
                {/* Typed but not submitted. Without this the box reads as the
                    live filter while the list behind it answers something
                    else. */}
                {recipientName.trim() !== searchingFor && (
                    <p className="izy-muted" style={{ marginTop: 8 }}>
                        {recipientName.trim() === ''
                            ? 'The box is empty but a name is still being matched. Press Find to search for nothing, or Stop searching by name.'
                            : 'Not applied yet — press Find.'}
                    </p>
                )}
                <p className="izy-muted" style={{ marginTop: 8 }}>
                    A name is sent in the request rather than put in the address bar, so it does not
                    reach browser history, proxies or logs — and it is forgotten when this page
                    reloads. The pharmacy reference a caller reads out is still the surer match.
                </p>
            </div>

            {summary && (
                <div className="izy-card">
                    <div className="izy-statline">
                        <span><b>{summary.total}</b> {summary.total === 1 ? 'order' : 'orders'}</span>
                        <span className={summary.overdue > 0 ? 'izy-stat-bad' : undefined}><b>{summary.overdue}</b> overdue</span>
                        {STATUSES.filter((s) => summary.byStatus[s]).map((s) => (
                            <span key={s}>{STATUS_LABEL[s]}: <b>{summary.byStatus[s]}</b></span>
                        ))}
                        <span>
                            on time:{' '}
                            <b>{summary.onTime.rate === null ? 'no data' : `${summary.onTime.rate}%`}</b>
                            {summary.onTime.measured > 0 && <span className="izy-muted"> ({summary.onTime.met} of {summary.onTime.measured})</span>}
                        </span>
                    </div>
                    <p className="izy-muted" style={{ marginTop: 6 }}>
                        On time is measured at arrival, not at delivery: an on-time arrival counts as the success
                        even when nobody answers the door.
                    </p>
                </div>
            )}

            <div className="izy-card">
                {error && <div className="izy-alert error" role="alert">{error}</div>}
                {orders === null ? <Loading label="Loading orders" /> : orders.length === 0 ? (
                    <div className="izy-muted">No orders match these filters.</div>
                ) : (
                    <table className="izy-table">
                        <thead>
                            <tr>
                                <th>Due</th><th>Order</th><th>Recipient</th><th>Address</th>
                                <th>Zone</th><th>Service</th><th>Status</th><th>Courier</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paged.rows.map((o) => {
                                const label = slaLabel(o.sla);
                                /* The same rule the deliveries list uses: a
                                   row somebody has to do something about is
                                   findable while scrolling past it, not only
                                   once it has been read. Late or failed, and
                                   nothing else: marking half the table marks
                                   nothing. */
                                const needsAttention = o.sla.state === 'overdue' || o.status === 'failed';
                                return (
                                    <tr key={o.id} className={needsAttention ? 'izy-row-bad' : undefined}>
                                        <td>
                                            {clock(o.dueAt)}
                                            {label.text && <><br /><span className={`izy-pill ${label.tone === 'muted' ? 'muted' : label.tone}`}>{label.text}</span></>}
                                        </td>
                                        <td>
                                            <Link to={`/projects/${code}/orders/${o.id}`}>#{o.id}</Link>
                                            {o.externalRef && <><br /><span className="izy-muted">{o.externalRef}</span></>}
                                        </td>
                                        <td>{o.recipientName}</td>
                                        <td>{o.address}<br /><span className="izy-muted">{o.city} {o.zip}</span></td>
                                        <td>{o.zone === null ? <span className="izy-pill warn">out of area</span> : o.zone}</td>
                                        <td>{o.serviceType}</td>
                                        <td>{STATUS_LABEL[o.status] ?? o.status}</td>
                                        {/* By name. The username behind it is an email address. */}
                                        <td>{o.assignedTo
                                            ? displayName({ name: o.assignedToName ?? '', username: o.assignedTo })
                                            : <span className="izy-muted">unassigned</span>}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
                {/* THIS USED TO SAY NOTHING UNTIL 500 ROWS, and the request
                    only ever asked for 200, so it never said anything at all.
                    The count now comes from the server's own total over the
                    same filters, so a short list announces itself. */}
                <Pager
                    of={paged}
                    noun="orders"
                    note={total > (orders?.length ?? 0)
                        ? `${orders?.length ?? 0} of ${total} loaded`
                        : undefined}
                />
                {total > (orders?.length ?? 0) && (
                    <p style={{ marginTop: 8 }}>
                        <button type="button" className="izy-btn secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                            {loadingMore ? 'Loading...' : `Load the next ${Math.min(200, total - (orders?.length ?? 0))}`}
                        </button>
                        <span className="izy-muted" style={{ marginLeft: 10 }}>
                            {total - (orders?.length ?? 0)} more match these filters. Narrowing them is quicker than loading everything.
                        </span>
                    </p>
                )}
            </div>
        </>
    );
}
