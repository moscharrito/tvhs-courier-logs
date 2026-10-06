/* The app icon guard.
 *
 * What is tested is the refusal, not the happy path. Expo substitutes its own
 * icon when none is configured, so the failure this prevents is a release
 * build that SUCCEEDS and produces an app wearing somebody else's logo. That
 * is not something a test of "does it return a path" would catch.
 */

import { describe, it, expect } from 'vitest';
import {
    AppIconError, ICON, ADAPTIVE_ICON, ADAPTIVE_BACKGROUND, OVERRIDE, REQUIRED, resolveIcons,
} from './appIcons.cjs';

/** An `exists` that answers yes to exactly these paths. */
const only = (...present: string[]) => (p: string) => present.includes(p);
const all = () => true;
const none = () => false;
/** No override, whatever this machine's environment happens to hold. */
const off = {};

describe('with the artwork in place', () => {
    it('configures both platforms', () => {
        const config = resolveIcons({ profile: 'production', exists: all, env: off });
        expect(config.icon).toBe(ICON);
        expect(config.android?.adaptiveIcon.foregroundImage).toBe(ADAPTIVE_ICON);
        expect(config.android?.adaptiveIcon.backgroundColor).toBe(ADAPTIVE_BACKGROUND);
    });

    it('gives Android a background colour that is not white', () => {
        /* A white mark on a white background disappears on a light launcher,
           and the adaptive foreground is masked over whatever this is. */
        expect(ADAPTIVE_BACKGROUND.toLowerCase()).not.toBe('#ffffff');
        expect(ADAPTIVE_BACKGROUND).toMatch(/^#[0-9a-f]{6}$/i);
    });
});

describe('a release build with no artwork', () => {
    it.each(['production', 'preview'])('refuses rather than shipping a default: %s', (profile) => {
        expect(() => resolveIcons({ profile, exists: none })).toThrow(AppIconError);
    });

    it('names the file, the size and the constraint, not just "icon not found"', () => {
        let message = '';
        try {
            resolveIcons({ profile: 'production', exists: none, env: off });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain(ICON);
        expect(message).toContain(ADAPTIVE_ICON);
        expect(message).toContain('1024x1024');
        /* The two constraints that cause an actual App Store rejection. */
        expect(message).toContain('no transparency');
        expect(message).toContain('66 percent');
    });

    it('refuses when only one of the two is there', () => {
        /* The nastier case: a build with an iOS icon and no Android
           foreground succeeds and ships a default on one platform only. */
        expect(() => resolveIcons({ profile: 'preview', exists: only(ICON), env: off })).toThrow(AppIconError);
        expect(() => resolveIcons({ profile: 'preview', exists: only(ADAPTIVE_ICON), env: off })).toThrow(AppIconError);
    });

    it('says which one is missing, not both', () => {
        let message = '';
        try {
            resolveIcons({ profile: 'preview', exists: only(ICON), env: off });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain(ADAPTIVE_ICON);
        /* The one that is present must not be listed as missing. */
        expect(message.split('\n').filter((l) => l.includes(ICON) && !l.includes(ADAPTIVE_ICON))).toEqual([]);
    });
});

describe('development', () => {
    it('runs without artwork, because that is what development is for', () => {
        expect(() => resolveIcons({ profile: undefined, exists: none, env: off })).not.toThrow();
        expect(resolveIcons({ profile: 'development', exists: none, env: off })).toEqual({});
    });

    it('configures nothing rather than half of it', () => {
        /* Half the configuration is a default icon on one platform with no
           warning, which is the thing this file exists to prevent. */
        const config = resolveIcons({ profile: undefined, exists: only(ICON), env: off });
        expect(config).toEqual({});
    });

    it('uses the artwork once it is there', () => {
        expect(resolveIcons({ profile: undefined, exists: all, env: off }).icon).toBe(ICON);
    });
});

describe('the specification it hands somebody', () => {
    it('covers both files and says what each is for', () => {
        expect(REQUIRED.map((f) => f.path)).toEqual([ICON, ADAPTIVE_ICON]);
        for (const f of REQUIRED) {
            expect(f.what.length).toBeGreaterThan(0);
            expect(f.spec).toContain('1024x1024');
        }
    });
});

describe('the deliberate override', () => {
    it('proceeds without artwork when it is set, and reports no icon', () => {
        /* For an internal Android test build while the logo is being drawn.
           It returns {} rather than half a configuration, so the build is
           knowingly the Expo default on both platforms rather than silently
           mixed. */
        const config = resolveIcons({
            profile: 'preview', exists: none, env: { [OVERRIDE]: '1' },
        });
        expect(config).toEqual({});
    });

    it('is off unless it is exactly 1, so a stray value cannot disarm it', () => {
        for (const value of ['', '0', 'true', 'yes', 'TRUE']) {
            expect(() => resolveIcons({
                profile: 'production', exists: none, env: { [OVERRIDE]: value },
            })).toThrow(AppIconError);
        }
    });

    it('is named in the refusal, so somebody blocked by it knows it exists', () => {
        let message = '';
        try {
            resolveIcons({ profile: 'preview', exists: none, env: off });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain(OVERRIDE);
        /* And warns that it buys nothing on iOS, which is where somebody
           would otherwise reach for it and lose a day to App Store Connect. */
        expect(message).toContain('TestFlight');
    });

    it('still uses the artwork when it is there, override or not', () => {
        const config = resolveIcons({
            profile: 'production', exists: all, env: { [OVERRIDE]: '1' },
        });
        expect(config.icon).toBe(ICON);
    });
});
