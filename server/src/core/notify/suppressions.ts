/* Addresses we must not send to, and the webhook that learns about them.
 *
 *   POST /api/webhooks/ses    SNS delivers bounces and complaints here
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ENDPOINT IS PUBLIC AND THE PAYLOAD IS A STRANGER.
 *
 * SNS posts from the internet with no credential of ours, so nothing in the
 * body may be believed until core/notify/sns.ts has checked Amazon's
 * signature, the certificate host and the topic. Only then is a single field
 * read out of it. See that file for why all three checks are load-bearing.
 *
 * WHY SUPPRESS AT ALL. Continuing to send to an address that hard bounced, or
 * to somebody who marked us as spam, is how a sending domain's reputation is
 * destroyed. The damage is not confined to that address: it degrades delivery
 * for every pharmacist on the contract, including the ones waiting to hear
 * that a STAT arrived.
 *
 * IT NEVER ANSWERS 500 TO SNS. A 5xx makes SNS retry the same message for
 * hours, so a bug here would turn into a retry storm against our own server.
 * Anything unexpected is logged and answered 200: the message is dropped
 * rather than redelivered forever, and the log is where somebody finds out.
 * A REJECTED SIGNATURE IS THE EXCEPTION and answers 403, because that is not
 * our bug to swallow and it should be visible from the outside as a refusal.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import type { Logger } from '../http/logger';
import {
    addressesToSuppress, verifySns, SnsVerificationError,
    type SnsEnvelope, type BouncedAddress,
} from './sns';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Lowercased once, here, so every caller compares the same way. */
export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

/** Every suppressed address. Small by nature: a closed list of named staff. */
export async function suppressedAddresses(client: Client): Promise<Set<string>> {
    try {
        const rs = await client.execute('SELECT address FROM mail_suppressions');
        return new Set(rs.rows.map((r) => String(r['address'])));
    } catch {
        /* Fail OPEN, deliberately, and this is the one place in this file
           where that is right. If the table cannot be read we do not know
           that an address is suppressed, and the choice is between sending a
           message somebody may not want and silently not telling a hospital
           their STAT arrived. The second is worse. */
        return new Set();
    }
}

/** Record one. Idempotent: the same bounce arriving twice is one row. */
export async function suppress(client: Client, entry: BouncedAddress): Promise<void> {
    await client.execute({
        sql: `INSERT INTO mail_suppressions (address, reason, detail, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET reason = excluded.reason, detail = excluded.detail`,
        args: [normalizeAddress(entry.address), entry.reason, entry.detail, new Date().toISOString()],
    });
}

export interface WebhookDeps {
    client: Client;
    logger: Logger;
    /** The topic we accept. Absent means the webhook refuses everything. */
    topicArn: string | undefined;
    /** Injected so tests never reach AWS. */
    fetchCert?: ((url: string) => Promise<string>) | undefined;
    /** Injected so a test can assert a confirmation was followed. */
    confirmSubscription?: ((url: string) => Promise<void>) | undefined;
}

const fetchCertOverHttps = async (url: string): Promise<string> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`certificate fetch returned ${res.status}`);
    return res.text();
};

export function createSesWebhookRouter(deps: WebhookDeps): Router {
    const router = Router();
    const fetchCert = deps.fetchCert ?? fetchCertOverHttps;
    const confirm = deps.confirmSubscription ?? (async (url: string) => { await fetch(url); });

    router.post('/api/webhooks/ses', wrap(async (req, res) => {
        const { client, logger, topicArn } = deps;

        if (!topicArn) {
            /* Nothing configured means nothing is trusted. Refusing is the
               only safe answer: with no expected topic, the ownership check
               in verifySns cannot be made at all. */
            res.status(503).json({ error: 'No SES notification topic is configured on this server.' });
            return;
        }

        const msg = req.body as SnsEnvelope;
        if (typeof msg !== 'object' || msg === null || typeof msg.Type !== 'string') {
            res.status(400).json({ error: 'Not an SNS message' });
            return;
        }

        try {
            await verifySns(msg, { fetchCert, expectedTopicArn: topicArn });
        } catch (err) {
            /* 403 and not 200: this is not our bug to swallow, and a refusal
               should be visible from the outside. Logged with the topic and
               the reason, never with the body. */
            logger.warn('notify.sns.rejected', {
                reason: err instanceof SnsVerificationError ? err.message : String(err),
                type: String(msg.Type), topic: String(msg.TopicArn ?? ''),
            });
            res.status(403).json({ error: 'Signature verification failed' });
            return;
        }

        try {
            if (msg.Type === 'SubscriptionConfirmation') {
                /* Confirmed only now, AFTER the signature and the topic have
                   been checked. Fetching SubscribeURL is what completes the
                   subscription, so doing it before verification would let a
                   stranger wire their own topic to this endpoint. */
                if (msg.SubscribeURL) await confirm(msg.SubscribeURL);
                logger.info('notify.sns.subscribed', { topic: msg.TopicArn });
                res.status(200).json({ ok: true });
                return;
            }

            if (msg.Type === 'Notification') {
                let payload: unknown = null;
                try { payload = JSON.parse(msg.Message); } catch { payload = null; }
                const entries = addressesToSuppress(payload);
                for (const entry of entries) await suppress(client, entry);
                if (entries.length > 0) {
                    /* The address is the subject of the record and belongs in
                       the log; it is a staff mailbox at the client, not a
                       patient. Nothing else from the payload is logged. */
                    logger.warn('notify.suppressed', {
                        count: entries.length,
                        reason: entries[0]?.reason ?? '',
                        addresses: entries.map((e) => e.address),
                    });
                }
                res.status(200).json({ ok: true, suppressed: entries.length });
                return;
            }

            res.status(200).json({ ok: true, ignored: msg.Type });
        } catch (err) {
            /* 200 on purpose. A 5xx makes SNS retry for hours, and a bug here
               would become a retry storm against our own server. The message
               is dropped and the log is where somebody finds out. */
            logger.error('notify.sns.failed', { error: String(err), type: String(msg.Type) });
            res.status(200).json({ ok: false });
        }
    }));

    return router;
}
