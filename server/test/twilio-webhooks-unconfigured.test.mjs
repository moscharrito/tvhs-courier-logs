/* The same two webhooks on a server that was never told where it lives.
 *
 * ITS OWN FILE BECAUSE startServer HOLDS MODULE-LEVEL STATE and refuses a
 * second call in one file -- see the guard at the top of helpers/server.mjs.
 * The configuration under test IS the boot, so it cannot share one.
 *
 * WHAT IS BEING PINNED IS FAILING CLOSED. Without PUBLIC_BASE_URL there is
 * no URL to check a signature against, and a verifier with nothing to
 * compare to would have to accept everything. Every deploy before
 * 27 November 2026 was in exactly this state, so it is not hypothetical.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

let srv;

beforeAll(async () => {
    srv = await startServer({
        SMS_ENABLED: 'true',
        TWILIO_ACCOUNT_SID: 'ACtest',
        TWILIO_AUTH_TOKEN: 'test-auth-token-not-a-real-one',
        TWILIO_FROM: '+12105550100',
        /* and deliberately no PUBLIC_BASE_URL */
    });
});
afterAll(async () => { await srv?.stop(); });

describe('a server with no callback URL configured', () => {
    it('refuses both webhooks rather than accepting unverifiable ones', async () => {
        /* 503 AND NOT 403, so that a log read after somebody pastes the URL
           into the Twilio console says which of the two states they are in:
           "we cannot check" and "we checked and it was forged" are different
           problems with different fixes. */
        for (const path of ['/api/webhooks/twilio/status', '/api/webhooks/twilio/inbound']) {
            const res = await srv.agent().post(path).type('form')
                .set('X-Twilio-Signature', 'anything')
                .send({ MessageSid: 'SM1', MessageStatus: 'delivered' });
            expect(res.status, path).toBe(503);
        }
    });

    it('still boots and still serves health, because texting is not the server', async () => {
        /* A missing callback URL is not a boot refusal: texting worked
           without one from September to November and what is lost is
           receipts, not sends. Refusing to start over it would take
           production down in order to add a feature. */
        const res = await srv.agent().get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });
});
