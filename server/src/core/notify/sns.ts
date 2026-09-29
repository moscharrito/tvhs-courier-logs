/* Proving an SNS message actually came from AWS.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL.
 *
 * The endpoint that receives bounce notifications has to be public: SNS posts
 * to it from the internet with no credential we control. So the payload
 * arrives from an unauthenticated stranger, and acting on it means adding
 * addresses to a suppression list.
 *
 * An unverified webhook here is not a small hole. Anyone who found the URL
 * could post a fabricated bounce for a named pharmacist and silently stop a
 * hospital being told about their deliveries, and nothing in the application
 * would look wrong afterwards. The failure would be invisible on both sides.
 *
 * So every message is checked against Amazon's signature before anything is
 * read out of it, and the check fails closed.
 *
 * THREE THINGS ARE VERIFIED, and all three are necessary:
 *
 *   1. The signature, over a canonical string built from the message fields
 *      in a fixed order, against the public key in the certificate.
 *   2. That the certificate is served from an AWS SNS host over https. This
 *      is the one people forget, and without it the whole scheme is theatre:
 *      an attacker signs a message with their own key and points
 *      SigningCertURL at their own server.
 *   3. That the topic is OUR topic. A valid signature only proves the message
 *      came from SNS, not that it came from a topic we own: anybody with an
 *      AWS account can create one and point it here.
 *
 * SignatureVersion 1 is SHA1 and 2 is SHA256. Both are accepted because AWS
 * still sends 1 in some regions; the security of the scheme rests on the key
 * and the certificate host, not on the digest.
 */

import crypto from 'node:crypto';

export type SnsType = 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation';

export interface SnsEnvelope {
    Type: SnsType;
    MessageId: string;
    TopicArn: string;
    Message: string;
    Timestamp: string;
    SignatureVersion: string;
    Signature: string;
    SigningCertURL?: string;
    /** Older field name; AWS has sent both. */
    SigningCertUrl?: string;
    Subject?: string;
    Token?: string;
    SubscribeURL?: string;
}

/** The fields that are signed, in order, per message type. AWS specifies
 *  exactly these and exactly this order; anything else produces a string that
 *  does not match and the message is rejected. */
const SIGNED_FIELDS: Record<SnsType, readonly string[]> = {
    Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
    SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
    UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

/** key\nvalue\n for each present field, in the order above. */
export function stringToSign(msg: SnsEnvelope): string {
    const fields = SIGNED_FIELDS[msg.Type];
    let out = '';
    for (const field of fields) {
        const value = (msg as unknown as Record<string, string | undefined>)[field];
        /* Absent fields are SKIPPED, not sent as empty. Subject is optional
           and including it as "" when it was absent produces a different
           string and a failed verification on every notification without a
           subject, which is most of them. */
        if (value === undefined || value === null) continue;
        out += `${field}\n${value}\n`;
    }
    return out;
}

/**
 * Whether the certificate URL is one AWS would actually serve.
 *
 * THE LOAD-BEARING CHECK. Without it an attacker signs anything with their
 * own key and points this at their own host, and every other check passes.
 * https only, and a hostname that is exactly an SNS endpoint under
 * amazonaws.com rather than merely containing it: `sns.evil-amazonaws.com`
 * and `amazonaws.com.evil.net` both contain the string.
 */
export function isTrustedCertUrl(raw: string | undefined): boolean {
    if (!raw) return false;
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    if (url.protocol !== 'https:') return false;
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return false;
    return url.pathname.endsWith('.pem');
}

export interface VerifyDeps {
    /** Fetches the signing certificate. Injected so tests never touch AWS. */
    fetchCert: (url: string) => Promise<string>;
    /** The topic we expect. A valid signature does not prove ownership. */
    expectedTopicArn: string;
}

export class SnsVerificationError extends Error {}

/**
 * Verify one message. Throws on anything suspicious; never returns false.
 *
 * Throwing rather than returning a boolean is deliberate: a caller that
 * forgets to check a boolean has an open webhook, and a caller that forgets
 * to catch an exception has a 500. One of those fails safe.
 */
export async function verifySns(msg: SnsEnvelope, deps: VerifyDeps): Promise<void> {
    if (!SIGNED_FIELDS[msg.Type]) {
        throw new SnsVerificationError(`Unknown SNS message type: ${String(msg.Type)}`);
    }
    if (msg.TopicArn !== deps.expectedTopicArn) {
        /* A valid signature proves it came from SNS, not from OUR topic.
           Anybody with an AWS account can make one and point it here. */
        throw new SnsVerificationError('Message is for a different SNS topic');
    }

    const certUrl = msg.SigningCertURL ?? msg.SigningCertUrl;
    if (!isTrustedCertUrl(certUrl)) {
        throw new SnsVerificationError('Signing certificate is not served from an AWS SNS host over https');
    }

    const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    let pem: string;
    try {
        pem = await deps.fetchCert(certUrl as string);
    } catch (err) {
        throw new SnsVerificationError(`Could not fetch the signing certificate: ${String(err)}`);
    }

    let ok = false;
    try {
        const verifier = crypto.createVerify(algorithm);
        verifier.update(stringToSign(msg), 'utf8');
        ok = verifier.verify(pem, msg.Signature, 'base64');
    } catch (err) {
        throw new SnsVerificationError(`Signature could not be checked: ${String(err)}`);
    }
    if (!ok) throw new SnsVerificationError('Signature does not match');
}

/* ------------------------------------------------------------ the payload */

export interface BouncedAddress {
    address: string;
    reason: 'bounce' | 'complaint';
    detail: string;
}

/**
 * The addresses to stop sending to, out of an SES notification.
 *
 * ONLY PERMANENT BOUNCES. A full mailbox or a server having a bad afternoon
 * is a Transient bounce, and suppressing on one would permanently silence a
 * pharmacist over a fault that fixed itself. Undetermined is also left alone:
 * it means AWS could not tell, and "could not tell" is not grounds for
 * cutting somebody off from their own delivery notifications.
 */
export function addressesToSuppress(message: unknown): BouncedAddress[] {
    if (typeof message !== 'object' || message === null) return [];
    const m = message as Record<string, unknown>;
    const out: BouncedAddress[] = [];

    const type = String(m['notificationType'] ?? m['eventType'] ?? '');

    if (type === 'Bounce') {
        const bounce = (m['bounce'] ?? {}) as Record<string, unknown>;
        if (String(bounce['bounceType']) !== 'Permanent') return [];
        const subType = String(bounce['bounceSubType'] ?? '');
        for (const r of (bounce['bouncedRecipients'] as Array<Record<string, unknown>> | undefined) ?? []) {
            const address = String(r['emailAddress'] ?? '').trim().toLowerCase();
            if (address) out.push({ address, reason: 'bounce', detail: `Permanent/${subType}` });
        }
    } else if (type === 'Complaint') {
        const complaint = (m['complaint'] ?? {}) as Record<string, unknown>;
        const feedback = String(complaint['complaintFeedbackType'] ?? '');
        for (const r of (complaint['complainedRecipients'] as Array<Record<string, unknown>> | undefined) ?? []) {
            const address = String(r['emailAddress'] ?? '').trim().toLowerCase();
            if (address) out.push({ address, reason: 'complaint', detail: feedback || 'complaint' });
        }
    }
    return out;
}
