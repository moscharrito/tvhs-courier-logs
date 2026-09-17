/* Which server a build talks to (ticket 7.6).
 *
 * Every one of these is a wasted App Store review cycle if it is wrong, which
 * is why a constant has a test file.
 */

import { describe, it, expect } from 'vitest';
import { ApiUrlError, DEV_FALLBACK, resolveApiUrl } from './apiUrl';

describe('development', () => {
    it('falls back to localhost, because that is what it is for', () => {
        expect(resolveApiUrl({ configured: undefined, profile: 'development' })).toBe(DEV_FALLBACK);
        expect(resolveApiUrl({ configured: undefined, profile: undefined })).toBe(DEV_FALLBACK);
    });

    it('lets a developer point at a machine on the LAN', () => {
        /* A real phone cannot reach 127.0.0.1 on a laptop, so this is the
           first thing anybody changes. */
        expect(resolveApiUrl({ configured: 'http://192.168.1.40:3100', profile: 'development' }))
            .toBe('http://192.168.1.40:3100');
    });
});

describe('a release build', () => {
    it('REFUSES to default to localhost', () => {
        /* The defect this file exists for. A submitted build pointing at
           127.0.0.1 reaches for a server on the reviewer's own phone, answers
           nothing, and is rejected as broken. */
        expect(() => resolveApiUrl({ configured: undefined, profile: 'production' })).toThrow(ApiUrlError);
        expect(() => resolveApiUrl({ configured: '', profile: 'preview' })).toThrow(/EXPO_PUBLIC_API_URL is not set/);
    });

    it('refuses an address that is the phone itself, however it is spelled', () => {
        for (const url of [
            'https://localhost:3100', 'https://127.0.0.1', 'http://0.0.0.0:3100',
            'https://10.0.2.2:3100', 'https://[::1]:3100',
        ]) {
            expect(() => resolveApiUrl({ configured: url, profile: 'production' }), url).toThrow(ApiUrlError);
        }
    });

    it('refuses plain HTTP', () => {
        /* Session tokens and patient addresses cross this connection, and
           both platforms block cleartext by default, so an http:// release
           build fails silently on a device instead of loudly at build time. */
        expect(() => resolveApiUrl({ configured: 'http://dispatch.example.com', profile: 'production' }))
            .toThrow(/must use https/);
    });

    it('takes a real one', () => {
        expect(resolveApiUrl({ configured: 'https://dispatch.izyglobalservices.com', profile: 'production' }))
            .toBe('https://dispatch.izyglobalservices.com');
    });

    it('trims a trailing slash, so paths do not double up', () => {
        expect(resolveApiUrl({ configured: 'https://dispatch.example.com/', profile: 'preview' }))
            .toBe('https://dispatch.example.com');
    });
});

describe('anything that is not a URL', () => {
    it('is refused in every profile', () => {
        for (const profile of ['development', 'preview', 'production']) {
            expect(() => resolveApiUrl({ configured: 'dispatch.example.com', profile }), profile)
                .toThrow(/must start with http/);
        }
    });
});
