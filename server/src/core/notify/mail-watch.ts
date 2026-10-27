/* Telling somebody that the thing which tells people has stopped.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT RAN DEAD FOR TWENTY-FIVE HOURS AND NOTHING SAID SO.
 *
 * SES answered 403 AccessDeniedException to every send for a day. The
 * credentials were refused, so no password reset code reached anybody and
 * no pharmacy was told about a delivery. /health reported it accurately the
 * whole time -- and /health is a URL somebody has to think to open. What
 * actually found it was the owner trying a reset and noticing no email.
 *
 * That is the shape of the failure this file exists for. Email going down
 * is quiet by construction: there is no error on anybody's screen, because
 * the person who would have seen one is the person who never got the
 * message. The courier waits for a code. The pharmacist assumes the
 * delivery has not happened yet. Nobody is confused enough to ring.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CHANNEL HAS TO BE ONE THAT STILL WORKS.
 *
 * An email saying email is broken is a joke with a long delivery time. So
 * this writes an in-app notification: a row in the database that the board
 * renders, which needs nothing of SES at all. Whoever runs the board sees
 * it next time they look at the screen they are already looking at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONCE A DAY WHILE IT IS BROKEN, AND THAT IS DELIBERATE.
 *
 * Not once ever: a mailer that is still dead tomorrow is still news
 * tomorrow, and a single notification scrolled past on Tuesday does not
 * help on Wednesday. Not once per sweep either -- that is three hundred
 * rows before lunch and a board nobody can read.
 *
 * The body names the day and the fault, so the key is the body itself and
 * there is no second table to keep in step. A different fault on the same
 * day is a different sentence and says itself: 403 becoming 400 means
 * somebody fixed the credentials and met the sandbox, which is progress
 * worth hearing about.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT SHOUT ABOUT.
 *
 * A mailer that is switched off. `available` false is a configuration
 * somebody chose, reported by /health as "off", and alarming about it every
 * day would train people to ignore this.
 *
 * A single refusal. One failed send is a blip -- a timeout, a momentary
 * throttle -- and the sweep retries. It takes a run of them, because the
 * thing worth waking somebody for is a mailer that is not working rather
 * than a message that did not go.
 *
 * A run of failures that has gone quiet. If nothing has been attempted for
 * a while the count is history, not a fault: the same reasoning that made
 * /health stop describing a cleared-away queue in the present tense.
 */

import type { Client } from '@libsql/client';
import type { MailAttempts } from './ses';
import { notifyAll, dispatchersOf } from './outbox';

/** Consecutive refusals before anybody is told.
 *
 *  Five rather than one: a single failure is a blip and the sweep retries.
 *  Five rather than fifty: the sweep takes twenty-five per batch, so a
 *  whole failing batch is already five times this and the alarm should not
 *  wait for a second one. */
export const FAILURES_BEFORE_ALARM = 5;

/** How recently something must have been tried for the run to count as now.
 *  Ten minutes is five sweeps. See the header. */
export const STALE_AFTER_MINUTES = 10;

export interface MailWatchResult {
    told: number;
    /** Why nothing happened, when nothing did. */
    skipped?: 'off' | 'working' | 'tooFew' | 'stale' | 'alreadySaid' | 'nobodyToTell';
}

/**
 * Look once, and tell whoever runs the board if email has stopped.
 *
 * Never throws: it runs on the same timer as everything else.
 */
export async function sweepMailWatch(deps: {
    client: Client;
    projectId: number;
    attempts: MailAttempts;
    available: boolean;
    now?: Date;
}): Promise<MailWatchResult> {
    const { client, projectId, attempts, available } = deps;
    const now = deps.now ?? new Date();

    try {
        /* Switched off is a decision, not a fault. */
        if (!available) return { told: 0, skipped: 'off' };
        if (attempts.failing === 0) return { told: 0, skipped: 'working' };
        if (attempts.failing < FAILURES_BEFORE_ALARM) return { told: 0, skipped: 'tooFew' };

        /* A run of refusals nobody has added to lately is history. Without
           this, clearing away the queue that was failing would leave the
           alarm firing daily over a mailer nobody is asking to send
           anything -- which is exactly the bug /health had. */
        if (attempts.lastAttemptAt === null) return { told: 0, skipped: 'stale' };
        const minutesSince = Math.round((now.getTime() - Date.parse(attempts.lastAttemptAt)) / 60000);
        if (minutesSince >= STALE_AFTER_MINUTES) return { told: 0, skipped: 'stale' };

        const day = now.toISOString().slice(0, 10);
        const fault = attempts.lastError ?? 'reason not recorded';
        /* The day AND the fault are in the body, which is what makes the
           body its own key. A fault that changes is a different sentence
           and says itself: 403 becoming 400 means the credentials were
           fixed and the sandbox was met, and somebody should hear that. */
        const body = `Email is not going out. SES has refused ${attempts.failing} sends in a row `
            + `(${fault}) as of ${day}. Password reset codes and delivery notices are not reaching anybody. `
            + `Nothing is lost: the queue retries once it is fixed.`;

        const said = await client.execute({
            sql: "SELECT 1 FROM notifications WHERE project_id = ? AND kind = 'mail.failing' AND body = ? LIMIT 1",
            args: [projectId, body],
        });
        if (said.rows.length > 0) return { told: 0, skipped: 'alreadySaid' };

        const dispatchers = await dispatchersOf(client, projectId);
        if (dispatchers.length === 0) return { told: 0, skipped: 'nobodyToTell' };

        const written = await notifyAll(client, dispatchers, { projectId, kind: 'mail.failing', body });
        return { told: written > 0 ? 1 : 0 };
    } catch {
        /* A watch that can crash the timer takes the sweep down with it. */
        return { told: 0 };
    }
}
