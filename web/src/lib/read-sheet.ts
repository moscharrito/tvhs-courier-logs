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
 * workerBlobURL: false, AND IT IS NOT A TUNING KNOB.
 *
 * tesseract.js defaults it to TRUE (constants/defaultOptions.js), which
 * means it does not load the worker from the path it was given. It builds
 * a one-line Blob that importScripts the path, and starts the worker from
 * `blob:`. Our policy is `worker-src 'self'`, which does not include
 * blob:, so the Worker constructor throws before a single file is
 * fetched -- after every asset has downloaded perfectly.
 *
 * That is the shape that cost two deploys: nothing 404s, nothing logs,
 * and the page says the reader would not start. Setting this false makes
 * it `new Worker('/vendor/tesseract/worker.min.js')`, which is same
 * origin and already allowed. The alternative was adding blob: to
 * worker-src, which widens the policy to fix a default we can simply
 * turn off.
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
 *
 * THEY DID NOT AGREE, AND THAT IS WHAT cropFor FIXES.
 *
 * GUIDE is a fraction of the VIEWFINDER, which is a 4:3 box, and the box
 * is filled with `object-fit: cover`. A phone's back camera hands over a
 * 16:9 frame, so a quarter of its width is cropped away before anything
 * is drawn -- and this file was reading the strip as a fraction of the
 * WHOLE frame. The read extended about 190 pixels past each edge of the
 * green box into picture the sorter could not see, which is how our own
 * number, printed top right and nowhere near the guide, kept turning up
 * in the candidates. cropFor maps the drawn box into frame coordinates
 * so the strip read is the strip shown.
 */

/**
 * The guide rectangle, as a fraction of the VIEWFINDER. CSS matches this.
 *
 * Wider than it was, from 25 November: at 88% the bench was still having
 * to line a sheet up left to right, and the whole point of the box is
 * that filling it is something you can do without looking. The width is
 * nearly all of the frame now; the height is unchanged, because the
 * height is what keeps the rest of the sheet's forty numbers out.
 */
export const GUIDE = { x: 0.03, y: 0.38, w: 0.94, h: 0.24 };

/** The viewfinder's shape, from .izy-sort-view's aspect-ratio. */
export const VIEW_ASPECT = 4 / 3;

/**
 * Where the guide actually falls on a camera frame of this size.
 *
 * `object-fit: cover` scales the frame until it fills the 4:3 box and
 * throws the overflow away evenly, so only part of the frame is ever on
 * screen. Everything here is in that visible part.
 */
export function cropFor(fw: number, fh: number): { sx: number; sy: number; sw: number; sh: number } {
    const frame = fw / fh;
    /* How much of the frame survives the crop, each way. A wide frame in
       a squarer box loses width; a square frame in a wide box loses
       height. One of these is always 1. */
    const keepW = frame > VIEW_ASPECT ? VIEW_ASPECT / frame : 1;
    const keepH = frame > VIEW_ASPECT ? 1 : frame / VIEW_ASPECT;
    const offX = (1 - keepW) / 2;
    const offY = (1 - keepH) / 2;
    return {
        sx: Math.round(fw * (offX + GUIDE.x * keepW)),
        sy: Math.round(fh * (offY + GUIDE.y * keepH)),
        sw: Math.max(1, Math.round(fw * GUIDE.w * keepW)),
        sh: Math.max(1, Math.round(fh * GUIDE.h * keepH)),
    };
}

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
            /* ── SAY WHICH STEP FAILED.
             *
             * "The reader could not start" was the whole of what this
             * reported, and it was the same eleven words for a missing
             * file, a blocked worker and a browser with no WebAssembly.
             * Two wrong diagnoses came out of that. Each stage now names
             * itself, so the next failure arrives already half read. */
            let stage = 'loading the reader';
            try {
                const { createWorker } = await import('tesseract.js');
                stage = 'starting the reader';
                const made = await createWorker('eng', 1, {
                    workerPath: '/vendor/tesseract/worker.min.js',
                    corePath: '/vendor/tesseract/',
                    langPath: '/vendor/tesseract',
                    /* See the note at the top: the default starts the
                       worker from a blob: URL, which our policy refuses. */
                    workerBlobURL: false,
                    /* Nothing to a console in a warehouse. */
                    logger: () => {},
                });
            /* DIGITS AND WHAT SEPARATES THEM, nothing else. The reader is
               far less likely to offer an S where a 5 is when S is not a
               character it may return. phone-scan.ts still forgives the
               substitutions, because this only narrows the alphabet and
               does not guarantee it.

               THE COMMA AND THE SLASH EARN THEIR PLACE, added 25 November.
               A RECIPIENT panel often carries two numbers written
               "210-555-0147, 210-555-0199" or with a slash between them.
               Neither character was on this list, so the reader returned
               its best guess at a digit instead -- or nothing, leaving a
               space -- and phone-scan.ts saw one twenty-digit run and
               threw the pair away. They are separators between numbers,
               never characters inside one, which is exactly how
               phone-scan.ts treats them. */
                stage = 'setting the reader up';
                await made.setParameters({
                    tessedit_char_whitelist: '0123456789()-./, ',
                });
                return made;
            } catch (e) {
                /* The cause is kept, not swallowed: a SecurityError from a
                   refused worker and a TypeError from a bad path read very
                   differently once somebody can see which is which.
                
                   NOT `instanceof Error`, which was the first attempt and
                   was wrong in the one case this exists for. A worker
                   refused by the content security policy throws a
                   DOMException, and a DOMException does not reliably pass
                   that check -- so the message was dropped from exactly
                   the failure it was added to explain. Read the property. */
                starting = null;
                const said = typeof (e as { message?: unknown })?.message === 'string'
                    && (e as { message: string }).message !== ''
                    ? `: ${(e as { message: string }).message}`
                    : '';
                throw new Error(`Failed ${stage}${said}`);
            }
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
    /* Through cropFor, not off the raw frame. See the note at the top:
       the viewfinder crops before the sorter sees anything, and reading
       the uncropped fractions meant reading well outside the green box. */
    const { sx, sy, sw, sh } = cropFor(el.videoWidth, el.videoHeight);

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
