/* Reading a PNG, because the proof of delivery could not print one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * The upload path accepts image/jpeg, image/png, image/webp, image/heic and
 * application/pdf (core/files/storage.ts). The PDF writer embedded JPEG and
 * nothing else, because PDF carries JPEG natively through DCTDecode and the
 * bytes can be copied in untouched.
 *
 * PNG cannot be copied in untouched, so for eighteen months it was not
 * carried at all -- and on 8 November a real collection form on order 902
 * turned out to be a PNG. It was stored, bound to the order, shown on every
 * screen, and absent from the one document that goes to University Health,
 * which printed a line about storage instead. A photograph that exists and
 * cannot be printed is the worst of the three states: nobody goes looking
 * for it, because every screen says it is there.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT DECODES RATHER THAN PASSING THE BYTES THROUGH.
 *
 * PDF's FlateDecode with /Predictor 15 is, by design, the same compression
 * and the same filtering PNG uses, so a non-interlaced truecolour PNG's IDAT
 * can in principle be handed to a PDF reader verbatim. That trick covers
 * colour types 0 and 2 and nothing else: an indexed PNG needs its palette
 * declared, and an image with an alpha channel needs that channel split out
 * into a separate soft mask or it renders as garbage.
 *
 * A scan of a signed form arrives as any of those. A screenshot is usually
 * RGBA. Supporting the two easy types and silently failing the rest would
 * reproduce the exact fault this file was written to fix, one layer down and
 * harder to see. So it inflates, undoes the per-scanline filters, resolves
 * the palette, composites alpha onto WHITE -- a signed form on a white page
 * is what a reader expects, and PDF has no page-colour to inherit -- and
 * deflates one more time as plain 8-bit grey or RGB.
 *
 * The cost is CPU and memory on a document nobody waits on, against a
 * photograph that is either in the record or is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES, AND WHY REFUSING IS THE POINT.
 *
 * Adam7 interlacing and the 40-megapixel ceiling both answer with null, and
 * the caller then prints a line saying the picture could not be embedded.
 * That is a worse document than one with the photograph and a better one
 * than a document that quietly drops it. Interlaced PNGs are seven
 * sub-images with their own filtering and essentially nothing produces them
 * any more; the ceiling exists because the upload cap is on the COMPRESSED
 * bytes, and twenty megabytes of PNG can inflate to several hundred.
 */

import { inflateSync } from 'node:zlib';

/** 8-bit samples, ready for a PDF image XObject. */
export interface PngRaster {
    width: number;
    height: number;
    /** 1 for DeviceGray, 3 for DeviceRGB. There is no alpha by this point. */
    components: 1 | 3;
    data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded pixels we will hold at once. See the header. */
const MAX_PIXELS = 40_000_000;

interface Header {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace: number;
}

/** Samples per pixel for each PNG colour type. Index is the colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function isPng(bytes: Buffer): boolean {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(SIGNATURE);
}

/**
 * Walk the chunks once, collecting the three we care about.
 *
 * Returns null for anything malformed rather than throwing: this runs while
 * a legal record is being produced, and a proof of delivery that 500s
 * because a photograph was truncated is worse than one that says so.
 */
function read(bytes: Buffer): { header: Header; palette: Buffer | null; idat: Buffer } | null {
    if (!isPng(bytes)) return null;
    let at = 8;
    let header: Header | null = null;
    let palette: Buffer | null = null;
    const parts: Buffer[] = [];

    while (at + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(at);
        const type = bytes.toString('latin1', at + 4, at + 8);
        const start = at + 8;
        const end = start + length;
        /* A chunk claiming more than is there. Truncated upload, usually. */
        if (end + 4 > bytes.length) return null;

        if (type === 'IHDR') {
            if (length < 13) return null;
            header = {
                width: bytes.readUInt32BE(start),
                height: bytes.readUInt32BE(start + 4),
                bitDepth: bytes[start + 8]!,
                colorType: bytes[start + 9]!,
                interlace: bytes[start + 12]!,
            };
        } else if (type === 'PLTE') {
            palette = bytes.subarray(start, end);
        } else if (type === 'IDAT') {
            parts.push(bytes.subarray(start, end));
        } else if (type === 'IEND') {
            break;
        }
        at = end + 4;
    }

    if (!header || parts.length === 0) return null;
    return { header, palette, idat: Buffer.concat(parts) };
}

/** The dimensions alone, for a caller sizing a box before it decodes. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
    const parsed = read(bytes);
    if (!parsed) return null;
    const { width, height } = parsed.header;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
}

/** Paeth, from the specification, unchanged. */
function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/**
 * Undo the per-scanline filters, in place, one row at a time.
 *
 * `bpp` is the filter's idea of a pixel: bytes per pixel rounded UP, and 1
 * for anything narrower than a byte. Getting that wrong does not fail, it
 * produces a picture with a diagonal smear, which is why it is named here
 * rather than inlined.
 */
function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Buffer | null {
    const out = Buffer.alloc(height * stride);
    let pos = 0;
    for (let y = 0; y < height; y += 1) {
        if (pos >= raw.length) return null;
        const filter = raw[pos]!;
        pos += 1;
        if (pos + stride > raw.length) return null;
        const row = out.subarray(y * stride, (y + 1) * stride);
        raw.copy(row, 0, pos, pos + stride);
        pos += stride;
        const prior = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);

        switch (filter) {
            case 0: break;
            case 1:
                for (let i = bpp; i < stride; i += 1) row[i] = (row[i]! + row[i - bpp]!) & 0xff;
                break;
            case 2:
                if (prior) for (let i = 0; i < stride; i += 1) row[i] = (row[i]! + prior[i]!) & 0xff;
                break;
            case 3:
                for (let i = 0; i < stride; i += 1) {
                    const left = i >= bpp ? row[i - bpp]! : 0;
                    const up = prior ? prior[i]! : 0;
                    row[i] = (row[i]! + ((left + up) >> 1)) & 0xff;
                }
                break;
            case 4:
                for (let i = 0; i < stride; i += 1) {
                    const left = i >= bpp ? row[i - bpp]! : 0;
                    const up = prior ? prior[i]! : 0;
                    const upLeft = prior && i >= bpp ? prior[i - bpp]! : 0;
                    row[i] = (row[i]! + paeth(left, up, upLeft)) & 0xff;
                }
                break;
            /* An unknown filter byte means the stream is not what it says it
               is. Stop rather than carry on producing plausible nonsense. */
            default: return null;
        }
    }
    return out;
}

/** One sample out of a packed row, for bit depths below 8. */
function sampleAt(row: Buffer, index: number, bitDepth: number): number {
    const perByte = 8 / bitDepth;
    const byte = row[Math.floor(index / perByte)];
    if (byte === undefined) return 0;
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
}

/**
 * A PNG as 8-bit grey or RGB, or null if this file will not carry it.
 *
 * Alpha is composited onto white rather than carried into a soft mask: the
 * pictures this prints are forms and doorsteps, the page behind them is
 * white, and an SMask is a second stream to get wrong for a transparency
 * nothing in evidence photography uses.
 */
export function decodePng(bytes: Buffer): PngRaster | null {
    const parsed = read(bytes);
    if (!parsed) return null;
    const { header, palette, idat } = parsed;
    const { width, height, bitDepth, colorType, interlace } = header;

    if (width <= 0 || height <= 0) return null;
    if (interlace !== 0) return null;
    if (width * height > MAX_PIXELS) return null;

    const channels = CHANNELS[colorType];
    if (channels === undefined) return null;

    /* The depths the specification allows for each colour type, and nothing
       outside them: a 16-bit palette index is not a thing, and accepting one
       would read somebody else's bytes. */
    const depthOk = colorType === 3
        ? [1, 2, 4, 8].includes(bitDepth)
        : colorType === 0
            ? [1, 2, 4, 8, 16].includes(bitDepth)
            : [8, 16].includes(bitDepth);
    if (!depthOk) return null;
    if (colorType === 3 && !palette) return null;

    let raw: Buffer;
    try {
        raw = inflateSync(idat);
    } catch {
        return null;
    }

    const bitsPerPixel = channels * bitDepth;
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
    const rows = unfilter(raw, height, stride, bpp);
    if (!rows) return null;

    /* Grey stays grey. Three bytes a pixel for a scanned form that is black
       on white would triple the document for nothing. */
    const components: 1 | 3 = colorType === 0 || colorType === 4 ? 1 : 3;
    const out = Buffer.alloc(width * height * components);

    /* 16-bit samples are taken by their high byte. PDF supports 16 bits per
       component and no camera or scanner in this contract produces it; the
       top byte is the picture, and the bottom byte is noise a reader of a
       signed form will never miss. */
    const wide = bitDepth === 16;
    const step = wide ? 2 : 1;
    const maxSample = (1 << bitDepth) - 1;

    for (let y = 0; y < height; y += 1) {
        const row = rows.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < width; x += 1) {
            const at = (y * width + x) * components;

            if (colorType === 3) {
                const index = sampleAt(row, x, bitDepth) * 3;
                out[at] = palette![index] ?? 0;
                out[at + 1] = palette![index + 1] ?? 0;
                out[at + 2] = palette![index + 2] ?? 0;
                continue;
            }

            if (bitDepth < 8) {
                /* Greyscale below 8 bits: 1-bit black and white is what a
                   fax-style scan of a docket arrives as. Scale to 0..255 so
                   that a 1 means white rather than almost black. */
                const v = sampleAt(row, x, bitDepth);
                out[at] = Math.round((v / maxSample) * 255);
                continue;
            }

            const base = x * channels * step;
            if (colorType === 0) {
                out[at] = row[base] ?? 0;
            } else if (colorType === 2) {
                out[at] = row[base] ?? 0;
                out[at + 1] = row[base + step] ?? 0;
                out[at + 2] = row[base + 2 * step] ?? 0;
            } else if (colorType === 4) {
                const grey = row[base] ?? 0;
                const alpha = row[base + step] ?? 255;
                out[at] = Math.round((grey * alpha + 255 * (255 - alpha)) / 255);
            } else {
                const alpha = row[base + 3 * step] ?? 255;
                for (let c = 0; c < 3; c += 1) {
                    const v = row[base + c * step] ?? 0;
                    out[at + c] = Math.round((v * alpha + 255 * (255 - alpha)) / 255);
                }
            }
        }
    }

    return { width, height, components, data: out };
}
