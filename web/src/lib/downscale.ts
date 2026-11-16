/* Making a photograph smaller before it leaves the phone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * On 16 November the contract manager asked for the proof of delivery
 * bundle covering 2 to 15 November: 1,838 documents, about 3.3 GB, against
 * a ceiling of 3.0 GB. The ceiling is not arbitrary -- client-portal.ts
 * explains it -- and the range was not unreasonable. It was a fortnight of
 * one contract.
 *
 * 3.3 GB over 1,838 documents is about 1.8 MB each, and nearly all of that
 * is one photograph. Nothing in this application had ever made a picture
 * smaller: the file the camera handed the browser was the file that went
 * into the bucket, into the proof of delivery, and into the bundle. A
 * modern phone camera produces a twelve-megapixel JPEG around two
 * megabytes. A photograph of a signed form printed at about five inches
 * across a page does not need twelve megapixels; it needs to be LEGIBLE,
 * which is a far lower bar and the only one that matters here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IN THE BROWSER, AND NOT ON THE SERVER.
 *
 * Two reasons, and the second is the one that decided it.
 *
 * FIRST: the bytes are already here. core/files/storage.ts is built so that
 * a photograph of a patient's front door never touches the application
 * server -- the browser is handed a signed PUT and uploads straight to S3.
 * Resizing on the server would mean fetching every picture back out of the
 * bucket, through a process that was deliberately kept out of the path, and
 * writing it again. Resizing here costs one decode on a device that already
 * holds the file, and it SAVES the driver's upload: four fifths of the
 * bytes never go over cellular from a pharmacy car park.
 *
 * SECOND: there is no image library on the server and adding one is not a
 * small act. The only serious option is a native binary (libvips), which on
 * Render means a build that can fail for reasons that have nothing to do
 * with this code, and which still would not read HEIC without more. The
 * browser already contains a decoder and an encoder for every format a
 * phone can produce, including HEIC on the iPhones that make it. This file
 * is a hundred lines using what is already there; the alternative is a
 * dependency, a build risk and a decoder we would own.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT FIXES BY ACCIDENT, WHICH IS WORTH SAYING OUT LOUD.
 *
 * HEIC AND WEBP WERE BEING STORED AND NEVER PRINTED. The upload path
 * accepts image/jpeg, image/png, image/webp and image/heic. The PDF writer
 * embeds JPEG and PNG and nothing else (core/pdf/writer.ts). So a HEIC
 * proof of delivery was stored, bound to the order, shown on every screen,
 * and ABSENT from the document that goes to University Health -- the exact
 * fault core/pdf/png.ts was written to fix, still open for two of the four
 * types. Everything that comes out of here is a JPEG, so that hole closes
 * for anything taken from today on.
 *
 * THE EXIF GOES. A canvas re-encode carries no metadata, and the metadata a
 * phone camera writes includes GPS coordinates. This platform refuses to
 * send a patient's address to any outside service -- see the geocoding
 * BAA gate -- while quietly uploading the latitude and longitude of their
 * front door inside every doorstep photograph. That stops here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT IS ALLOWED TO GIVE UP.
 *
 * Every failure answers null, and null means "send what the camera gave
 * us". A browser too old for OffscreenCanvas, a decoder that cannot read
 * the file, a canvas that will not hand back a blob: none of those is a
 * reason to stop a driver at a door. The worst case is the behaviour we
 * had last week, which was working.
 *
 * That is also why the size checks below prefer the ORIGINAL on a tie. A
 * re-encode that saves nothing has only lost detail.
 */

/** The longest edge we keep, in pixels.
 *
 *  A proof of delivery prints its photograph about five inches across, so
 *  2,048 px is roughly 400 dpi on the page -- several times what a reader
 *  needs to make out a signature, and chosen there deliberately. The
 *  picture is also opened full-screen in the portal and zoomed into, and
 *  the cost of being generous is a few hundred kilobytes. A twelve-
 *  megapixel camera photograph is around 4,000 px on the long edge, so this
 *  is a halving in each direction: a quarter of the pixels. */
export const TARGET_EDGE = 2048;

/** JPEG quality. 0.82 is the usual place to sit: visually indistinguishable
 *  from the original at this size, and roughly half the bytes of 0.95. */
export const JPEG_QUALITY = 0.82;

/** Below this, an image already within TARGET_EDGE is left alone rather
 *  than re-encoded. Re-encoding a small JPEG trades real detail for a
 *  saving measured in kilobytes, which is a bad trade on a signature. */
export const LEAVE_ALONE_BYTES = 600 * 1024;

/** How long to wait for a decode before giving up and sending the original.
 *  A twenty-megabyte HEIC on a four-year-old Android is seconds, not
 *  minutes; this is here so that a decoder which never settles cannot wedge
 *  the upload queue behind it for the rest of the shift. */
export const DECODE_TIMEOUT_MS = 20_000;

const JPEG = 'image/jpeg';

/** What a proof of delivery can actually carry. See the header: a type
 *  outside this list is converted even when conversion makes it bigger,
 *  because the alternative is a document with no picture in it. */
const PRINTABLE = [JPEG, 'image/png'];

export interface Smaller {
    blob: Blob;
    /** Always image/jpeg. Named rather than assumed because the caller has
     *  to declare it to the file service BEFORE the upload is signed, and a
     *  declaration that disagrees with the bytes is a 403 from S3. */
    contentType: string;
}

/** White, then the picture. PNG and HEIC can both carry transparency and
 *  JPEG cannot, so without this a form scanned with a transparent border
 *  arrives on a black one. core/pdf/png.ts composites onto white for the
 *  same reason and the two should agree. */
function paint(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, w: number, h: number): void {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
}

/** A JPEG of the bitmap at the given size, or null if this browser cannot.
 *  OffscreenCanvas first because it does not touch the document; a DOM
 *  canvas is the fallback for anything older. */
async function toJpeg(bitmap: ImageBitmap, w: number, h: number): Promise<Blob | null> {
    if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
        if (!ctx || typeof canvas.convertToBlob !== 'function') return null;
        paint(ctx, bitmap, w, h);
        return await canvas.convertToBlob({ type: JPEG, quality: JPEG_QUALITY });
    }
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.toBlob !== 'function') return null;
    paint(ctx, bitmap, w, h);
    return await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, JPEG, JPEG_QUALITY); });
}

/** Resolves null if the promise has not settled in time. The work carries
 *  on and is discarded; we only stop waiting for it. */
async function inTime<T>(work: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DECODE_TIMEOUT_MS); }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * A smaller copy of this photograph, or null to send the original.
 *
 * NEVER THROWS and never upscales. Callers treat null as "nothing to do"
 * rather than as a failure, because on the only path that matters -- a
 * driver at a door with a signed form -- it is not one.
 */
export async function smallerPhoto(blob: Blob, contentType: string): Promise<Smaller | null> {
    /* jsdom has neither, and neither does a browser old enough to matter.
       Both answer the same way: leave it alone. */
    if (typeof createImageBitmap !== 'function') return null;
    if (blob.size === 0) return null;

    let bitmap: ImageBitmap | null = null;
    try {
        /* `from-image` applies the EXIF orientation. Without it every
           portrait photograph from an iPhone arrives on its side, because
           the camera stores the sensor's landscape frame plus a rotation
           flag and the canvas does not read flags. */
        bitmap = await inTime(createImageBitmap(blob, { imageOrientation: 'from-image' }));
    } catch {
        return null;
    }
    if (!bitmap) return null;

    try {
        const longest = Math.max(bitmap.width, bitmap.height);
        if (longest === 0) return null;

        const scale = Math.min(1, TARGET_EDGE / longest);
        const printable = PRINTABLE.includes(contentType);

        /* Already small in both senses, and in a format the document can
           carry. Nothing to gain and detail to lose. */
        if (scale === 1 && blob.size <= LEAVE_ALONE_BYTES && printable) return null;

        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const out = await toJpeg(bitmap, w, h);
        if (!out || out.size === 0) return null;

        /* A tie goes to the original -- but only if the original is a
           format a proof of delivery can print. A HEIC that re-encodes
           LARGER is still the better one to keep, because the alternative
           is a document with a line of text where the photograph should
           be. See the header. */
        if (out.size >= blob.size && printable) return null;

        return { blob: out, contentType: JPEG };
    } catch {
        return null;
    } finally {
        /* Frees the decoded pixels now rather than at the next collection.
           A twelve-megapixel decode is about 48 MB of RGBA and a courier
           may photograph four things at one door. */
        bitmap.close?.();
    }
}
