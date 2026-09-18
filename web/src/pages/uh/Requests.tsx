/* Couriers asking for work, and the answer.
 *
 * Ticket 8.2, and the second of the phase 6 screens that were never built.
 * `POST /uh/requests/:id/approve` and `/deny` shipped in 6.4 with no client,
 * which means a courier asking for a delivery from their phone was asking
 * somebody who had no way to answer.
 *
 * IT LIVES ON THE BOARD, not on a page of its own. The person who answers a
 * request is the person watching the board during a wave, and a request that
 * needs a second tab is a request that waits until somebody remembers the
 * tab exists. A courier is standing still while it is pending.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SWEEP IS NOT AN ORDINARY BUTTON, and it is treated differently here.
 *
 * Pressing it hands real deliveries to real couriers, under the actor
 * `system`, in an append-only custody table. So it previews first: a dry run
 * is the default and the button that actually assigns only appears once
 * somebody has seen what it would do. That is not caution for its own sake.
 * `sweepUnclaimed` picks the courier carrying least, not the nearest, for the
 * reasons in ticket 6.5, and a dispatcher who can see who is about to be
 * given a run out to Boerne can stop it.
 *
 * AND THE LOUD CASE IS LOUD. `unassignable` with "Nobody is on shift" is the
 * case the sweep cannot fix; 6.5 was explicit that silence there leaves it as
 * invisible as it was before. It gets an alert, not a row in a table.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS SCREEN SHOWS THAT THE COURIER'S DOES NOT. The claimable board a
 * courier browses carries no patient name and no street address (6.4). This
 * one carries the name, because dispatch already sees every name on the board
 * behind it and deciding who goes where is their job. The asymmetry is the
 * point, and it is enforced on the server rather than here.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clockFor } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';

export interface DeliveryRequest {
    id: number;
    orderId: number;
    status: string;
    requestedAt: string;
    decidedAt: string | null;
    decisionReason: string;
    zip: string;
    zone: number | null;
    serviceType: string;
    dueAt: string | null;
    courierUsername: string;
    recipientName: string;
}

export interface SweepState {
    automatic: boolean;
    everySeconds: number | null;
}

interface QueueResponse {
    requests: DeliveryRequest[];
    sweep: SweepState;
}

export interface SweepOutcome {
    serviceDate: string;
    assigned: Array<{ orderId: number; courierUsername: string; serviceType: string; minutesToDue: number; runId: number | null }>;
    unassignable: Array<{ orderId: number; serviceType: string; minutesToDue: number; reason: string }>;
    couriers: Array<{ courierUsername: string; open: number }>;
}

const POLL_MS = 15_000;

/** Minutes until a deadline, or null when there is not one. */
function minutesTo(dueAt: string | null): number | null {
    if (!dueAt) return null;
    const t = new Date(dueAt).getTime();
    if (Number.isNaN(t)) return null;
    return Math.round((t - Date.now()) / 60000);
}

function dueLabel(mins: number | null): { text: string; className: string } {
    if (mins === null) return { text: 'no deadline', className: 'izy-muted' };
    if (mins < 0) return { text: `${-mins} min overdue`, className: 'izy-stat-bad' };
    if (mins <= 30) return { text: `due in ${mins} min`, className: 'izy-stat-warn' };
    return { text: `due in ${mins} min`, className: '' };
}

export function Requests({ projectCode, timezone }: { projectCode: string; timezone: string }) {
    const base = `/api/projects/${projectCode}/uh/requests`;
    const clock = clockFor(timezone);

    const [requests, setRequests] = useState<DeliveryRequest[] | null>(null);
    const [sweepState, setSweepState] = useState<SweepState | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [denying, setDenying] = useState<number | null>(null);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<SweepOutcome | null>(null);

    const load = useCallback(async () => {
        try {
            const r = await api<QueueResponse>(`${base}?status=pending`);
            setRequests(r.requests);
            setSweepState(r.sweep);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load requests' });
            setRequests([]);
        }
    }, [base]);

    useEffect(() => { void load(); }, [load]);

    /* Polled, and paused with the tab hidden, for the same reason the board
       is: a request is only useful while the courier is still waiting, and a
       board left open overnight should not ask anyway. */
    useEffect(() => {
        const tick = () => { if (!document.hidden) void load(); };
        const id = setInterval(tick, POLL_MS);
        return () => clearInterval(id);
    }, [load]);

    const approve = async (r: DeliveryRequest) => {
        setBusy(true);
        setMsg(null);
        try {
            const out = await api<{ runId: number; superseded: number }>(`${base}/${r.id}/approve`, { method: 'POST', json: {} });
            setMsg({
                kind: 'ok',
                text: `Delivery ${r.orderId} is ${r.courierUsername}'s, on run ${out.runId}.`
                    /* Named, because the other couriers were told something
                       and dispatch should know what. */
                    + (out.superseded > 0
                        ? ` ${out.superseded} other ${out.superseded === 1 ? 'courier was' : 'couriers were'} told somebody got there first.`
                        : ''),
            });
            await load();
        } catch (err) {
            /* The interesting failure is 409 stop.taken: somebody else got
               the order between the list loading and this click. The server's
               sentence says so; ours would not. */
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not approve that request' });
            await load();
        } finally {
            setBusy(false);
        }
    };

    const deny = async (e: FormEvent, r: DeliveryRequest) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
            await api(`${base}/${r.id}/deny`, { method: 'POST', json: { reason } });
            setDenying(null);
            setReason('');
            setMsg({ kind: 'ok', text: `${r.courierUsername} was told no, with the reason.` });
            await load();
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not deny that request' });
        } finally {
            setBusy(false);
        }
    };

    const sweep = async (dryRun: boolean) => {
        setBusy(true);
        setMsg(null);
        try {
            const out = await api<SweepOutcome>(`${base}/sweep?dryRun=${dryRun}`, { method: 'POST', json: {} });
            if (dryRun) {
                setPreview(out);
            } else {
                setPreview(null);
                setMsg({
                    kind: 'ok',
                    text: out.assigned.length === 0
                        ? 'Nothing was close enough to its deadline to hand out.'
                        : `${out.assigned.length} ${out.assigned.length === 1 ? 'delivery' : 'deliveries'} handed out.`,
                });
                await load();
            }
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'The sweep could not run' });
        } finally {
            setBusy(false);
        }
    };

    const paged = usePaged(requests ?? []);
    const waiting = requests?.length ?? 0;

    return (
        <Section
            id="uh.requests"
            title="Couriers asking for work"
            /* Open, always, and not "open when somebody is waiting".
               `defaultOpen` is read once when the card mounts, and at that
               moment the request list is still loading, so a rule that
               depends on the data would fold this card and never unfold it:
               the one card on the board with a person standing still behind
               it would be the one nobody sees. It stays open and remembers
               if somebody folds it. */
            defaultOpen
            summary={requests === null
                ? undefined
                : waiting === 0 ? 'nobody is waiting' : `${waiting} waiting on an answer`}
        >
            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>
            )}

            {requests === null ? <Loading label="Loading requests" /> : (
                <>
                    <table className="izy-table">
                        <thead>
                            <tr><th>Courier</th><th>Delivery</th><th>Where</th><th>Due</th><th /></tr>
                        </thead>
                        <tbody>
                            {paged.rows.map((r) => {
                                const mins = minutesTo(r.dueAt);
                                const due = dueLabel(mins);
                                return (
                                    <tr key={r.id}>
                                        <td>
                                            <b>{r.courierUsername}</b>
                                            <div className="izy-muted">asked at {clock(r.requestedAt)}</div>
                                        </td>
                                        <td>
                                            <b>{r.recipientName}</b>
                                            <div className="izy-muted">#{r.orderId} · {r.serviceType.toUpperCase()}</div>
                                        </td>
                                        <td>
                                            {r.zip}
                                            <div className="izy-muted">{r.zone === null ? 'out of area' : `zone ${r.zone}`}</div>
                                        </td>
                                        <td className={due.className}>{due.text}</td>
                                        <td style={{ textAlign: 'right' }}>
                                            <button className="izy-btn small" type="button" disabled={busy} onClick={() => { void approve(r); }}>
                                                Approve
                                            </button>
                                            {' '}
                                            <button
                                                className="izy-btn secondary small"
                                                type="button"
                                                disabled={busy}
                                                onClick={() => { setDenying(denying === r.id ? null : r.id); setReason(''); }}
                                            >
                                                Deny
                                            </button>
                                            {denying === r.id && (
                                                <form onSubmit={(e) => { void deny(e, r); }}>
                                                    <label className="izy-field">
                                                        Why not
                                                        {/* Required and short-checked here because the server
                                                            requires three characters, and a courier reading
                                                            "Not this time: no" twice stops asking for work. */}
                                                        <input
                                                            aria-label={`Why ${r.courierUsername} cannot have delivery ${r.orderId}`}
                                                            value={reason}
                                                            onChange={(e) => setReason(e.target.value)}
                                                            minLength={3}
                                                            required
                                                            placeholder="They will read this on their phone."
                                                        />
                                                    </label>
                                                    <button className="izy-btn danger small" type="submit" disabled={busy}>Send the no</button>
                                                </form>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {waiting === 0 && (
                                <tr><td colSpan={5} className="izy-muted">Nobody is waiting on an answer.</td></tr>
                            )}
                        </tbody>
                    </table>
                    <Pager of={paged} noun="requests" />

                    <Sweep
                        state={sweepState}
                        preview={preview}
                        busy={busy}
                        onPreview={() => { void sweep(true); }}
                        onRun={() => { void sweep(false); }}
                        onCancel={() => setPreview(null)}
                    />
                </>
            )}
        </Section>
    );
}

/* ------------------------------------------------------------------ sweep */

function Sweep({ state, preview, busy, onPreview, onRun, onCancel }: {
    state: SweepState | null;
    preview: SweepOutcome | null;
    busy: boolean;
    onPreview: () => void;
    onRun: () => void;
    onCancel: () => void;
}) {
    return (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--izy-line)', paddingTop: 12 }}>
            <h3>Work nobody has asked for</h3>
            <p className="izy-muted">
                Deliveries close to their deadline that nobody has claimed go to whoever is on shift and carrying
                least. Not the nearest: the pharmacies have no coordinates yet, so distance is a guess and this is
                not.
            </p>

            {/* The sentence a dispatcher needs and could not otherwise get.
                Unset in every environment today, and a button that looks
                automatic but is not is how a STAT sits there. */}
            {/* NOT role="status". This is standing prose about how the
                system is configured, and it never changes while somebody is
                looking at it. A live region here is announced on load and
                then sits on the page competing with the board's real
                messages, which is how "Order 1 assigned" ends up as one of
                two things claiming to be the status. */}
            {state && (
                <div
                    className="izy-alert"
                    style={state.automatic ? undefined : { background: 'var(--izy-warn-soft)', color: '#92400e' }}
                >
                    {state.automatic
                        ? `This also runs on its own every ${state.everySeconds} seconds.`
                        : 'This does not run on its own. Nothing is handed out until somebody presses the button, '
                          + 'so an unclaimed STAT waits for a person to notice. Set SWEEP_INTERVAL_SECONDS to change that.'}
                </div>
            )}

            {preview === null ? (
                <button className="izy-btn secondary" type="button" disabled={busy} onClick={onPreview}>
                    Show me what would be handed out
                </button>
            ) : (
                <>
                    {/* The case the sweep cannot fix, and the reason it is an
                        alert rather than a row: 6.5 said silence here leaves
                        it as invisible as it was before the ticket. */}
                    {preview.unassignable.length > 0 && (
                        <div className="izy-alert error" role="alert">
                            <b>{preview.unassignable.length} past the point of waiting, and nowhere to send {preview.unassignable.length === 1 ? 'it' : 'them'}.</b>
                            <ul>
                                {preview.unassignable.map((u) => (
                                    <li key={u.orderId}>
                                        #{u.orderId} ({u.serviceType.toUpperCase()}), {u.minutesToDue < 0 ? `${-u.minutesToDue} min overdue` : `due in ${u.minutesToDue} min`}: {u.reason}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {preview.assigned.length === 0 ? (
                        <p>Nothing is close enough to its deadline to hand out.</p>
                    ) : (
                        <>
                            <table className="izy-table">
                                <thead>
                                    <tr><th>Delivery</th><th>Would go to</th><th>Due</th></tr>
                                </thead>
                                <tbody>
                                    {preview.assigned.map((a) => (
                                        <tr key={a.orderId}>
                                            <td>#{a.orderId} <span className="izy-muted">{a.serviceType.toUpperCase()}</span></td>
                                            <td><b>{a.courierUsername}</b></td>
                                            <td className={a.minutesToDue < 0 ? 'izy-stat-bad' : 'izy-stat-warn'}>
                                                {a.minutesToDue < 0 ? `${-a.minutesToDue} min overdue` : `in ${a.minutesToDue} min`}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {preview.couriers.length > 0 && (
                                <p className="izy-muted">
                                    On shift: {preview.couriers.map((c) => `${c.courierUsername} (${c.open} open)`).join(', ')}
                                </p>
                            )}
                        </>
                    )}

                    <div className="izy-row">
                        {/* Only after a preview, and only when the preview
                            found something. Disabling it instead left a
                            button reading "Hand out these 0" on the screen,
                            which is a control offering to do nothing next to
                            an alert saying a STAT has nowhere to go. */}
                        {preview.assigned.length > 0 && (
                            <button className="izy-btn" type="button" disabled={busy} onClick={onRun}>
                                Hand out {preview.assigned.length === 1 ? 'this delivery' : `these ${preview.assigned.length}`}
                            </button>
                        )}
                        <button className="izy-btn secondary" type="button" onClick={onCancel}>Cancel</button>
                    </div>
                </>
            )}
        </div>
    );
}
