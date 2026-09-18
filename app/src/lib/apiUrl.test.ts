/* Which server a build talks to (ticket 7.6).
 *
 * Every one of these is a wasted App Store review cycle if it is wrong, which
 * is why a constant has a test file.
 *
 * Imported from './apiUrl.cjs' by its real extension. The module is
 * CommonJS because Expo's config loader cannot require TypeScript, which is
 * the defect that stopped `expo start` working at all: see the header of
 * apiUrl.cjs. These tests passed the whole time it was broken, because what
 * was broken was the module SYSTEM and not the logic.
 */

import { describe, it, expect } from 'vitest';
import { ApiUrlError, DEV_FALLBACK, lanAddress, resolveApiUrl } from './apiUrl.cjs';

const wifi = (address: string) => ({ address, family: 'IPv4' as const, internal: false });
const loopback = { address: '127.0.0.1', family: 'IPv4' as const, internal: true };

describe('development', () => {
    it('uses this machine’s LAN address, because 127.0.0.1 is the phone', () => {
        /* The failure this prevents: a real device loads the bundle over the
           network, then asks 127.0.0.1:3000 for the API, which is itself,
           and hangs at sign-in with nothing on screen saying why. */
        const found = resolveApiUrl({
            configured: undefined,
            profile: 'development',
            interfaces: { 'Wi-Fi': [loopback, wifi('192.168.1.40')] },
        });
        expect(found).toBe('http://192.168.1.40:3000');
    });

    it('gives the same answer twice on a machine with two cards', () => {
        /* Sorted rather than first-found: enumeration order is not stable,
           and a base URL that changes between builds is a bug nobody can
           reproduce. */
        const shape = { Ethernet: [wifi('10.0.0.5')], 'Wi-Fi': [wifi('192.168.1.40')] };
        expect(resolveApiUrl({ configured: undefined, profile: 'development', interfaces: shape }))
            .toBe('http://10.0.0.5:3000');
        expect(resolveApiUrl({ configured: undefined, profile: 'development', interfaces: { ...shape } }))
            .toBe('http://10.0.0.5:3000');
    });

    it('falls back to localhost on a machine with no network at all', () => {
        expect(resolveApiUrl({ configured: undefined, profile: 'development', interfaces: {} })).toBe(DEV_FALLBACK);
        expect(resolveApiUrl({ configured: undefined, profile: undefined, interfaces: { lo: [loopback] } })).toBe(DEV_FALLBACK);
    });

    it('ignores loopback and IPv6', () => {
        expect(lanAddress({ lo: [loopback] })).toBeNull();
        expect(lanAddress({ 'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }] })).toBeNull();
        /* Node 18+ reports family as the number 4 rather than the string. */
        expect(lanAddress({ 'Wi-Fi': [{ address: '10.1.2.3', family: 4, internal: false }] })).toBe('10.1.2.3');
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
