/* How the reader is started, which is where two deploys went.
 *
 * Nothing here reads a sheet: that needs a worker and four megabytes of
 * WebAssembly, and picking the right number out of the text is tested in
 * phone-scan.test.ts without any of it. What IS tested is the handful of
 * options that decide whether the reader starts at all, because every one
 * of them fails in the same silent way -- no 404, nothing in a console,
 * and a page that says it could not start.
 */

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

        expect(made.setParameters).toHaveBeenCalledWith(
            expect.objectContaining({ tessedit_char_whitelist: '0123456789()-. ' }),
        );
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
