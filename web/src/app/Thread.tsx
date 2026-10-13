/* The conversation about one delivery.
 *
 * Ticket 7.12. One component, two screens: dispatch opens it from the order
 * page and a pharmacy opens it from the portal, against the same endpoint.
 * Two components would be two renderings of the same conversation that
 * eventually disagree about what was said.
 *
 * IT POLLS RATHER THAN HOLDING A SOCKET. Fifteen seconds, the same cadence
 * the dispatch board already uses, and the same reason: a counter asking
 * where a package is does not need sub-second delivery, and a websocket is a
 * connection to keep alive, authorise, scale and debug for a gain nobody
 * would notice. It stops polling when the tab is hidden, so an afternoon
 * with the portal open in a background tab is not an afternoon of requests.
 *
 * NOTHING CAN BE EDITED OR DELETED, because the server will not allow it:
 * append-only in the routes and again in the table. So there is no pencil
 * icon here, and that absence is deliberate rather than unfinished.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, fmtWhen } from '../lib/api';

export interface ThreadMessage {
    id: number;
    author: string;
    authorName: string;
    body: string;
    mentions: string[];
    at: string;
}

interface ThreadData {
    orderId: number;
    messages: ThreadMessage[];
    people: Array<{ username: string; name: string }>;
}

const EVERY_MS = 15000;

export function Thread({ base, orderId, label = 'Messages' }: {
    /** The project API root, e.g. /api/projects/uh/uh. */
    base: string;
    orderId: number;
    label?: string;
}) {
    const [data, setData] = useState<ThreadData | null>(null);
    const [draft, setDraft] = useState('');
    const [tagged, setTagged] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const timer = useRef<number | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await api<ThreadData>(`${base}/threads/${orderId}`));
        } catch {
            /* Quiet on a failed poll. The thread is a side panel; a red
               banner every fifteen seconds because the network blinked is
               worse than a panel that is briefly out of date. A failure that
               matters is the one on send, and that one is shown. */
        }
    }, [base, orderId]);

    useEffect(() => {
        void load();
        const tick = () => {
            if (timer.current !== null) window.clearInterval(timer.current);
            timer.current = document.hidden ? null : window.setInterval(() => { void load(); }, EVERY_MS);
        };
        tick();
        document.addEventListener('visibilitychange', tick);
        return () => {
            if (timer.current !== null) window.clearInterval(timer.current);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [load]);

    const send = async () => {
        const body = draft.trim();
        if (body === '') return;
        setBusy(true);
        setMsg(null);
        try {
            await api(`${base}/threads/${orderId}`, { method: 'POST', json: { body, mentions: tagged } });
            setDraft('');
            setTagged([]);
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'That did not send.');
        } finally {
            setBusy(false);
        }
    };

    const people = data?.people ?? [];

    return (
        <div className="izy-thread">
            <h3>{label}</h3>

            {data === null ? <p className="izy-muted">Loading...</p>
                : data.messages.length === 0 ? (
                    <p className="izy-muted">
                        Nothing yet. Anything written here stays on this delivery, and the
                        pharmacy and dispatch both see it.
                    </p>
                ) : (
                    <ol className="izy-thread-list">
                        {data.messages.map((m) => (
                            <li key={m.id}>
                                <div className="izy-thread-who">
                                    <b>{m.authorName}</b>
                                    <span className="izy-muted"> · {fmtWhen(m.at)}</span>
                                </div>
                                {/* Plain text. No markdown, no links, no HTML:
                                    this box takes typing from nine
                                    organisations and renders it to all of
                                    them. */}
                                <div className="izy-thread-body">{m.body}</div>
                                {m.mentions.length > 0 && (
                                    <div className="izy-muted">
                                        tagged {m.mentions.map((u) => people.find((p) => p.username === u)?.name ?? u).join(', ')}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>
                )}

            {msg !== null && <div className="izy-alert error" role="alert">{msg}</div>}

            <div className="izy-thread-write">
                <label className="izy-field">
                    <span className="izy-visually-hidden">Message about this delivery</span>
                    <textarea
                        aria-label="Message about this delivery"
                        rows={2}
                        maxLength={2000}
                        value={draft}
                        placeholder="What is happening with this delivery?"
                        onChange={(e) => setDraft(e.target.value)}
                    />
                </label>
                <div className="izy-row">
                    {people.length > 0 && (
                        <label className="izy-field">Tag
                            <select
                                aria-label="Tag somebody"
                                value=""
                                onChange={(e) => {
                                    const who = e.target.value;
                                    if (who !== '' && !tagged.includes(who)) setTagged([...tagged, who]);
                                }}
                            >
                                <option value="">Nobody</option>
                                {people.filter((p) => !tagged.includes(p.username)).map((p) => (
                                    <option key={p.username} value={p.username}>{p.name}</option>
                                ))}
                            </select>
                        </label>
                    )}
                    <button className="izy-btn" type="button" disabled={busy || draft.trim() === ''} onClick={() => { void send(); }}>
                        {busy ? 'Sending' : 'Send'}
                    </button>
                </div>
                {tagged.length > 0 && (
                    <p className="izy-muted">
                        Telling {tagged.map((u) => people.find((p) => p.username === u)?.name ?? u).join(', ')}
                        {' '}
                        <button
                            className="izy-btn secondary small"
                            type="button"
                            onClick={() => setTagged([])}
                        >
                            Clear
                        </button>
                    </p>
                )}
            </div>
        </div>
    );
}
