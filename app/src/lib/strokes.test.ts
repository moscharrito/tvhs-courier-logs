/* A signature, in numbers (ticket 7.5). */

import { describe, it, expect } from 'vitest';
import {
    MAX_POINTS_PER_STROKE, MAX_STROKES,
    fit, looksSigned, toPath, toPoint, type Stroke,
} from './strokes';

const line = (n: number, y = 0.5): Stroke =>
    Array.from({ length: n }, (_, i) => ({ x: i / Math.max(1, n - 1), y, t: i * 10 }));

describe('normalising a point', () => {
    it('puts pad coordinates into the 0..1 box the server wants', () => {
        expect(toPoint(150, 80, 300, 160, 250)).toEqual({ x: 0.5, y: 0.5, t: 250 });
    });

    it('gives the same numbers for the same scrawl on a bigger pad', () => {
        /* A signature captured on a phone and printed from a proof of
           delivery generated elsewhere must not come out stretched. */
        expect(toPoint(150, 80, 300, 160, 0)).toEqual(toPoint(300, 160, 600, 320, 0));
    });

    it('clamps a finger dragged past the edge', () => {
        /* Otherwise the pad builds a payload the server refuses, and the
           courier sees a rejection for signing slightly enthusiastically. */
        expect(toPoint(-20, 400, 300, 160, 0)).toMatchObject({ x: 0, y: 1 });
    });

    it('survives a pad that has not been measured yet', () => {
        expect(toPoint(10, 10, 0, 0, 0)).toMatchObject({ x: 0, y: 0 });
    });

    it('never sends a negative timestamp', () => {
        expect(toPoint(10, 10, 100, 100, -5).t).toBe(0);
    });
});

describe('fitting what the server takes', () => {
    it('leaves an ordinary signature alone', () => {
        const strokes = [line(40), line(25, 0.7)];
        expect(fit(strokes)).toEqual(strokes);
    });

    it('thins a long stroke rather than cutting it off', () => {
        /* A signature truncated half way through is a different signature. At
           half the sample rate it is the same one. */
        const long = line(MAX_POINTS_PER_STROKE + 500);
        const fitted = fit([long])[0]!;
        expect(fitted.length).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE);
        expect(fitted[0]).toEqual(long[0]);
        expect(fitted[fitted.length - 1]!.x).toBeCloseTo(1, 1);
    });

    it('caps how many strokes it will send', () => {
        expect(fit(Array.from({ length: MAX_STROKES + 20 }, () => line(3)))).toHaveLength(MAX_STROKES);
    });

    it('drops empty strokes, which a stray tap produces', () => {
        expect(fit([[], line(10), []])).toHaveLength(1);
    });
});

describe('is that a signature', () => {
    it('accepts a normal one', () => {
        expect(looksSigned([line(30)])).toBe(true);
    });

    it('refuses a tap', () => {
        /* Somebody handing over a controlled substance needs a mark that was
           meant. One dot is what a phone records in a pocket. */
        expect(looksSigned([[{ x: 0.5, y: 0.5, t: 0 }]])).toBe(false);
    });

    it('refuses a finger resting on the glass', () => {
        const still: Stroke = Array.from({ length: 40 }, (_, i) => ({ x: 0.5, y: 0.5, t: i * 10 }));
        expect(looksSigned([still])).toBe(false);
    });

    it('refuses nothing at all', () => {
        expect(looksSigned([])).toBe(false);
    });
});

describe('drawing it back', () => {
    it('builds a path in pad coordinates', () => {
        const path = toPath([{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 10 }], 200, 100);
        expect(path).toBe('M0.0,0.0L200.0,100.0');
    });

    it('says nothing for an empty stroke', () => {
        expect(toPath([], 200, 100)).toBe('');
    });
});
