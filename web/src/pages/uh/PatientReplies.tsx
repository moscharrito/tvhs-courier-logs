/* What patients have texted back.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS SCREEN IS THE REASON THE REPLIES ARE WORTH KEEPING.
 *
 * Until 27 November 2026 a patient's reply was answered by Twilio's default
 * empty response and discarded. Storing them instead is only an improvement
 * if somebody reads them: a reply nobody sees is an instruction from a
 * patient that we accepted and ignored, which is worse than never having
 * had it, because now we hold it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OUTSTANDING ONLY, BY DEFAULT.
 *
 * The question this page answers is "is there anything I have not dealt
 * with", not "what have patients ever said". Handled ones are one click
 * away and not on the screen, the same bargain the list-drops page strikes.
 *
 * THE BODY IS THE BIGGEST THING ON EACH ROW, because it is the only part a
 * dispatcher cannot guess. Everything else -- which delivery, which
 * patient, when -- is context for deciding whether to act on it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DISPATCH ONLY. The server refuses a pharmacy outright (see the header of
 * modules/uh/patient-replies.ts) and this page is behind the same roles, so
 * a counter never reaches it. That is the one thing in this module a
 * pharmacy is refused about its own deliveries, and it is deliberate: these
 * are a patient's unprompted words, addressed to the courier who texted
 * them rather than to the counter.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { clockFor } from '../../lib/when';

interface ReplyOrder {
    id: number;
    reference: string;
    patient: string;
    serviceDate: string;
    status: string;
    pharmacy: string;
}

interface Reply {
    id: number;
    phone: string;
    body: string;
    kind: 'message' | 'stop' | 'start';
    receivedAt: string;
    handled: boolean;
    handledAt: string | null;
    handledBy: string;
    /** Null when the number matched nothing we have sent. Still listed. */
    order: ReplyOrder | null;
}

interface Replies {
    replies: Reply[];
    outstanding: number;
    truncated: boolean;
}

/** 2105559876 as a person would read it back. */
const pretty = (d: string): string => (/^\d{10}$/.test(d)
    ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
    : d);

export function PatientReplies() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const timezone = useProjectTimezone(code);

    const [data, setData] = useState<Replies | null>(null);
    const [showAll, setShowAll] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [busy, setBusy] = useState<number | null>(null);

    /* DECIDED BEFORE THE FETCH, not after it. The server refuses a
       pharmacy, so asking anyway would be a 403 on every visit from a
       counter -- noise in the log for an answer we already know, and a
       failed request whose error state races the refusal rendered below.
       Computed from the membership rather than the loaded data for the
       same reason: the data is what we are deciding not to ask for. */
    const mayRead = project?.role === 'admin' || project?.role === 'lead';

    const load = useCallback(async () => {
        if (!mayRead) return;
        setMsg(null);
        try {
            setData(await api<Replies>(
                `/api/projects/${code}/uh/patient-replies${showAll ? '?all=1' : ''}`,
            ));
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not load the replies.');
        }
    }, [code, showAll, mayRead]);
    useEffect(() => { void load(); }, [load]);

    if (!project) return <Loading />;
    const clock = clockFor(timezone);

    /* A COURIER IS NOT SENT AWAY BY THE ROUTER HERE, because the server is
       the one that decides and a redirect would have to duplicate its rule.
       What they get is this sentence. */
    if (!mayRead) {
        return (
            <div className="izy-card">
                <h1>Patient replies</h1>
                <p className="izy-muted">
                    Only dispatch reads these. They are what a patient wrote back about their
                    own delivery, so they are not shown at a pharmacy counter.
                </p>
            </div>
        );
    }

    const toggle = async (reply: Reply) => {
        setBusy(reply.id);
        try {
            await api(`/api/projects/${code}/uh/patient-replies/${reply.id}/handled`, {
                method: 'POST', json: { handled: !reply.handled },
            });
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not update that reply.');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div>
            <header className="izy-row-between">
                <h1>Patient replies</h1>
                <Link className="izy-btn secondary" to={`/projects/${code}/board`}>Back to the board</Link>
            </header>

            {msg !== null && <div className="izy-alert error" role="alert">{msg}</div>}
            {data === null ? <Loading /> : (
                <>
                    <p className="izy-muted">
                        {data.outstanding === 0
                            ? 'Nothing is waiting.'
                            : `${data.outstanding} waiting.`}
                        {' '}
                        {/* SAID OUT LOUD, because our messages do not ask for a
                            reply and somebody reading this page for the first
                            time will reasonably wonder where these came from. */}
                        These are texts patients sent us in answer to a delivery notice.
                    </p>

                    <p className="izy-rownote" role="status">
                        <span>
                            {showAll ? 'Showing everything, handled included.' : 'Showing what is still outstanding.'}
                        </span>
                        <button
                            className="izy-btn secondary"
                            type="button"
                            onClick={() => { setShowAll(!showAll); }}
                        >
                            {showAll ? 'Show only what is waiting' : 'Show the handled ones too'}
                        </button>
                    </p>

                    {data.truncated && (
                        <p className="izy-alert warn" role="status">
                            More than this page can show. Deal with some and reload.
                        </p>
                    )}

                    {data.replies.length === 0 ? (
                        <p className="izy-muted">
                            {showAll ? 'No patient has replied yet.' : 'Nothing outstanding.'}
                        </p>
                    ) : data.replies.map((r) => (
                        <article
                            key={r.id}
                            className={`izy-card izy-reply${r.handled ? ' is-handled' : ''}`}
                        >
                            <p className="izy-sort-when">
                                {r.kind === 'stop' && <><span className="izy-pill warn">opted out</span>{' '}</>}
                                {r.kind === 'start' && <><span className="izy-pill">opted back in</span>{' '}</>}
                                <span className="izy-muted">{clock(r.receivedAt)}</span>
                                {' · '}
                                {/* The number, because ringing back is the
                                    commonest thing done from this page. */}
                                <a href={`tel:${r.phone}`}>{pretty(r.phone)}</a>
                            </p>

                            {/* THE WORDS THEMSELVES, LARGEST. */}
                            <blockquote className="izy-reply-body">{r.body}</blockquote>

                            {r.order === null ? (
                                /* NOT AN ERROR AND NOT HIDDEN. We could not match
                                   the number to anything we sent, which is the
                                   reply most likely to need somebody to ring. */
                                <p className="izy-muted">
                                    No delivery matches this number. Nothing we have texted went to it.
                                </p>
                            ) : (
                                <dl className="izy-sort-facts">
                                    <div><dt>Patient</dt><dd>{r.order.patient}</dd></div>
                                    <div><dt>Delivery</dt>
                                        <dd>
                                            <Link to={`/projects/${code}/orders/${r.order.id}`}>
                                                #{r.order.id}
                                            </Link>
                                            {r.order.reference !== '' && <> · {r.order.reference}</>}
                                        </dd>
                                    </div>
                                    <div><dt>Pharmacy</dt><dd>{r.order.pharmacy}</dd></div>
                                    <div><dt>Date</dt><dd>{r.order.serviceDate}</dd></div>
                                    <div><dt>State</dt><dd>{r.order.status}</dd></div>
                                </dl>
                            )}

                            <p className="izy-row-between">
                                <span className="izy-muted">
                                    {r.handled
                                        ? `Done by ${r.handledBy || 'somebody'}${r.handledAt ? ` · ${clock(r.handledAt)}` : ''}`
                                        : ''}
                                </span>
                                <button
                                    className={r.handled ? 'izy-btn secondary' : 'izy-btn'}
                                    type="button"
                                    disabled={busy === r.id}
                                    onClick={() => { void toggle(r); }}
                                >
                                    {/* REVERSIBLE, and the button says so rather
                                        than greying out: somebody presses Done on
                                        the wrong row and the alternative is a
                                        patient's message that looks dealt with
                                        for ever. */}
                                    {r.handled ? 'Not done after all' : 'Mark done'}
                                </button>
                            </p>
                        </article>
                    ))}
                </>
            )}
        </div>
    );
}
