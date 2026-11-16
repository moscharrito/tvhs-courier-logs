import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECODE_TIMEOUT_MS, LEAVE_ALONE_BYTES, TARGET_EDGE, smallerPhoto } from './downscale';

/* jsdom has no createImageBitmap, no OffscreenCanvas and a canvas that
   refuses to encode anything, which is the whole reason smallerPhoto is
   written to give up quietly. These tests install just enough of a browser
   to watch it decide, and record what it asked the canvas to do. */

interface Painted { fillRect: number[] | null; drawImage: number[] | null; order: string[] }

function installBrowser(opts: {
    width: number;
    height: number;
    /** Bytes the canvas hands back for a w x h encode. */
    encodedBytes?: (w: number, h: number) => number;
    decode?: 'ok' | 'throws' | 'hangs';
    noConvertToBlob?: boolean;
}): { painted: Painted; sized: { w: number; h: number } | null; bitmapClosed: () => boolean; options: () => unknown } {
    const painted: Painted = { fillRect: null, drawImage: null, order: [] };
    let sized: { w: number; h: number } | null = null;
    let closed = false;
    let seenOptions: unknown = undefined;

    const g = globalThis as unknown as Record<string, unknown>;

    g['createImageBitmap'] = vi.fn((_blob: Blob, options?: unknown) => {
        seenOptions = options;
        if (opts.decode === 'throws') return Promise.reject(new Error('cannot decode'));
        if (opts.decode === 'hangs') return new Promise(() => { /* never */ });
        return Promise.resolve({
            width: opts.width,
            height: opts.height,
            close: () => { closed = true; },
        });
    });

    g['OffscreenCanvas'] = class {
        constructor(public width: number, public height: number) {
            sized = { w: width, h: height };
        }

        getContext(): unknown {
            return {
                fillStyle: '',
                fillRect: (...a: number[]) => { painted.fillRect = a; painted.order.push('fillRect'); },
                drawImage: (_b: unknown, ...a: number[]) => { painted.drawImage = a; painted.order.push('drawImage'); },
            };
        }

        convertToBlob(options: { type: string; quality: number }): Promise<Blob> {
            const w = sized?.w ?? 0;
            const h = sized?.h ?? 0;
            const n = opts.encodedBytes ? opts.encodedBytes(w, h) : Math.round(w * h * 0.1);
            return Promise.resolve(new Blob([new Uint8Array(n)], { type: options.type }));
        }
    };
    if (opts.noConvertToBlob) {
        delete (g['OffscreenCanvas'] as { prototype: Record<string, unknown> }).prototype['convertToBlob'];
    }

    return { painted, get sized() { return sized; }, bitmapClosed: () => closed, options: () => seenOptions };
}

/** A blob of a given size, so the size comparisons have something to compare. */
const sized = (bytes: number, type: string): Blob => new Blob([new Uint8Array(bytes)], { type });

afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g['createImageBitmap'];
    delete g['OffscreenCanvas'];
    vi.useRealTimers();
});

describe('making a camera photograph smaller', () => {
    it('brings the long edge down to the target and keeps the proportions', async () => {
        /* A twelve-megapixel phone photograph, landscape. */
        const browser = installBrowser({ width: 4032, height: 3024 });

        const out = await smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');

        expect(out).not.toBeNull();
        expect(browser.sized).toEqual({ w: TARGET_EDGE, h: Math.round(3024 * (TARGET_EDGE / 4032)) });
        /* 4:3 on the way in is 4:3 on the way out. A form photographed
           square-on and squashed is a form a reader will not trust. */
        expect((browser.sized!.w / browser.sized!.h)).toBeCloseTo(4032 / 3024, 2);
    });

    it('measures the long edge, not the width', async () => {
        /* Portrait, which is how a signed form is actually photographed. */
        const browser = installBrowser({ width: 3024, height: 4032 });

        await smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');

        expect(browser.sized!.h).toBe(TARGET_EDGE);
        expect(browser.sized!.w).toBe(Math.round(3024 * (TARGET_EDGE / 4032)));
    });

    it('never makes a small photograph bigger', async () => {
        /* Scanning at 1 would be an upscale, which costs bytes and adds no
           detail. The picture keeps its own size. */
        const browser = installBrowser({ width: 400, height: 300, encodedBytes: () => 10_000 });

        await smallerPhoto(sized(900_000, 'image/jpeg'), 'image/jpeg');

        expect(browser.sized).toEqual({ w: 400, h: 300 });
    });

    it('asks the decoder to apply the orientation the camera recorded', async () => {
        /* Without this an iPhone's portrait photograph arrives on its side:
           the sensor frame is landscape and the rotation lives in a flag
           that a canvas does not read. */
        const browser = installBrowser({ width: 4032, height: 3024 });

        await smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');

        expect(browser.options()).toEqual({ imageOrientation: 'from-image' });
    });

    it('lays down white before the picture', async () => {
        /* PNG and HEIC carry transparency and JPEG does not. Without the
           fill, a form scanned with a transparent margin arrives on black. */
        const browser = installBrowser({ width: 4032, height: 3024 });

        await smallerPhoto(sized(1_900_000, 'image/png'), 'image/png');

        expect(browser.painted.order).toEqual(['fillRect', 'drawImage']);
        expect(browser.painted.fillRect).toEqual([0, 0, browser.sized!.w, browser.sized!.h]);
    });

    it('releases the decoded pixels', async () => {
        /* Twelve megapixels is about 48 MB of RGBA, and a courier may
           photograph four things at one door. */
        const browser = installBrowser({ width: 4032, height: 3024 });

        await smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');

        expect(browser.bitmapClosed()).toBe(true);
    });
});

describe('leaving a photograph alone', () => {
    it('does not touch one already small in both senses', async () => {
        installBrowser({ width: 1200, height: 900 });

        const out = await smallerPhoto(sized(LEAVE_ALONE_BYTES - 1, 'image/jpeg'), 'image/jpeg');

        /* Re-encoding this would trade real detail on a signature for a
           saving measured in kilobytes. */
        expect(out).toBeNull();
    });

    it('still re-encodes one that is small on screen and heavy on disk', async () => {
        installBrowser({ width: 1200, height: 900, encodedBytes: () => 200_000 });

        const out = await smallerPhoto(sized(LEAVE_ALONE_BYTES + 1, 'image/jpeg'), 'image/jpeg');

        expect(out?.blob.size).toBe(200_000);
    });

    it('keeps the original when the re-encode saves nothing', async () => {
        /* A tie goes to the original: a re-encode that saves nothing has
           only lost detail. */
        installBrowser({ width: 1200, height: 900, encodedBytes: () => 800_000 });

        const out = await smallerPhoto(sized(800_000, 'image/png'), 'image/png');

        expect(out).toBeNull();
    });
});

describe('a format the proof of delivery cannot print', () => {
    /* The upload path takes HEIC and WebP; core/pdf/writer.ts embeds JPEG
       and PNG. So those two were stored, shown on every screen, and absent
       from the document that goes to University Health. */
    it('converts a HEIC even when the JPEG comes out larger', async () => {
        installBrowser({ width: 1000, height: 800, encodedBytes: () => 999_999 });

        const out = await smallerPhoto(sized(500_000, 'image/heic'), 'image/heic');

        expect(out?.contentType).toBe('image/jpeg');
        expect(out?.blob.size).toBe(999_999);
    });

    it('converts a WebP that is already small enough to leave alone', async () => {
        installBrowser({ width: 1000, height: 800, encodedBytes: () => 90_000 });

        const out = await smallerPhoto(sized(1_000, 'image/webp'), 'image/webp');

        expect(out?.contentType).toBe('image/jpeg');
    });

    it('declares the type the bytes actually are', async () => {
        /* The caller sends this to the file service before the upload is
           signed, and S3 refuses a PUT whose body disagrees with the
           content type in the signature. */
        installBrowser({ width: 4032, height: 3024 });

        const out = await smallerPhoto(sized(1_900_000, 'image/heic'), 'image/heic');

        expect(out?.contentType).toBe('image/jpeg');
        expect(out?.blob.type).toBe('image/jpeg');
    });
});

describe('a browser that cannot do it', () => {
    it('gives up when there is no decoder at all', async () => {
        /* jsdom, and anything old enough. The driver still uploads. */
        const out = await smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');
        expect(out).toBeNull();
    });

    it('gives up when the decoder refuses the file', async () => {
        /* Chrome on Android cannot read HEIC. That is not a reason to stop
           somebody at a door. */
        installBrowser({ width: 0, height: 0, decode: 'throws' });

        const out = await smallerPhoto(sized(1_900_000, 'image/heic'), 'image/heic');

        expect(out).toBeNull();
    });

    it('gives up when the canvas will not hand back a blob', async () => {
        installBrowser({ width: 4032, height: 3024, noConvertToBlob: true });

        const out = await smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');

        expect(out).toBeNull();
    });

    it('stops waiting for a decode that never settles', async () => {
        /* Otherwise the rest of the shift queues up behind one picture. */
        vi.useFakeTimers();
        installBrowser({ width: 0, height: 0, decode: 'hangs' });

        const pending = smallerPhoto(sized(1_900_000, 'image/jpeg'), 'image/jpeg');
        await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 1);

        expect(await pending).toBeNull();
    });

    it('gives up on an empty file without asking the decoder', async () => {
        const browser = installBrowser({ width: 10, height: 10 });

        const out = await smallerPhoto(sized(0, 'image/jpeg'), 'image/jpeg');

        expect(out).toBeNull();
        expect(browser.options()).toBeUndefined();
    });
});
