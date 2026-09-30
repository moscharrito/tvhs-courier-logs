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

import type { Client } from '@libsql/client';
import type { Logger } from '../../core/http/logger';
import { assertMinimal, toE164, type Texter } from '../../core/notify/twilio';
import { renderTemplate, windowText, type Stage } from '../../core/notify/sms-template';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../core/projects/settings';

/** The whole message. Read it as a stranger would, on a lock screen.
 *
 *  THE WORDING IS A SETTING NOW (`patientSms.morningTemplate`), because
 *  University Health asked to edit it and it is their patients reading it.
 *  This is what a project that has never been configured sends, and it is
 *  what the settings default to, so the two cannot drift apart. */
export const DELIVERY_TODAY = noticeFor(DEFAULT_PROJECT_SETTINGS, 'delivery_today');

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
export function noticeFor(settings: ProjectSettings, stage: Stage, at?: { when: Date; timezone: string }): string {
    const s = settings.patientSms;
    const body = renderTemplate(s.stages[stage].template, {
        company: s.company,
        window: windowText(s.windowStart, s.windowEnd),
        callMinutes: String(s.callMinutes),
        time: at ? clockIn(at.when, at.timezone) : '',
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
    const stage = opts.settings.patientSms.stages[opts.stage];
    if (!stage?.enabled) return false;
    try {
        const rs = await client.execute({
            sql: 'SELECT recipient_phone FROM orders WHERE project_id = ? AND id = ?',
            args: [opts.projectId, opts.orderId],
        });
        const phone = String(rs.rows[0]?.['recipient_phone'] ?? '').trim();
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
           "delivered" for the same order is one delivery. */
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
}

/**
 * Write a morning notice for every delivery going out today. Never throws.
 *
 * Idempotent by the unique index rather than by checking first: two ticks
 * racing would both pass a check and only one can pass the constraint.
 */
export async function queueMorningNotices(
    client: Client,
    opts: { projectId: number; serviceDate: string; now: Date; settings?: ProjectSettings },
): Promise<QueueResult> {
    const result: QueueResult = { queued: 0, noPhone: 0 };
    /* The body is stored on the row, so a wording change affects what is sent
       next and never what somebody has already been told. */
    const body = opts.settings ? noticeFor(opts.settings, 'delivery_today') : DELIVERY_TODAY;
    /* Off means no row is written at all, so nothing can be sent by accident
       later by a sweep that does not re-read the setting. */
    if (opts.settings && !opts.settings.patientSms.stages.delivery_today.enabled) return result;
    try {
        const rs = await client.execute({
            sql: `SELECT o.id, o.recipient_phone FROM orders o
                  WHERE o.project_id = ? AND o.service_date = ?
                    AND o.status NOT IN ('cancelled', 'delivered', 'failed')`,
            args: [opts.projectId, opts.serviceDate],
        });

        for (const row of rs.rows) {
            const phone = String(row['recipient_phone'] ?? '').trim();
            if (phone === '') { result.noPhone += 1; continue; }
            try {
                await client.execute({
                    sql: `INSERT INTO patient_messages
                            (project_id, order_id, phone, kind, body, created_at)
                          VALUES (?, ?, ?, 'delivery_today', ?, ?)`,
                    args: [opts.projectId, Number(row['id']), phone, body, opts.now.toISOString()],
                });
                result.queued += 1;
            } catch {
                /* The unique index. Already queued for this order, which is
                   the correct outcome and not worth a log line per order per
                   tick. */
            }
        }
    } catch {
        /* A delivery that happens is not undone by a text that was not
           queued. Same rule as every other notification path here. */
    }
    return result;
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
 * Send what is waiting. Never throws.
 *
 * An opt-out is recorded permanently the first time Twilio reports one,
 * rather than being rediscovered once per order forever.
 */
export async function sendQueued(
    client: Client, texter: Texter, logger: Logger,
): Promise<SendResult> {
    const result: SendResult = { considered: 0, sent: 0, failed: 0, optedOut: 0 };
    if (!texter.available) return result;

    let rows;
    try {
        const rs = await client.execute({
            sql: `SELECT m.id, m.phone, m.body FROM patient_messages m
                  LEFT JOIN patient_optouts o ON o.phone = m.phone
                  WHERE m.sent_at IS NULL AND o.id IS NULL
                  ORDER BY m.id LIMIT ?`,
            args: [BATCH],
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
