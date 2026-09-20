/* Drawing typed initials as handwriting.
 *
 * "James Madison" becomes a JM that looks written rather than typeset,
 * because a signature rendered in a UI font does not read as a signature to
 * anybody looking at a proof of collection.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS STILL RECORDED AS TYPED, and that is the whole reason this is safe.
 *
 * The mark looks handwritten. The database says `capture_method = 'initials'`
 * (migration 0035), so nothing downstream can mistake it for a finger on
 * glass. Making it look like handwriting is presentation; making it claim to
 * be handwriting would be forgery, and the column is the difference.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY LETTERFORMS ARE SPELLED OUT HERE RATHER THAN DRAWN FROM A FONT.
 *
 * The signature format is strokes, not an image: `[[{x,y,t}, ...], ...]` in a
 * 0..1 box, so it renders at any size and on the PDF. Getting glyph outlines
 * out of a font at runtime would need a font parser, a licence for a script
 * face, and the outlines would be closed contours rather than pen paths,
 * which would draw as filled letters and look nothing like a pen.
 *
 * Twenty-six capitals as pen paths is less code than any of that, and it
 * gives a stroke that starts where a pen would start.
 *
 * DETERMINISTIC on purpose. The same name always produces the same mark, so
 * two collections signed by the same pharmacist look the same, and a test
 * can assert on it. No jitter, no randomness.
 * ───────────────────────────────────────────────────────────────────────── */

import type { Point, Stroke } from './strokes';
import { initialsOf } from './initials';

/* Each glyph is drawn in its own 0..1 box, y down, as a list of pen paths.
 * Curves are written as a few control points and sampled below, which keeps
 * this table readable: a capital A is three numbers, not thirty.
 *
 * The shapes lean on the copperplate capitals people actually use when they
 * initial something: an entry stroke, one main movement, an exit. */
type Path = Array<[number, number]>;

const GLYPHS: Record<string, Path[]> = {
    A: [[[0.04, 1], [0.42, 0.06], [0.5, 0], [0.58, 0.06], [0.96, 1]], [[0.22, 0.66], [0.78, 0.66]]],
    B: [[[0.18, 1], [0.18, 0]], [[0.18, 0], [0.7, 0.04], [0.82, 0.22], [0.66, 0.46], [0.2, 0.5]], [[0.2, 0.5], [0.76, 0.54], [0.9, 0.76], [0.7, 0.97], [0.18, 1]]],
    C: [[[0.9, 0.2], [0.72, 0.02], [0.36, 0], [0.1, 0.3], [0.08, 0.72], [0.32, 0.98], [0.72, 1], [0.92, 0.82]]],
    D: [[[0.18, 1], [0.18, 0]], [[0.18, 0], [0.66, 0.04], [0.9, 0.34], [0.88, 0.7], [0.62, 0.97], [0.18, 1]]],
    E: [[[0.9, 0.08], [0.5, 0], [0.18, 0.12], [0.14, 0.5], [0.52, 0.5]], [[0.14, 0.5], [0.12, 0.88], [0.46, 1], [0.9, 0.9]]],
    F: [[[0.9, 0.06], [0.42, 0], [0.24, 0.12], [0.22, 1]], [[0.14, 0.48], [0.66, 0.44]]],
    G: [[[0.9, 0.18], [0.64, 0], [0.28, 0.06], [0.1, 0.42], [0.18, 0.84], [0.56, 1], [0.86, 0.86], [0.88, 0.56], [0.54, 0.54]]],
    H: [[[0.14, 0], [0.14, 1]], [[0.86, 0], [0.86, 1]], [[0.14, 0.52], [0.86, 0.48]]],
    I: [[[0.5, 0], [0.5, 1]], [[0.26, 0.02], [0.74, 0]], [[0.26, 1], [0.74, 0.98]]],
    J: [[[0.74, 0], [0.72, 0.76], [0.54, 0.99], [0.24, 0.94], [0.16, 0.74]], [[0.42, 0.02], [0.92, 0]]],
    K: [[[0.16, 0], [0.16, 1]], [[0.88, 0.02], [0.16, 0.54]], [[0.36, 0.42], [0.9, 1]]],
    L: [[[0.2, 0], [0.16, 0.9], [0.5, 1], [0.92, 0.9]]],
    M: [[[0.06, 1], [0.14, 0], [0.5, 0.76], [0.86, 0], [0.94, 1]]],
    N: [[[0.1, 1], [0.16, 0], [0.84, 1], [0.9, 0]]],
    O: [[[0.5, 0], [0.16, 0.16], [0.08, 0.56], [0.3, 0.94], [0.7, 0.96], [0.92, 0.6], [0.84, 0.2], [0.5, 0]]],
    P: [[[0.2, 1], [0.2, 0]], [[0.2, 0], [0.74, 0.04], [0.88, 0.26], [0.7, 0.5], [0.2, 0.54]]],
    Q: [[[0.5, 0], [0.16, 0.16], [0.08, 0.56], [0.3, 0.94], [0.7, 0.96], [0.92, 0.6], [0.84, 0.2], [0.5, 0]], [[0.6, 0.72], [0.96, 1.04]]],
    R: [[[0.2, 1], [0.2, 0]], [[0.2, 0], [0.72, 0.04], [0.86, 0.24], [0.68, 0.48], [0.2, 0.52]], [[0.4, 0.5], [0.9, 1]]],
    S: [[[0.88, 0.14], [0.6, 0], [0.26, 0.06], [0.2, 0.32], [0.56, 0.5], [0.82, 0.66], [0.76, 0.92], [0.4, 1], [0.12, 0.86]]],
    T: [[[0.08, 0.06], [0.92, 0]], [[0.5, 0.02], [0.46, 1]]],
    U: [[[0.12, 0], [0.14, 0.72], [0.4, 0.98], [0.72, 0.96], [0.86, 0.68], [0.86, 0]]],
    V: [[[0.08, 0], [0.5, 1], [0.92, 0]]],
    W: [[[0.04, 0], [0.26, 1], [0.5, 0.3], [0.74, 1], [0.96, 0]]],
    X: [[[0.1, 0], [0.9, 1]], [[0.9, 0], [0.1, 1]]],
    Y: [[[0.1, 0], [0.5, 0.52], [0.9, 0]], [[0.5, 0.52], [0.48, 1]]],
    Z: [[[0.1, 0.06], [0.9, 0.02], [0.14, 0.96], [0.92, 1]]],
};

/* Anything with no glyph of its own is drawn as its unaccented base where
   there is one, because Á written as A is still recognisably somebody's
   initial, and a blank is not. */
const FALLBACK: Record<string, string> = {
    Á: 'A', À: 'A', Â: 'A', Ä: 'A', Ã: 'A', Å: 'A',
    É: 'E', È: 'E', Ê: 'E', Ë: 'E',
    Í: 'I', Ì: 'I', Î: 'I', Ï: 'I',
    Ó: 'O', Ò: 'O', Ô: 'O', Ö: 'O', Õ: 'O', Ø: 'O',
    Ú: 'U', Ù: 'U', Û: 'U', Ü: 'U',
    Ñ: 'N', Ç: 'C', Ý: 'Y',
};

/** Sample a path through its points with a Catmull-Rom spline, so the pen
 *  curves rather than showing the corners of the control points. */
function smooth(path: Path, per = 8): Array<[number, number]> {
    if (path.length < 3) return path;
    const pts: Array<[number, number]> = [path[0]!, ...path, path[path.length - 1]!];
    const out: Array<[number, number]> = [];
    for (let i = 1; i < pts.length - 2; i += 1) {
        const [x0, y0] = pts[i - 1]!;
        const [x1, y1] = pts[i]!;
        const [x2, y2] = pts[i + 1]!;
        const [x3, y3] = pts[i + 2]!;
        for (let s = 0; s < per; s += 1) {
            const t = s / per;
            const t2 = t * t;
            const t3 = t2 * t;
            out.push([
                0.5 * ((2 * x1) + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
                0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
            ]);
        }
    }
    out.push(pts[pts.length - 2]!);
    return out;
}

/* The slant is what stops it reading as a diagram. Real capitals lean
   forward; this shears the top of the glyph box to the right. */
const SLANT = 0.26;

/* ─────────────────────────────────────────────────────────────────────────
 * WHAT MAKES IT READ AS WRITING RATHER THAN AS SLANTED PRINT.
 *
 * The first version drew textbook letterforms on a perfect baseline and
 * looked exactly like that: legible, leaning, and obviously produced by a
 * machine. Three things fix it, and all three are derived from the letter
 * itself rather than from a random number, so the same name still produces
 * the same mark every time.
 *
 * A hand does not place two letters at identical heights or identical
 * sizes, and it does not start and stop dead on the letter: there is a
 * lead-in where the pen lands and a flick where it leaves.
 * ───────────────────────────────────────────────────────────────────────── */

/** A small, stable number in -1..1 for a character. Not random: the same
 *  initials must draw identically on every phone and in every test. */
function wobble(ch: string, salt: number): number {
    const n = (ch.codePointAt(0) ?? 65) * 2654435761 + salt * 40503;
    return (((n % 2000) + 2000) % 2000) / 1000 - 1;
}
/* Vertical band the writing occupies inside the signature box, leaving room
   above and below so it does not touch the edges of the pad. */
const TOP = 0.18;
const HEIGHT = 0.48;

/**
 * Strokes that draw these initials as handwriting, in the 0..1 box the
 * signature format uses.
 *
 * Returns an empty array when there is nothing drawable, so a caller can use
 * the length as "is there a mark" without a second check.
 */
export function handwrittenInitials(name: string): Stroke[] {
    const mark = initialsOf(name);
    if (mark === '') return [];

    const letters = [...mark].map((ch) => GLYPHS[ch] ?? GLYPHS[FALLBACK[ch] ?? ''] ?? null);
    if (letters.some((g) => g === null)) return [];

    /* Two letters take a little over half the width, centred, which is where
       somebody signing a box puts their initials. */
    const count = letters.length;
    const glyphWidth = count === 1 ? 0.26 : 0.3;
    const gap = 0.06;
    const total = count * glyphWidth + (count - 1) * gap;
    const startX = (1 - total) / 2;

    const out: Stroke[] = [];
    /* A plausible pen speed. The times are not used for anything except
       replay, but a signature with every point at t=0 would look like a
       teleport if anything ever animates it. */
    let t = 0;

    const chars = [...mark];
    letters.forEach((glyph, index) => {
        const ch = chars[index] ?? 'A';
        /* A hand does not place two letters at the same height or draw them
           at the same size. Both are derived from the letter, so the mark is
           still identical every time this name is typed. */
        const drift = wobble(ch, 1) * 0.045;
        const scale = 1 + wobble(ch, 2) * 0.07;
        const left = startX + index * (glyphWidth + gap);

        const place = (gx: number, gy: number): Point => {
            const y = TOP + drift + gy * HEIGHT * scale;
            /* Shear: the higher up the glyph, the further right. */
            const lean = (1 - gy) * SLANT * glyphWidth;
            const x = left + gx * glyphWidth + lean;
            t += 6;
            return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), t };
        };

        glyph!.forEach((path, pathIndex) => {
            const sampled = smooth(path);
            const stroke: Point[] = [];

            /* The pen lands before the letter and leaves after it. Only on
               the first and last stroke of a glyph, because a lead-in on
               every crossbar would look like scribble.

               Built in drawing order rather than unshifted afterwards: place()
               stamps an increasing time, so a lead-in created after the letter
               and pushed to the front would carry a timestamp later than the
               points behind it, and a replay would run backwards. */
            if (pathIndex === 0) {
                const first = sampled[0]!;
                stroke.push(place(first[0] - 0.14, first[1] + 0.08));
            }
            for (const [gx, gy] of sampled) stroke.push(place(gx, gy));
            if (pathIndex === glyph!.length - 1) {
                const last = sampled[sampled.length - 1]!;
                stroke.push(place(last[0] + 0.16, last[1] - 0.1));
            }

            if (stroke.length > 1) out.push(stroke);
            /* A pen lift between strokes. */
            t += 90;
        });
    });

    /* The underline people put beneath their initials. Drawn as one sweep
       that rises slightly to the right, which is what a hand does. */
    const baseY = TOP + HEIGHT + 0.08;
    const swash: Point[] = smooth([
        [startX - 0.03, baseY + 0.01],
        [startX + total * 0.35, baseY + 0.035],
        [startX + total * 0.75, baseY - 0.01],
        [startX + total + 0.05, baseY - 0.05],
    ]).map(([x, y]) => {
        t += 5;
        return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), t };
    });
    if (swash.length > 1) out.push(swash);

    return out;
}
