/* Work nobody has been given, handed out before its deadline passes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS CARD USED TO BE A REQUEST QUEUE.
 *
 * Tickets 6.4, 6.5 and 8.2 built a pull model: couriers browsed unassigned
 * deliveries from their phone, asked for the ones they wanted, and a
 * dispatcher approved or denied each one here. Operations never ran that way
 * -- dispatch assigns every delivery from the forecast and a site manager
 * moves one at the counter when somebody is late -- so the asking half was
 * removed on 16 October 2026 on the owner's instruction. The courier app had
 * already dropped its Work and Asked tabs; this is the other end of that.
 *
 * WHAT IS LEFT IS THE OPPOSITE FEATURE, and the name now says so. The sweep
 * is not a courier pulling work: it is the platform refusing to let a
 * delivery sit unassigned while its deadline runs out.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SWEEP IS NOT AN ORDINARY BUTTON.
 *
 * Pressing it hands real deliveries to real couriers, under the actor
 * `system`, in an append-only custody table. So it previews first: a dry run
 * is the default and the button that actually assigns only appears once
 * somebody has seen what it would do. `sweepUnclaimed` picks the courier
 * carrying least, not the nearest, and a dispatcher who can see who is about
 * to be given a run out to Boerne can stop it.
 *
 * AND THE LOUD CASE IS LOUD. `unassignable` with "Nobody is on shift" is the
 * case the sweep cannot fix; 6.5 was explicit that silence there leaves it as
 * invisible as it was before. It gets an alert, not a row in a table.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { displayName } from '../../lib/people';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';

export interface SweepState {
    automatic: boolean;
    everySeconds: number | null;
}

export interface SweepOutcome {
    serviceDate: string;
    assigned: Array<{ orderId: number; courierUsername: string; courierName?: string; serviceType: string; minutesToDue: number; runId: number | null }>;
    unassignable: Array<{ orderId: number; serviceType: string; minutesToDue: number; reason: string }>;
    couriers: Array<{ courierUsername: string; courierName?: string; open: number }>;
}

export function Escalation({ projectCode }: { projectCode: string }) {
    const base = `/api/projects/${projectCode}/uh/escalation`;

    const [state, setState] = useState<SweepState | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<SweepOutcome | null>(null);
    const [loaded, setLoaded] = useState(false);

    /* Read once, not polled. The request queue above this used to refresh
       every fifteen seconds because somebody was standing still behind each
       row; whether the sweep timer is configured does not change while a
       dispatcher is looking at it. */
    const load = useCallback(async () => {
        try {
            const r = await api<{ sweep: SweepState }>(base);
            setState(r.sweep);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not read the sweep settings' });
        } finally {
            setLoaded(true);
        }
    }, [base]);

    useEffect(() => { void load(); }, [load]);

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
            }
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'The sweep could not run' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section id="uh.escalation" title="Work nobody has been given" defaultOpen={false}>
            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>
            )}
            {!loaded ? <Loading label="Loading" /> : (
                <Sweep
                    state={state}
                    preview={preview}
                    busy={busy}
                    onPreview={() => { void sweep(true); }}
                    onRun={() => { void sweep(false); }}
                    onCancel={() => setPreview(null)}
                />
            )}
        </Section>
    );
}

function Sweep({ state, preview, busy, onPreview, onRun, onCancel }: {
    state: SweepState | null;
    preview: SweepOutcome | null;
    busy: boolean;
    onPreview: () => void;
    onRun: () => void;
    onCancel: () => void;
}) {
    const pagedStuck = usePaged(preview?.unassignable ?? []);
    const pagedSweep = usePaged(preview?.assigned ?? []);
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
                                {pagedStuck.rows.map((u) => (
                                    <li key={u.orderId}>
                                        #{u.orderId} ({u.serviceType.toUpperCase()}), {u.minutesToDue < 0 ? `${-u.minutesToDue} min overdue` : `due in ${u.minutesToDue} min`}: {u.reason}
                                    </li>
                                ))}
                            </ul>
                            <Pager of={pagedStuck} noun="deliveries" />
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
                                    {pagedSweep.rows.map((a) => (
                                        <tr key={a.orderId}>
                                            <td>#{a.orderId} <span className="izy-muted">{a.serviceType.toUpperCase()}</span></td>
                                            {/* The driver, by name. This printed their email address. */}
                                            <td><b>{displayName({ name: a.courierName ?? '', username: a.courierUsername })}</b></td>
                                            <td className={a.minutesToDue < 0 ? 'izy-stat-bad' : 'izy-stat-warn'}>
                                                {a.minutesToDue < 0 ? `${-a.minutesToDue} min overdue` : `in ${a.minutesToDue} min`}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <Pager of={pagedSweep} noun="deliveries" />
                            {preview.couriers.length > 0 && (
                                <p className="izy-muted">
                                    On shift: {preview.couriers.map((c) => `${displayName({ name: c.courierName ?? '', username: c.courierUsername })} (${c.open} open)`).join(', ')}
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

