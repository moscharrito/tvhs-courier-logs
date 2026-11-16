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

    /* NOTHING IS SAID WHILE IT IS GOING THROUGH.
     *
     * This used to announce "Sending 2 things." in a yellow banner at the
     * top of every screen for as long as the outbox was busy. Yellow is the
     * colour this app uses for something a person has to deal with, and
     * sending is not: it is the queue doing its job, unaided, in under a
     * second on a signal and by itself later without one.
     *
     * What it actually did was tell a driver who had just recorded a stop
     * that something was unfinished, at the exact moment the stop screen was
     * also telling them it was saved. Two messages, one reassuring and one
     * alarming, about the same event. Removed 16 November on instruction.
     *
     * The banner still appears for the two cases that do need a person: work
     * that is sitting here and NOT moving, and work the server refused. */
    const stalled = waiting > 0 && !sending;
    if (!stalled && rejected.length === 0 && online) return null;

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

            {stalled && (
                <div className={`izy-alert ${online ? 'warn' : 'muted'}`} role="status">
                    {`${waiting} ${waiting === 1 ? 'thing is' : 'things are'} saved on this phone and not sent yet`}
                    {oldest !== null && <> ({ago(oldest)})</>}
                    {!online && <>. No signal right now.</>}
                    {online && (
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
