/* Typed initials, drawn as handwriting.
 *
 * The tests are about the shape being a plausible signature rather than
 * about the exact curve of a J: a mark that falls outside the box, or that
 * changes between two collections by the same pharmacist, is a bug anybody
 * would notice, and the letterforms themselves are a matter of taste.
 */

import { describe, it, expect } from 'vitest';
import { handwrittenInitials } from './handwriting';
import { MAX_POINTS_PER_STROKE, MAX_STROKES } from './strokes';

describe('what it draws', () => {
    it('draws something for an ordinary name', () => {
        const strokes = handwrittenInitials('James Madison');
        expect(strokes.length).toBeGreaterThan(0);
        const points = strokes.reduce((n, s) => n + s.length, 0);
        /* Enough points to be curves rather than a stick figure. */
        expect(points).toBeGreaterThan(40);
    });

    it('draws nothing when there is no name yet', () => {
        /* Length is the "is there a mark" check, so it must be zero rather
           than one empty stroke. */
        expect(handwrittenInitials('')).toEqual([]);
        expect(handwrittenInitials('   ')).toEqual([]);
        expect(handwrittenInitials('123')).toEqual([]);
    });

    it('draws one letter for a single name', () => {
        expect(handwrittenInitials('James').length).toBeGreaterThan(0);
    });
});

describe('the mark stays inside the box', () => {
    it('never leaves 0..1 in either direction', () => {
        /* The server rejects anything outside, and a signature clipped by
           the edge of a PDF looks like a printing fault. */
        for (const name of ['James Madison', 'Wendy Xu', 'Olga Zimmerman', 'Ada A']) {
            for (const stroke of handwrittenInitials(name)) {
                for (const p of stroke) {
                    expect(p.x, `${name} x`).toBeGreaterThanOrEqual(0);
                    expect(p.x, `${name} x`).toBeLessThanOrEqual(1);
                    expect(p.y, `${name} y`).toBeGreaterThanOrEqual(0);
                    expect(p.y, `${name} y`).toBeLessThanOrEqual(1);
                }
            }
        }
    });

    it('leaves room above and below rather than touching the edges', () => {
        const ys = handwrittenInitials('James Madison').flat().map((p) => p.y);
        expect(Math.min(...ys)).toBeGreaterThan(0.1);
        expect(Math.max(...ys)).toBeLessThan(0.9);
    });

    it('stays within the caps the server enforces', () => {
        const strokes = handwrittenInitials('Wendy Xu');
        expect(strokes.length).toBeLessThanOrEqual(MAX_STROKES);
        for (const s of strokes) expect(s.length).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE);
    });
});

describe('it is the same mark every time', () => {
    it('gives identical strokes for the same name', () => {
        /* Two collections signed by the same pharmacist should look the
           same, and a test can only assert on it if there is no jitter. */
        expect(handwrittenInitials('James Madison')).toEqual(handwrittenInitials('James Madison'));
    });

    it('gives a different mark for a different name', () => {
        expect(handwrittenInitials('James Madison')).not.toEqual(handwrittenInitials('Alison Baker'));
    });

    it('ignores the case and spacing of the typed name', () => {
        expect(handwrittenInitials('  james   madison ')).toEqual(handwrittenInitials('James Madison'));
    });
});

describe('it looks written rather than typeset', () => {
    it('leans forward', () => {
        /* The shear is what stops it reading as a diagram. The top of a
           glyph should sit to the right of its own bottom. */
        const stroke = handwrittenInitials('Ian Ives')[0]!;
        const top = stroke.reduce((a, b) => (a.y < b.y ? a : b));
        const bottom = stroke.reduce((a, b) => (a.y > b.y ? a : b));
        expect(top.x).toBeGreaterThan(bottom.x);
    });

    it('carries increasing timestamps, so a replay is not a teleport', () => {
        const flat = handwrittenInitials('James Madison').flat();
        for (let i = 1; i < flat.length; i += 1) {
            expect(flat[i]!.t).toBeGreaterThan(flat[i - 1]!.t);
        }
    });

    it('lifts the pen between strokes', () => {
        /* A capital A is two movements, not one continuous scribble. */
        expect(handwrittenInitials('Ada Adams').length).toBeGreaterThan(1);
    });
});

describe('names that are not two English words', () => {
    it('draws an accented letter as its base rather than nothing', () => {
        /* Á written as A is still recognisably somebody's initial. A blank
           is not, and a blank here would silently become "nobody signed". */
        expect(handwrittenInitials('Álvaro Núñez').length).toBeGreaterThan(0);
    });

    it('draws nothing for an alphabet it has no letters for', () => {
        /* Cyrillic has no glyphs here, and guessing at one would produce a
           mark that is not this person's initials. Better to fall through to
           the no-signature path, which asks for a reason. */
        expect(handwrittenInitials('Олена Коваленко')).toEqual([]);
    });
});
