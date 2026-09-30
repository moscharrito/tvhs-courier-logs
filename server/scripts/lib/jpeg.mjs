/* A baseline JPEG encoder, greyscale, written from scratch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * The proof of delivery embeds photographs as JPEG, because that is the one
 * format PDF decodes natively (/DCTDecode) and it means the bytes off a
 * courier's camera go in untouched. The rehearsal seed had no camera, so it
 * uploaded a single grey pixel: the database row was right, the S3 object was
 * right, the document said a photograph existed, and what a presenter saw was
 * a blank rectangle half a page tall.
 *
 * So the seed needs to draw. There is no image library in this project and
 * adding one to generate fixtures would be a strange dependency, in the same
 * way that the PDF writer and the SigV4 signer are here rather than pulled in.
 *
 * GREYSCALE ONLY, one component. A photographed paper form is grey anyway, and
 * a single component removes chroma subsampling, the hardest part to get right
 * and the easiest to get subtly wrong.
 *
 * Standard tables from the JPEG specification, Annex K. They are what every
 * decoder is tuned for, and a hand-tuned table would be one more thing that
 * could be the reason an image will not open.
 */

/* Annex K.1, the example luminance quantisation table, in natural order. */
const BASE_QUANT = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
];

/* Natural-order index of each zigzag position. The coefficients are written
 * in this order, and the quantisation table in the header is too. */
const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
];

/* Annex K.3.3. Counts of codes of length 1..16, then the values they map to. */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
    0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
    0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];

/** Quality to an actual table, by the usual libjpeg scaling. */
function quantTable(quality) {
    const q = Math.max(1, Math.min(100, quality));
    const scale = q < 50 ? 5000 / q : 200 - q * 2;
    return BASE_QUANT.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

/** Canonical codes, assigned shortest-first in value order. */
function huffTable(bits, values) {
    const codes = new Map();
    let code = 0;
    let k = 0;
    for (let len = 1; len <= 16; len += 1) {
        for (let i = 0; i < bits[len - 1]; i += 1) {
            codes.set(values[k], { code, length: len });
            k += 1;
            code += 1;
        }
        code <<= 1;
    }
    return codes;
}

/**
 * The entropy-coded stream, MSB first.
 *
 * 0xFF has to be followed by a stuffed 0x00, because 0xFF starts a marker.
 * Forget it and every decoder stops at the first bright block, which is why
 * this is the one thing in here with its own note.
 */
class BitWriter {
    constructor() {
        this.bytes = [];
        this.acc = 0;
        this.count = 0;
    }

    bit(b) {
        this.acc = ((this.acc << 1) | b) & 0xff;
        this.count += 1;
        if (this.count === 8) {
            this.bytes.push(this.acc);
            if (this.acc === 0xff) this.bytes.push(0x00);
            this.acc = 0;
            this.count = 0;
        }
    }

    write(code, length) {
        for (let i = length - 1; i >= 0; i -= 1) this.bit((code >> i) & 1);
    }

    /** Pad the last byte with ones, as the specification requires. */
    flush() {
        while (this.count !== 0) this.bit(1);
    }
}

/* The forward DCT, separable and direct. 4096 multiplies a block, which is
 * slow and does not matter: this runs once to make a fixture, not per frame.
 * A fast integer DCT here would be an optimisation whose bugs look exactly
 * like a slightly wrong picture. */
const COS = new Float64Array(64);
for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}
const scaleOf = (u) => (u === 0 ? Math.SQRT1_2 : 1);

function forwardDct(block, out) {
    for (let v = 0; v < 8; v += 1) {
        for (let u = 0; u < 8; u += 1) {
            let sum = 0;
            for (let y = 0; y < 8; y += 1) {
                for (let x = 0; x < 8; x += 1) sum += block[y * 8 + x] * COS[u * 8 + x] * COS[v * 8 + y];
            }
            out[v * 8 + u] = 0.25 * scaleOf(u) * scaleOf(v) * sum;
        }
    }
}

/** How many bits a signed magnitude needs. */
function category(v) {
    let a = Math.abs(v);
    let n = 0;
    while (a > 0) { n += 1; a >>= 1; }
    return n;
}

/** Negative values are stored as a one's-complement of the magnitude. */
const valueBits = (v, size) => (v < 0 ? v + (1 << size) - 1 : v) & ((1 << size) - 1);

function segment(marker, payload) {
    const head = Buffer.from([0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff]);
    return Buffer.concat([head, payload]);
}

/**
 * Encode a greyscale bitmap as a baseline JPEG.
 *
 * `pixels` is one byte per pixel, row-major, 0 black to 255 white, exactly
 * `width * height` long.
 *
 * Dimensions need not be multiples of eight. The edge is replicated out to the
 * next block boundary rather than padded with black, which would otherwise put
 * a dark fringe along the right and bottom of every picture.
 */
export function encodeJpeg(pixels, width, height, quality = 72) {
    if (pixels.length !== width * height) {
        throw new Error(`expected ${width * height} pixels, got ${pixels.length}`);
    }

    const quant = quantTable(quality);
    const dc = huffTable(DC_BITS, DC_VALS);
    const ac = huffTable(AC_BITS, AC_VALS);

    const zigzagged = Buffer.from(ZIGZAG.map((n) => quant[n]));

    const parts = [
        Buffer.from([0xff, 0xd8]),                                        // SOI
        segment(0xe0, Buffer.concat([                                     // APP0, JFIF
            Buffer.from('JFIF\0', 'latin1'),
            Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
        ])),
        segment(0xdb, Buffer.concat([Buffer.from([0x00]), zigzagged])),   // DQT
        segment(0xc0, Buffer.from([                                       // SOF0
            0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
            0x01,                    // one component
            0x01, 0x11, 0x00,        // id 1, no subsampling, quant table 0
        ])),
        segment(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from(DC_BITS), Buffer.from(DC_VALS)])),
        segment(0xc4, Buffer.concat([Buffer.from([0x10]), Buffer.from(AC_BITS), Buffer.from(AC_VALS)])),
        segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])), // SOS
    ];

    const bw = new BitWriter();
    const block = new Float64Array(64);
    const coef = new Float64Array(64);
    let prevDc = 0;

    const emit = (table, symbol) => {
        const entry = table.get(symbol);
        /* Unreachable with the standard tables, and worth saying so rather
           than writing a silently corrupt stream if it ever is not. */
        if (!entry) throw new Error(`no Huffman code for symbol ${symbol}`);
        bw.write(entry.code, entry.length);
    };

    for (let by = 0; by < height; by += 8) {
        for (let bx = 0; bx < width; bx += 8) {
            for (let y = 0; y < 8; y += 1) {
                const sy = Math.min(by + y, height - 1);
                for (let x = 0; x < 8; x += 1) {
                    const sx = Math.min(bx + x, width - 1);
                    /* Level shift: JPEG works on signed values around zero. */
                    block[y * 8 + x] = pixels[sy * width + sx] - 128;
                }
            }
            forwardDct(block, coef);

            const zz = new Int32Array(64);
            for (let i = 0; i < 64; i += 1) {
                const nat = ZIGZAG[i];
                zz[i] = Math.round(coef[nat] / quant[nat]);
            }

            /* DC is stored as a difference from the previous block, which is
               why the order blocks are visited in is part of the format. */
            const diff = zz[0] - prevDc;
            prevDc = zz[0];
            const dcSize = category(diff);
            emit(dc, dcSize);
            if (dcSize > 0) bw.write(valueBits(diff, dcSize), dcSize);

            let run = 0;
            for (let i = 1; i < 64; i += 1) {
                if (zz[i] === 0) { run += 1; continue; }
                /* A run longer than fifteen needs an explicit zero-run marker;
                   the length field is four bits and cannot say more. */
                while (run > 15) { emit(ac, 0xf0); run -= 16; }
                const size = category(zz[i]);
                emit(ac, (run << 4) | size);
                bw.write(valueBits(zz[i], size), size);
                run = 0;
            }
            if (run > 0) emit(ac, 0x00);   // end of block
        }
    }

    bw.flush();
    parts.push(Buffer.from(bw.bytes));
    parts.push(Buffer.from([0xff, 0xd9]));                                // EOI
    return Buffer.concat(parts);
}
