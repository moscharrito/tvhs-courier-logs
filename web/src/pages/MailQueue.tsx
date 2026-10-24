/* What is waiting to go out by email, before it goes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS PAGE EXISTS TO ANSWER ONE QUESTION BEFORE AN IRREVERSIBLE ACT.
 *
 * SES refused every send for a day with 403 AccessDeniedException, so the
 * queue filled up and nothing left the building. /health said so. The next
 * question decided whether it was safe to fix:
 *
 *     If I grant that permission now, what actually gets sent?
 *
 * A queue of genuine delivery notifications should be released at once. A
 * queue of notifications about dry-run orders sends a hospital delivery
 * confirmations for packages that never existed, weeks before go-live, the
 * moment the permission lands -- and an email cannot be recalled.
 *
 * Nothing could answer it: the notifications API is scoped to the signed-in
 * member by design, /health is forbidden from carrying row counts, and the
 * audit trail has no record of a notification that has not been sent. The
 * only way to look was the database credentials and a SQL prompt.
 *
 * SO THE NUMBER AT THE TOP IS THE POINT, not the table. "Granting it now
 * would send N emails" is the sentence somebody needs, and `would send` is
 * computed by the server with the same rules in the same order as the real
 * sweep (see core/notify/queue.ts) so that it is true rather than nearly.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, fmtWhen } from '../lib/api';
import { Pager, usePaged } from '../app/Pager';

interface QueuedMail {
    id: number;
    kind: string;
    orderId: number | null;
    username: string;
    email: string;
    createdAt: string;
    body: string;
    outcome: 'would send' | 'no address' | 'suppressed';
    inNextBatch: boolean;
}

interface Queue {
    total: number;
    wouldSend: number;
    noAddress: number;
    suppressed: number;
    batch: number;
    oldest: string | null;
    rows: QueuedMail[];
    partial: boolean;
}

const TONE: Record<QueuedMail['outcome'], string> = {
    'would send': 'warn',
    'no address': 'muted',
    suppressed: 'muted',
};

export function MailQueue() {
    const [queue, setQueue] = useState<Queue | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            setQueue(await api<Queue>('/api/mail-queue?limit=200'));
        } catch (err) {
            setError(err instanceof ApiError ? [err.message, ...err.details].join(' ') : 'Failed to load');
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    /* Hoisted above every early return. A hook called below a conditional
        return is the crash this codebase has already shipped once. */
    const paged = usePaged(queue?.rows ?? []);

    return (
        <>
            <h1>Mail queue</h1>
            <p className="izy-sub">
                Delivery notifications waiting to be emailed, and what would happen to each
                one if the sweep ran now.
            </p>

            {error && <div className="izy-alert error" role="alert">{error}</div>}

            {queue && (
                <div className="izy-card">
                    {/* THE SENTENCE SOMEBODY CAME HERE FOR. Said in words
                        rather than left to be worked out of four figures,
                        because the thing it decides cannot be undone. */}
                    {queue.wouldSend > 0 ? (
                        <div className="izy-alert warn" role="status">
                            <b>Releasing this queue would send {queue.wouldSend} email
                                {queue.wouldSend === 1 ? '' : 's'}.</b>{' '}
                            Check below what they are about before fixing whatever is
                            holding them. An email cannot be recalled.
                        </div>
                    ) : (
                        <div className="izy-alert ok" role="status">
                            <b>Nothing here would be emailed.</b>{' '}
                            {queue.total === 0
                                ? 'The queue is empty.'
                                : 'Every waiting row has nowhere to go or is suppressed, so the sweep will close them without sending.'}
                        </div>
                    )}

                    <div className="izy-stats">
                        <div><b>{queue.total}</b><span>waiting</span></div>
                        <div className={queue.wouldSend > 0 ? 'izy-stat-bad' : undefined}>
                            <b>{queue.wouldSend}</b><span>would send</span>
                        </div>
                        <div><b>{queue.noAddress}</b><span>no address</span></div>
                        <div><b>{queue.suppressed}</b><span>suppressed</span></div>
                    </div>

                    <p className="izy-muted izy-field-note">
                        {/* dispatch reads `ORDER BY id LIMIT batch`, so a queue
                            deeper than one batch has a head and a tail, and
                            anything behind a row that keeps failing waits for
                            it. Worth saying when it applies and not otherwise. */}
                        The sweep takes {queue.batch} at a time, oldest first.
                        {queue.total > queue.batch
                            && ` The ${queue.batch} marked “next” are the only ones the next tick will touch.`}
                        {queue.oldest !== null && ` The oldest has been waiting since ${fmtWhen(queue.oldest)}.`}
                    </p>

                    <button className="izy-btn secondary" type="button" disabled={busy} onClick={() => { void load(); }}>
                        {busy ? 'Checking' : 'Check again'}
                    </button>
                </div>
            )}

            {queue && queue.total > 0 && (
                <div className="izy-card">
                    <table className="izy-table">
                        <thead>
                            <tr>
                                <th>Waiting since</th>
                                <th>Account</th>
                                <th>Address</th>
                                <th>Order</th>
                                <th>Says</th>
                                <th>Would</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paged.rows.map((r) => (
                                <tr key={r.id}>
                                    <td>
                                        {fmtWhen(r.createdAt)}
                                        {queue.total > queue.batch && r.inNextBatch
                                            && <span className="izy-pill" style={{ marginLeft: 6 }}>next</span>}
                                    </td>
                                    <td>{r.username}</td>
                                    <td>
                                        {r.email === ''
                                            ? <span className="izy-muted">none on the account</span>
                                            : <code>{r.email}</code>}
                                    </td>
                                    <td>
                                        {r.orderId === null
                                            ? <span className="izy-muted">—</span>
                                            : <code>{r.orderId}</code>}
                                    </td>
                                    {/* The body, because an order number alone
                                        does not tell anybody whether this is a
                                        dry run. It is composed from a fixed
                                        template and carries no patient data. */}
                                    <td>{r.body}</td>
                                    <td><span className={`izy-pill ${TONE[r.outcome]}`}>{r.outcome}</span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <Pager
                        of={paged}
                        noun="waiting"
                        note={queue.partial ? `only the first ${queue.rows.length} of ${queue.total} are listed` : undefined}
                    />
                </div>
            )}

            {queue === null && !busy && error === null && <p className="izy-muted">Loading.</p>}
        </>
    );
}
