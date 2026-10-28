/* The bridge mailer. Tested because it is the only thing standing between a
   courier who forgot their password and a support call, for as long as SES
   stays in the sandbox. */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHttpMailer } from './http-mail';
import type { Config } from '../../config';

/** Only the mail branch matters; the rest of Config is irrelevant here. */
const configWith = (http: unknown): Config => ({
    mail: { enabled: true, ses: undefined, http, portalUrl: '', snsTopicArn: undefined },
} as unknown as Config);

const enabled = configWith({
    enabled: true,
    endpoint: 'https://api.example.test/emails',
    apiKey: 'k-test',
    from: 'no-reply@izyglobalservices.com',
});

const mail = { to: 'driver@gmail.com', subject: 'Your TAG Courier reset code', text: 'Your code is 418207' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('createHttpMailer', () => {
    it('is unavailable, not broken, when nothing is configured', async () => {
        /* A server with no fallback must still boot and must still send
           reset codes through SES. Returning an unavailable mailer rather
           than throwing is what makes removing the bridge a one-line env
           change rather than a deployment. */
        const m = createHttpMailer(configWith(undefined));
        expect(m.available).toBe(false);
        expect(m.reason).toMatch(/SES/);
        await expect(m.send(mail)).rejects.toThrow();
    });

    it('names what is missing rather than failing at send time', () => {
        const m = createHttpMailer(configWith({ enabled: true, apiKey: '', from: '' }));
        expect(m.available).toBe(false);
        expect(m.reason).toContain('apiKey');
        expect(m.reason).toContain('from');
    });

    it('sends to an address nobody verified, which is the whole point', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const m = createHttpMailer(enabled);
        await m.send(mail);

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://api.example.test/emails');
        expect((init as RequestInit).method).toBe('POST');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.to).toEqual(['driver@gmail.com']);
        expect(body.from).toBe('no-reply@izyglobalservices.com');
        expect(body.text).toContain('418207');
        expect(m.attempts().attempted).toBe(1);
        expect(m.attempts().failing).toBe(0);
    });

    it('reports a refusal by status only, never the provider or the recipient', async () => {
        /* A provider's error body quotes the address straight back. /health
           is public; a courier's gmail address must not reach it. */
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response('{"message":"driver@gmail.com is invalid"}', { status: 422 })));

        const m = createHttpMailer(enabled);
        await expect(m.send(mail)).rejects.toThrow(/422/);

        const last = m.attempts().lastError ?? '';
        expect(last).toContain('422');
        expect(last).not.toContain('gmail.com');
        expect(last).not.toContain('api.example.test');
        expect(m.attempts().failing).toBe(1);
    });

    it('does not name the endpoint when the network fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.example.test')));
        const m = createHttpMailer(enabled);
        await expect(m.send(mail)).rejects.toThrow();
        expect(m.attempts().lastError).not.toContain('api.example.test');
    });

    it('clears the failing count once a send works again', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('', { status: 500 }))
            .mockResolvedValueOnce(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const m = createHttpMailer(enabled);
        await expect(m.send(mail)).rejects.toThrow();
        expect(m.attempts().failing).toBe(1);

        await m.send(mail);
        expect(m.attempts().failing).toBe(0);
        expect(m.attempts().lastError).toBeNull();
        expect(m.attempts().attempted).toBe(2);
    });

    it('still refuses a body carrying patient data, and does not count it', async () => {
        /* The guard is cheap and already written, and a bridge is exactly
           where a template grows something it should not. A refusal here is
           a bug in a template, not a fact about the provider, so it must not
           make /health announce that the mailer is failing. */
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const m = createHttpMailer(enabled);
        await expect(m.send({ ...mail, text: 'Deliver to 221 Baker Street' })).rejects.toThrow();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(m.attempts().attempted).toBe(0);
        expect(m.attempts().failing).toBe(0);
    });
});
