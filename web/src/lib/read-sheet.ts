/* Reading characters off a frame of camera, in the browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IN THE BROWSER, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
 *
 * The obvious build sends the photograph to a cloud reader, which is more
 * accurate and would take an afternoon. It is also a photograph of a
 * waybill carrying a patient's name, home address, telephone number and
 * seven prescription numbers, and the business associate agreement signed
 * on 20 November covers an ADDRESS LOOKUP. It does not cover a document
 * reader, and "it is only a photo" is exactly how a disclosure happens
 * that nobody wrote down.
 *
 * So the frame is read here and dropped here. What leaves the handset is
 * ten digits in the body of a POST.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERYTHING IS SERVED FROM OUR OWN ORIGIN.
 *
 * tesseract.js fetches its worker, its WebAssembly core and its language
 * data from a public CDN by default. Under this app's content security
 * policy -- script-src 'self', connect-src 'self', worker-src 'self', and
 * no CDN anywhere, see core/http/security.ts -- every one of those is
 * blocked, and the failure is a silent hang rather than an error anybody
 * could read. All three paths are set below to /vendor/tesseract/, which
 * the build copies out of node_modules.
 *
 * IT ALSO NEEDS 'wasm-unsafe-eval' in script-src, which is a real
 * relaxation and a narrow one: it permits compiling WebAssembly and does
 * NOT permit eval of a JavaScript string. Without it Chrome refuses to
 * instantiate the core.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT READS A STRIP, NOT A PAGE.
 *
 * The sheet has forty-odd numbers on it and the one that matters is not
 * the biggest. Reading the whole page means a second or two of work and a
 * field of candidates to pick between; reading the strip the sorter has
 * lined up in the guide means a handful of characters and usually one
 * answer. The crop below is the guide rectangle the page draws, and the
 * two have to agree -- if the box on screen and the box read here drift
 * apart, a sorter lines up a number that is not the one being read, which
 * looks exactly like bad recognition and is not.
 */

/** The guide rectangle, as a fraction of the frame. CSS matches this. */
export const GUIDE = { x: 0.06, y: 0.38, w: 0.88, h: 0.24 };

/** Recognition is slow on a small image and barely slower on a big one. */
const UPSCALE = 2;

/* Loaded once per page, not per scan: the core is megabytes and
   instantiating it for every press would make the second scan as slow as
   the first. Null until somebody scans, so a sorter who only ever types
   never downloads it. */
let worker: unknown = null;
let starting: Promise<unknown> | null = null;

/** Whether this browser can run the reader at all. */
export function scanSupported(): boolean {
    return typeof WebAssembly === 'object'
        && typeof Worker === 'function'
        && typeof OffscreenCanvas !== 'undefined';
}

interface Recogniser {
    recognize: (image: unknown) => Promise<{ data: { text: string } }>;
}

async function reader(): Promise<Recogniser> {
    if (worker !== null) return worker as Recogniser;
    if (starting === null) {
        /* DYNAMIC, so the core is a separate chunk and the people who
           never open this page never pay for it. */
        starting = (async () => {
            const { createWorker } = await import('tesseract.js');
            const made = await createWorker('eng', 1, {
                workerPath: '/vendor/tesseract/worker.min.js',
                corePath: '/vendor/tesseract/',
                langPath: '/vendor/tesseract',
                /* Nothing to a console in a warehouse. */
                logger: () => {},
            });
            /* DIGITS AND WHAT SEPARATES THEM, nothing else. The reader is
               far less likely to offer an S where a 5 is when S is not a
               character it may return. phone-scan.ts still forgives the
               substitutions, because this only narrows the alphabet and
               does not guarantee it. */
            await made.setParameters({
                tessedit_char_whitelist: '0123456789()-. ',
            });
            return made;
        })();
    }
    worker = await starting;
    return worker as Recogniser;
}

/**
 * The guide strip of this video frame, upscaled and flattened to grey.
 *
 * Grey rather than colour because the reader works on luminance anyway,
 * and a warehouse's overhead lighting puts a colour cast on white paper
 * that costs nothing to remove here.
 */
function strip(el: HTMLVideoElement): HTMLCanvasElement {
    const fw = el.videoWidth;
    const fh = el.videoHeight;
    const sx = Math.round(fw * GUIDE.x);
    const sy = Math.round(fh * GUIDE.y);
    const sw = Math.round(fw * GUIDE.w);
    const sh = Math.round(fh * GUIDE.h);

    const canvas = document.createElement('canvas');
    canvas.width = sw * UPSCALE;
    canvas.height = sh * UPSCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser would not give the page a canvas to read from.');
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
        /* Rec. 601 luma, which is what every reader uses internally. */
        const y = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
        d[i] = y; d[i + 1] = y; d[i + 2] = y;
    }
    ctx.putImageData(px, 0, 0);
    return canvas;
}

/**
 * What the camera can see in the guide, as text.
 *
 * Returns whatever the reader made of it, good or bad. Deciding which of
 * those characters is a telephone number is phone-scan.ts's job, and the
 * two are separate so that the hard part -- picking the patient's number
 * out of forty others -- can be tested without a camera, a worker or
 * four megabytes of WebAssembly.
 */
export async function readDigits(el: HTMLVideoElement): Promise<string> {
    if (el.videoWidth === 0 || el.videoHeight === 0) {
        throw new Error('The camera has not sent a picture yet. Give it a moment and scan again.');
    }
    const canvas = strip(el);
    const got = await (await reader()).recognize(canvas);
    return got.data.text;
}
