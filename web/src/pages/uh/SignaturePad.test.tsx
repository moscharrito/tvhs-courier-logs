/* The signature pad itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE TESTS LIVED IN Pickup.test.tsx UNTIL 19 OCTOBER.
 *
 * They were written there because that is where the pad was, and they moved
 * with it twice: first onto the courier's countersignature when the
 * pharmacy's pad was replaced by a photograph of the signed form, and then
 * out of that screen entirely when University Health confirmed that both
 * signatures are taken on physical paper at every point and the driver
 * photographs the completed form at the final delivery.
 *
 * They are kept, against the component, because every one of them is a real
 * bug that was found and fixed rather than a guess about how a canvas
 * behaves. Where the pad is rendered is a product decision; that a fast
 * stroke must not collapse to its endpoints is not.
 *
 * The pad is still used for historic records: strokes captured before the
 * paper process are drawn on the proof-of-delivery document, and a handover
 * recorded with one still means what it meant.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import { useState } from 'react';
import { SignaturePad, pointCount, type SignatureStrokes } from './SignaturePad';

/* The pad watches its own box so a rotated phone re-maps the 0..1 space.
   jsdom has no ResizeObserver; the screens that used to host these tests got
   one from their own mounting. A no-op is enough: every test here sets the
   box explicitly. */
vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
});

/** The pad is controlled, so a test needs something to hold the strokes. */
function Harness({ onStrokes }: { onStrokes?: (s: SignatureStrokes) => void }) {
    const [strokes, setStrokes] = useState<SignatureStrokes>([]);
    return (
        <>
            <SignaturePad
                label="Signature"
                strokes={strokes}
                onChange={(s) => { setStrokes(s); onStrokes?.(s); }}
            />
            <output data-testid="points">{pointCount(strokes)}</output>
        </>
    );
}

/** A pad with a known box, so clientX/clientY map to the 0..1 space. */
function padOf() {
    const pad = screen.getByRole('application', { name: 'Signature' });
    pad.getBoundingClientRect = () => ({
        left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    if (!pad.setPointerCapture) pad.setPointerCapture = () => {};
    pad.releasePointerCapture = () => {};
    return pad;
}

function point(pad: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number, clientY: number) {
    const evt = (createEvent as unknown as Record<string, (el: Element, init: object) => Event>)[type]!(pad, { pointerId: 1 });
    Object.defineProperty(evt, 'clientX', { value: clientX });
    Object.defineProperty(evt, 'clientY', { value: clientY });
    fireEvent(pad, evt);
}

describe('the signature pad', () => {
    it('keeps every point of a fast stroke, not just the ends', () => {
        /* pointermove fires faster than React re-renders and the updates are
           batched, so reading the prop in each handler collapsed the stroke
           to its first and last point per batch: a signature recorded as
           straight lines. This fires a burst synchronously, which is what a
           real finger produces. Before the fix it was 2. */
        let last: SignatureStrokes = [];
        render(<Harness onStrokes={(s) => { last = s; }} />);
        const pad = padOf();

        point(pad, 'pointerDown', 10, 50);
        for (let i = 1; i <= 20; i += 1) point(pad, 'pointerMove', 10 + i * 8, 50 + (i % 2 === 0 ? 20 : -20));
        point(pad, 'pointerUp', 170, 50);

        expect(last).toHaveLength(1);
        // One down plus twenty moves; the up ends the stroke without adding a point.
        expect(last[0]).toHaveLength(21);
    });

    it('captures in a 0..1 box, so the same scrawl is the same numbers on any screen', () => {
        let last: SignatureStrokes = [];
        render(<Harness onStrokes={(s) => { last = s; }} />);
        const pad = padOf();
        point(pad, 'pointerDown', 10, 50);
        point(pad, 'pointerMove', 100, 25);
        point(pad, 'pointerUp', 190, 75);

        for (const p of last[0]!) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(1);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(1);
        }
    });

    it('still records the stroke when the browser refuses pointer capture', () => {
        /* Capture throws on a pointer the browser does not recognise. Losing
           it costs an edge case; letting it throw aborted the signature
           before a single point was kept. */
        render(<Harness />);
        const pad = padOf();
        pad.setPointerCapture = () => { throw new DOMException('InvalidPointerId'); };

        point(pad, 'pointerDown', 10, 50);
        point(pad, 'pointerMove', 80, 20);
        point(pad, 'pointerMove', 140, 60);
        point(pad, 'pointerUp', 140, 60);

        expect(Number(screen.getByTestId('points').textContent)).toBeGreaterThan(2);
    });

    it('clears when asked, so a wrong signature is not submitted', () => {
        render(<Harness />);
        const pad = padOf();
        point(pad, 'pointerDown', 10, 50);
        point(pad, 'pointerMove', 80, 20);
        point(pad, 'pointerMove', 140, 60);
        point(pad, 'pointerUp', 140, 60);
        expect(Number(screen.getByTestId('points').textContent)).toBeGreaterThan(2);

        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(Number(screen.getByTestId('points').textContent)).toBe(0);
    });

    it('counts points across every stroke, not only the first', () => {
        /* pointCount is what every caller used to gate its submit button on,
           and a pad that reported only its first stroke would accept a
           single dot as a signature. */
        expect(pointCount([])).toBe(0);
        expect(pointCount([[{ x: 0, y: 0, t: 0 }], [{ x: 1, y: 1, t: 1 }, { x: 0.5, y: 0.5, t: 2 }]])).toBe(3);
    });
});
