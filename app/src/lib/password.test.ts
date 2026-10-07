/* The rules for a new password, and when the screen says anything.
 *
 * The tests that matter are not "does it reject a short password". They are
 * the two things that decide whether a courier at a counter gets through this
 * screen at all: nothing is said before there is something to answer, and
 * nothing is refused that the server would have accepted.
 */

import { describe, it, expect } from 'vitest';
import { MIN_LENGTH, hintFor, problemWith, readyToSend, type Draft } from './password';

const draft = (over: Partial<Draft> = {}): Draft => ({
    current: 'given-to-me-1', next: 'chosen-by-me-1', again: 'chosen-by-me-1', ...over,
});

describe('what is wrong', () => {
    it('is nothing, for a filled-in form', () => {
        expect(problemWith(draft())).toBeNull();
        expect(readyToSend(draft())).toBe(true);
    });

    it('is the current password, before anything else', () => {
        /* First box first. Telling somebody their new password is too short
           while the box above it is empty is answering a question they have
           not asked yet. */
        expect(problemWith(draft({ current: '', next: 'ab' }))).toBe('noCurrent');
    });

    it('is the length, at the boundary the server holds and not one of our own', () => {
        expect(problemWith(draft({ next: 'a'.repeat(MIN_LENGTH - 1), again: 'a'.repeat(MIN_LENGTH - 1) })))
            .toBe('tooShort');
        expect(problemWith(draft({ next: 'a'.repeat(MIN_LENGTH), again: 'a'.repeat(MIN_LENGTH) })))
            .toBeNull();
    });

    it('is the password they already have, said here rather than by the server', () => {
        /* The server answers this with password.unchanged. Making somebody
           wait for a round trip, on a phone with one bar, to be told
           something we already know is a slow way to be unhelpful. */
        const same = 'given-to-me-1';
        expect(problemWith(draft({ current: same, next: same, again: same }))).toBe('unchanged');
    });

    it('calls two identical copies of the old password unchanged, not a mismatch', () => {
        /* They DO match. Saying otherwise sends somebody off to retype a
           thing that was never the problem. */
        const same = 'given-to-me-1';
        expect(problemWith(draft({ current: same, next: same, again: same }))).not.toBe('mismatch');
    });

    it('is the second box, when the two disagree', () => {
        expect(problemWith(draft({ again: 'chosen-by-me-2' }))).toBe('mismatch');
        expect(readyToSend(draft({ again: 'chosen-by-me-2' }))).toBe(false);
    });

    it('will not send with the second box untouched', () => {
        /* THE PROPERTY THE SECOND BOX EXISTS FOR. Letting this through on the
           grounds that the first box looks fine is the same as not having a
           second box, and the failure it prevents is a courier whose old
           password has just stopped working and whose new one is a typo. */
        expect(readyToSend(draft({ again: '' }))).toBe(false);
    });
});

describe('when it says anything at all', () => {
    it('says nothing to an untouched form', () => {
        expect(hintFor({ current: '', next: '', again: '' })).toBe('');
    });

    it('says nothing about length until they have started typing one', () => {
        expect(hintFor(draft({ next: '', again: '' }))).toBe('');
    });

    it('says nothing about a mismatch until the second box has been typed in', () => {
        /* Otherwise every form shows "those two do not match" from the
           moment the new password is entered, which is both true and
           useless, and people learn to read past it. */
        expect(hintFor(draft({ again: '' }))).toBe('');
    });

    it('says the length once a short one is being typed', () => {
        expect(hintFor(draft({ next: 'abc', again: '' }))).toContain(String(MIN_LENGTH));
    });

    it('says the mismatch once there is one to see', () => {
        expect(hintFor(draft({ again: 'chosen-by-me-2' }))).toMatch(/do not match/i);
    });

    it('never says anything about the current password being missing', () => {
        /* The button being unready says it. A form that scolds somebody for
           not having filled in a box they are about to fill in is the thing
           people mean when they say an app nags. */
        expect(hintFor({ current: '', next: '', again: '' })).toBe('');
        expect(hintFor(draft({ current: '' }))).toBe('');
    });

    it('says nothing when there is nothing wrong', () => {
        expect(hintFor(draft())).toBe('');
    });
});
