/* Billing University Health.
 *
 * A draft is a working document that moves; an issued invoice is a fact. The
 * screen makes that difference obvious, because the mistake it is guarding
 * against is somebody quoting a draft total down the phone and then sending a
 * different number.
 *
 * Anything that cannot be priced is at the top, in red, before the total. An
 * exclusion a reader has to scroll for is an exclusion that gets discovered by
 * the client instead.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { dateFor } from '../../lib/when';

interface Line {
    orderId: number; serviceDate: string; reference: string; pharmacy: string;
    deliveryZip: string; zone: number | null; serviceType: string;
    dryRun: boolean; items: number; baseCents: number; statCents: number;
    afterHoursCents: number; dryRunCents: number; outOfAreaMiles: number | null;
    outOfAreaCents: number; amountCents: number; note: string;
}
interface Adjustment { id: number; description: string; amount: number; amountCents: number; reason: string; createdBy: string }
interface Exception { orderId: number; serviceDate: string; reference: string; reason: string }

interface Invoice {
    id: number; number: string; status: string;
    periodFrom: string; periodTo: string;
    lines: Line[]; exceptions: Exception[]; adjustments: Adjustment[];
    byZone: Array<{ zone: string; count: number; cents: number }>;
    byServiceType: Array<{ serviceType: string; count: number; cents: number }>;
    dryRuns: { count: number; items: number; cents: number };
    subtotal: number; subtotalCents: number; adjustmentsTotal: number;
    total: number; totalCents: number;
    lineCount: number; excludedCount: number; excludedNote: string; notes: string;
    issuedAt: string | null; paidAt: string | null; voidReason: string;
    recomputes: boolean;
}

interface Summary {
    id: number; number: string; status: string; periodFrom: string; periodTo: string;
    pharmacy: string | null; total: number; lineCount: number; excludedCount: number;
    issuedAt: string | null; paidAt: string | null;
}

/** The blank line between paragraphs of a prompt. A template literal
 *  spanning two lines, because an escape here has to survive every tool
 *  that touches this file and one of them already ate it. */
const NL2 = `

`;

const money = (dollars: number) =>
    `${dollars < 0 ? '-' : ''}$${Math.abs(dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
    draft: 'muted', issued: 'warn', paid: 'ok', void: 'muted',
};

/** Which confirmation is open, if any. Null is the ordinary state. */
type Confirming =
    /** Issuing a draft that has deliveries on it we cannot price. */
    | 'issue'
    | 'void'
    /** Never issued and carrying nothing entered by hand: one button. */
    | 'delete'
    /** A draft whose adjustments were typed by somebody and exist nowhere
     *  else, so deleting it destroys them. Needs a reason. */
    | 'delete-adjusted'
    /** Issued. Needs the number typed back and a reason: the number is what
     *  a hospital would quote at us, and it cannot be given by clicking the
     *  wrong row. */
    | 'delete-issued'
    | null;

const DELETE_REASON_MIN = 10;

export function Invoices() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const base = `/api/projects/${code}/uh/invoices`;
    /* The contract's zone. An issue date is a date on a document. */
    const issuedDate = dateFor(useProjectTimezone(code));

    const [list, setList] = useState<Summary[] | null>(null);
    const [open, setOpen] = useState<Invoice | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [period, setPeriod] = useState({ from: '', to: '' });
    const [adjustment, setAdjustment] = useState({ description: '', amount: '', reason: '' });
    /* ───────────── WHY THIS IS NOT prompt() AND confirm() ─────────────
     *
     * It was, and on 18 November the Delete button did nothing at all when
     * it was clicked. Not an error, not a spinner: nothing.
     *
     * Chrome offers "Don't allow this page to create more dialogs" once a
     * page has shown a few in a row, and a person working through a list of
     * invoices sees a few in a row. Tick it and every later prompt() returns
     * null the instant it is called, so this ran:
     *
     *     const typed = prompt(...);
     *     if (typed === null || ...) return;   // silently
     *
     * The whole safety mechanism of a destructive action became a silent
     * no-op, decided by a checkbox in a browser we do not control and
     * cannot read. The confirmation now lives in the page, where it can be
     * seen, tested, and cannot be switched off. */
    const [confirming, setConfirming] = useState<Confirming>(null);
    const [typed, setTyped] = useState('');
    const [why, setWhy] = useState('');

    /** Open one of the confirmations, with the boxes empty. */
    const ask = (kind: Confirming) => { setConfirming(kind); setTyped(''); setWhy(''); setMsg(null); };
    const stopAsking = () => { setConfirming(null); setTyped(''); setWhy(''); };

    const load = useCallback(async () => {
        try {
            setList((await api<{ invoices: Summary[] }>(base)).invoices);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load invoices.' });
        }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

    const openInvoice = async (id: number) => {
        setMsg(null);
        try {
            setOpen(await api<Invoice>(`${base}/${id}`));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not open that invoice.' });
        }
    };

    async function act(fn: () => Promise<unknown>, ok: string) {
        setBusy(true);
        setMsg(null);
        try {
            await fn();
            setMsg({ kind: 'ok', text: ok });
            await load();
            if (open) await openInvoice(open.id);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'That did not work.' });
        } finally {
            setBusy(false);
        }
    }

    /**
     * Delete one that was never issued.
     *
     * Its own function rather than act(), because act() reopens the invoice
     * it just worked on and there is no longer one to reopen: the panel has
     * to close, and the list behind it is the confirmation.
     */
    async function remove(id: number, number: string, reason: string, confirmWith?: string) {
        setBusy(true);
        setMsg(null);
        try {
            await api(`${base}/${id}`, {
                method: 'DELETE',
                json: confirmWith === undefined ? { reason } : { reason, confirm: confirmWith },
            });
            setOpen(null);
            setMsg({ kind: 'ok', text: `${number} deleted. The number is recorded in the audit trail.` });
            await load();
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'That did not work.' });
        } finally {
            setBusy(false);
        }
    }

    const pagedPeriods = usePaged(list ?? []);
    const pagedLines = usePaged(open?.lines ?? []);
    /* The unpriced ones and the adjustments. Both are safe to page because
       the count above each is stated whole and does not come from the pager:
       the alert says how many deliveries cannot be priced whichever page you
       are on, which is the number somebody has to act on. */
    const pagedExceptions = usePaged(open?.exceptions ?? []);
    const pagedAdjustments = usePaged(open?.adjustments ?? []);

    if (!project) return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    if (list === null) {
        return msg
            ? (<><h1>Invoices</h1><div className="izy-alert error" role="alert">{msg.text}</div></>)
            : <div className="izy-card"><Loading label="Loading invoices" /></div>;
    }

    const create = (e: FormEvent) => {
        e.preventDefault();
        void act(
            () => api(base, { method: 'POST', json: { from: period.from, to: period.to } }),
            `Draft opened for ${period.from} to ${period.to}.`,
        );
    };

    const addAdjustment = (e: FormEvent) => {
        e.preventDefault();
        if (!open) return;
        void act(
            () => api(`${base}/${open.id}/adjustments`, {
                method: 'POST',
                json: { description: adjustment.description, amount: Number(adjustment.amount), reason: adjustment.reason },
            }),
            'Adjustment added.',
        );
        setAdjustment({ description: '', amount: '', reason: '' });
    };

    return (
        <>
            <h1>Invoices</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}`}>{project.name}</Link> · billing periods and what they came to
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>
            )}

            <div className="izy-card">
                <h2>Open a draft</h2>
                <form className="izy-row" onSubmit={create}>
                    <label className="izy-field">From
                        <input type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} required />
                    </label>
                    <label className="izy-field">To
                        <input type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} required />
                    </label>
                    <button className="izy-btn" type="submit" disabled={busy || !period.from || !period.to}>Open draft</button>
                    {/* ASKING WHAT A RANGE COMES TO IS NOT BILLING FOR IT.
                        Opening a draft is refused for a period that is not
                        over, and refused again for one an invoice already
                        covers. Both guards are right and neither has
                        anything to do with "what is Wheatley at so far this
                        month", which was being turned away by them.

                        A plain link, like every other export in this
                        application: the browser knows how to save a
                        download, and the file carries patient-free billing
                        lines that have no reason to sit in a blob URL until
                        the tab is closed. */}
                    <a
                        className={`izy-btn secondary${!period.from || !period.to ? ' disabled' : ''}`}
                        href={!period.from || !period.to ? undefined
                            : `${base}/export.xlsx?from=${period.from}&to=${period.to}`}
                        aria-disabled={!period.from || !period.to}
                    >
                        Export without billing
                    </a>
                </form>
                <p className="izy-muted">
                    A draft re-prices every delivery in the period each time you open it. Issuing it freezes the lines,
                    which is what stops a sent total from moving afterwards.
                </p>
                <p className="izy-muted">
                    <strong>Export without billing</strong> prices any range at all — including today, and including
                    days an invoice already covers — and raises nothing. No invoice, no number reserved, nothing that
                    can be sent. Use it to answer a question; use a draft to bill.
                </p>
            </div>

            <div className="izy-card">
                <h2>Billing periods</h2>
                {list.length === 0 ? <p className="izy-muted">Nothing billed yet.</p> : (
                    <>
                    <table className="izy-table">
                        <thead>
                            <tr><th>Invoice</th><th>Period</th><th>Status</th><th>Deliveries</th><th>Total</th><th /></tr>
                        </thead>
                        <tbody>
                            {pagedPeriods.rows.map((i) => (
                                <tr key={i.id}>
                                    <td><code>{i.number}</code></td>
                                    <td>{i.periodFrom} to {i.periodTo}</td>
                                    <td>
                                        <span className={`izy-pill ${STATUS_TONE[i.status] ?? 'muted'}`}>{i.status}</span>
                                        {i.excludedCount > 0 && (
                                            <><br /><span className="izy-stat-bad">{i.excludedCount} left off</span></>
                                        )}
                                    </td>
                                    {/* A draft has no stored line count: the
                                        lines are recomputed when it is opened
                                        and only frozen at issue. This column
                                        read a confident "0" for every draft,
                                        beside a draft that opens with three
                                        deliveries and a total of $74.00. A
                                        dispatcher scanning for a period worth
                                        billing would read 0 and move on. The
                                        total column next to it already
                                        declined to make up a number; this one
                                        now does the same. */}
                                    <td>{i.status === 'draft'
                                        ? <span className="izy-muted">counted on open</span>
                                        : i.lineCount}</td>
                                    <td>{i.status === 'draft' ? <span className="izy-muted">draft</span> : money(i.total)}</td>
                                    <td><button className="izy-btn secondary small" type="button" onClick={() => { void openInvoice(i.id); }}>Open</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                        <Pager of={pagedPeriods} noun="billing periods" />
                    </>
                )}
            </div>

            {open && (
                <section className="izy-card izy-next" aria-label={`Invoice ${open.number}`}>
                    <div className="izy-row-between">
                        <h2>{open.number}</h2>
                        <span className={`izy-pill ${STATUS_TONE[open.status] ?? 'muted'}`}>{open.status}</span>
                    </div>
                    <p className="izy-muted">
                        {open.periodFrom} to {open.periodTo} · {open.lineCount} {open.lineCount === 1 ? 'delivery' : 'deliveries'}
                        {open.issuedAt && <> · issued {issuedDate(open.issuedAt)}</>}
                        {open.paidAt && <> · paid {open.paidAt.slice(0, 10)}</>}
                    </p>

                    {open.recomputes && (
                        <div className="izy-alert warn" role="status">
                            This is a draft. The numbers below are recomputed every time it is opened and will change
                            if a delivery in the period changes. Do not quote them as final until it is issued.
                        </div>
                    )}

                    {/* Before the total, deliberately. */}
                    {open.exceptions.length > 0 && (
                        <div className="izy-alert error" role="alert">
                            <b>{open.exceptions.length} {open.exceptions.length === 1 ? 'delivery cannot' : 'deliveries cannot'} be priced and {open.exceptions.length === 1 ? 'is' : 'are'} not in this total.</b>
                            <ul className="izy-plain-list">
                                {pagedExceptions.rows.map((e) => (
                                    <li key={e.orderId}>
                                        {e.serviceDate} · {e.reference || `#${e.orderId}`}: {e.reason}
                                    </li>
                                ))}
                            </ul>
                            <Pager of={pagedExceptions} noun="unpriced deliveries" />
                        </div>
                    )}
                    {open.excludedCount > 0 && !open.recomputes && (
                        <div className="izy-alert warn" role="status">{open.excludedNote}</div>
                    )}

                    <div className="izy-stats">
                        <div><b>{money(open.subtotal)}</b><span>subtotal</span></div>
                        {open.adjustmentsTotal !== 0 && (
                            <div><b>{money(open.adjustmentsTotal)}</b><span>adjustments</span></div>
                        )}
                        <div><b>{money(open.total)}</b><span>total</span></div>
                        {/* Their word, not ours. A failed delivery is what
                            happened; "dry run" is the bid table's name for
                            the RATE, which is why the invoice carries both. */}
                        <div><b>{open.dryRuns.count}</b><span>undelivered, {open.dryRuns.items} items</span></div>
                    </div>

                    <div className="izy-row">
                        {/* The standard invoice is the summary. The long
                            one is still here for anybody who wants every
                            delivery on paper; the spreadsheet beside it is
                            the format somebody reconciling actually wants. */}
                        <a className="izy-btn secondary" href={`${base}/${open.id}/invoice.pdf`} target="_blank" rel="noreferrer">Invoice PDF</a>
                        <a className="izy-btn secondary" href={`${base}/${open.id}/invoice.pdf?detail=lines`} target="_blank" rel="noreferrer">PDF with every delivery</a>
                        <a className="izy-btn secondary" href={`${base}/${open.id}/invoice.xlsx`}>Excel</a>
                        {open.status === 'draft' && (
                            <button
                                className="izy-btn"
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    /* The exclusion is acknowledged in one place
                                       by a person who has just read the list
                                       above it -- in the page, not in a browser
                                       dialog that can be switched off. */
                                    if (open.exceptions.length > 0) { ask('issue'); return; }
                                    void act(
                                        () => api(`${base}/${open.id}/issue`, { method: 'POST', json: { excludeUnpriceable: false } }),
                                        'Invoice issued. The lines are frozen now.',
                                    );
                                }}
                            >
                                Issue
                            </button>
                        )}
                        {open.status === 'issued' && (
                            <button className="izy-btn" type="button" disabled={busy}
                                onClick={() => { void act(() => api(`${base}/${open.id}/paid`, { method: 'POST', json: {} }), 'Marked paid.'); }}>
                                Mark paid
                            </button>
                        )}
                        {open.status !== 'void' && (
                            <button className="izy-btn danger" type="button" disabled={busy}
                                onClick={() => { ask('void'); }}>
                                Void
                            </button>
                        )}
                        {(
                            /* ONCE REFUSED FOR AN ISSUED INVOICE, OPENED ON
                               17 NOVEMBER ON INSTRUCTION. The old reasoning
                               was that a number which has gone out must stay
                               answerable, and that is still true -- but this
                               system cannot tell an invoice SENT to
                               University Health from one issued by somebody
                               checking the screen worked. Refusing did not
                               protect a sent invoice; it stranded a mistake
                               in the list that is meant to be the record of
                               what we billed. The protection moved to "say
                               which one, and why". */
                            <button className="izy-btn danger" type="button" disabled={busy}
                                onClick={() => {
                                    /* WHICH QUESTION, decided here because the
                                       answer depends on what is on the invoice
                                       and the person can still see it. The
                                       server asks the same three things again;
                                       this only means the refusal is not the
                                       first anybody hears of them. */
                                    if (open.issuedAt !== null) { ask('delete-issued'); return; }
                                    if (open.adjustments.length > 0) { ask('delete-adjusted'); return; }
                                    ask('delete');
                                }}>
                                Delete
                            </button>
                        )}
                        <button className="izy-btn secondary" type="button" onClick={() => setOpen(null)}>Close</button>
                    </div>

                    {/* ───────────────────── THE CONFIRMATION ─────────────────────
                        In the page, under the invoice it is about, so whoever is
                        answering can still see what they are about to destroy.
                        The primary button stays disabled until the answer is one
                        the server will accept, so a refusal is not how somebody
                        learns what was wanted. */}
                    {confirming !== null && (
                        <div className="izy-card izy-confirm" role="alertdialog" aria-label="Confirm">
                            {confirming === 'issue' && (
                                <>
                                    <p>
                                        <strong>{open.exceptions.length}</strong>{' '}
                                        {open.exceptions.length === 1 ? 'delivery cannot' : 'deliveries cannot'} be priced.
                                        Issuing now leaves {open.exceptions.length === 1 ? 'it' : 'them'} off this invoice,
                                        to be billed on a later one. The reason is recorded on the invoice.
                                    </p>
                                    <div className="izy-row-actions">
                                        <button className="izy-btn" type="button" disabled={busy}
                                            onClick={() => {
                                                stopAsking();
                                                void act(
                                                    () => api(`${base}/${open.id}/issue`, { method: 'POST', json: { excludeUnpriceable: true } }),
                                                    'Invoice issued. The lines are frozen now.',
                                                );
                                            }}>
                                            Issue without them
                                        </button>
                                        <button className="izy-btn secondary" type="button" onClick={stopAsking}>Cancel</button>
                                    </div>
                                </>
                            )}

                            {confirming === 'void' && (
                                <>
                                    <p>
                                        Voiding keeps {open.number} and its number, with the reason against it.
                                        That is the right answer for an invoice that has been sent.
                                    </p>
                                    <label className="izy-field">Why is it being voided?
                                        <input value={why} onChange={(e) => setWhy(e.target.value)} autoFocus />
                                    </label>
                                    <div className="izy-row-actions">
                                        <button className="izy-btn danger" type="button"
                                            disabled={busy || why.trim() === ''}
                                            onClick={() => {
                                                const reason = why.trim();
                                                stopAsking();
                                                void act(() => api(`${base}/${open.id}/void`, { method: 'POST', json: { reason } }), 'Invoice voided.');
                                            }}>
                                            Void {open.number}
                                        </button>
                                        <button className="izy-btn secondary" type="button" onClick={stopAsking}>Cancel</button>
                                    </div>
                                </>
                            )}

                            {confirming === 'delete' && (
                                <>
                                    <p>
                                        Delete {open.number}? It has never been issued, so nobody outside has seen it.
                                        This cannot be undone.
                                    </p>
                                    <div className="izy-row-actions">
                                        <button className="izy-btn danger" type="button" disabled={busy}
                                            onClick={() => { stopAsking(); void remove(open.id, open.number, ''); }}>
                                            Delete it
                                        </button>
                                        <button className="izy-btn secondary" type="button" onClick={stopAsking}>Cancel</button>
                                    </div>
                                </>
                            )}

                            {confirming === 'delete-adjusted' && (
                                <>
                                    <p>
                                        {open.number} carries {open.adjustments.length}{' '}
                                        {open.adjustments.length === 1 ? 'adjustment' : 'adjustments'} entered by hand and
                                        recorded nowhere else. Deleting it destroys {open.adjustments.length === 1 ? 'it' : 'them'} and
                                        cannot be undone.
                                    </p>
                                    <label className="izy-field">Why is it being deleted?
                                        <input value={why} onChange={(e) => setWhy(e.target.value)} autoFocus />
                                    </label>
                                    <div className="izy-row-actions">
                                        <button className="izy-btn danger" type="button"
                                            disabled={busy || why.trim().length < DELETE_REASON_MIN}
                                            onClick={() => { const reason = why.trim(); stopAsking(); void remove(open.id, open.number, reason); }}>
                                            Delete it
                                        </button>
                                        <button className="izy-btn secondary" type="button" onClick={stopAsking}>Cancel</button>
                                    </div>
                                    <p className="izy-muted">At least {DELETE_REASON_MIN} characters.</p>
                                </>
                            )}

                            {confirming === 'delete-issued' && open.issuedAt !== null && (
                                <>
                                    <p>
                                        {open.number} was issued on {issuedDate(open.issuedAt)} and totals {money(open.total)}.
                                        Deleting it destroys a numbered record of what we billed, and cannot be undone.
                                    </p>
                                    <p>
                                        <strong>If this invoice was ever sent to University Health, cancel and void it
                                        instead</strong>, so the number stays answerable.
                                    </p>
                                    {/* The NUMBER typed back, not a count. It is what is at
                                        stake and what a hospital would quote at us, and it is
                                        the one confirmation that cannot be given by clicking
                                        the wrong row. */}
                                    <label className="izy-field">Type {open.number} to confirm
                                        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
                                    </label>
                                    <label className="izy-field">Why is it being deleted?
                                        <input value={why} onChange={(e) => setWhy(e.target.value)} />
                                    </label>
                                    <div className="izy-row-actions">
                                        <button className="izy-btn danger" type="button"
                                            disabled={busy || typed.trim() !== open.number || why.trim().length < DELETE_REASON_MIN}
                                            onClick={() => {
                                                const reason = why.trim();
                                                stopAsking();
                                                void remove(open.id, open.number, reason, open.number);
                                            }}>
                                            Delete {open.number}
                                        </button>
                                        <button className="izy-btn secondary" type="button" onClick={stopAsking}>Cancel</button>
                                    </div>
                                    <p className="izy-muted">
                                        The number and a reason of at least {DELETE_REASON_MIN} characters.
                                        Both are recorded in the audit trail, which is what answers the gap this
                                        leaves in the month's sequence.
                                    </p>
                                </>
                            )}
                        </div>
                    )}

                    {open.voidReason && <p className="izy-muted">Voided: {open.voidReason}</p>}

                    <h3>Lines</h3>
                    <table className="izy-table">
                        <thead>
                            <tr>
                                <th>Date</th><th>Reference</th><th>Pharmacy</th><th>ZIP</th><th>Zone</th>
                                <th>Service</th><th>Outcome</th><th>Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagedLines.rows.map((l) => (
                                <tr key={l.orderId}>
                                    <td>{l.serviceDate}</td>
                                    <td><Link to={`/projects/${code}/orders/${l.orderId}`}>{l.reference || `#${l.orderId}`}</Link></td>
                                    <td>{l.pharmacy}</td>
                                    <td>{l.deliveryZip}</td>
                                    <td>{l.zone === null ? 'out of area' : l.zone}</td>
                                    <td>{l.serviceType}</td>
                                    {/* "undelivered" against "delivered": what
                                        happened at the door, in one word each.
                                        The dry-run RATE is named on the
                                        summary, where it can be reconciled. */}
                                    <td>{l.dryRun ? `undelivered, ${l.items} ${l.items === 1 ? 'item' : 'items'}` : 'delivered'}</td>
                                    <td>{money(l.amountCents / 100)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <Pager of={pagedLines} noun="lines" />

                    <h3>Adjustments</h3>
                    {open.adjustments.length === 0 ? <p className="izy-muted">None.</p> : (
                        <ul className="izy-plain-list">
                            {pagedAdjustments.rows.map((a) => (
                                <li key={a.id}>
                                    {money(a.amount)} · {a.description} · <span className="izy-muted">{a.reason}</span>
                                    {open.status === 'draft' && (
                                        <>
                                            {' '}
                                            <button className="izy-btn secondary small" type="button" disabled={busy}
                                                onClick={() => { void act(() => api(`${base}/${open.id}/adjustments/${a.id}`, { method: 'DELETE' }), 'Adjustment removed.'); }}>
                                                Remove
                                            </button>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    <Pager of={pagedAdjustments} noun="adjustments" />

                    {open.status !== 'paid' && open.status !== 'void' && (
                        <Section
                            id="uh.invoice.adjust"
                            title="Add an adjustment"
                            defaultOpen={false}
                            summary="a credit or a charge agreed with University Health"
                        >
                        <form className="izy-row" onSubmit={addAdjustment}>
                            <label className="izy-field">Description
                                <input value={adjustment.description} onChange={(e) => setAdjustment({ ...adjustment, description: e.target.value })} required />
                            </label>
                            <label className="izy-field" style={{ maxWidth: 140 }}>Amount
                                <input value={adjustment.amount} onChange={(e) => setAdjustment({ ...adjustment, amount: e.target.value })}
                                    inputMode="decimal" placeholder="-25.00" required />
                            </label>
                            <label className="izy-field">Reason
                                <input value={adjustment.reason} onChange={(e) => setAdjustment({ ...adjustment, reason: e.target.value })}
                                    placeholder="Agreed with Karthik on 12 Sep" required />
                            </label>
                            <button className="izy-btn secondary" type="submit" disabled={busy}>Add adjustment</button>
                        </form>
                        </Section>
                    )}
                </section>
            )}
        </>
    );
}
