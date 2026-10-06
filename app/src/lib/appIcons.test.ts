/* The app icon guard.
 *
 * What is tested is the refusal, not the happy path. Expo substitutes its own
 * icon when none is configured, so the failure this prevents is a release
 * build that SUCCEEDS and produces an app wearing somebody else's logo. That
 * is not something a test of "does it return a path" would catch.
 */

import { describe, it, expect } from 'vitest';
import {
    AppIconError, ICON, ADAPTIVE_ICON, ADAPTIVE_BACKGROUND, REQUIRED, resolveIcons,
} from './appIcons.cjs';

/** An `exists` that answers yes to exactly these paths. */
const only = (...present: string[]) => (p: string) => present.includes(p);
const all = () => true;
const none = () => false;

describe('with the artwork in place', () => {
    it('configures both platforms', () => {
        const config = resolveIcons({ profile: 'production', exists: all });
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
    it('refuses rather than shipping a default', () => {
        expect(() => resolveIcons({ profile: 'production', exists: none })).toThrow(AppIconError);
    });

    it('names the file, the size and the constraint, not just "icon not found"', () => {
        let message = '';
        try {
            resolveIcons({ profile: 'production', exists: none });
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
        expect(() => resolveIcons({ profile: 'production', exists: only(ICON) })).toThrow(AppIconError);
        expect(() => resolveIcons({ profile: 'production', exists: only(ADAPTIVE_ICON) })).toThrow(AppIconError);
    });

    it('says which one is missing, not both', () => {
        let message = '';
        try {
            resolveIcons({ profile: 'production', exists: only(ICON) });
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
        expect(() => resolveIcons({ profile: undefined, exists: none })).not.toThrow();
        expect(resolveIcons({ profile: 'development', exists: none })).toEqual({});
    });

    it('configures nothing rather than half of it', () => {
        /* Half the configuration is a default icon on one platform with no
           warning, which is the thing this file exists to prevent. */
        const config = resolveIcons({ profile: undefined, exists: only(ICON) });
        expect(config).toEqual({});
    });

    it('uses the artwork once it is there', () => {
        expect(resolveIcons({ profile: undefined, exists: all }).icon).toBe(ICON);
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

describe('the boundary between a store build and an internal one', () => {
    it('stops a production build, which is the only one a store sees', () => {
        expect(() => resolveIcons({ profile: 'production', exists: none })).toThrow(AppIconError);
    });

    it('lets a preview build through, because it goes to our drivers by link', () => {
        /* preview is distribution: internal. Stopping it means nobody can put
           a build on a phone until somebody has drawn a logo, which is the
           guard obstructing the work it exists to protect. */
        expect(() => resolveIcons({ profile: 'preview', exists: none })).not.toThrow();
    });

    it('warns on that build rather than passing in silence', () => {
        const said: string[] = [];
        resolveIcons({ profile: 'preview', exists: none, warn: (m) => said.push(m) });
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('Expo');
        expect(said[0]).toContain('cannot go to a store');
        /* And still names the files, so the warning is actionable. */
        expect(said[0]).toContain(ICON);
    });

    it('says nothing on a preview build that has the artwork', () => {
        const said: string[] = [];
        resolveIcons({ profile: 'preview', exists: all, warn: (m) => said.push(m) });
        expect(said).toEqual([]);
    });

    it('does not warn in development, where it would be noise every time', () => {
        const said: string[] = [];
        resolveIcons({ profile: undefined, exists: none, warn: (m) => said.push(m) });
        expect(said).toEqual([]);
    });

    it('works without a warn function at all', () => {
        /* app.config.ts passes one; a test or a script may not. */
        expect(() => resolveIcons({ profile: 'preview', exists: none })).not.toThrow();
    });
});
