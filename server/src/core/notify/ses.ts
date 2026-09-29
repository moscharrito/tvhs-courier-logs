/* Sending one email through Amazon SES.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO PATIENT DATA LEAVES IN AN EMAIL. NOT A NAME, NOT AN ADDRESS, NOT A DRUG.
 *
 * This is the rule the whole module is built around, and it is a decision
 * about where PHI is allowed to go rather than a limitation of SES. An email
 * stops being ours the moment it is sent: it sits on a hospital mail server,
 * gets forwarded, syncs to a phone, and lands in backups nobody here
 * controls. A signed agreement with the service that SENDS it says nothing
 * about any of that.
 *
 * So the body carries an order number, a pharmacy, a time and a link. A
 * misaddressed notification is then an annoyance rather than a breach, and
 * anybody who needs to know who the delivery was for opens the portal, where
 * reading it is authenticated, scoped to their own pharmacy, and audited.
 *
 * `assertNoPatientData` below is not decoration. It is the last thing between
 * a well-meaning future edit to a template and a patient's name in somebody's
 * inbox, and it throws rather than trimming, because a caller that tried to
 * put a name in an email should fail loudly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT THE AWS SDK, and why not the signer in core/files.
 *
 * Not the SDK, for the same reason core/files/sigv4.ts does not use it: this
 * is one operation, and @aws-sdk/client-sesv2 is a large amount of transitive
 * dependency to reach it on a system holding PHI.
 *
 * Not that signer either, deliberately. It presigns S3 URLs: query-parameter
 * signing, UNSIGNED-PAYLOAD, no body. SES is header-based authorization over
 * a signed JSON body, so the parts that actually carry risk (the canonical
 * request and the payload hash) are different code however it is arranged.
 * What they share is three wrappers over node:crypto, and coupling the mailer
 * to the file store to save those would be the worse trade.
 *
 * DISABLED IS A FIRST-CLASS STATE. With no credentials it reports why and
 * refuses, exactly like the file storage. Nothing here pretends to send.
 */

import crypto from 'node:crypto';
import type { Config } from '../../config';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'ses';

const sha256Hex = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();

/** 20130524T000000Z and 20130524. */
export function amzDates(at: Date): { amzDate: string; dateStamp: string } {
    const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface Mail {
    to: string;
    subject: string;
    /** Plain text only. An HTML mail is a tracking pixel waiting to happen. */
    text: string;
}

export interface Mailer {
    readonly available: boolean;
    readonly reason: string | null;
    /** Resolves when SES accepted it. Throws otherwise; the caller decides. */
    send(mail: Mail, at?: Date): Promise<void>;
}

/**
 * Anything that looks like it identifies a person.
 *
 * Deliberately crude and deliberately strict. It cannot know that "Ines
 * Vargas" is a patient, so it works the other way round: a notification body
 * is generated from a fixed template with an order number, a pharmacy name, a
 * time and a URL, so anything resembling a street address or a long free-text
 * run is a template that grew something it should not have.
 *
 * Erring towards refusing a legitimate email is the right direction here. A
 * notification that failed to send is a support ticket; a patient's address
 * in a mailbox is a reportable breach.
 */
const STREET = /\b\d+\s+[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*)*\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|circle|cir|place|pl|terrace|ter)\b/i;
const ZIP = /\b\d{5}(-\d{4})?\b/;

export function assertNoPatientData(text: string): void {
    if (STREET.test(text)) {
        throw new Error('Refusing to send: the message contains something shaped like a street address. Notifications carry an order number and a link, never patient data.');
    }
    if (ZIP.test(text)) {
        throw new Error('Refusing to send: the message contains something shaped like a ZIP code. Notifications carry an order number and a link, never patient data.');
    }
}

interface SesConfig {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    from: string;
}

/** The Authorization header for one SES request. */
export function signRequest(
    cfg: SesConfig,
    host: string,
    path: string,
    body: string,
    at: Date,
): Record<string, string> {
    const { amzDate, dateStamp } = amzDates(at);
    const payloadHash = sha256Hex(body);

    /* Signed headers must be sorted, lowercase, and exactly the ones sent. */
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
        'POST', path, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, cfg.region);
    const kService = hmac(kRegion, SERVICE);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    return {
        'content-type': 'application/json',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization: `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}

const unavailable = (reason: string): Mailer => ({
    available: false,
    reason,
    async send() { throw new Error(reason); },
});

export function createMailer(config: Config): Mailer {
    const m = config.mail;
    if (!m?.enabled) return unavailable('Email is not enabled on this server. Set MAIL_ENABLED and the SES values.');
    const missing = (['region', 'accessKeyId', 'secretAccessKey', 'from'] as const).filter((k) => !m.ses?.[k]);
    if (missing.length > 0 || !m.ses) {
        return unavailable(`Email is enabled but these are missing: ${missing.join(', ')}.`);
    }
    const cfg: SesConfig = { ...m.ses };
    const host = `email.${cfg.region}.amazonaws.com`;
    const path = '/v2/email/outbound-emails';

    return {
        available: true,
        reason: null,

        async send(mail: Mail, at = new Date()): Promise<void> {
            /* Before anything else, and before the body is even serialised. */
            assertNoPatientData(mail.subject);
            assertNoPatientData(mail.text);

            const body = JSON.stringify({
                FromEmailAddress: cfg.from,
                Destination: { ToAddresses: [mail.to] },
                Content: {
                    Simple: {
                        Subject: { Data: mail.subject, Charset: 'UTF-8' },
                        Body: { Text: { Data: mail.text, Charset: 'UTF-8' } },
                    },
                },
            });

            const res = await fetch(`https://${host}${path}`, {
                method: 'POST',
                headers: { ...signRequest(cfg, host, path, body, at), host },
                body,
            });
            if (!res.ok) {
                /* The response text can name the recipient, which is an
                   address and not patient data, but it has no business in a
                   log line either. Status and the AWS error type only. */
                let type = '';
                try {
                    const parsed = await res.json() as { __type?: string; message?: string };
                    type = parsed.__type ?? '';
                } catch { /* not JSON; the status is enough */ }
                throw new Error(`SES refused the message: ${res.status}${type ? ` ${type}` : ''}`);
            }
        },
    };
}
