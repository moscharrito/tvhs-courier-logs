/* How the reader is started, which is where two deploys went.
 *
 * Nothing here reads a sheet: that needs a worker and four megabytes of
 * WebAssembly, and picking the right number out of the text is tested in
 * phone-scan.test.ts without any of it. What IS tested is the handful of
 * options that decide whether the reader starts at all, because every one
 * of them fails in the same silent way -- no 404, nothing in a console,
 * and a page that says it could not start.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createWorker = vi.fn();
vi.mock('tesseract.js', () => ({ createWorker: (...a: unknown[]) => createWorker(...a) }));

/** A video the page would have been playing, and a canvas to copy it into. */
function framed() {
    const ctx = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4 * 4) })),
        putImageData: vi.fn(),
    };
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        if (tag !== 'canvas') throw new Error(`unexpected ${tag}`);
        return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLElement;
    }) as typeof document.createElement);
    return { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
}

const working = () => ({
    setParameters: vi.fn(async () => {}),
    recognize: vi.fn(async () => ({ data: { text: 'Mobile: 210-555-0147' } })),
});

beforeEach(() => {
    vi.resetModules();
    createWorker.mockReset();
    vi.restoreAllMocks();
});

/** Fresh each time: the module holds one worker for the life of the page. */
const load = async () => import('./read-sheet');

describe('how the worker is started', () => {
    it('does NOT let tesseract build it from a blob URL', async () => {
        /* THE ONE THAT COST TWO DEPLOYS. tesseract.js defaults
           workerBlobURL to true, which means it ignores the path it was
           handed and instead starts the worker from a one-line Blob that
           importScripts that path. Our policy is worker-src 'self' and
           does not include blob:, so the Worker constructor throws after
           every asset has downloaded perfectly -- no 404, nothing logged,
           and a page saying the reader would not start.

           Pinned because it is invisible: every example in the library's
           own documentation omits it, so it comes back the moment
           somebody pastes one. */
        createWorker.mockResolvedValue(working());
        const { readDigits } = await load();
        await readDigits(framed());

        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(createWorker.mock.calls[0]![2]).toMatchObject({ workerBlobURL: false });
    });

    it('loads every file from our own origin, because no CDN is allowed', async () => {
        /* script-src 'self', connect-src 'self', worker-src 'self' and no
           CDN anywhere. Left to its defaults tesseract fetches all three
           of these from jsdelivr, and each one fails as a silent hang. */
        createWorker.mockResolvedValue(working());
        const { readDigits } = await load();
        await readDigits(framed());

        const opts = createWorker.mock.calls[0]![2] as Record<string, string>;
        for (const key of ['workerPath', 'corePath', 'langPath']) {
            expect(opts[key], key).toMatch(/^\/vendor\/tesseract/);
        }
    });

    it('asks for digits and the things between them, and no letters', async () => {
        /* A reader that may not return an S is much less likely to offer
           one where a 5 belongs. phone-scan.ts forgives the substitution
           anyway; this only narrows the alphabet. */
        const made = working();
        createWorker.mockResolvedValue(made);
        const { readDigits } = await load();
        await readDigits(framed());

        const [opts] = made.setParameters.mock.calls[0]! as unknown as [{ tessedit_char_whitelist: string }];
        expect(opts.tessedit_char_whitelist).toMatch(/^[0-9]{10}/);
        /* No letter may be returned at all. */
        expect(opts.tessedit_char_whitelist).not.toMatch(/[A-Za-z]/);
    });

    it('may return a comma and a slash, which separate two numbers', async () => {
        /* A RECIPIENT panel carrying "210-555-0147, 210-555-0199" is
           ordinary. Without these two characters on the list the reader
           returns its best guess at a DIGIT in their place, or nothing,
           and phone-scan.ts is handed one twenty-digit run instead of a
           pair -- so the sheet with two numbers on it found neither. */
        const made = working();
        createWorker.mockResolvedValue(made);
        const { readDigits } = await load();
        await readDigits(framed());

        const [opts] = made.setParameters.mock.calls[0]! as unknown as [{ tessedit_char_whitelist: string }];
        expect(opts.tessedit_char_whitelist).toContain(',');
        expect(opts.tessedit_char_whitelist).toContain('/');
    });

    it('starts the worker once however often it is used', async () => {
        /* The core is megabytes. Instantiating it per press would make
           the second scan as slow as the first. */
        createWorker.mockResolvedValue(working());
        const { readDigits } = await load();
        const el = framed();
        await readDigits(el);
        await readDigits(el);
        expect(createWorker).toHaveBeenCalledTimes(1);
    });
});

/* ── WHAT IS ACTUALLY READ, which is not what it used to be.
 *
 * The viewfinder is a 4:3 box filled with `object-fit: cover`, and a
 * phone's back camera sends 16:9. A quarter of the frame's width is cut
 * off before the sorter sees any of it, and the crop used to be taken as
 * a fraction of the WHOLE frame -- so the strip read ran well past both
 * edges of the green box, into picture nobody could line anything up in.
 * That is how our own number, printed top right, kept being offered.
 */
describe('which part of the frame is read', () => {
    it('stays inside what the viewfinder is actually showing', async () => {
        const { cropFor } = await load();
        /* 16:9, the ordinary back camera. Cover keeps the middle 75% of
           the width: x from 240 to 1680. */
        const { sx, sw } = cropFor(1920, 1080);
        expect(sx).toBeGreaterThanOrEqual(240);
        expect(sx + sw).toBeLessThanOrEqual(1680);
    });

    it('reads the box that is drawn, and not a wider one', async () => {
        const { cropFor, GUIDE } = await load();
        const { sx, sw } = cropFor(1920, 1080);
        /* The visible window is 1440px wide starting at 240. The guide is
           GUIDE.x into it and GUIDE.w across it. */
        expect(sx).toBe(Math.round(240 + 1440 * GUIDE.x));
        expect(sw).toBe(Math.round(1440 * GUIDE.w));
    });

    it('crops the other way round when the frame is squarer than the box', async () => {
        /* A laptop webcam at 640x480 is exactly 4:3 and loses nothing; a
           4:3 frame must come through whole or the arithmetic is wrong in
           the case that has no crop to get wrong. */
        const { cropFor, GUIDE } = await load();
        const { sx, sy, sw, sh } = cropFor(640, 480);
        expect(sx).toBe(Math.round(640 * GUIDE.x));
        expect(sy).toBe(Math.round(480 * GUIDE.y));
        expect(sw).toBe(Math.round(640 * GUIDE.w));
        expect(sh).toBe(Math.round(480 * GUIDE.h));
    });

    it('is the same rectangle the stylesheet draws', async () => {
        /* THE INVARIANT THIS FILE'S HEADER ASKS FOR, and until now it was
           asked for in prose. GUIDE and .izy-sort-guide are two copies of
           one rectangle, and when they drift the sorter lines up a number
           that is not the one being read -- which looks exactly like bad
           recognition and is not. There is no way to share the value:
           the box has to be a CSS percentage to sit over the video. So
           the stylesheet is read here instead. */
        const { GUIDE } = await load();
        /* From the project root, not import.meta.url: Vite serves this
           module over http, so its URL has no file scheme to resolve. */
        const css = readFileSync('src/styles.css', 'utf8');
        const rule = /\.izy-sort-guide\s*\{[^}]*?left:\s*([\d.]+)%;\s*top:\s*([\d.]+)%;\s*width:\s*([\d.]+)%;\s*height:\s*([\d.]+)%/
            .exec(css);
        expect(rule, 'the .izy-sort-guide rule was not found in the shape this test reads')
            .not.toBeNull();
        const [x, y, w, h] = rule!.slice(1, 5).map((n) => Number(n) / 100);
        expect({ x, y, w, h }).toEqual(GUIDE);
    });

    it('is wide enough that a sheet does not have to be lined up sideways', async () => {
        /* The bench asked for this on 25 November. Pinned as a floor
           rather than an exact value so the box can be tuned without a
           test to edit, but not quietly narrowed back. */
        const { GUIDE } = await load();
        expect(GUIDE.w).toBeGreaterThanOrEqual(0.92);
        expect(GUIDE.x + GUIDE.w).toBeLessThanOrEqual(1);
    });
});

describe('when it will not start', () => {
    it('says which step failed, and keeps what the browser said', async () => {
        /* "The reader could not start" was the whole of the report, and
           it was the same eleven words for a missing file, a refused
           worker and a browser without WebAssembly. Two wrong diagnoses
           came out of that before the real one. */
        createWorker.mockRejectedValue(new DOMException('Refused to create a worker', 'SecurityError'));
        const { readDigits } = await load();

        await expect(readDigits(framed())).rejects.toThrow(/Failed starting the reader/);
        await expect(readDigits(framed())).rejects.toThrow(/Refused to create a worker/);
    });

    it('tries again next press rather than staying broken', async () => {
        /* The promise is cleared on failure. Caching a rejection would
           mean a sorter whose first scan hit a hiccup had to reload the
           page, and nothing on the screen would say so. */
        createWorker.mockRejectedValueOnce(new Error('one bad moment'));
        createWorker.mockResolvedValue(working());
        const { readDigits } = await load();
        const el = framed();

        await expect(readDigits(el)).rejects.toThrow();
        await expect(readDigits(el)).resolves.toMatch(/210-555-0147/);
    });

    it('will not read a frame the camera has not filled yet', async () => {
        createWorker.mockResolvedValue(working());
        const { readDigits } = await load();
        await expect(readDigits({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement))
            .rejects.toThrow(/has not sent a picture yet/);
        expect(createWorker).not.toHaveBeenCalled();
    });
});
