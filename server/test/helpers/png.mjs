/* Build a real PNG, so the decoder is tested against the format rather than
 * against a fixture somebody generated once and nobody can regenerate.
 *
 * Every PNG that matters here is a handful of pixels, and writing them by
 * hand means a test can say "this pixel is red, through a palette, with the
 * Paeth filter on" and check exactly that. A binary fixture cannot be read
 * in a review.
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* The table CRC-32 wants, built once. */
const TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

/**
 * A PNG from raw, UNFILTERED scanlines.
 *
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} spec.colorType  0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA
 * @param {number} [spec.bitDepth=8]
 * @param {Buffer} spec.rows       the pixel bytes, height * stride, no filter bytes
 * @param {Buffer} [spec.palette]  PLTE for colour type 3
 * @param {number} [spec.filter=0] the filter byte to put on every row
 * @param {number} [spec.interlace=0]
 */
export function png({ width, height, colorType, bitDepth = 8, rows, palette, filter = 0, interlace = 0 }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = interlace;

    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    const stride = Math.ceil((width * channels * bitDepth) / 8);

    /* The filter byte in front of every scanline. Filtering itself is the
       encoder's job and these rows arrive unfiltered, so anything other
       than 0 here is a test asking the DECODER to undo arithmetic -- which
       it will, and the result must still be the pixels that went in only
       when the rows were filtered to match. Tests that want a real filter
       pass pre-filtered rows with the matching byte. */
    const parts = [];
    for (let y = 0; y < height; y += 1) {
        parts.push(Buffer.from([filter]));
        parts.push(rows.subarray(y * stride, (y + 1) * stride));
    }

    return Buffer.concat([
        SIGNATURE,
        chunk('IHDR', ihdr),
        ...(palette ? [chunk('PLTE', palette)] : []),
        chunk('IDAT', deflateSync(Buffer.concat(parts))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** A solid RGB rectangle, the commonest shape of all. */
export function solidPng(width, height, [r, g, b]) {
    const rows = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
        rows[i * 3] = r;
        rows[i * 3 + 1] = g;
        rows[i * 3 + 2] = b;
    }
    return png({ width, height, colorType: 2, rows });
}
