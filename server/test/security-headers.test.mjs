/* The headers that constrain the browser.
 *
 * Ticket 4.2. A content security policy is only worth having if somebody
 * notices when it is quietly widened, so the directives that matter are
 * asserted by name here rather than by eye at review time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { buildCsp, createSecurityHeaders } from '../src/core/http/security.ts';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

/** The policy as a map of directive to its values. */
function directives(csp) {
    const out = new Map();
    for (const part of csp.split(';')) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) out.set(name, values);
    }
    return out;
}

describe('every response', () => {
    it('carries the policy, on the API and on the shell alike', async () => {
        for (const path of ['/health', '/api/session', '/', '/api/does-not-exist']) {
            const res = await srv.agent().get(path);
            expect(res.headers['content-security-policy'], `${path} has no policy`).toBeTruthy();
            expect(res.headers['x-content-type-options'], path).toBe('nosniff');
            expect(res.headers['x-frame-options'], path).toBe('DENY');
            expect(res.headers['referrer-policy'], path).toBe('no-referrer');
        }
    });

    it('does not announce the framework', async () => {
        const res = await srv.agent().get('/health');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('asks for the camera and position, and nothing else', async () => {
        const res = await srv.agent().get('/health');
        const policy = res.headers['permissions-policy'];
        expect(policy).toContain('camera=(self)');
        expect(policy).toContain('geolocation=(self)');
        // A courier app has no reason to listen.
        expect(policy).toContain('microphone=()');
        expect(policy).toContain('payment=()');
    });
});

describe('the content security policy', () => {
    it('allows scripts from here and nowhere else', async () => {
        const res = await srv.agent().get('/');
        const d = directives(res.headers['content-security-policy']);
        expect(d.get('script-src')).toEqual(["'self'"]);
        /* If this ever fails because a page needs a CDN, the answer is to
           serve the file from server/public, the way flatpickr now is. A
           script from somebody else's server runs with our session cookie on
           a page showing patient addresses. */
        expect(d.get('script-src')).not.toContain("'unsafe-inline'");
        expect(d.get('script-src')).not.toContain("'unsafe-eval'");
    });

    it('refuses to be framed and refuses to be repointed', async () => {
        const d = directives((await srv.agent().get('/')).headers['content-security-policy']);
        expect(d.get('frame-ancestors')).toEqual(["'none'"]);
        expect(d.get('base-uri')).toEqual(["'none'"]);
        expect(d.get('object-src')).toEqual(["'none'"]);
        expect(d.get('form-action')).toEqual(["'self'"]);
    });

    it('lets a signature and a photo preview render', () => {
        const d = directives(buildCsp({ isProduction: false }));
        // Signatures are drawn on a canvas and read back as a data URL.
        expect(d.get('img-src')).toContain('data:');
        expect(d.get('img-src')).toContain('blob:');
    });

    it('opens connect-src and img-src to the bucket only when there is one', () => {
        const without = directives(buildCsp({ isProduction: true }));
        expect(without.get('connect-src')).toEqual(["'self'"]);

        const bucket = 'https://izy-pod.s3.us-east-2.amazonaws.com';
        const with_ = directives(buildCsp({ isProduction: true, connectOrigins: [bucket], imageOrigins: [bucket] }));
        expect(with_.get('connect-src')).toEqual(["'self'", bucket]);
        expect(with_.get('img-src')).toContain(bucket);
    });
});

describe('transport security', () => {
    it('is not sent in development, because it would pin localhost to HTTPS', async () => {
        const res = await srv.agent().get('/health');
        expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('is sent in production, for two years, subdomains included', () => {
        const headers = new Map();
        const res = { setHeader: (k, v) => headers.set(k, v) };
        createSecurityHeaders({ isProduction: true })({}, res, () => {});
        expect(headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
        // The policy itself also changes in production.
        expect(headers.get('Content-Security-Policy')).toContain('upgrade-insecure-requests');
    });
});
