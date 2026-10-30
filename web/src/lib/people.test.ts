/* Naming a person on screen.
 *
 * The case that matters is a driver whose username IS their email address,
 * which is how create-drivers.mjs makes them and is therefore most of the
 * contract. Printing it under their name put a personal address on every
 * row of a screen a room can see, and told a dispatcher nothing.
 */

import { describe, it, expect } from 'vitest';
import { handleUnder, displayName, looksLikeEmail } from './people';

describe('handleUnder', () => {
    it('says nothing when the username is only the name again, as an address', () => {
        expect(handleUnder({ name: 'Dana Whitfield', username: 'dana.whitfield@example.com' })).toBeNull();
    });

    it('keeps a handle, which is not a name and cannot be guessed from one', () => {
        /* `uh.sitemanager` and `sim.courier13` are the reason this is not
           simply "never show the username". */
        expect(handleUnder({ name: 'UH Site Manager', username: 'uh.sitemanager' })).toBe('uh.sitemanager');
    });

    it('falls back to the username when there is no name at all', () => {
        /* A row with no label is a row nobody can act on, and an address is
           better than that. */
        expect(handleUnder({ name: '', username: 'owen.castellanos@example.com' })).toBe('owen.castellanos@example.com');
        expect(handleUnder({ name: undefined, username: 'test.courier' })).toBe('test.courier');
    });

    it('treats a name of only spaces as no name', () => {
        expect(handleUnder({ name: '   ', username: 'zoe@example.com' })).toBe('zoe@example.com');
    });
});

describe('displayName', () => {
    it('prefers the name', () => {
        expect(displayName({ name: 'Owen Castellanos', username: 'owen.castellanos@example.com' })).toBe('Owen Castellanos');
    });

    it('does not render an empty heading', () => {
        expect(displayName({ name: '', username: 'test.courier' })).toBe('test.courier');
    });
});

describe('looksLikeEmail', () => {
    it('is about the shape, not validity', () => {
        expect(looksLikeEmail('a@b')).toBe(true);
        expect(looksLikeEmail('uh.green')).toBe(false);
    });
});
