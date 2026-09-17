/* A signature, in numbers (ticket 7.5).
 *
 * The server stores strokes rather than an image, and has since the web
 * signature pad: points in a 0..1 box with a millisecond offset, so the same
 * signature renders on a proof of delivery at any size and weighs almost
 * nothing on a cellular link. This is the phone's half of that, kept pure so
 * the awkward parts are testable without a finger.
 *
 * NORMALISED AGAINST THE PAD, NOT THE SCREEN. A phone rotated, a tablet, a
 * small pad on a cramped screen: the same scrawl has to produce the same
 * numbers, or a signature captured on one device and printed from another
 * comes out stretched. So every point is divided by the pad it was drawn in
 * and clamped, which also means a finger dragged past the edge cannot produce
 * a point the server will refuse.
 *
 * WHAT COUNTS AS A SIGNATURE. Not a tap. Somebody handing over a controlled
 * substance needs a mark that was meant, and a single dot is what a phone
 * records when it is jostled in a pocket. `looksSigned` is that line, and it
 * is deliberately low: this is about refusing an accident, not about judging
 * anybody's handwriting.
 */

export interface Point {
    x: number;
    y: number;
    /** Milliseconds since the first point of the signature. */
    t: number;
}

export type Stroke = Point[];

/** The server's caps, mirrored so the pad never builds a refused payload. */
export const MAX_STROKES = 200;
export const MAX_POINTS_PER_STROKE = 2000;

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** One point, from pad coordinates into the 0..1 box the server wants. */
export function toPoint(x: number, y: number, width: number, height: number, msSinceStart: number): Point {
    return {
        x: clamp(width > 0 ? x / width : 0),
        y: clamp(height > 0 ? y / height : 0),
        t: Math.max(0, Math.round(msSinceStart)),
    };
}

/**
 * Trim to what the server will take, keeping the shape.
 *
 * Every other point rather than the first N: a signature cut off half way
 * through is a different signature, and one drawn at half the sample rate is
 * the same one.
 */
export function fit(strokes: Stroke[]): Stroke[] {
    let kept = strokes.filter((s) => s.length > 0).slice(0, MAX_STROKES);
    kept = kept.map((stroke) => {
        let points = stroke;
        while (points.length > MAX_POINTS_PER_STROKE) {
            points = points.filter((_, i) => i % 2 === 0);
        }
        return points;
    });
    return kept;
}

/** Enough of a mark to be a signature rather than a jostle. */
export function looksSigned(strokes: Stroke[]): boolean {
    const points = strokes.reduce((n, s) => n + s.length, 0);
    if (points < 8) return false;
    /* And it has to go somewhere. Eight points in the same spot is a finger
       resting on the glass. */
    const all = strokes.flat();
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const spread = Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys));
    return spread > 0.05;
}

/** An SVG path for one stroke, for drawing it back on the pad. */
export function toPath(stroke: Stroke, width: number, height: number): string {
    if (stroke.length === 0) return '';
    const at = (p: Point) => `${(p.x * width).toFixed(1)},${(p.y * height).toFixed(1)}`;
    const [first, ...rest] = stroke;
    return `M${at(first!)}${rest.map((p) => `L${at(p)}`).join('')}`;
}
