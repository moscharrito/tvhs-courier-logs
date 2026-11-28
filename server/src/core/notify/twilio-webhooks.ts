/* What Twilio tells us after a text has left: did it arrive, and did they reply.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY BOTH OF THESE WERE MISSING UNTIL 27 NOVEMBER 2026, AND WHAT IT COST.
 *
 * `patient_messages.sent_at` has always been set the moment Twilio's API
 * accepted a message, which is Twilio agreeing to TRY. Whether it reached a
 * handset is decided seconds later and reported to a status callback -- and
 * there was no callback, so the answer was never collected. 112 messages went
 * to real patients under that column. A disconnected number, a landline that
 * cannot receive SMS, and a text read at a kitchen table are all the same row.
 *
 * And people reply to texts. Our wording does not invite it -- the "reply
 * STOP" line was removed deliberately because Twilio enforces STOP at their
 * end -- but "not home till 6" and "wrong address" get sent anyway. With no
 * inbound URL configured, Twilio answered those with its default empty
 * response and discarded them. A patient told us something about their
 * delivery and the system threw it away.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PUBLIC BY NECESSITY, WHICH IS WHY THE SIGNATURE IS CHECKED FIRST.
 *
 * Twilio posts with no session and from no network we control, so these two
 * routes are reachable by anybody. Both write:
 *
 *   the status route marks delivery outcomes, which is the evidence a
 *   delivery dispute turns on;
 *
 *   the inbound route records an OPT-OUT, so anybody who could post to it
 *   could silence texting to any number they chose with one forged STOP,
 *   and the silence would read as the patient's own decision for ever.
 *
 * So verifyTwilioSignature runs before the body is read for meaning, and a
 * request that fails it touches no table. See twilio-signature.ts for why
 * the URL it checks against is configuration and not req.host.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THEY ALWAYS ANSWER 200, EVEN FOR THINGS THEY DID NOTHING WITH.
 *
 * Twilio retries a webhook that errors or times out, with backoff, for
 * hours. A 500 on an unknown message sid would turn one unrecognised
 * callback into a retry storm, and a 404 on a replayed inbound would do the
 * same. The only non-200 here is the forged-signature 403, which is the one
 * case where we want them to stop.
 *
 * NO PHI IN A LOG LINE. Every log below counts rows or names a sid. Not the
 * number, never the body: a patient's own words about their delivery can
 * contain anything they chose to put in them.
 */

import express, { Router, type Request, type Response } from 'express';
import type { Client } from '@libsql/client';
import type { Logger } from '../http/logger';
import { SIGNATURE_HEADER, verifyTwilioSignature } from './twilio-signature';

/** Where Twilio reports what became of a message we sent. */
export const STATUS_PATH = '/api/webhooks/twilio/status';
/** Where Twilio delivers a reply from a patient. */
export const INBOUND_PATH = '/api/webhooks/twilio/inbound';

export interface TwilioWebhookDeps {
    client: Client;
    logger: Logger;
    /** The account auth token, which is also the signing key. */
    authToken: string | undefined;
    /** Origin Twilio posts to, no trailing slash. Undefined disables both. */
    publicBaseUrl: string | undefined;
    /** Overridable so a test does not have to wait for a real clock. */
    now?: () => Date;
}

/**
 * The carrier keywords. Twilio acts on these itself and tells us after the
 * fact; recording them is how an opt-out survives in OUR data rather than
 * being rediscovered by being refused once per order, for ever.
 *
 * The list is Twilio's published set, matched exactly after trimming and
 * upper-casing. Not a substring match, which would read "please stop
 * sending it to the back door" as an opt-out.
 */
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE']);
/** Their counterpart, which undoes it. */
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

/** Ten digits, the way every other phone in this system is stored. */
function digitsOf(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** Form bodies arrive as strings or not at all; everything else is a lie. */
function formOf(body: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
            if (typeof v === 'string') out[k] = v;
        }
    }
    return out;
}

export function createTwilioWebhookRouter(deps: TwilioWebhookDeps): Router {
    const { client, logger, authToken, publicBaseUrl } = deps;
    const now = deps.now ?? (() => new Date());
    const router = Router();

    /* Twilio posts application/x-www-form-urlencoded. The global parser in
       server.js is express.json() with default options, which leaves this
       content type alone -- so req.body would be empty, the signature would
       be computed over no parameters, and every callback would be refused as
       forged. Scoped to these two paths rather than widening the global
       parser, the same way the SES webhook scopes its own. */
    router.use([STATUS_PATH, INBOUND_PATH], express.urlencoded({ extended: false, limit: '64kb' }));

    /**
     * Gate both routes.
     *
     * Returns the verified parameters, or null having already answered. A
     * caller that forgets the null check gets a type error rather than an
     * unverified body, which is the point of returning the params here
     * instead of a boolean.
     */
    function verified(req: Request, res: Response, path: string): Record<string, string> | null {
        if (!publicBaseUrl || !authToken) {
            /* NOT CONFIGURED IS NOT THE SAME AS FORGED, and it is worth the
               separate line: this is the state every deploy was in before
               today, and somebody reading a log after pasting the URL into
               the Twilio console needs to see which of the two they have. */
            logger.warn('twilio webhook: refused, not configured', { path });
            res.status(503).type('text/plain').send('not configured');
            return null;
        }
        const params = formOf(req.body);
        const signature = req.header(SIGNATURE_HEADER) ?? undefined;
        if (!verifyTwilioSignature({ url: `${publicBaseUrl}${path}`, params, signature, authToken })) {
            logger.warn('twilio webhook: bad signature, refused', { path, hadSignature: Boolean(signature) });
            res.status(403).type('text/plain').send('bad signature');
            return null;
        }
        return params;
    }

    /* ───────────────────────────────────────────── what became of it */

    router.post(STATUS_PATH, (req, res) => {
        void (async () => {
            const form = verified(req, res, STATUS_PATH);
            if (!form) return;

            const sid = form['MessageSid'] ?? form['SmsSid'] ?? '';
            const status = form['MessageStatus'] ?? form['SmsStatus'] ?? '';
            const errorCode = form['ErrorCode'] ?? '';

            /* An empty sid is a malformed callback rather than an attack --
               the signature already passed -- so it is answered and dropped. */
            if (sid === '' || status === '') { res.type('text/plain').send('ok'); return; }

            try {
                /* `delivered_at` only on the terminal good state. Twilio
                   sends `sent` first and `delivered` after, and writing a
                   timestamp on both would mean the column recorded whichever
                   callback arrived last -- including `undelivered`, which
                   would stamp a delivery time on a message that failed. */
                const deliveredAt = status === 'delivered' ? now().toISOString() : null;
                const rs = await client.execute({
                    sql: `UPDATE patient_messages
                             SET provider_status = ?,
                                 provider_error = ?,
                                 delivered_at = COALESCE(?, delivered_at)
                           WHERE provider_id = ? AND provider_id != ''`,
                    args: [status, errorCode, deliveredAt, sid],
                });
                /* Nought rows is ordinary and not an error: a callback for a
                   message this database never wrote, or one swept away by
                   retention. Logged at info with the sid only, because the
                   alternative -- silence -- makes "the receipts are not
                   landing" unanswerable. */
                if (rs.rowsAffected === 0) {
                    logger.info('twilio status: no matching message', { sid, status });
                }
            } catch (err) {
                /* Answered 200 anyway. A retry would hit the same error and
                   Twilio would keep trying for hours; the row is already
                   lost and a storm does not recover it. */
                logger.error('twilio status: could not record', { sid, err: String(err) });
            }
            res.type('text/plain').send('ok');
        })();
    });

    /* ───────────────────────────────────────────── and what they said */

    router.post(INBOUND_PATH, (req, res) => {
        void (async () => {
            const form = verified(req, res, INBOUND_PATH);
            if (!form) return;

            /* EMPTY TwiML, ALWAYS. Returning a <Message> here would send an
               auto-reply, which costs a segment per inbound and -- for STOP
               -- would be a message to somebody who has just asked us to
               stop messaging them. Twilio sends its own STOP confirmation at
               their end, which is the compliant one. */
            const done = () => res.type('text/xml').send('<Response></Response>');

            const sid = form['MessageSid'] ?? form['SmsSid'] ?? '';
            const from = digitsOf(form['From'] ?? '');
            const body = form['Body'] ?? '';
            if (sid === '' || from === '') { done(); return; }

            const word = body.trim().toUpperCase();
            const kind = STOP_WORDS.has(word) ? 'stop' : START_WORDS.has(word) ? 'start' : 'message';
            const at = now().toISOString();

            try {
                if (kind === 'stop') {
                    /* Permanent and keyed on the number, not the order: a
                       person who says STOP has said it to us, not to one
                       delivery. INSERT OR IGNORE because the unique index is
                       what makes a second STOP a no-op rather than a crash. */
                    await client.execute({
                        sql: `INSERT OR IGNORE INTO patient_optouts (phone, reason, created_at)
                              VALUES (?, 'replied_stop', ?)`,
                        args: [from, at],
                    });
                } else if (kind === 'start') {
                    /* The only thing that removes one. Twilio has already
                       re-enabled their end by the time this arrives, so a
                       row left here would be us refusing somebody who has
                       explicitly asked to be texted again. */
                    await client.execute({
                        sql: 'DELETE FROM patient_optouts WHERE phone = ?',
                        args: [from],
                    });
                }

                /* WHICH DELIVERY IT IS ABOUT, WHERE THAT IS UNAMBIGUOUS.
                   The most recent message we sent this number, which is the
                   one they are replying to. Left null rather than guessed
                   when there is none: a reply filed against the wrong
                   delivery is worse than one filed against none, and the
                   dispatcher sees it either way. */
                const match = await client.execute({
                    sql: `SELECT order_id, project_id FROM patient_messages
                           WHERE phone = ? ORDER BY id DESC LIMIT 1`,
                    args: [from],
                });
                const row = match.rows[0];

                await client.execute({
                    sql: `INSERT OR IGNORE INTO patient_replies
                            (provider_id, phone, body, order_id, project_id, kind, received_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    args: [
                        sid, from, body,
                        row ? Number(row['order_id']) : null,
                        row ? Number(row['project_id']) : null,
                        kind, at,
                    ],
                });
                logger.info('twilio inbound: recorded', { sid, kind, matched: Boolean(row) });
            } catch (err) {
                logger.error('twilio inbound: could not record', { sid, err: String(err) });
            }
            done();
        })();
    });

    return router;
}
