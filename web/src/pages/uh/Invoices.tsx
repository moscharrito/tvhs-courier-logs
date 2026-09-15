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

const money = (dollars: number) =>
    `${dollars < 0 ? '-' : ''}$${Math.abs(dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
    draft: 'muted', issued: 'warn', paid: 'ok', void: 'muted',
};

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

    const pagedPeriods = usePaged(list ?? []);
    const pagedLines = usePaged(open?.lines ?? []);

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
                </form>
                <p className="izy-muted">
                    A draft re-prices every delivery in the period each time you open it. Issuing it freezes the lines,
                    which is what stops a sent total from moving afterwards.
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
                                {open.exceptions.map((e) => (
                                    <li key={e.orderId}>
                                        {e.serviceDate} · {e.reference || `#${e.orderId}`}: {e.reason}
                                    </li>
                                ))}
                            </ul>
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
                        <div><b>{open.dryRuns.count}</b><span>dry runs, {open.dryRuns.items} items</span></div>
                    </div>

                    <div className="izy-row">
                        <a className="izy-btn secondary" href={`${base}/${open.id}/invoice.pdf`} target="_blank" rel="noreferrer">PDF</a>
                        <a className="izy-btn secondary" href={`${base}/${open.id}/invoice.xlsx`}>Excel</a>
                        {open.status === 'draft' && (
                            <button
                                className="izy-btn"
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    /* The exclusion is acknowledged here, in one
                                       place, by a person who has just read the
                                       list above it. */
                                    const exclude = open.exceptions.length > 0
                                        && confirm(`${open.exceptions.length} deliveries cannot be priced. Issue without them and bill them on a later invoice?`);
                                    if (open.exceptions.length > 0 && !exclude) return;
                                    void act(
                                        () => api(`${base}/${open.id}/issue`, { method: 'POST', json: { excludeUnpriceable: exclude } }),
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
                                onClick={() => {
                                    const reason = prompt('Why is this invoice being voided?');
                                    if (!reason) return;
                                    void act(() => api(`${base}/${open.id}/void`, { method: 'POST', json: { reason } }), 'Invoice voided.');
                                }}>
                                Void
                            </button>
                        )}
                        <button className="izy-btn secondary" type="button" onClick={() => setOpen(null)}>Close</button>
                    </div>

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
                                    <td>{l.dryRun ? `dry run, ${l.items} ${l.items === 1 ? 'item' : 'items'}` : 'delivered'}</td>
                                    <td>{money(l.amountCents / 100)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <Pager of={pagedLines} noun="lines" />

                    <h3>Adjustments</h3>
                    {open.adjustments.length === 0 ? <p className="izy-muted">None.</p> : (
                        <ul className="izy-plain-list">
                            {open.adjustments.map((a) => (
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
