#!/usr/bin/env node
/* Drop the alpha channel from a PNG.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL.
 *
 * Apple rejects an app icon that has an alpha channel. Not a transparent
 * icon: an icon with the CHANNEL, even when every pixel in it is fully
 * opaque. assets/README.md says so and it is one of the commonest reasons a
 * first submission comes back.
 *
 * A browser canvas always emits RGBA, so anything rasterised that way is
 * colour type 6 and would be rejected. There is no image library in this
 * project and adding one to delete four bytes per pixel is a dependency with
 * a lifetime of one command, so this reads the PNG, undoes the row filters,
 * drops the fourth channel and writes colour type 2.
 *
 * It is deliberately NOT a general PNG tool. It handles 8-bit RGBA
 * non-interlaced, which is what a canvas produces, and refuses anything else
 * rather than guessing. A tool that silently mangled an icon would be worse
 * than no tool, because the result still looks like a PNG.
 *
 *   node scripts/strip-alpha.mjs assets/icon.png
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
    console.error('usage: node scripts/strip-alpha.mjs <file.png>');
    process.exit(1);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const buf = fs.readFileSync(file);
if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    console.error(`${file} is not a PNG.`);
    process.exit(1);
}

/* ------------------------------------------------------------- read it */

const chunks = [];
let at = 8;
while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('ascii');
    const data = buf.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data });
    at += 12 + length;
}

const ihdr = chunks.find((c) => c.type === 'IHDR');
if (!ihdr) { console.error('no IHDR'); process.exit(1); }
const width = ihdr.data.readUInt32BE(0);
const height = ihdr.data.readUInt32BE(4);
const bitDepth = ihdr.data[8];
const colourType = ihdr.data[9];
const interlace = ihdr.data[12];

if (colourType === 2) {
    console.log(`${file} already has no alpha channel. Nothing to do.`);
    process.exit(0);
}
/* Refuses rather than guesses: see the header. */
if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
    console.error(`${file}: expected 8-bit RGBA non-interlaced, got bitDepth ${bitDepth}, colourType ${colourType}, interlace ${interlace}.`);
    process.exit(1);
}

const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));

/* ------------------------------------------------- undo the row filters
 *
 * Each scanline is prefixed with a filter byte and encoded against the row
 * above and the pixel to the left. Reconstructing is the inverse, in order,
 * because every row depends on the one before it.
 */
const BPP = 4;
const stride = width * BPP;
const pixels = Buffer.alloc(height * stride);

for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

    for (let i = 0; i < stride; i += 1) {
        const left = i >= BPP ? out[i - BPP] : 0;
        const up = prior ? prior[i] : 0;
        const upLeft = prior && i >= BPP ? prior[i - BPP] : 0;
        let value;
        switch (filter) {
            case 0: value = line[i]; break;
            case 1: value = line[i] + left; break;
            case 2: value = line[i] + up; break;
            case 3: value = line[i] + ((left + up) >> 1); break;
            case 4: {
                /* Paeth: whichever of the three neighbours the gradient is
                   closest to. */
                const p = left + up - upLeft;
                const dl = Math.abs(p - left);
                const du = Math.abs(p - up);
                const dul = Math.abs(p - upLeft);
                value = line[i] + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft);
                break;
            }
            default:
                console.error(`unknown row filter ${filter} on line ${y}`);
                process.exit(1);
        }
        out[i] = value & 0xff;
    }
}

/* --------------------------------------------- drop the fourth channel
 *
 * Composited onto white rather than simply discarded. Every pixel in an icon
 * like this is opaque so the two are the same answer, but a part-transparent
 * pixel discarded would keep whatever colour happened to be under it, and a
 * halo round the artwork is exactly the kind of thing nobody notices until it
 * is on a store listing.
 */
let madeOpaque = 0;
const rgbStride = width * 3;
const outRaw = Buffer.alloc(height * (rgbStride + 1));
for (let y = 0; y < height; y += 1) {
    outRaw[y * (rgbStride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
        const i = y * stride + x * BPP;
        const o = y * (rgbStride + 1) + 1 + x * 3;
        const a = pixels[i + 3] / 255;
        if (a < 1) madeOpaque += 1;
        outRaw[o] = Math.round(pixels[i] * a + 255 * (1 - a));
        outRaw[o + 1] = Math.round(pixels[i + 1] * a + 255 * (1 - a));
        outRaw[o + 2] = Math.round(pixels[i + 2] * a + 255 * (1 - a));
    }
}

/* -------------------------------------------------------------- write it */

const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

const crc32 = (b) => {
    let c = -1;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
};

const newIhdr = Buffer.alloc(13);
newIhdr.writeUInt32BE(width, 0);
newIhdr.writeUInt32BE(height, 4);
newIhdr[8] = 8;
newIhdr[9] = 2; // truecolour, no alpha
newIhdr[10] = 0;
newIhdr[11] = 0;
newIhdr[12] = 0;

fs.writeFileSync(file, Buffer.concat([
    SIGNATURE,
    chunk('IHDR', newIhdr),
    chunk('IDAT', zlib.deflateSync(outRaw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]));

console.log(`${file}: alpha removed, ${width}x${height}, colour type 2`);
if (madeOpaque > 0) {
    console.log(`  ${madeOpaque} part-transparent pixels were composited onto white.`);
}
