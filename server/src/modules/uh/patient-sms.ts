/* Telling a patient a delivery is coming today.
 *
 * University Health, 29 September 2026: "Text patients in the morning that
 * package will be delivered that day."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MESSAGE IS DELIBERATELY ALMOST EMPTY.
 *
 * It says a courier has a delivery and how to stop receiving these. It does
 * not name the pharmacy, the medication, a prescription, an order, or us as
 * anything other than a delivery company. A text is read on a lock screen by
 * whoever is holding the phone, and the difference between "a courier is
 * coming" and "your pharmacy is sending your prescription" is the difference
 * between a delivery notice and telling somebody's flatmate they are ill.
 *
 * core/notify/twilio.ts refuses to send anything containing the obvious
 * words. That is a backstop, not a substitute for writing this carefully.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WRITTEN FIRST, SENT AFTERWARDS, exactly like the pharmacy email.
 *
 * The row is inserted with sent_at null and the sweep sends it. That makes a
 * Twilio outage a delay rather than a silence, and it means the unique index
 * on (order_id, kind) is what stops a two-minute scheduler texting somebody
 * all morning. Relying on the sender to remember would be relying on the
 * sender to remember.
 *
 * ONLY ORDERS THAT ARE ACTUALLY GOING OUT. Cancelled work is not announced,
 * and neither is anything already delivered: a text at 8am about a parcel
 * that arrived at 7.40 is worse than no text.
 *
 * ONLY IN THE MORNING, and only once. `morningWindow` is the judgement here:
 * before 7am nobody wants it, after noon it is not a morning notice and the
 * courier is probably outside.
 */

import type { Client, InValue } from '@libsql/client';
import type { Logger } from '../../core/http/logger';
import { assertMinimal, toE164, type Texter } from '../../core/notify/twilio';
import { renderTemplate, windowText, type Stage } from '../../core/notify/sms-template';
import { DEFAULT_PROJECT_SETTINGS, resolveSettings, type ProjectSettings } from '../../core/projects/settings';

/** The whole message. Read it as a stranger would, on a lock screen.
 *
 *  THE WORDING IS A SETTING NOW (`patientSms.morningTemplate`), because
 *  University Health asked to edit it and it is their patients reading it.
 *  This is what a project that has never been configured sends, and it is
 *  what the settings default to, so the two cannot drift apart. */
export const DELIVERY_TODAY = noticeFor(
    DEFAULT_PROJECT_SETTINGS,
    'delivery_today',
    undefined,
    /* ── A SAMPLE, AND SINCE 22 NOVEMBER 2026 THAT IS ALL IT IS.
     *
     * This used to be rendered with nothing filled in, which was fine while
     * the wording had no per-delivery words in it. It has two now, so an
     * unfilled render reads "arriving by .  will call about 20 min before"
     * -- a sentence nobody should ever see, and which assertMinimal below
     * would happily pass because there is nothing disclosing about it.
     *
     * So it is rendered with representative values and used ONLY as the
     * import-time check on the wording: if somebody edits the default into
     * something that names a pharmacy, the server refuses to start instead
     * of texting it to eight hundred people. It is no longer a fallback
     * body, because a sender without settings cannot know whether the
     * project is paused and must send nothing at all. */
    { driver: 'Alex', by: '2:00 PM' },
);

/* A sanity check that runs at import rather than at send: if somebody edits
   the default wording into something that names a pharmacy, the server
   refuses to start instead of texting it to eight hundred people. An edited
   template is checked by the same rule when it is saved. */
assertMinimal(DELIVERY_TODAY);

/**
 * The message this project sends at one stage, with its own wording.
 *
 * Rendered per queue run rather than per row: every order in a morning gets
 * the same sentence, and rendering it once means a settings change midway
 * through a sweep cannot produce two different promises on the same day.
 *
 * `at` is only needed by stages whose wording can mention a time.
 */
export function noticeFor(
    settings: ProjectSettings,
    stage: Stage,
    at?: { when: Date; timezone: string },
    /* ── PER ORDER, WHICH THE REST OF THIS IS NOT.
     *
     * The note above says this is rendered once per queue run so that a
     * settings change midway cannot produce two different promises on the
     * same day. That still holds and is still the reason: what is read once
     * is the TEMPLATE. These two vary per delivery by their nature -- a
     * round has one driver and each stop its own deadline -- so they arrive
     * as arguments rather than being read from anywhere.
     *
     * Both are optional and both render empty when absent, because every
     * other stage uses this function and none of them has a driver or a
     * deadline to talk about. */
    per?: { driver?: string; by?: string },
): string {
    const s = settings.patientSms;
    const body = renderTemplate(s.stages[stage].template, {
        company: s.company,
        window: windowText(s.windowStart, s.windowEnd),
        callMinutes: String(s.callMinutes),
        time: at ? clockIn(at.when, at.timezone) : '',
        driver: per?.driver ?? '',
        by: per?.by ?? '',
    });
    /* Checked again here, not only on save. A row stored before this
       validation existed, or edited around the endpoint, must still not go
       out; the sender treats a throw as "the text is wrong" and stops. */
    assertMinimal(body);
    return body;
}

/** A time as a patient would read it, in the project's own zone. */
function clockIn(when: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(when);
}

/**
 * Write the text for one custody event, if that stage is switched on.
 *
 * Never throws, for the same reason nothing else on this path does: a
 * delivery that happened is not undone by a text that was not queued.
 *
 * Called from recordOrderEvent, which is the single place every status change
 * passes through. Hooking the routes instead would mean a seventh route added
 * later silently tells nobody, which is exactly how the pharmacy notification
 * nearly went wrong.
 */
export async function queueStageNotice(
    client: Client,
    opts: { projectId: number; orderId: number; stage: Stage; settings: ProjectSettings; timezone: string; now: Date },
): Promise<boolean> {
    if (opts.settings.patientSms.paused) return false;
    const stage = opts.settings.patientSms.stages[opts.stage];
    if (!stage?.enabled) return false;
    try {
        const rs = await client.execute({
            sql: 'SELECT recipient_phone, delivery_kind FROM orders WHERE project_id = ? AND id = ?',
            args: [opts.projectId, opts.orderId],
        });
        const row = rs.rows[0];
        /* Same rule as the morning notice, and checked here too rather than
           trusted from there: these are two separate paths to the same table
           and only one of them used to exist. */
        if (String(row?.['delivery_kind'] ?? 'patient') !== 'patient') return false;
        const phone = String(row?.['recipient_phone'] ?? '').trim();
        if (phone === '') return false;

        const body = noticeFor(opts.settings, opts.stage, { when: opts.now, timezone: opts.timezone });
        await client.execute({
            sql: `INSERT INTO patient_messages (project_id, order_id, phone, kind, body, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [opts.projectId, opts.orderId, phone, opts.stage, body, opts.now.toISOString()],
        });
        return true;
    } catch {
        /* The unique index on (order_id, kind), or anything else. A second
           "delivered" for the same order is one delivery.

           THIS CATCH HID A REAL BUG ONCE. The kind column had a CHECK
           constraint listing only 'delivery_today', so every stage added
           afterwards was refused by the table, swallowed here, and reported
           as "nothing written" -- which is indistinguishable from the stage
           being switched off. Migration 0040 widened it, and a test compares
           the constraint against the stage list so the two cannot drift
           again. The catch stays broad: a delivery that happened must not be
           undone by a text that was not queued. */
        return false;
    }
}

/** Local hours during which a morning notice is a morning notice. */
export const MORNING_FROM = 7;
export const MORNING_UNTIL = 12;

export function inMorningWindow(now: Date, timezone: string): boolean {
    const hour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', hour12: false,
    }).format(now));
    return hour >= MORNING_FROM && hour < MORNING_UNTIL;
}

export interface QueueResult {
    /** Rows written. Anything already queued is silently not written again. */
    queued: number;
    /** Orders with no phone number on them. Counted, because it is the
     *  pharmacy's data quality and somebody should be able to see it. */
    noPhone: number;
    /** Assigned to a username this project has no name for, so the text
     *  would have had a hole where the driver goes. */
    noDriver: number;
    /** No due_at, so there is no honest "arriving by" to quote. */
    noDeadline: number;
}

/**
 * Write a morning notice for every delivery going out today. Never throws.
 *
 * Idempotent by the unique index rather than by checking first: two ticks
 * racing would both pass a check and only one can pass the constraint.
 */
/**
 * Tell the patients on a round that it is coming, now that it exists.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRIGGERED BY THE ROUND, NOT BY THE CLOCK. Changed 22 November 2026.
 *
 * The old trigger was a sweep between 7am and noon. It had two faults and
 * only one of them was visible. A list released after noon got no notice at
 * all, silently -- nothing on any screen said a word about it. And at 7am
 * nothing is known about a delivery except that it exists, so the sentence
 * could promise no more than "today, 9am-5pm".
 *
 * Clustering is the moment both of those are fixed: the order has a driver
 * and its place in somebody's day is settled, so the text can name the
 * driver and quote the deadline.
 *
 * ONLY ORDERS WITH A COURIER. That is what makes the message truthful, and
 * it is also the one way this can go quiet: a delivery assigned by hand
 * rather than through the clusterer never passes this way. The morning
 * sweep is kept for exactly that reason -- see the scheduler -- and it now
 * queues the same per-order sentence rather than a vaguer one, so the two
 * paths cannot produce different promises for the same day.
 *
 * `orderIds` narrows it to a round that has just been built. Without it the
 * whole day is considered, which is what the sweep wants.
 */
export async function queueRoundNotices(
    client: Client,
    opts: {
        projectId: number;
        /** Omit when `orderIds` already says which deliveries are meant. The
         *  sweep needs it; the assignment hook has one order and no day. */
        serviceDate?: string;
        now: Date;
        timezone: string;
        settings: ProjectSettings;
        orderIds?: number[];
    },
): Promise<QueueResult> {
    const result: QueueResult = { queued: 0, noPhone: 0, noDriver: 0, noDeadline: 0 };
    /* NO SETTINGS MEANS NO MESSAGE. A caller that cannot supply them cannot
       have checked whether this project is paused, and "send the built-in
       default" is the wrong answer to that: the pause is the only thing
       standing between a half-configured project and eight hundred texts. */
    if (!opts.settings) return result;
    if (opts.settings.patientSms.paused) return result;
    if (!opts.settings.patientSms.stages.delivery_today.enabled) return result;
    if (opts.orderIds !== undefined && opts.orderIds.length === 0) return result;
    /* One or the other, or there is no question being asked: without either
       this would consider every order the project has ever held. */
    if (opts.serviceDate === undefined && opts.orderIds === undefined) return result;

    try {
        const day = opts.serviceDate === undefined ? '' : 'AND o.service_date = ?';
        const narrow = opts.orderIds === undefined
            ? ''
            : `AND o.id IN (${opts.orderIds.map(() => '?').join(',')})`;
        const args: InValue[] = [opts.projectId];
        if (opts.serviceDate !== undefined) args.push(opts.serviceDate);
        if (opts.orderIds !== undefined) args.push(...opts.orderIds);
        const rs = await client.execute({
            /* The same exclusions as every other path here: a facility is a
               goods-in desk with no patient behind it, and a settled order
               is not coming. The courier join is what is new -- a name on
               the message is the point of moving the trigger. */
            sql: `SELECT o.id, o.recipient_phone, o.due_at, o.assigned_to_username
                    FROM orders o
                   WHERE o.project_id = ?
                     ${day}
                     AND o.delivery_kind = 'patient'
                     AND o.assigned_to_username IS NOT NULL
                     AND o.status NOT IN ('cancelled', 'delivered', 'failed')
                     ${narrow}`,
            args,
        });

        /* Every driver on these rows once, rather than a lookup per patient:
           a round is one driver and a day is a handful of them. */
        const usernames = [...new Set(rs.rows
            .map((r) => String(r['assigned_to_username'] ?? ''))
            .filter((u) => u !== ''))];
        const firstNames = await driverFirstNames(client, opts.projectId, usernames);

        for (const row of rs.rows) {
            const phone = String(row['recipient_phone'] ?? '').trim();
            if (phone === '') { result.noPhone += 1; continue; }

            const due = String(row['due_at'] ?? '');
            const driver = firstNames.get(String(row['assigned_to_username'] ?? '')) ?? '';
            /* NO DRIVER NAME AND NO DEADLINE MEANS NO MESSAGE, rather than a
               message with a hole where a name should be. "  will call about
               20 min before" is worse than silence, and a deadline this
               cannot read would render "arriving by ." to a patient.

               COUNTED SEPARATELY SINCE 23 NOVEMBER 2026, and that is most of
               what this commit is. These were two bare `continue`s. An order
               meeting every other condition produced no text, no row, no log
               line and no number -- so "I assigned it and nothing arrived"
               had no answer anywhere in the system, which is how the first
               live test of this feature ended. The skip is still the right
               behaviour; being unable to see it was not. */
            if (driver === '') { result.noDriver += 1; continue; }
            if (due === '') { result.noDeadline += 1; continue; }

            const body = noticeFor(opts.settings, 'delivery_today', undefined, {
                driver,
                by: clockIn(new Date(due), opts.timezone),
            });
            try {
                await client.execute({
                    sql: `INSERT INTO patient_messages
                            (project_id, order_id, phone, kind, body, created_at)
                          VALUES (?, ?, ?, 'delivery_today', ?, ?)`,
                    args: [opts.projectId, Number(row['id']), phone, body, opts.now.toISOString()],
                });
                result.queued += 1;
            } catch {
                /* The unique index: already told. Re-clustering a list must
                   not text the same patient a second time, and this is what
                   makes that true rather than a rule somebody remembers. */
            }
        }
    } catch {
        /* A round that was built is not unbuilt by a text that was not
           queued. Same rule as every other notification path here. */
    }
    return result;
}

/** First names for a handful of drivers, from the users table.
 *
 *  FIRST NAME ONLY. A patient needs to know who is knocking, not a courier's
 *  surname -- the same line the client portal draws, for the same reason. An
 *  account with no name on it returns nothing and the caller sends no text
 *  rather than a nameless one. */
async function driverFirstNames(
    client: Client, projectId: number, usernames: string[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (usernames.length === 0) return out;
    const rs = await client.execute({
        sql: `SELECT u.username, u.name FROM users u
                JOIN memberships m ON m.user_id = u.id AND m.project_id = ?
               WHERE u.username IN (${usernames.map(() => '?').join(',')})`,
        args: [projectId, ...usernames],
    });
    for (const r of rs.rows) {
        const first = String(r['name'] ?? '').trim().split(/\s+/)[0] ?? '';
        if (first !== '') out.set(String(r['username']), first);
    }
    return out;
}

export interface SendResult {
    considered: number;
    sent: number;
    failed: number;
    /** Numbers that have told us to stop. Marked done, never retried. */
    optedOut: number;
}

/** Enough to clear a morning, few enough not to look like a burst. */
export const BATCH = 50;

/**
 * ONE SENTENCE FOR /health SAYING WHETHER PATIENT TEXTING IS HAPPENING.
 *
 * The parallel of recentMailState in notify/outbox.ts, written for the same
 * reason and after the same kind of afternoon. /health said `sms:
 * "configured"` -- which means the three Twilio values are present and
 * nothing more -- while the first real test of this feature sent nothing at
 * all, and no field, log line or screen anywhere said why.
 *
 * THE PAUSE IS FIRST BECAUSE IT OUTRANKS EVERYTHING BELOW IT. It defaults to
 * TRUE, it lives in the database rather than the repository, and a deploy
 * never moves it. A paused project queues nothing and sends nothing, so
 * every count below reads zero and looks like a quiet day. That is the
 * auto-assign lesson in settings-check.ps1 pointed the other way: there a
 * switch was believed off for three days while it was on.
 *
 * NO PHONE NUMBER AND NO MESSAGE BODY, here or anywhere near this endpoint.
 * The counts are of rows; the rows are addressed to patients.
 */
export async function recentSmsState(client: Client): Promise<string> {
    const paused: string[] = [];
    const live: string[] = [];
    try {
        const rs = await client.execute('SELECT code, settings FROM projects ORDER BY id');
        for (const r of rs.rows) {
            let stored: Record<string, unknown> = {};
            try {
                stored = JSON.parse(String(r['settings'] ?? '{}')) as Record<string, unknown>;
            } catch { stored = {}; }
            const code = String(r['code']);
            if (resolveSettings(stored).patientSms.paused) paused.push(code); else live.push(code);
        }
    } catch {
        /* Said rather than thrown: a health check that 500s because one extra
           query was slow is worse than one that says less. */
        return 'configured, but the projects could not be read';
    }

    let waiting = 0; let sent = 0; let failed = 0;
    let lastFailure = '';
    try {
        const rs = await client.execute(
            `SELECT
                 SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END) AS waiting,
                 SUM(CASE WHEN sent_at IS NOT NULL AND failed_reason = '' THEN 1 ELSE 0 END) AS sent,
                 SUM(CASE WHEN failed_reason != '' THEN 1 ELSE 0 END) AS failed
               FROM patient_messages`,
        );
        const row = rs.rows[0];
        waiting = Number(row?.['waiting'] ?? 0);
        sent = Number(row?.['sent'] ?? 0);
        failed = Number(row?.['failed'] ?? 0);
        if (failed > 0) {
            /* The reason this process recorded, not the patient's number and
               not the body. failed_reason is written by fail() below from
               Twilio's own message or from assertMinimal, and both describe
               the fault rather than the recipient. Truncated because an
               unauthenticated endpoint is no place for an essay. */
            const last = await client.execute(
                `SELECT failed_reason FROM patient_messages
                  WHERE failed_reason != '' ORDER BY id DESC LIMIT 1`,
            );
            lastFailure = String(last.rows[0]?.['failed_reason'] ?? '').slice(0, 120);
        }
    } catch {
        return 'configured, but the queue could not be read';
    }

    const counts = `${sent} sent, ${waiting} waiting`
        + (failed > 0 ? `, ${failed} failed` : '')
        + (lastFailure === '' ? '' : ` -- last failure: ${lastFailure}`);

    /* ONE PAUSED PROJECT MUST NOT SPEAK FOR THE OTHERS, which the first
       draft of this got wrong. TVHS does not text patients and never will,
       so a line that leads with "PAUSED for tvhs" would read as an outage
       every day of the year and would hide the only project the question is
       ever about. A pause leads the sentence only when EVERY project has
       one -- which is the state that actually means no text can be sent by
       anybody -- and is otherwise a parenthesis. */
    const aside = paused.length === 0 ? '' : ` (paused for ${paused.join(', ')})`;
    if (live.length === 0) {
        return `PAUSED for every project -- nothing is queued and nothing will send: ${counts}`;
    }
    if (sent === 0 && waiting === 0 && failed === 0) return `configured, nothing queued yet${aside}`;
    if (sent === 0 && waiting > 0) return `configured, NOTHING SENT YET: ${counts}${aside}`;
    return `sending: ${counts}${aside}`;
}

/**
 * Send what is waiting. Never throws.
 *
 * An opt-out is recorded permanently the first time Twilio reports one,
 * rather than being rediscovered once per order forever.
 */
export async function sendQueued(
    client: Client, texter: Texter, logger: Logger, pausedProjectIds: readonly number[] = [],
): Promise<SendResult> {
    const result: SendResult = { considered: 0, sent: 0, failed: 0, optedOut: 0 };
    if (!texter.available) return result;

    let rows;
    try {
        const rs = await client.execute({
            /* A PAUSED PROJECT'S QUEUE IS LEFT WHERE IT IS, not sent and not
               deleted. Pausing is usually temporary: somebody is waiting on
               wording, or on a campaign, and throwing the queue away would
               mean the morning's patients are never told at all once it
               resumes. Skipped here rather than filtered at write time
               because a row may have been queued before the pause. */
            sql: `SELECT m.id, m.phone, m.body FROM patient_messages m
                  LEFT JOIN patient_optouts o ON o.phone = m.phone
                  WHERE m.sent_at IS NULL AND o.id IS NULL
                    ${pausedProjectIds.length > 0 ? `AND m.project_id NOT IN (${pausedProjectIds.map(() => '?').join(',')})` : ''}
                  ORDER BY m.id LIMIT ?`,
            args: [...pausedProjectIds, BATCH],
        });
        rows = rs.rows;
    } catch (err) {
        logger.warn('sms.read_failed', { error: String(err) });
        return result;
    }
    result.considered = rows.length;

    for (const row of rows) {
        const id = Number(row['id']);
        const phone = String(row['phone']);
        let outcome;
        try {
            outcome = await texter.send({ to: toE164(phone), body: String(row['body']) });
        } catch (err) {
            /* assertMinimal threw, which means the message text is wrong
               rather than the network. Retrying would send it again, so this
               is marked failed and left for a person. */
            result.failed += 1;
            await fail(client, id, String(err), logger);
            continue;
        }

        if (outcome.kind === 'sent') {
            result.sent += 1;
            await mark(client, id, outcome.providerId, logger);
        } else if (outcome.kind === 'opted_out') {
            result.optedOut += 1;
            /* Their decision, recorded once. The number, not the order: a
               person who replied STOP said it to us, not to one parcel. */
            try {
                await client.execute({
                    sql: `INSERT INTO patient_optouts (phone, reason, created_at) VALUES (?, 'carrier', ?)
                          ON CONFLICT(phone) DO NOTHING`,
                    args: [phone, new Date().toISOString()],
                });
            } catch { /* already recorded */ }
            await fail(client, id, 'recipient has opted out', logger);
        } else {
            result.failed += 1;
            /* Left unsent so the next tick tries again. The message text is
               never logged: it is addressed to a patient. */
            logger.warn('sms.send_failed', { id, error: outcome.message });
        }
    }

    if (result.sent > 0 || result.failed > 0 || result.optedOut > 0) {
        logger.info('sms.dispatch', { ...result });
    }
    return result;
}

async function mark(client: Client, id: number, providerId: string, logger: Logger): Promise<void> {
    try {
        await client.execute({
            sql: 'UPDATE patient_messages SET sent_at = ?, provider_id = ? WHERE id = ? AND sent_at IS NULL',
            args: [new Date().toISOString(), providerId, id],
        });
    } catch (err) {
        /* The text went. Failing to record it means one duplicate on the next
           tick, which is better than losing the record of a sent message. */
        logger.warn('sms.mark_failed', { id, error: String(err) });
    }
}

/** Stop retrying, and say why. Marks sent_at so the sweep passes over it. */
async function fail(client: Client, id: number, reason: string, logger: Logger): Promise<void> {
    try {
        await client.execute({
            sql: 'UPDATE patient_messages SET sent_at = ?, failed_reason = ? WHERE id = ?',
            args: [new Date().toISOString(), reason.slice(0, 300), id],
        });
    } catch (err) {
        logger.warn('sms.fail_mark_failed', { id, error: String(err) });
    }
}
