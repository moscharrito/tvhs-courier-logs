/* Capturing a signature with a finger.
 *
 * Records the STROKES, not a picture: points in a 0..1 space, so the capture
 * does not depend on the size of the phone held at the counter and renders
 * crisply at any size on a proof of delivery later.
 *
 * Pointer events rather than touch or mouse events, so a finger, a stylus
 * and a mouse all work through one code path. Pointer capture keeps the
 * stroke alive when the finger slides past the edge of the box, which is what
 * signatures do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SignaturePoint { x: number; y: number; t: number }
export type SignatureStrokes = SignaturePoint[][];

/** An SVG path for one stroke, in the same 0..1 space. */
export function strokePath(stroke: SignaturePoint[], width: number, height: number): string {
    return stroke
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * width).toFixed(1)},${(p.y * height).toFixed(1)}`)
        .join(' ');
}

/** Points across every stroke. Used to tell a signature from a stray tap. */
export const pointCount = (strokes: SignatureStrokes) => strokes.reduce((n, s) => n + s.length, 0);

export function SignaturePad({ strokes, onChange, label, disabled }: {
    strokes: SignatureStrokes;
    onChange: (strokes: SignatureStrokes) => void;
    label: string;
    disabled?: boolean;
}) {
    const boxRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const startedAt = useRef(0);
    /* The authoritative stroke data while a finger is down.
     *
     * pointermove fires far faster than React re-renders, and it batches the
     * updates, so every handler in a burst would otherwise read the same
     * stale `strokes` prop and overwrite the others. The stroke would collapse
     * to its first and last point per batch: a signature recorded as two or
     * three straight lines instead of a curve. Reading and writing a ref
     * keeps every point. */
    const strokesRef = useRef<SignatureStrokes>(strokes);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const box = boxRef.current;
        if (!box) return;
        const measure = () => setSize({ width: box.clientWidth, height: box.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        return () => observer.disconnect();
    }, []);

    const redraw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || size.width === 0) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = size.width * ratio;
        canvas.height = size.height * ratio;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, size.width, size.height);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#14532d';
        for (const stroke of strokes) {
            ctx.beginPath();
            stroke.forEach((p, i) => {
                const x = p.x * size.width;
                const y = p.y * size.height;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            // A single tap is a dot, not an invisible zero-length line.
            if (stroke.length === 1) ctx.lineTo(stroke[0]!.x * size.width + 0.1, stroke[0]!.y * size.height);
            ctx.stroke();
        }
    }, [strokes, size]);

    useEffect(() => { redraw(); }, [redraw]);

    // Follow the parent when it changes the strokes itself, such as Clear.
    useEffect(() => { if (!drawing.current) strokesRef.current = strokes; }, [strokes]);

    const pointFrom = (e: React.PointerEvent): SignaturePoint | null => {
        const box = boxRef.current;
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        // Clamped: a finger that leaves the box should end the stroke at the
        // edge rather than record a point outside the space.
        const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
        /* Drop a point rather than record a broken one. An event without
           usable coordinates would otherwise become NaN, serialise as null,
           and be rejected by the server as a malformed signature after the
           courier had already signed. */
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y, t: Math.max(0, Math.round(performance.now() - startedAt.current)) };
    };

    const down = (e: React.PointerEvent) => {
        if (disabled) return;
        e.preventDefault();
        if (strokesRef.current.length === 0) startedAt.current = performance.now();
        const p = pointFrom(e);
        if (!p) return;
        drawing.current = true;
        /* Capture keeps the stroke alive when the finger slides past the edge
           of the box, but it throws on a pointer the browser does not
           recognise. Losing capture costs an edge case; letting it throw here
           would abort the whole signature before a single point was kept. */
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* draw without it */ }
        const next = [...strokesRef.current, [p]];
        strokesRef.current = next;
        onChange(next);
    };

    const move = (e: React.PointerEvent) => {
        if (!drawing.current || disabled) return;
        e.preventDefault();
        const p = pointFrom(e);
        if (!p) return;
        const next = strokesRef.current.slice();
        const last = next[next.length - 1];
        if (!last) return;
        next[next.length - 1] = [...last, p];
        strokesRef.current = next;
        onChange(next);
    };

    const up = (e: React.PointerEvent) => {
        if (!drawing.current) return;
        drawing.current = false;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    };

    return (
        <div className="izy-sigpad">
            <div className="izy-row-between">
                <span className="izy-sigpad-label">{label}</span>
                <button
                    className="izy-btn secondary"
                    type="button"
                    onClick={() => onChange([])}
                    disabled={disabled || strokes.length === 0}
                >
                    Clear
                </button>
            </div>
            <div
                ref={boxRef}
                className="izy-sigpad-box"
                role="application"
                aria-label={label}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
            >
                <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />
                {strokes.length === 0 && <span className="izy-sigpad-hint">Sign here</span>}
            </div>
        </div>
    );
}
