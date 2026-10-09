/* Over-the-air updates, pinned because they are a decision with an expiry.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS GUARDING.
 *
 * Every launch of this app asks u.expo.dev whether a newer JavaScript bundle
 * exists. That is a request from a courier's phone to a third party who is
 * not a business associate, at every start, for the life of the install. The
 * position is that nothing in it is protected health information, which is
 * true, and the disclosure is therefore outside our agreements rather than in
 * breach of them.
 *
 * It was kept on 8 October 2026 for one reason: the ability to push a fix to
 * every phone in minutes, which a crash on the site lead's first screen had
 * just demonstrated the value of. That reason weakens as the app settles and
 * the decision is to be taken again at go-live.
 *
 * So this file is not really about the config. It is about making sure the
 * config cannot change quietly in either direction:
 *
 *   Switched off by somebody tidying, and drivers stop receiving fixes with
 *   nobody noticing until one is needed.
 *
 *   Pointed somewhere else, or made blocking, and the disclosure described in
 *   docs/privacy-controls.md stops matching what the app does.
 *
 * A failure here is not a bug. It is a prompt to update that document and
 * then change this test deliberately.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const appJson = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'app.json'), 'utf8'),
) as { expo: Record<string, any> };

const updates = appJson.expo['updates'] as Record<string, unknown> | undefined;

describe('the over-the-air update configuration', () => {
    it('is on, which is the decision of 8 October 2026', () => {
        /* Kept until go-live for the speed of fixes. If this fails because
           somebody switched it off, that may well be right: go-live is when
           it was always going to be reconsidered. Update
           docs/privacy-controls.md and then change this test. */
        expect(updates, 'app.json should configure expo-updates').toBeTruthy();
        expect(updates?.['checkAutomatically']).toBe('ON_LOAD');
    });

    it('does not make a courier wait for Expo before the app opens', () => {
        /* THE PROPERTY THAT MAKES IT ACCEPTABLE AT ALL. fallbackToCacheTimeout
           of 0 means the app starts from the bundle it has and checks behind
           it, so Expo being slow or unreachable costs a driver nothing. A
           non-zero value here would put a third party on the critical path of
           a courier opening the app at a pharmacy counter. */
        expect(updates?.['fallbackToCacheTimeout']).toBe(0);
    });

    it('talks to Expo and nowhere else', () => {
        /* The disclosure described in docs/privacy-controls.md is to
           u.expo.dev. Another host would be a different disclosure and a
           different conversation. */
        expect(String(updates?.['url'] ?? '')).toMatch(/^https:\/\/u\.expo\.dev\//);
    });

    it('is keyed to the app version rather than to a moving target', () => {
        /* runtimeVersion decides which bundles an install will accept. The
           appVersion policy means a native change requires a new build rather
           than letting an OTA push JavaScript at a binary that cannot run it,
           which is the failure mode that bricks an app in the field. */
        expect(appJson.expo['runtimeVersion']).toEqual({ policy: 'appVersion' });
    });

    it('is written down where somebody auditing would look', () => {
        /* The decision, its reason, its expiry and the cost of reversing it.
           A configuration nobody can explain is a finding. */
        const controls = fs.readFileSync(
            path.join(import.meta.dirname, '..', '..', '..', 'docs', 'privacy-controls.md'),
            'utf8',
        );
        expect(controls).toMatch(/Over-the-air updates/);
        expect(controls, 'say when it is to be taken again').toMatch(/reconsidered|revisit/i);
        expect(controls, 'name the third party').toMatch(/u\.expo\.dev/);
    });
});
