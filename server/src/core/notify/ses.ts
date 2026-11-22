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

/**
 * What SES has actually done with this process's sends.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS COUNTED AT ALL, WHICH IS A FAULT THAT HID FOR A DAY.
 *
 * `available` means the five configuration values are present. It is the
 * same weak fact `files: "configured"` used to be, and it failed the same
 * way: production ran for a day with a mailer reporting configured while
 * SES answered 403 to every single send. /health said
 *
 *     mail: "configured, nothing sent yet"
 *
 * because outbox.ts counts notification ROWS that finished, a refused send
 * leaves its row pending rather than finished, and a password reset is not
 * a notification row at all. So the one field anybody could check could not
 * distinguish a dead mailer from a quiet Sunday.
 *
 * Counted HERE, in the mailer, rather than from the rows, because this is
 * the only place every send passes through: the notification sweep, the
 * daily report, and the password reset codes that were the actual casualty.
 *
 * Per process and lost on restart, which is honest -- after a boot the true
 * answer is "nothing attempted yet", and that is what it says.
 */
export interface MailAttempts {
    /** Sends this process has put to SES since boot. */
    attempted: number;
    /** Consecutive refusals ending now. Back to zero as soon as one works. */
    failing: number;
    /** The last refusal. Status and AWS error type only, never a recipient
     *  and never a hostname -- it is reported on a public endpoint. */
    lastError: string | null;
    /** What SES SAID, with every address taken out of it.
     *
     *  ── WHY THE TYPE ALONE WAS NOT ENOUGH, AGAIN.
     *
     *  The same lesson as the 403s one field up, learned a second time and
     *  more expensively. `400 MessageRejected` is at least three faults:
     *  an unverified SENDER identity, the sandbox refusing an unverified
     *  RECIPIENT, and a custom MAIL FROM domain whose MX record is missing
     *  while the account is set to reject on MX failure. They need three
     *  different fixes -- verify an identity, request production access,
     *  add one DNS record -- and the type names none of them.
     *
     *  Production spent days at "REFUSING EVERY SEND: 400 MessageRejected"
     *  with the sentence that says which one thrown away on every single
     *  attempt, nine and a half thousand times. The only copy anywhere was
     *  in an audit row for a password reset, reachable by signing in and
     *  running a script, which is not where somebody reading /health is.
     *
     *  SAFE TO KEEP, BECAUSE OF WHAT IS TAKEN OUT. See `redact` below: every
     *  address is removed before this is stored, and the one that was there
     *  is reported as `the sender` or `a recipient` -- which is the part
     *  that decides the fix, and is exactly the part that is not personal.
     *  SES's error sentences are a fixed published set describing the
     *  REQUEST; they never quote the message body. */
    lastDetail: string | null;
    /** When this process last PUT something to SES, failed or not.
     *
     *  WITHOUT THIS THE COUNT ABOVE IS A LIE BY OMISSION. `failing` only
     *  returns to zero when a send succeeds, so once the queue that was
     *  failing is cleared away nothing is attempted at all and the number
     *  freezes -- and /health goes on announcing "REFUSING EVERY SEND: 25
     *  in a row" over a mailer that is not being asked to send anything.
     *  It happened: a queue of doomed notifications was closed, the figure
     *  did not move, and the obvious reading was that the clearing had not
     *  worked.
     *
     *  A refusal that is minutes old is a fault. The same refusal hours
     *  old with nothing tried since is history, and saying them the same
     *  way is how a field stops being believed. */
    lastAttemptAt: string | null;
}

export interface Mailer {
    readonly available: boolean;
    readonly reason: string | null;
    /** Resolves when SES accepted it. Throws otherwise; the caller decides. */
    send(mail: Mail, at?: Date): Promise<void>;
    /** For /health. A function because it changes after boot. */
    attempts(): MailAttempts;
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

/* Anything shaped like an email address, which is the only personal thing
   an SES error sentence can contain. Deliberately greedy about what counts
   as one: a near-miss left in a public field is worse than a sentence with
   a hole in it. */
const ADDRESS = /[^\s<>@,;:"()[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Space to tilde: printable ASCII, written as a range so it reads as one. */
const UNPRINTABLE = /[^ -~]/g;

/** For comparing one address to another. Not for displaying either. */
const normalise = (address: string): string => address.trim().toLowerCase().replace(/^<|>$/g, '');

/**
 * SES's sentence, with every address replaced by what it WAS to us.
 *
 * The substitution is the useful part, not a side effect of hiding things.
 * "Email address is not verified. The following identities failed the check
 * in region US-EAST-2: <the sender>" and the same sentence ending in
 * "<a recipient>" are two different faults with two different fixes, and
 * telling them apart is the entire reason this field exists.
 *
 * Printable ASCII only and capped: this goes on an unauthenticated endpoint,
 * and an upstream that one day returns something other than a short English
 * sentence must not be able to turn /health into its megaphone.
 */
export function redact(message: string, from: string): string {
    const sender = normalise(from);
    const said = message.replace(ADDRESS, (found) => (
        normalise(found) === sender && sender !== '' ? '<the sender>' : '<a recipient>'
    ));
    const clean = said.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
    return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
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
    /* Nothing is attempted, so nothing is failing. /health reports this
       mailer as "off" from `available` and never reads these. */
    attempts: () => ({
        attempted: 0, failing: 0, lastError: null, lastDetail: null, lastAttemptAt: null,
    }),
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

    /* See MailAttempts. Closure state rather than a field so nothing outside
       can set it, and so `attempts()` cannot be stale. */
    let attempted = 0;
    let failing = 0;
    let lastError: string | null = null;
    let lastDetail: string | null = null;
    let lastAttemptAt: string | null = null;

    return {
        available: true,
        reason: null,
        attempts: () => ({ attempted, failing, lastError, lastDetail, lastAttemptAt }),

        async send(mail: Mail, at = new Date()): Promise<void> {
            /* Before anything else, and before the body is even serialised.
               DELIBERATELY NOT COUNTED as a send attempt: this throws before
               anything reaches AWS, and it is a bug in a template rather
               than a fact about the mailer. Counting it would have /health
               announce that SES is refusing us when SES has not been asked. */
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

            attempted += 1;
            lastAttemptAt = new Date().toISOString();

            let res;
            try {
                res = await fetch(`https://${host}${path}`, {
                    method: 'POST',
                    headers: { ...signRequest(cfg, host, path, body, at), host },
                    body,
                });
            } catch (err) {
                /* DNS, a timeout, a dropped connection. Recorded as a fixed
                   string rather than the error's own words, because those
                   name the SES endpoint -- and a hostname is on the list at
                   the top of core/http/health.ts of things that never appear
                   on a public endpoint. The real message still goes to the
                   caller and the log. */
                failing += 1;
                lastError = 'could not reach SES';
                /* No response, so there is no sentence. Clearing it stops
                   the last one standing over a different fault. */
                lastDetail = null;
                throw err;
            }

            if (!res.ok) {
                /* The response text can name the recipient, which is an
                   address and not patient data, but it has no business in a
                   log line either. Status and the AWS error type only.

                   THE HEADER IS READ FIRST, AND THAT IS NOT A DETAIL. SES v2
                   is REST-JSON: it puts the error name in x-amzn-errortype
                   and only sometimes repeats it in the body as __type. The
                   first version of this read the body alone, so a real 403
                   in production surfaced as the bare words "SES refused the
                   message: 403" -- and 403 is three completely different
                   faults with three different fixes:

                     UnrecognizedClientException  the access key does not
                                                  exist (or not in SES)
                     SignatureDoesNotMatch        the secret is wrong, or
                                                  this signer has a bug
                     AccessDeniedException        the key is fine and its
                                                  IAM policy has no
                                                  ses:SendEmail

                   Telling them apart from the status alone is impossible,
                   which left the one person who could fix it guessing. An
                   AWS error type is a fixed string from a published list: it
                   names no recipient and carries no patient data, so the
                   rule above is satisfied by keeping it. */
                let type = res.headers.get('x-amzn-errortype') ?? '';
                /* The header can arrive as "AccessDeniedException:http://..." */
                type = type.split(':')[0]!.trim();

                /* ── AND THE SENTENCE, WHICH IS THE PART THAT NAMES THE FIX.
                 *
                 * READ ONCE, AS TEXT. The body was previously read only
                 * when the header was missing, and with res.json(), which
                 * consumes the stream -- so there was no second chance at
                 * it afterwards. It is taken as text here and parsed from
                 * that, which leaves both the type and the message
                 * available however SES chose to answer.
                 *
                 * `message` is the human sentence; `Message` is the same
                 * field in the older query-protocol shape, and SES still
                 * answers with it from some endpoints. */
                let message = '';
                try {
                    const body = await res.text();
                    if (body !== '') {
                        const parsed = JSON.parse(body) as {
                            __type?: string; message?: string; Message?: string;
                        };
                        if (type === '') type = (parsed.__type ?? '').split(':')[0]!.trim();
                        message = parsed.message ?? parsed.Message ?? '';
                    }
                } catch { /* not JSON, or already consumed; the type is enough */ }

                failing += 1;
                lastError = `${res.status}${type ? ` ${type}` : ''}`;
                /* Addresses out, the fix left in. See redact(). */
                lastDetail = message === '' ? null : redact(message, cfg.from);
                throw new Error(`SES refused the message: ${lastError}`);
            }

            /* One success clears it. A mailer that sent something a moment
               ago is not broken, whatever it did before. */
            failing = 0;
            lastError = null;
            lastDetail = null;
        },
    };
}
