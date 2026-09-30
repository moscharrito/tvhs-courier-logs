/* Sending one text message through Twilio.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT MAY BE IN THE BODY, AND WHY IT IS SO LITTLE.
 *
 * A phone number plus "a medical courier has a delivery for you" links a
 * named person to healthcare. That is PHI. It is lawful to send because
 * Twilio has executed a business associate agreement, and it is still worth
 * minimising, because a text is read on a lock screen by whoever is holding
 * the phone.
 *
 * So the body names no pharmacy, no medication, no prescription and no order
 * reference. A neighbour who glances at the screen learns that a courier is
 * coming. `assertMinimal` below refuses anything else and THROWS rather than
 * trimming, because a caller that tried to put a drug name in a text should
 * fail loudly rather than send a shortened version of the same mistake.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO SDK, for the same reason core/files and core/notify/ses have none: this
 * is one HTTP call with Basic auth and a form body. `twilio` is a large
 * dependency tree to reach it, and on a system holding PHI dependency surface
 * is a security property rather than a packaging preference.
 *
 * OPT-OUT IS NOT OURS TO OVERRIDE. Twilio refuses a send to a number that has
 * replied STOP with error 21610, and that refusal is reported here as a
 * distinct outcome rather than a generic failure, so the caller can record
 * the decision permanently instead of rediscovering it once per order.
 */

import type { Config } from '../../config';

/** Twilio's code for "this number has opted out". */
export const OPTED_OUT = 21610;

export interface Text {
    /** E.164, which is what Twilio wants and not what we store. */
    to: string;
    body: string;
}

export type SendOutcome =
    | { kind: 'sent'; providerId: string }
    | { kind: 'opted_out' }
    | { kind: 'failed'; message: string };

export interface Texter {
    readonly available: boolean;
    readonly reason: string | null;
    send(text: Text): Promise<SendOutcome>;
}

/* Words that must never travel in a text to a patient. Crude on purpose and
   erring towards refusing a legitimate message: a message that failed to send
   is a support ticket, where a prescription named on a lock screen is a
   disclosure to whoever was looking. */
const FORBIDDEN = /\b(pharmac\w*|prescription|medication|medicine|drug|rx|dose|dosage|refill|patient|clinic|hospital|diagnos\w*)\b/i;

export function assertMinimal(body: string): void {
    const hit = FORBIDDEN.exec(body);
    if (hit) {
        throw new Error(
            `Refusing to send: a text to a patient may not contain "${hit[0]}". `
            + 'These are read on lock screens. Say that a courier has a delivery and nothing else.',
        );
    }
}

/**
 * Digits to E.164.
 *
 * We store ten digits because that is what a US pharmacy list carries.
 * Twilio wants +1XXXXXXXXXX. Anything that is not recognisably a US number
 * is returned unchanged and will be refused by Twilio rather than guessed at
 * here: inventing a country code for a number we do not understand is how a
 * text reaches a stranger.
 */
export function toE164(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw.trim();
}

const unavailable = (reason: string): Texter => ({
    available: false,
    reason,
    async send() { return { kind: 'failed', message: reason }; },
});

export function createTexter(config: Config): Texter {
    const t = config.sms;
    if (!t?.enabled) return unavailable('Patient texting is not enabled on this server.');
    if (!t.twilio) return unavailable('Patient texting is enabled but the Twilio values are incomplete.');
    const { accountSid, authToken, from } = t.twilio;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    return {
        available: true,
        reason: null,

        async send(text: Text): Promise<SendOutcome> {
            /* Before the wire, and before the body is even encoded. */
            assertMinimal(text.body);

            const form = new URLSearchParams({ To: text.to, From: from, Body: text.body });
            let res: Response;
            try {
                res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        authorization: `Basic ${auth}`,
                        'content-type': 'application/x-www-form-urlencoded',
                    },
                    body: form.toString(),
                });
            } catch (err) {
                return { kind: 'failed', message: err instanceof Error ? err.message : 'network error' };
            }

            let parsed: { sid?: string; code?: number; message?: string } = {};
            try { parsed = await res.json() as typeof parsed; } catch { /* status is enough */ }

            if (res.ok && parsed.sid) return { kind: 'sent', providerId: parsed.sid };

            /* Their decision, not an error of ours. Reported separately so the
               caller records it once rather than being refused forever. */
            if (parsed.code === OPTED_OUT) return { kind: 'opted_out' };

            return {
                kind: 'failed',
                /* Twilio's message names the number it refused, which is a
                   patient's phone. Code and status only. */
                message: `Twilio refused it: ${res.status}${parsed.code ? ` code ${parsed.code}` : ''}`,
            };
        },
    };
}
