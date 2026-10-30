/* Naming a person on the phone.
 *
 * The case that matters is a driver whose username IS their email address,
 * which is how create-drivers.mjs makes them and therefore most of this
 * contract. The profile screen showed it back to them.
 */

import { describe, it, expect } from 'vitest';
import { displayName, handleUnder, looksLikeEmail } from './people';

describe('displayName', () => {
    it('prefers the name', () => {
        expect(displayName({ name: 'Dana Whitfield', username: 'dana.whitfield@example.com' })).toBe('Dana Whitfield');
    });

    it('falls back to the username rather than showing nothing', () => {
        /* A blank "Signed in as" is worse than an address: a driver on the
           phone to the office needs to be able to say which account it is. */
        expect(displayName({ name: '', username: 'owen.castellanos@example.com' })).toBe('owen.castellanos@example.com');
        expect(displayName({ name: undefined, username: 'uh.sitemanager' })).toBe('uh.sitemanager');
    });
});

describe('handleUnder', () => {
    it('drops an address, which only repeats the name in another spelling', () => {
        expect(handleUnder({ name: 'Owen Castellanos', username: 'owen.castellanos@example.com' })).toBeNull();
    });

    it('keeps a handle, which cannot be guessed from the name', () => {
        expect(handleUnder({ name: 'UH Site Manager', username: 'uh.sitemanager' })).toBe('uh.sitemanager');
    });

    it('shows the username when there is no name at all', () => {
        expect(handleUnder({ name: '   ', username: 'o.castellanos' })).toBe('o.castellanos');
    });
});

describe('looksLikeEmail', () => {
    it('is about the shape, not validity', () => {
        expect(looksLikeEmail('a@b')).toBe(true);
        expect(looksLikeEmail('uh.green')).toBe(false);
    });
});
