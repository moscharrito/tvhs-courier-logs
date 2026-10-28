/* A second way out, for mail SES will not carry yet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO MAILERS.
 *
 * SES is in the sandbox, and the sandbox will only deliver to an address
 * that has itself been verified. That is fine for our own domain and no use
 * at all for the thing password reset exists to do: a courier typing the
 * gmail address on their account and getting a code back. Verifying every
 * recipient is not a plan when the recipients are eighteen drivers and nine
 * pharmacy counters whose addresses change.
 *
 * Production access fixes it properly and is in AWS's queue. Until it lands,
 * reset codes go out through a provider that has no recipient allow-list.
 * This is a bridge with a date on it, not an architecture.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONLY RESET CODES COME THROUGH HERE, and that is deliberate.
 *
 * Delivery notices and the daily summary stay on SES. They are the ones
 * carrying an order number and a pharmacy name, they are the ones with the
 * volume -- about 3,000 on a weekday against this provider's smaller free
 * allowance -- and they are the ones covered by the agreement already in
 * place with AWS. A six digit code with no name, no link and no account
 * detail is the one message where a second vendor costs least.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PATIENT-DATA GUARD STILL RUNS.
 *
 * It is cheap, it is already written, and a bridge is exactly where a
 * template grows something it should not while nobody is looking. The reset
 * body is a constant and will never trip it; that is the point of keeping
 * it rather than an argument for dropping it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE PROVIDER, BEHIND ONE FUNCTION.
 *
 * `request()` below is the only part that knows whose API this is. It is
 * Resend: POST https://api.resend.com/emails, a bearer token, and a flat
 * JSON body of from / to / subject / text. Postmark, SendGrid and Mailgun
 * differ only in the header name, the URL and three field names, so swapping
 * is an edit to that one function rather than to this file.
 *
 * THE SENDING DOMAIN IS NOT THE SES ONE. Resend verifies
 * notify.izyglobalservices.com; SES holds mail. and the apex. Keeping them
 * apart means neither vendor's SPF record is something the other could break.
 * See docs/reset-codes-via-resend.md.
 */

import type { Config } from '../../config';
import { assertNoPatientData, type Mail, type MailAttempts, type Mailer } from './ses';

export interface HttpMailConfig {
    /** The provider's endpoint. Default is Resend's. */
    readonly endpoint: string;
    readonly apiKey: string;
    /** Must be an address at a domain verified with the provider. */
    readonly from: string;
}

/** The provider-shaped half. Everything else here is provider-agnostic. */
function request(cfg: HttpMailConfig, mail: Mail): { url: string; init: RequestInit } {
    return {
        url: cfg.endpoint,
        init: {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: cfg.from,
                to: [mail.to],
                subject: mail.subject,
                text: mail.text,
            }),
        },
    };
}

const unavailable = (reason: string): Mailer => ({
    available: false,
    reason,
    async send() { throw new Error(reason); },
    attempts: (): MailAttempts => ({ attempted: 0, failing: 0, lastError: null, lastAttemptAt: null }),
});

/**
 * The reset-code mailer, or a refusal explaining what is missing.
 *
 * Returns `unavailable` rather than throwing, so a server with no fallback
 * configured starts normally and simply keeps sending reset codes through
 * SES -- which is the correct behaviour the moment production access lands.
 */
export function createHttpMailer(config: Config): Mailer {
    const m = config.mail?.http;
    if (!m?.enabled) {
        return unavailable('No fallback mailer is configured; reset codes go through SES.');
    }
    const missing = (['apiKey', 'from'] as const).filter((k) => !m[k]);
    if (missing.length > 0) {
        return unavailable(`The fallback mailer is enabled but these are missing: ${missing.join(', ')}.`);
    }
    const cfg: HttpMailConfig = {
        endpoint: m.endpoint ?? 'https://api.resend.com/emails',
        apiKey: m.apiKey as string,
        from: m.from as string,
    };

    /* Closure state, for the same reason as the SES mailer: nothing outside
       can set it and `attempts()` cannot go stale. /health reads both
       mailers, so a fallback quietly failing is visible rather than inferred
       from couriers not getting codes. */
    let attempted = 0;
    let failing = 0;
    let lastError: string | null = null;
    let lastAttemptAt: string | null = null;

    return {
        available: true,
        reason: null,
        attempts: () => ({ attempted, failing, lastError, lastAttemptAt }),

        async send(mail: Mail): Promise<void> {
            /* Before the body is serialised, and NOT counted as an attempt:
               it throws before anything leaves this process, and it is a bug
               in a template rather than a fact about the provider. */
            assertNoPatientData(mail.subject);
            assertNoPatientData(mail.text);

            const { url, init } = request(cfg, mail);

            attempted += 1;
            lastAttemptAt = new Date().toISOString();

            let res: Response;
            try {
                res = await fetch(url, init);
            } catch {
                /* A fixed string, not the error's own words. Those name the
                   provider's endpoint, and core/http/health.ts does not put
                   a hostname on a public endpoint. The real error still
                   reaches the caller and the log. */
                failing += 1;
                lastError = 'could not reach the fallback mail provider';
                throw new Error(lastError);
            }

            if (!res.ok) {
                /* The status and nothing else. A provider's error body can
                   quote the recipient address straight back, and that would
                   put a courier's address in /health. */
                failing += 1;
                lastError = `${res.status} from the fallback mail provider`;
                throw new Error(lastError);
            }

            failing = 0;
            lastError = null;
        },
    };
}
