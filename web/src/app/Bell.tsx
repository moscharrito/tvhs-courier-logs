/* The bell, and the feed behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO TABS, BECAUSE THE ASK WAS TWO DIFFERENT THINGS.
 *
 * "Notify us whenever there is new activity -- when the pharmacy uploads
 * their daily list, when a driver arrives, when one completes an order."
 * Those are not the same kind of fact, and building them as one thing is
 * what makes notification systems useless:
 *
 *   FOR YOU is addressed to you and you clear it. A STAT nobody claimed, a
 *   driver who never came on shift, a list waiting in the drop box. A
 *   handful a day. It has an unread count, it goes to the operating system
 *   if you let it, and emptying it means something.
 *
 *   ACTIVITY is the operation, running. Five hundred to fifteen hundred
 *   arrivals and as many completions. No count, no unread, nothing to
 *   clear, nothing written to the database -- it is the board's own live
 *   feed, which has existed since the board did, moved somewhere you can
 *   see it without standing on the board. See modules/uh/activity.ts.
 *
 * Putting arrivals in the first list would give a dispatcher an unread count
 * of nine hundred, which is the same information as no count at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FEED IS ONLY FETCHED WHILE THE PANEL IS OPEN, which is the whole
 * reason it can be a feed. Nobody is billed for a tab nobody opened, and a
 * person with the panel open is, by definition, looking at it.
 *
 * NOT EVERYBODY HAS IT. The feed is a window onto nine counters and every
 * courier; a pharmacy sees their own deliveries in their own portal and a
 * courier has their own run. The server refuses them (403) and the tab is
 * not drawn rather than drawn and broken.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLive, agoLabel } from './useLive';
import { useNotices, hrefFor, type Notice } from './useNotices';
import { askForDesktop, desktopState, type DesktopState } from '../lib/desktop';
import { BellIcon } from './Icons';

interface ActivityRow {
    id: string;
    at: string;
    what: 'picked_up' | 'arrived' | 'delivered' | 'attempted' | 'returned' | 'note' | 'list_dropped';
    pharmacy: string;
    orderId: number | null;
    reference: string;
    who: string;
    by: string;
}

/** The verb, in the past tense, for somebody scanning a column of them. */
const DID: Record<ActivityRow['what'], string> = {
    picked_up: 'collected',
    arrived: 'arrived at',
    delivered: 'delivered',
    attempted: 'could not deliver',
    returned: 'returned',
    note: 'noted something on',
    list_dropped: 'sent a list',
};

/** "14:32", in the reader's own clock. A feed is read in the minute it
 *  happened; a full date on every line is noise. */
function clock(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "just now", "6m", "2h", "Tue". Short: it sits at the end of a line. */
function since(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.round((Date.now() - then) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    if (mins < 24 * 60) return `${Math.round(mins / 60)}h`;
    return new Date(iso).toLocaleDateString([], { weekday: 'short' });
}

export function Bell() {
    const { notices, unread, loading, failing, markRead, markAllRead, refresh } = useNotices();
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<'you' | 'activity'>('you');
    const wrap = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);

    /* Escape closes it and puts the focus back on the button, rather than
       dropping it on the document where the next Tab starts from the top of
       the page. Outside-click closes it because a popover that does not is
       a modal nobody agreed to. */
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setOpen(false); button.current?.focus(); }
        };
        const onDown = (e: MouseEvent) => {
            if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
        };
    }, [open]);

    /* Looking at the bell is a reason to be current, whatever the poll is
       doing -- the alternative is opening it and reading something up to
       twenty-five seconds old with no way to tell.

       THE REFRESH IS BESIDE THE UPDATER, NOT INSIDE IT, and the first
       version had it inside: `setOpen((was) => { if (!was) refresh(); return
       !was; })`. A state updater must be pure. React invokes it twice under
       StrictMode, so that called refresh() -- which sets state on the
       provider above -- in the middle of computing this component's state,
       and the panel never opened at all. aria-expanded stayed "false"
       through every click.

       It reads fine and it is wrong, which is the combination worth a
       comment. Found in the browser, not by a type or a test. */
    const toggle = () => {
        if (!open) refresh();
        setOpen((was) => !was);
    };

    return (
        <div className="izy-bell" ref={wrap}>
            <button
                type="button"
                ref={button}
                className={`izy-bell-btn${unread > 0 ? ' has-unread' : ''}`}
                onClick={toggle}
                aria-expanded={open}
                aria-haspopup="dialog"
                /* The count is in the accessible name, because the red disc
                   beside the glyph is not text and a screen reader otherwise
                   announces an unlabelled button on every screen. */
                aria-label={unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`}
            >
                <BellIcon size={19} />
                {unread > 0 && (
                    /* 99+ rather than a number that breaks the disc. If
                       somebody is at 99 the exact figure is not the point. */
                    <span className="izy-bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                )}
            </button>

            {open && (
                <div className="izy-bell-panel" role="dialog" aria-label="Notifications">
                    <div className="izy-bell-tabs" role="tablist">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'you'}
                            className={tab === 'you' ? 'active' : ''}
                            onClick={() => setTab('you')}
                        >
                            For you{unread > 0 && <span className="izy-bell-tabn">{unread}</span>}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'activity'}
                            className={tab === 'activity' ? 'active' : ''}
                            onClick={() => setTab('activity')}
                        >
                            Activity
                        </button>
                        {tab === 'you' && unread > 0 && (
                            <button
                                type="button"
                                className="izy-bell-clear"
                                onClick={() => { void markAllRead(); }}
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    {tab === 'you'
                        ? (
                            <ForYou
                                notices={notices}
                                loading={loading}
                                failing={failing}
                                onOpened={(n) => { void markRead([n.id]); setOpen(false); }}
                                onRead={(n) => { void markRead([n.id]); }}
                            />
                        )
                        : <Activity />}

                    <DesktopFooter />
                </div>
            )}
        </div>
    );
}

function ForYou({ notices, loading, failing, onOpened, onRead }: {
    notices: Notice[];
    loading: boolean;
    failing: boolean;
    onOpened: (n: Notice) => void;
    onRead: (n: Notice) => void;
}) {
    const navigate = useNavigate();
    /* More than one contract is the only reason to say which one. For a
       driver or a counter it is the same word on every line. */
    const multi = new Set(notices.map((n) => n.project)).size > 1;

    if (loading && notices.length === 0) return <p className="izy-bell-empty">Looking…</p>;
    if (notices.length === 0) {
        return (
            <p className="izy-bell-empty">
                Nothing for you.
                {failing && <><br /><span className="izy-bell-stale">The last check did not get through.</span></>}
            </p>
        );
    }

    return (
        <>
            {failing && <p className="izy-bell-stale">The last check did not get through. This may be out of date.</p>}
            <ul className="izy-bell-list">
                {notices.map((n) => (
                    <li key={`${n.project}-${n.id}`} className={n.readAt === null ? 'is-unread' : ''}>
                        <button
                            type="button"
                            className="izy-bell-row"
                            onClick={() => { onOpened(n); navigate(hrefFor(n)); }}
                        >
                            <span className="izy-bell-body">{n.body}</span>
                            <span className="izy-bell-meta">
                                {multi && <>{n.projectName} · </>}
                                {since(n.createdAt)}
                                {/* Whether it left the building. Null while no
                                    channel is configured, which is the true
                                    state and worth saying rather than
                                    implying an email that never went. */}
                                {n.pushedAt === null && n.dispatchResult === '' && <> · in the app only</>}
                            </span>
                        </button>
                        {n.readAt === null && (
                            <button
                                type="button"
                                className="izy-bell-tick"
                                onClick={() => onRead(n)}
                                aria-label="Mark as read"
                                title="Mark as read"
                            >
                                ✓
                            </button>
                        )}
                    </li>
                ))}
            </ul>
        </>
    );
}

function Activity() {
    const { code } = useParams<{ code: string }>();
    const [rows, setRows] = useState<ActivityRow[]>([]);
    const [refused, setRefused] = useState(false);
    const [failed, setFailed] = useState(false);
    /* Whether anything has come back yet. Without it the empty state shows
       while the first request is still in flight, and "Nothing in the last
       twelve hours" is a statement about the operation, not about the
       network -- a dispatcher reading it has been told something false. */
    const [answered, setAnswered] = useState(false);

    const load = useCallback(async () => {
        if (!code) return;
        try {
            const got = await api<{ activity: ActivityRow[] }>(`/api/projects/${code}/uh/activity?limit=40`);
            setRows(got.activity);
            setRefused(false);
            setFailed(false);
            setAnswered(true);
        } catch (err) {
            /* A 403 is not a failure, it is an answer: this account does not
               get a feed. Saying "could not load" to somebody who was never
               going to have one sends them to support. */
            if (err instanceof ApiError && err.status === 403) { setRefused(true); setAnswered(true); return; }
            setFailed(true);
            setAnswered(true);
        }
    }, [code]);

    /* Fifteen seconds, matching the board, and only while the panel is open:
       this is unmounted the moment the tab is switched or the panel closed.
       See the header. */
    const live = useLive(load, 15);

    /* AND ONCE, NOW, WHICH useLive DOES NOT DO.

       useLive starts an interval and fetches on nothing but a
       visibilitychange, which is right for the screens it was built for:
       they mount with data already loaded by the page around them and the
       hook only has to keep it fresh.

       This one mounts empty every time the tab is pressed. Without this the
       panel says "Nothing in the last twelve hours" for fifteen seconds and
       then fills -- which is not a slow feed, it is a feed that states the
       opposite of the truth and then corrects itself. Caught in the browser
       with six events in the API response and an empty panel on the screen.

       THROUGH live.refresh RATHER THAN load, so the hook's own clock
       advances with it: calling load() directly left the footer reading
       "Live - not yet loaded" underneath six rows it had just drawn. A
       one-shot ref because refresh is a fresh closure on every render, and
       depending on it would poll in a loop. */
    const started = useRef(false);
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        live.refresh();
    }, [live]);

    if (!code) return <p className="izy-bell-empty">Open a contract to see what is happening on it.</p>;
    if (refused) {
        return (
            <p className="izy-bell-empty">
                The activity feed is for dispatch. Your own deliveries are on your pages.
            </p>
        );
    }
    if (failed && rows.length === 0) return <p className="izy-bell-empty">Could not reach the feed.</p>;
    if (!answered) return <p className="izy-bell-empty">Looking…</p>;
    if (rows.length === 0) return <p className="izy-bell-empty">Nothing in the last twelve hours.</p>;

    return (
        <>
            <ul className="izy-bell-list izy-bell-feed">
                {rows.map((r) => (
                    <li key={r.id}>
                        {r.orderId === null ? (
                            <span className="izy-bell-row as-text">
                                <span className="izy-bell-body">
                                    <b>{r.who || 'Somebody'}</b> {DID[r.what]} for {r.pharmacy}
                                    {r.reference !== '' && <> ({r.reference})</>}
                                </span>
                                <span className="izy-bell-meta">{clock(r.at)}</span>
                            </span>
                        ) : (
                            <Link className="izy-bell-row" to={`/projects/${code}/orders/${r.orderId}`}>
                                <span className="izy-bell-body">
                                    <b>{r.who || 'A driver'}</b> {DID[r.what]} {r.reference || `delivery ${r.orderId}`}
                                    {' · '}{r.pharmacy}
                                    {/* Only when it differs from the courier.
                                        "Cy delivered it" and "Cy's delivery
                                        was closed from a desk" are different
                                        facts; the same name twice is not. */}
                                    {r.by !== '' && <> · recorded by {r.by}</>}
                                </span>
                                <span className="izy-bell-meta">{clock(r.at)}</span>
                            </Link>
                        )}
                    </li>
                ))}
            </ul>
            <p className="izy-bell-foot-note">
                Live · {agoLabel(live.secondsAgo)}. Nothing here is a notification; nothing needs clearing.
            </p>
        </>
    );
}

/** The line that turns the operating system on, and says what it will do. */
function DesktopFooter() {
    const [state, setState] = useState<DesktopState>(() => desktopState());
    const ask = async () => { setState(await askForDesktop()); };

    return (
        <div className="izy-bell-foot">
            {state === 'granted' && (
                <span className="izy-bell-ok">
                    On this computer too. Only the For you list — never the feed.
                </span>
            )}
            {state === 'default' && (
                <button type="button" className="izy-btn secondary small" onClick={() => { void ask(); }}>
                    Also show these on this computer
                </button>
            )}
            {state === 'denied' && (
                /* The button is not offered, because pressing it would do
                   nothing: a refusal cannot be reversed from script. The way
                   back is the browser's own site settings and the sentence
                   has to say so, or somebody presses a dead control twice
                   and concludes the feature is broken. */
                <span className="izy-bell-stale">
                    This browser is blocking notifications for this site. Turn them back on in the
                    padlock menu beside the address bar.
                </span>
            )}
            {state === 'unsupported' && (
                <span className="izy-bell-stale">This browser cannot show desktop notifications.</span>
            )}
            <Link className="izy-bell-settings" to="/notifications">Choose what you hear about</Link>
        </div>
    );
}
