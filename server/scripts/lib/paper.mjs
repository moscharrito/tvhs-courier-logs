/* Draw the things a courier photographs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT IS NOT.
 *
 * The seed needs a picture of a signed courier form and a picture of an
 * identity document, so that a proof of delivery shown in a demonstration has
 * something on it a person can read. Before this, it uploaded one grey pixel.
 *
 * EVERY NAME, ADDRESS AND NUMBER DRAWN HERE IS INVENTED, and the caller passes
 * them in rather than this file inventing them, so there is exactly one place
 * to look to confirm that. No University Health data, real or sampled, goes
 * anywhere near it.
 *
 * The identity document is drawn as a SPECIMEN, banded and with its fields
 * masked. The real system stores the courier's photograph of a real one, and
 * for a fixture that is both the safer thing to generate and the better thing
 * to put on a screen in front of a room: it shows the capability without
 * producing a picture that would pass as a genuine identity card.
 *
 * Greyscale, one byte a pixel, 0 black to 255 white, because that is what the
 * encoder next door takes and a photographed sheet of paper is grey anyway.
 */

/* A 5x7 bitmap font, written out so it can be read and corrected. Anything
 * not here draws as a blank, which is a missing letter rather than a crash. */
const GLYPHS = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
    H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
    J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
    N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..##', '.####'],
    R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
    X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
    ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
    '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
    '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
    ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
    '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
    "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
    '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
    '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
    X_: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.....', '.....'],
};

/** A sheet of paper, or anything else one byte per pixel. */
export class Paper {
    constructor(width, height, background = 252) {
        this.width = width;
        this.height = height;
        this.px = new Uint8Array(width * height).fill(background);
    }

    set(x, y, v) {
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return;
        this.px[iy * this.width + ix] = Math.max(0, Math.min(255, Math.round(v)));
    }

    get(x, y) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 255;
        return this.px[y * this.width + x];
    }

    rect(x, y, w, h, v) {
        for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.set(x + i, y + j, v);
    }

    /** An outline, drawn as four filled bars so corners are square. */
    frame(x, y, w, h, v, t = 1) {
        this.rect(x, y, w, t, v);
        this.rect(x, y + h - t, w, t, v);
        this.rect(x, y, t, h, v);
        this.rect(x + w - t, y, t, h, v);
    }

    line(x0, y0, x1, y1, v, t = 1) {
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
        for (let s = 0; s <= steps; s += 1) {
            const x = x0 + ((x1 - x0) * s) / steps;
            const y = y0 + ((y1 - y0) * s) / steps;
            /* Thickness as a small square brush. Round caps would be nicer and
               nobody will see the difference at this size. */
            for (let j = 0; j < t; j += 1) for (let i = 0; i < t; i += 1) this.set(x + i, y + j, v);
        }
    }

    /**
     * One line of text, in the bitmap font, scaled by whole pixels.
     *
     * Returns the width drawn, so a caller can put something after it without
     * counting characters.
     */
    text(str, x, y, scale = 2, v = 40) {
        let cx = x;
        for (const ch of String(str).toUpperCase()) {
            const glyph = GLYPHS[ch];
            if (glyph) {
                for (let row = 0; row < 7; row += 1) {
                    for (let col = 0; col < 5; col += 1) {
                        if (glyph[row][col] !== '#') continue;
                        this.rect(cx + col * scale, y + row * scale, scale, scale, v);
                    }
                }
            }
            cx += 6 * scale;
        }
        return cx - x;
    }

    /** Width the same text would take, for centring and right alignment. */
    static textWidth(str, scale = 2) {
        return String(str).length * 6 * scale;
    }

    centred(str, cx, y, scale = 2, v = 40) {
        this.text(str, cx - Paper.textWidth(str, scale) / 2, y, scale, v);
    }

    /**
     * A signature, as a stroke through control points with the corners
     * rounded off.
     *
     * A polyline looks like a polyline. Sampling a quadratic through the
     * midpoints is the cheapest thing that looks like a pen.
     */
    scrawl(points, v = 30, t = 3) {
        for (let i = 0; i < points.length - 1; i += 1) {
            const [x0, y0] = points[i];
            const [x1, y1] = points[i + 1];
            const [xp, yp] = points[i - 1] ?? points[i];
            const [xn, yn] = points[i + 2] ?? points[i + 1];
            const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
            for (let s = 0; s <= steps; s += 1) {
                const u = s / steps;
                /* Catmull-Rom, which passes through its points rather than
                   near them: a signature that missed its own baseline would
                   look like a fault in the picture. */
                const u2 = u * u;
                const u3 = u2 * u;
                const x = 0.5 * ((2 * x0) + (-xp + x1) * u + (2 * xp - 5 * x0 + 4 * x1 - xn) * u2 + (-xp + 3 * x0 - 3 * x1 + xn) * u3);
                const y = 0.5 * ((2 * y0) + (-yp + y1) * u + (2 * yp - 5 * y0 + 4 * y1 - yn) * u2 + (-yp + 3 * y0 - 3 * y1 + yn) * u3);
                for (let j = 0; j < t; j += 1) for (let i2 = 0; i2 < t; i2 += 1) this.set(x + i2, y + j, v);
            }
        }
    }

    /**
     * Make it look photographed rather than rendered.
     *
     * Sensor grain and an off-centre falloff, both mild. Without them the
     * image is suspiciously clean and, more to the point, a perfectly flat
     * white field is the one thing a JPEG encodes so well that the file comes
     * out implausibly small.
     *
     * Deterministic: a fixture that differs every time it is generated is a
     * fixture nobody can talk about in a meeting.
     */
    photograph(seed = 7) {
        let state = seed * 2654435761 % 4294967296;
        const rand = () => {
            state = (state * 1664525 + 1013904223) % 4294967296;
            return state / 4294967296;
        };
        const cx = this.width * 0.46;
        const cy = this.height * 0.42;
        const far = Math.hypot(this.width, this.height) * 0.62;
        for (let y = 0; y < this.height; y += 1) {
            for (let x = 0; x < this.width; x += 1) {
                const i = y * this.width + x;
                const falloff = 1 - 0.20 * (Math.hypot(x - cx, y - cy) / far) ** 2;
                const grain = (rand() - 0.5) * 9;
                this.px[i] = Math.max(0, Math.min(255, Math.round(this.px[i] * falloff + grain)));
            }
        }
    }
}

/**
 * A signature that does not look generated.
 *
 * The first attempt was an even zigzag, which reads as a sine wave the moment
 * anyone looks at it: a real hand varies its amplitude, loops back on itself
 * for capitals, and drifts upward across the line. These points are irregular
 * on purpose and fixed rather than random, so the fixture is the same every
 * time it is built.
 */
function signature(paper, x, baseline, width = 380) {
    const shape = [
        [0, 20], [4, 2], [9, -26], [19, -40], [30, -27], [28, -3], [21, 18], [31, 26],
        [44, 13], [55, -7], [63, 9], [73, 17], [81, -3], [89, -21],
        [101, 5], [111, 19], [119, 3], [127, -17],
        [141, 7], [151, 21], [159, 7], [165, -11],
        [179, 3], [191, 17], [201, -3], [207, -21],
        [221, 1], [233, 15], [245, -1], [253, -17],
        [269, 5], [283, 17], [297, 7], [313, -9], [331, 3], [353, 13], [377, -5],
    ];
    const span = shape[shape.length - 1][0];
    const k = width / span;
    /* Rising slightly to the right, the way a hand writing quickly does. */
    paper.scrawl(shape.map(([sx, sy]) => [x + sx * k, baseline + sy - sx * k * 0.04]), 28, 3);
    /* The underline somebody adds without thinking about it. */
    paper.scrawl([
        [x + 30, baseline + 32], [x + width * 0.4, baseline + 36],
        [x + width * 0.72, baseline + 29], [x + width * 0.94, baseline + 33],
    ], 48, 2);
}

/** A tick in a box, for the checked-identifier rows. */
function tick(paper, x, y, size = 16) {
    paper.frame(x, y, size, size, 90, 2);
    paper.line(x + 3, y + size * 0.55, x + size * 0.42, y + size - 4, 35, 3);
    paper.line(x + size * 0.42, y + size - 4, x + size - 3, y + 3, 35, 3);
}

/**
 * The signed paper courier form, as photographed on a counter.
 *
 * This is the document that replaced the drawn signature: University Health
 * sign their own form and the courier photographs it. Everything on it comes
 * from the caller.
 */
export function courierForm(f) {
    const W = 880;
    const H = 1180;
    const paper = new Paper(W, H, 250);

    /* The desk around the sheet, so it reads as a photograph of paper rather
       than as a page. */
    paper.rect(0, 0, W, H, 148);
    const m = 34;
    paper.rect(m + 6, m + 8, W - 2 * m, H - 2 * m, 120);        // shadow
    paper.rect(m, m, W - 2 * m, H - 2 * m, 250);                 // the sheet

    const L = m + 30;
    const R = W - m - 30;
    let y = m + 34;

    paper.text('UNIVERSITY HEALTH', L, y, 3, 25);
    y += 30;
    paper.text('PHARMACY COURIER DELIVERY FORM', L, y, 2, 60);
    y += 22;
    paper.line(L, y, R, y, 70, 2);
    y += 26;

    paper.text(`ORDER ${f.reference}`, L, y, 2, 35);
    paper.text(f.serviceType, R - Paper.textWidth(f.serviceType, 2), y, 2, 35);
    y += 30;

    /** A labelled value on a ruled line, the way a paper form does it. */
    const field = (label, value, small = false) => {
        paper.text(label, L, y, 1, 105);
        y += 12;
        paper.text(value, L + 4, y, small ? 2 : 2, 30);
        y += 22;
        paper.line(L, y, R, y, 190, 1);
        y += 16;
    };

    field('PATIENT / RECIPIENT', f.patient);
    field('DELIVERY ADDRESS', f.address);
    field('CONTENTS', `${f.items}   QTY ${f.qty}`);
    field('DISPENSED BY (PHARMACY)', f.dispensedBy);

    y += 6;
    paper.text('IDENTITY VERIFICATION', L, y, 2, 30);
    y += 14;
    paper.line(L, y, L + 300, y, 120, 2);
    y += 20;

    /* ID Required is stamped on the pharmacy's form, so the courier cannot
       record the delivery until identification has been photographed. */
    paper.frame(R - 230, y - 56, 226, 52, 60, 3);
    paper.text('ID REQUIRED', R - 214, y - 44, 2, 40);
    paper.text('VERIFIED', R - 214, y - 24, 1, 70);
    tick(paper, R - 60, y - 46, 34);

    for (const name of f.identifiers) {
        tick(paper, L + 4, y - 3, 18);
        paper.text(name, L + 32, y, 2, 40);
        y += 30;
    }

    y += 14;
    paper.line(L, y, R, y, 190, 1);
    y += 24;

    paper.text('RECEIVED BY (PRINT)', L, y, 1, 105);
    y += 14;
    paper.text(f.receivedBy, L + 4, y, 2, 30);
    y += 26;
    paper.line(L, y, R, y, 190, 1);
    y += 22;

    paper.text('SIGNATURE', L, y, 1, 105);
    /* Sitting on the ruled line rather than floating above it, which is what
       gives away a signature that was placed rather than written. */
    signature(paper, L + 10, y + 52, 380);
    y += 96;
    paper.line(L, y, R, y, 190, 1);
    y += 20;

    paper.text('DATE', L, y, 1, 105);
    paper.text(f.date, L + 4, y + 14, 2, 30);
    paper.text('TIME', L + 300, y, 1, 105);
    paper.text(f.time, L + 304, y + 14, 2, 30);
    y += 44;
    paper.line(L, y, R, y, 190, 1);
    y += 20;

    paper.text('COURIER', L, y, 1, 105);
    paper.text(f.courier, L + 4, y + 14, 2, 30);
    y += 44;
    paper.line(L, y, R, y, 190, 1);
    y += 20;

    paper.text('DELIVERY NOTES', L, y, 1, 105);
    y += 16;
    for (const note of f.notes) {
        paper.text(note, L + 4, y, 2, 45);
        y += 24;
    }
    y += 10;

    /* The stamp, double-ruled the way a rubber one prints. It fills what was
       otherwise a third of a page of blank sheet, which read as an unfinished
       form rather than a completed one. */
    const sw = 300;
    const sh = 96;
    const sx = R - sw;
    paper.frame(sx, y, sw, sh, 95, 3);
    paper.frame(sx + 7, y + 7, sw - 14, sh - 14, 95, 1);
    paper.centred('DELIVERED', sx + sw / 2, y + 20, 3, 70);
    paper.centred(`${f.date}  ${f.time}`, sx + sw / 2, y + 50, 2, 85);
    paper.centred('IZY GLOBAL SERVICES LLC', sx + sw / 2, y + 72, 1, 100);

    paper.text('IZY GLOBAL SERVICES LLC   CHAIN OF CUSTODY RETAINED', L, H - m - 34, 1, 120);

    paper.photograph(11);
    return paper;
}

/**
 * The photographed identification, as a specimen.
 *
 * Deliberately not a convincing identity card: banded SPECIMEN, fields masked
 * the way a record intended to prove that a check happened should be, and no
 * attempt at a real document's layout. What the demonstration needs to show is
 * that the courier could not complete the delivery without photographing one.
 */
export function idCard(f) {
    const W = 860;
    const H = 560;
    const paper = new Paper(W, H, 150);

    const m = 40;
    paper.rect(m + 8, m + 10, W - 2 * m, H - 2 * m, 118);
    paper.rect(m, m, W - 2 * m, H - 2 * m, 242);
    paper.frame(m, m, W - 2 * m, H - 2 * m, 90, 3);

    const L = m + 26;
    let y = m + 26;

    paper.text('IDENTIFICATION VERIFIED', L, y, 3, 30);
    y += 34;
    paper.text('PHOTOGRAPHED AT THE DOOR BY THE COURIER', L, y, 1, 95);
    y += 20;
    paper.line(L, y, W - m - 26, y, 80, 2);
    y += 28;

    /* A portrait box, left blank on purpose. */
    paper.frame(L, y, 150, 190, 110, 3);
    paper.rect(L + 6, y + 6, 138, 178, 205);
    paper.centred('PHOTO', L + 75, y + 78, 2, 120);
    paper.centred('WITHHELD', L + 75, y + 100, 1, 130);

    const C = L + 182;
    let cy = y + 6;
    const row = (label, value) => {
        paper.text(label, C, cy, 1, 110);
        paper.text(value, C + 150, cy, 2, 30);
        cy += 30;
        paper.line(C, cy - 6, W - m - 26, cy - 6, 200, 1);
    };
    row('NAME', f.maskedName);
    row('DATE OF BIRTH', '**/**/****');
    row('DOCUMENT', 'STATE ID');
    row('NUMBER', f.maskedNumber);
    row('CHECKED', f.date);
    row('MATCHES ORDER', 'YES');

    /* The band. Light grey so it does not swallow the fields under it, and
       repeated so it reads as a watermark rather than a label.
       Clipped to the card: it used to run off onto the desk and through the
       footer, which looked like a rendering fault rather than a watermark. */
    const bandTop = y + 206;
    for (let i = 0; i < 3; i += 1) {
        const row = new Paper(W, 30, 255);
        row.text('SPECIMEN   SPECIMEN   SPECIMEN   SPECIMEN', 10 + i * 34, 2, 3, 190);
        for (let ry = 0; ry < 26; ry += 1) {
            for (let rx = L; rx < W - m - 26; rx += 1) {
                const v = row.get(rx, ry);
                if (v < 250) paper.set(rx, bandTop + i * 27 + ry, v);
            }
        }
    }

    paper.text('NOT A GENUINE DOCUMENT   DEMONSTRATION FIXTURE', L, H - m - 34, 1, 105);

    paper.photograph(23);
    return paper;
}
