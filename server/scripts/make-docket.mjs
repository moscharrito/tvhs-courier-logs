#!/usr/bin/env node
/* The delivery docket, as a US Letter PDF.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT A PRINTED WEB PAGE.
 *
 * docs/forms/courier-docket.html is the design and stays the source of
 * truth for the layout: a form is far easier to iterate on in HTML than in
 * a PDF writer's coordinate space. But a web page has to be printed by
 * whoever opens it, through whatever margins their browser decides on, and
 * a docket that comes out at 96 per cent with the cut lines in the wrong
 * place is a pad nobody can tear straight.
 *
 * This writes the page at exactly 612 x 792 points, which is 8.5 x 11
 * inches, so what leaves the printer is the size it was drawn at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GREYSCALE, AND THAT IS NOT A LIMITATION HERE.
 *
 * core/pdf/writer.ts draws in grey levels, no RGB, because it was built for
 * the proof of delivery. A docket prints on a mono laser onto a carbonless
 * pad, so the three role bands are three distinguishable greys rather than
 * three colours -- which is how the HTML was designed to degrade anyway.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCISSORS ARE DRAWN, NOT TYPED.
 *
 * Helvetica has no Dingbats block, so U+2702 cannot be set as text in this
 * document: toLatin would drop it and the cut line would lose its only
 * marker. They are two crossed blades and two rings, drawn with the same
 * polyline the signature capture uses.
 *
 *   npx tsx scripts/make-docket.mjs                  # writes to docs/forms/
 *   npx tsx scripts/make-docket.mjs path/to/out.pdf
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf, Page, PAGE, textWidth } from '../src/core/pdf/writer.ts';

/* The wordmark green. Same Helvetica-Bold treatment as the Standard
   Carrier Packet, which sets it in near-black; only the colour differs. */
const IZY_GREEN = { r: 0.106, g: 0.369, b: 0.247 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2]
    ?? path.resolve(HERE, '..', '..', 'docs', 'forms', 'izy-delivery-docket.pdf');

/* ───────────────────────────────────────────────────────── the page grid */

const MARGIN = 36;                       // half an inch
const LEFT = MARGIN;
const RIGHT = PAGE.width - MARGIN;
const WIDTH = RIGHT - LEFT;
const TOP = PAGE.height - 30;
const BOTTOM = 26;

/* Three parts share what is left after the two cut lines. */
/* Clearance either side of a cut line. It was 16 and the capitals of the
   next part's wordmark rose into the scissors, because a part's `top` was
   being used as the wordmark's BASELINE -- so 11pt of ascender sat above
   the number the layout was reasoning about. letterhead() now treats the
   value it is given as the top of the ink, and this is honest white space
   on top of that. */
const CUT_SPACE = 30;
const PART_H = (TOP - BOTTOM - CUT_SPACE * 2) / 3;

/* Grey levels, named so the intent survives a later tweak. */
const INK = 0;
const SOFT = 0.42;
const RULE = 0.35;        // a line somebody writes on
const FAINT = 0.72;
const BAND_PHARMACY = 0.30;   // drawn in green; the grey is its mono fallback
const BAND_DRIVER = 0.08;
const BAND_PATIENT = 0.52;
const TINT = 0.94;

const ADDRESS = '500 Navarro St, 2nd Floor, San Antonio, TX 78205';
const DISPATCH = 'Dispatch +1 (832) 715 8986  ·  freights@izymovers.com';

/* ─────────────────────────────────────────────── the fillable overlay
 *
 * The same sheet is printed onto carbonless pads AND typed into at a desk
 * when dispatch takes a job by telephone, so every rule and every box
 * carries an invisible widget over it (core/pdf/writer.ts, FormField).
 *
 * COLLECTED ONLY ON THE REAL PASS. The layout is measured by rendering
 * each part once against a throwaway page, and registering fields during
 * that pass would put two widgets on every rule -- which a reader shows as
 * a field that will not take a second character.
 */
const FIELDS = [];
let collecting = false;
let prefix = '';
const seen = new Map();

/** A stable, unique, readable field name. */
function fieldName(label) {
    const base = `${prefix}.${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
}

function addField(kind, label, rect, extra = {}) {
    if (!collecting) return;
    FIELDS.push({ page: 0, kind, name: fieldName(label), rect, ...extra });
}

/* ────────────────────────────────────────────────────────────── drawing */

/** A row of labelled write-on rules, sized by weight. */
function fields(page, y, cols, { gap = 12, lineH = 17 } = {}) {
    const total = cols.reduce((n, c) => n + (c.w ?? 1), 0);
    const free = WIDTH - gap * (cols.length - 1);
    let x = LEFT;
    for (const c of cols) {
        const w = (free * (c.w ?? 1)) / total;
        page.text(c.label.toUpperCase(), x, y, { size: 5.4, grey: SOFT });
        page.line(x, y - lineH, x + w, y - lineH, { width: 0.7, grey: RULE });
        /* The writable zone is between the label and the rule it sits on. */
        addField('text', c.label, [x, y - lineH + 1, x + w, y - 1], { size: 8 });
        x += w + gap;
    }
    return y - lineH - 7;
}

/** An empty tick box with its wording, returning the x it ended at. */
function tick(page, x, y, label, { size = 7 } = {}) {
    const box = 8;
    page.rect(x, y - 1.5, box, box, { grey: INK });
    addField('check', label, [x, y - 1.5, x + box, y - 1.5 + box]);
    page.text(label, x + box + 3.5, y, { size, grey: INK, font: 'Helvetica-Bold' });
    return x + box + 5 + textWidth(label, 'Helvetica-Bold', size) + 12;
}

/** Two crossed blades and two rings. Helvetica cannot set U+2702. */
function scissors(page, x, y, { flip = false, s = 1 } = {}) {
    const d = flip ? -1 : 1;
    const X = (v) => x + v * d * s;
    const Y = (v) => y + v * s;
    const blade = { width: 0.8, grey: INK };
    page.polyline([{ x: X(0), y: Y(3.4) }, { x: X(9.5), y: Y(-3.2) }], blade);
    page.polyline([{ x: X(0), y: Y(-3.4) }, { x: X(9.5), y: Y(3.2) }], blade);
    /* The finger rings: small octagons read as circles at this size. */
    for (const cy of [3.8, -3.8]) {
        const pts = [];
        for (let i = 0; i <= 8; i += 1) {
            const a = (i / 8) * Math.PI * 2;
            pts.push({ x: X(-1.6 + Math.cos(a) * 1.9), y: Y(cy + Math.sin(a) * 1.9) });
        }
        page.polyline(pts, blade);
    }
}

/** The cut line: scissors, dashes, mirrored scissors. */
function cutLine(page, y) {
    const inset = 16;
    scissors(page, LEFT, y);
    scissors(page, RIGHT, y, { flip: true });
    const from = LEFT + inset;
    const to = RIGHT - inset;
    /* Drawn as segments: the writer has no dash array. */
    for (let x = from; x < to; x += 7) {
        page.line(x, y, Math.min(x + 4, to), y, { width: 0.7, grey: RULE });
    }
}

/** Letterhead plus the band saying whose part this is. */
function letterhead(page, top, { role, band, kind, part }) {
    /* `top` is the top of the ink, not a baseline. Helvetica-Bold at 11pt
       ascends about 11pt above its baseline, and treating the two as the
       same put the wordmark through the cut line above it. */
    const y = top - 11;

    page.text('IZY GLOBAL SERVICES LLC', LEFT, y, { font: 'Helvetica-Bold', size: 11, rgb: IZY_GREEN });
    page.text(ADDRESS, LEFT, y - 9.5, { size: 5.8, grey: SOFT });
    page.text(DISPATCH, LEFT, y - 18, { size: 6.4, grey: INK, font: 'Helvetica-Bold' });

    page.textRight(kind.toUpperCase(), RIGHT, y, { font: 'Helvetica-Bold', size: 8, grey: INK });

    /* The role band: knocked out white on a filled rectangle, so it survives
       a photocopy in a way grey small print does not. */
    const label = role.toUpperCase();
    const size = 7.5;
    const padX = 6;
    const w = textWidth(label, 'Helvetica-Bold', size) + padX * 2;
    const h = 12;
    const bx = RIGHT - w;
    const by = y - 11 - h + 3;
    /* Green for the pharmacy band, grey for the other two. Three tones
       either way, so the parts stay sortable when this is run off on a
       mono laser. */
    const bandRgb = band === BAND_PHARMACY ? IZY_GREEN : undefined;
    page.rect(bx, by, w, h, bandRgb
        ? { fillRgb: bandRgb, rgb: bandRgb }
        : { fill: band, grey: band });
    page.text(label, bx + padX, by + 3.6, { font: 'Helvetica-Bold', size, grey: 1 });

    page.textRight(part, RIGHT, by - 8, { size: 5.6, grey: SOFT });

    const ruleY = by - 13;
    page.line(LEFT, ruleY, RIGHT, ruleY, { width: 1.6, rgb: IZY_GREEN });
    return ruleY - 11;
}

/** A bordered block, used for handling and for the pharmacy-use footer. */
function block(page, y, h, label, { strong = true } = {}) {
    page.rect(LEFT, y - h, WIDTH, h, { grey: strong ? 0.1 : FAINT });
    page.text(label.toUpperCase(), LEFT + 6, y - 9, { size: 5.4, grey: strong ? INK : SOFT, font: 'Helvetica-Bold' });
    return y - 9;
}

/** The tinted strip naming what happens at this stage. */
function stage(page, y, what, note) {
    const h = 13;
    page.rect(LEFT, y - h, WIDTH, h, { fill: TINT, grey: TINT });
    page.rect(LEFT, y - h, 2.5, h, { fillRgb: IZY_GREEN, rgb: IZY_GREEN });
    page.text(what.toUpperCase(), LEFT + 7, y - 9.2, { font: 'Helvetica-Bold', size: 7, grey: INK });
    page.textRight(note, RIGHT - 5, y - 9, { size: 5.8, grey: SOFT });
    return y - h - 8;
}

function footer(page, y, left, right) {
    page.text(left, LEFT, y, { size: 5.6, grey: SOFT });
    page.textRight(right, RIGHT, y, { size: 5.6, grey: SOFT });
}

/* ─────────────────────────────────────────────────────────── the parts */

function partPharmacy(page, top) {
    let y = letterhead(page, top, {
        role: 'For pharmacy staff', band: BAND_PHARMACY,
        kind: 'Delivery docket', part: 'Part 1 of 3',
    });

    y = fields(page, y, [
        { label: 'Pharmacy', w: 1.6 }, { label: 'Service date', w: 1 },
        { label: 'Pickup time', w: 1 }, { label: 'Zone', w: 0.7 },
    ]);
    y = fields(page, y, [
        { label: 'Patient', w: 1.6 }, { label: 'Rx reference', w: 1 },
        { label: 'Packages', w: 1 }, { label: 'ZIP', w: 0.7 },
    ]);

    const hTop = y - 2;
    const inner = block(page, hTop, 30, 'Handling — tick every one that applies before the courier leaves');
    let x = LEFT + 6;
    for (const t of ['Refrigerated', 'Controlled', 'ID required', 'Medicare', 'Multi-box']) {
        x = tick(page, x, inner - 13, t);
    }
    y = hTop - 30 - 8;

    y = stage(page, y, 'Collected at the counter', 'Pharmacy keeps this part as proof of handover.');

    y = fields(page, y, [
        { label: 'Courier name (print)', w: 1.2 },
        { label: 'Courier signature — I received the packages above', w: 1.6 },
        { label: 'Time', w: 0.7 },
    ]);

    footer(page, y + 1, 'PHARMACY COPY. Keep at the counter.',
        'Late list or a change before pickup: ring dispatch.');
    return y + 1;
}

function partDriver(page, top) {
    let y = letterhead(page, top, {
        role: 'For driver', band: BAND_DRIVER,
        kind: 'Delivery docket', part: 'Part 2 of 3',
    });

    y = fields(page, y, [
        { label: 'Patient', w: 1.4 }, { label: 'Phone', w: 1 }, { label: 'Rx reference', w: 1 },
    ]);
    y = fields(page, y, [
        { label: 'Deliver to', w: 2.4 }, { label: 'Packages to hand over', w: 1 },
    ]);

    const hTop = y - 2;
    const inner = block(page, hTop, 44, 'Who may sign — tick one');
    let x = LEFT + 6;
    for (const t of ['The patient only (Medicare)', 'Anyone 18 or over', 'Anyone at the address']) {
        x = tick(page, x, inner - 13, t);
    }
    /* The named caregiver is written in, so it gets a rule rather than a box. */
    const nx = tick(page, LEFT + 6, inner - 27, 'Also named by the pharmacy:');
    page.line(nx - 6, inner - 29.5, LEFT + WIDTH * 0.52, inner - 29.5, { width: 0.7, grey: RULE });
    addField('text', 'Named caregiver', [nx - 6, inner - 28.5, LEFT + WIDTH * 0.52, inner - 17], { size: 8 });
    let x2 = LEFT + WIDTH * 0.56;
    for (const t of ['Refrigerated', 'Controlled', 'Photograph ID']) {
        x2 = tick(page, x2, inner - 27, t);
    }
    y = hTop - 44 - 8;

    y = fields(page, y, [
        { label: 'Special instructions — gate code, which door, where to park', w: 2.4 },
        { label: 'Zone', w: 0.7 },
    ]);

    y = stage(page, y, 'Handed over at the door',
        'No signature, no handover. Take it back to the pharmacy the same day.');

    y = fields(page, y, [
        { label: 'Received by (print)', w: 1.2 }, { label: 'Signature', w: 1.5 }, { label: 'Time', w: 0.7 },
    ]);
    y = fields(page, y, [
        { label: 'ID seen — type and last 4', w: 1.2 },
        { label: 'If not the patient, why', w: 1.2 },
        { label: 'Not delivered — reason', w: 1.2 },
    ]);

    footer(page, y + 1, 'COURIER COPY. Keep until the run is closed.',
        'Returns: the pharmacy, or Robert B. Green until 20:00. Ring first.');
    return y + 1;
}

function partPatient(page, top) {
    let y = letterhead(page, top, {
        role: 'For patient', band: BAND_PATIENT,
        kind: 'Delivery receipt', part: 'Part 3 of 3',
    });

    y = fields(page, y, [
        { label: 'Delivered to', w: 1.4 }, { label: 'From (pharmacy)', w: 1.4 },
        { label: 'Rx reference', w: 1 }, { label: 'Packages', w: 0.7 },
    ]);
    y = fields(page, y, [
        { label: 'Courier', w: 1.2 }, { label: 'Received by (print)', w: 1.5 },
        { label: 'Date and time', w: 1 },
    ]);

    y = stage(page, y, 'Your copy — keep it',
        'Medication questions: the pharmacy on the label. Delivery: Izy dispatch.');

    const hTop = y - 2;
    const inner = block(page, hTop, 34, 'Pharmacy use only — if this delivery was not completed', { strong: false });
    const cols = [
        { label: 'Returned to', w: 1.2 },
        { label: 'Pharmacy staff signature', w: 1.5 },
        { label: 'Date and time', w: 1 },
    ];
    const gap = 12;
    const innerW = WIDTH - 12;
    const total = cols.reduce((n, c) => n + c.w, 0);
    let cx = LEFT + 6;
    for (const c of cols) {
        const w = ((innerW - gap * (cols.length - 1)) * c.w) / total;
        page.text(c.label.toUpperCase(), cx, inner - 13, { size: 5.4, grey: SOFT });
        page.line(cx, inner - 25, cx + w, inner - 25, { width: 0.7, grey: RULE });
        addField('text', c.label, [cx, inner - 24, cx + w, inner - 14], { size: 8 });
        cx += w + gap;
    }
    y = hTop - 34 - 8;

    footer(page, y + 1, 'PATIENT COPY. Left with the medication, or returned to the pharmacy unused.',
        'Izy Global Services LLC');
    return y + 1;
}

/* ──────────────────────────────────────────────────────────────── build */

/* ─── MEASURE, THEN PLACE. The parts are not equal thirds.
 *
 * Splitting the sheet in three put the cut line 3pt inside the driver's
 * footer while the patient part sat above 79pt of white space -- because
 * the driver part carries roughly half as much again as the other two: the
 * full address, the four signing rules, the special instructions, and two
 * signature rows instead of one.
 *
 * So each part is rendered once against a throwaway page to learn its
 * height, and the cut lines are then placed where the content actually
 * ends. The part functions take a top and return where they finished, so
 * the height is the same wherever they are drawn.
 *
 * The leftover space is shared equally as breathing room below each part,
 * rather than given to whichever part is longest: a cut line hard against
 * a footer is unpleasant to tear even when it technically fits.
 */
const PARTS = [
    { name: 'pharmacy', draw: partPharmacy },
    { name: 'driver', draw: partDriver },
    { name: 'patient', draw: partPatient },
];

const scratch = new Page();
const heights = PARTS.map((p) => -p.draw(scratch, 0));

const available = TOP - BOTTOM - CUT_SPACE * (PARTS.length - 1);
const content = heights.reduce((a, b) => a + b, 0);
const pad = (available - content) / PARTS.length;

heights.forEach((h, i) => {
    console.log(`  ${PARTS[i].name.padEnd(9)} ${h.toFixed(1)}pt + ${pad.toFixed(1)}pt breathing room`);
});

if (pad < 4) {
    console.error(
        `
The three parts need ${content.toFixed(1)}pt and the sheet has ${available.toFixed(1)}pt. `
        + 'Tighten the rows before printing a pad.',
    );
    process.exit(1);
}

const page = new Page();
collecting = true;
let y = TOP;
PARTS.forEach((part, i) => {
    prefix = part.name;
    part.draw(page, y);
    y -= heights[i] + pad;
    if (i < PARTS.length - 1) {
        cutLine(page, y - CUT_SPACE / 2);
        y -= CUT_SPACE;
    }
});

const pdf = buildPdf([page], {
    title: 'Izy Delivery Docket',
    subject: 'Three-part delivery docket for the University Health pharmacy contract',
}, new Date(), [], FIELDS);

console.log(`  ${FIELDS.length} fillable fields `
    + `(${FIELDS.filter((f) => f.kind === 'text').length} text, `
    + `${FIELDS.filter((f) => f.kind === 'check').length} tick boxes)`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pdf);
console.log(`Wrote ${OUT}`);
console.log(`${pdf.length} bytes, ${PAGE.width} x ${PAGE.height} points (US Letter).`);
