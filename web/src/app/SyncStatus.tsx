/* Whether the phone has actually told anyone.
 *
 * A courier who records a delivery in a basement has to be able to tell the
 * difference between "sent" and "on this phone", without thinking about it and
 * without opening a menu. So this sits in the frame on every screen, says
 * nothing at all when there is nothing to say, and becomes loud only when
 * something needs a person.
 *
 * The loud case is a refusal. The server understood and said no, retrying will
 * not help, and the courier is the only one who can say what really happened.
 */

import { useEffect, useState } from 'react';
import {
    subscribe, flush, dismissRejection, type OutboxState,
} from '../lib/outbox';

const ago = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
};

export function SyncStatus() {
    const [state, setState] = useState<OutboxState | null>(null);

    useEffect(() => subscribe(setState), []);

    if (!state) return null;
    const { waiting, sending, online, rejected, oldest } = state;
    if (waiting === 0 && rejected.length === 0 && online) return null;

    return (
        <div className="izy-sync">
            {rejected.length > 0 && (
                <div className="izy-alert error" role="alert">
                    <b>{rejected.length === 1 ? 'One thing could not be recorded' : `${rejected.length} things could not be recorded`}.</b>
                    <ul className="izy-plain-list">
                        {rejected.map((r) => (
                            <li key={r.id}>
                                {r.label}: {r.error}
                                {' '}
                                <button className="izy-btn secondary small" type="button" onClick={() => { void dismissRejection(r.id); }}>
                                    Got it
                                </button>
                            </li>
                        ))}
                    </ul>
                    Tell dispatch what happened at these stops.
                </div>
            )}

            {waiting > 0 && (
                <div className={`izy-alert ${online ? 'warn' : 'muted'}`} role="status">
                    {sending
                        ? `Sending ${waiting} ${waiting === 1 ? 'thing' : 'things'}.`
                        : `${waiting} ${waiting === 1 ? 'thing is' : 'things are'} saved on this phone and not sent yet`}
                    {oldest !== null && !sending && <> ({ago(oldest)})</>}
                    {!online && <>. No signal right now.</>}
                    {online && !sending && (
                        <>
                            {' '}
                            <button className="izy-btn secondary small" type="button" onClick={() => { void flush(); }}>
                                Try now
                            </button>
                        </>
                    )}
                </div>
            )}

            {waiting === 0 && !online && rejected.length === 0 && (
                <div className="izy-alert muted" role="status">
                    No signal. Everything you have done so far is sent.
                </div>
            )}
        </div>
    );
}
