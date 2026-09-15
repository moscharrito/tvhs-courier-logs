/* The headers that constrain the browser.
 *
 * Ticket 4.2. A content security policy is only worth having if somebody
 * notices when it is quietly widened, so the directives that matter are
 * asserted by name here rather than by eye at review time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { buildCsp, createSecurityHeaders, securityHeadersFor } from '../src/core/http/security.ts';

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

    it('keeps frame-src none unless an origin is named, and names only the map', () => {
        /* frame-src was 'none' from ticket 4.2 until the courier map in 5.13
           needed one origin. The thing worth asserting is that it is still
           'none' for every installation that has not switched the map on, so
           that a relaxation made for one feature does not become the default
           for the whole application. */
        expect(directives(buildCsp({ isProduction: true })).get('frame-src')).toEqual(["'none'"]);
        expect(directives(buildCsp({ isProduction: true, frameOrigins: [] })).get('frame-src')).toEqual(["'none'"]);

        const d = directives(buildCsp({ isProduction: true, frameOrigins: ['https://www.google.com'] }));
        expect(d.get('frame-src')).toEqual(['https://www.google.com']);
        // Opening frame-src must not have opened being framed BY somebody.
        expect(d.get('frame-ancestors')).toEqual(["'none'"]);
        // Nor anything else. One origin, one directive.
        expect(d.get('default-src')).toEqual(["'self'"]);
        expect(d.get('script-src')).toEqual(["'self'"]);
        expect(d.get('connect-src')).toEqual(["'self'"]);
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

describe('the policy the config actually produces', () => {
    /* buildCsp is tested above with arguments handed to it. These test the
       wiring, which is the half that fails silently: a switch that is on and
       a frame-src that never heard about it shows the courier an empty grey
       box and an error only the console sees. */
    const headerFrom = (config) => {
        const headers = new Map();
        securityHeadersFor(config)({}, { setHeader: (k, v) => headers.set(k, v) }, () => {});
        return headers.get('Content-Security-Policy');
    };
    const base = { isProduction: false, files: { enabled: false } };

    it('keeps frames closed for the configuration everything ships with', () => {
        const csp = headerFrom({ ...base, geo: { googleApiKey: undefined, dailyCeiling: 2500, embedMaps: false } });
        expect(csp).toContain("frame-src 'none'");
        expect(csp).not.toContain('google.com');
    });

    it('does not open frames just because a map key exists', () => {
        /* The key is there so pharmacy sites can be geocoded, which is
           lawful. It must not also be what starts putting patient addresses
           on Google's servers from our pages. */
        const csp = headerFrom({ ...base, geo: { googleApiKey: 'k', dailyCeiling: 2500, embedMaps: false } });
        expect(csp).toContain("frame-src 'none'");
    });

    it('opens exactly one frame origin when the embed is switched on', () => {
        const csp = headerFrom({ ...base, geo: { googleApiKey: 'k', dailyCeiling: 2500, embedMaps: true } });
        expect(csp).toContain('frame-src https://www.google.com');
        expect(csp).not.toContain("frame-src 'none'");
        // And nothing else moved.
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("script-src 'self'");
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
