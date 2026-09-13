/* A very small PDF writer.
 *
 * Enough to lay out a proof of delivery: Helvetica text, rules, boxes, and
 * polylines for the captured signatures. No images, no embedded fonts, no
 * compression.
 *
 * WHY BY HAND RATHER THAN A LIBRARY. This document carries patient names,
 * addresses and signatures, so every dependency in its path is something that
 * has to be reviewed, kept patched and covered by the security program we owe
 * University Health. The whole feature needs text in one standard font and
 * some straight lines, which is a few hundred lines of a format designed to be
 * written by hand. A PDF library would be a larger surface than the problem.
 *
 * The same reasoning as the SigV4 signer in core/files: small, specified,
 * verifiable things are worth writing; large unspecified ones are not.
 *
 * The output is PDF 1.4, uncompressed, with a plain cross-reference table. It
 * opens in Acrobat, Preview, Chrome and Edge. Being uncompressed makes the
 * bytes readable, which is how the tests check it and how anybody debugging a
 * malformed document will thank us later.
 */

/** Points. 72 to the inch, US Letter, because this is a US contract. */
export const PAGE = { width: 612, height: 792 } as const;

export type FontName = 'Helvetica' | 'Helvetica-Bold';

/* Character widths in 1/1000 em for the two base-14 fonts used here, from the
 * standard Adobe metrics. Only the printable ASCII range: anything outside it
 * is transliterated before it reaches this file. Used for wrapping and
 * truncating; an error here costs a slightly ragged line, never a broken
 * document. */
const WIDTHS: Record<FontName, number[]> = {
    Helvetica: [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
    ],
    'Helvetica-Bold': [
        278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
        975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
        333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
        611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
    ],
};

/**
 * Reduce text to what a base-14 font can show.
 *
 * Names and addresses arrive with accents, curly quotes and the occasional
 * emoji from a phone keyboard. Without an embedded font those cannot be drawn,
 * and a proof of delivery with a mangled patient name is worse than one with a
 * plain-ASCII name, so the common cases are transliterated and the rest is
 * dropped rather than emitted as nonsense.
 */
export function toLatin(text: string): string {
    return String(text ?? '')
        .normalize('NFD')
        // Strip combining marks: é becomes e, ñ becomes n.
        .replace(/[̀-ͯ]/g, '')
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...')
        /* Punctuation this application actually writes, mapped rather than
           dropped. The middle dot separates fields all over the app, and
           silently removing it printed "stat Delivered" where the document
           meant "stat - Delivered". Found by rendering a page and reading it,
           not by reading the code. */
        .replace(/[·•]/g, '-')
        .replace(/×/g, 'x')
        .replace(/ /g, ' ')
        .replace(/[^\x20-\x7e]/g, '');
}

export function textWidth(text: string, font: FontName, size: number): number {
    const widths = WIDTHS[font];
    let total = 0;
    for (const ch of toLatin(text)) {
        const code = ch.charCodeAt(0);
        total += widths[code - 32] ?? 500;
    }
    return (total * size) / 1000;
}

/** Break text to fit a width, on spaces where possible. */
export function wrap(text: string, font: FontName, size: number, maxWidth: number): string[] {
    const words = toLatin(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const candidate = line === '' ? word : `${line} ${word}`;
        if (textWidth(candidate, font, size) <= maxWidth) {
            line = candidate;
            continue;
        }
        if (line !== '') lines.push(line);
        // A single word too long for the line: cut it rather than overflow.
        let rest = word;
        while (textWidth(rest, font, size) > maxWidth && rest.length > 1) {
            let cut = rest.length;
            while (cut > 1 && textWidth(rest.slice(0, cut), font, size) > maxWidth) cut -= 1;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        line = rest;
    }
    if (line !== '') lines.push(line);
    return lines.length === 0 ? [''] : lines;
}

/** Escape for a PDF literal string. */
const pdfString = (text: string): string =>
    `(${toLatin(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

const round = (n: number): string => (Math.round(n * 100) / 100).toString();

export interface Point { x: number; y: number }

/**
 * One page being drawn on.
 *
 * Coordinates are PDF coordinates: the origin is the BOTTOM left and y grows
 * upward. The document code above works in the same space rather than flipping
 * it, because a flipped wrapper is one more thing to be wrong about when a
 * signature comes out upside down.
 */
export class Page {
    private readonly ops: string[] = [];

    text(value: string, x: number, y: number, opts: { font?: FontName; size?: number; grey?: number } = {}): void {
        const { font = 'Helvetica', size = 10, grey = 0 } = opts;
        const content = toLatin(value);
        if (content === '') return;
        this.ops.push(
            'BT',
            `${round(grey)} g`,
            `/${font === 'Helvetica-Bold' ? 'F2' : 'F1'} ${round(size)} Tf`,
            `1 0 0 1 ${round(x)} ${round(y)} Tm`,
            `${pdfString(content)} Tj`,
            'ET',
            '0 g',
        );
    }

    /** Right-aligned at x. */
    textRight(value: string, x: number, y: number, opts: { font?: FontName; size?: number; grey?: number } = {}): void {
        const width = textWidth(value, opts.font ?? 'Helvetica', opts.size ?? 10);
        this.text(value, x - width, y, opts);
    }

    line(x1: number, y1: number, x2: number, y2: number, opts: { width?: number; grey?: number } = {}): void {
        this.ops.push(
            `${round(opts.grey ?? 0.7)} G`,
            `${round(opts.width ?? 0.5)} w`,
            `${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S`,
            '0 G',
        );
    }

    rect(x: number, y: number, width: number, height: number, opts: { grey?: number; fill?: number } = {}): void {
        if (opts.fill !== undefined) {
            this.ops.push(`${round(opts.fill)} g`, `${round(x)} ${round(y)} ${round(width)} ${round(height)} re f`, '0 g');
        }
        this.ops.push(
            `${round(opts.grey ?? 0.7)} G`,
            '0.5 w',
            `${round(x)} ${round(y)} ${round(width)} ${round(height)} re S`,
            '0 G',
        );
    }

    /** One captured stroke, already in page coordinates. */
    polyline(points: Point[], opts: { width?: number; grey?: number } = {}): void {
        const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (usable.length === 0) return;
        const [first, ...rest] = usable;
        this.ops.push(
            `${round(opts.grey ?? 0.1)} G`,
            `${round(opts.width ?? 1.2)} w`,
            '1 J 1 j',
            `${round(first!.x)} ${round(first!.y)} m`,
            // A single point is a dot, not an invisible zero-length line.
            ...(rest.length === 0
                ? [`${round(first!.x + 0.2)} ${round(first!.y)} l`]
                : rest.map((p) => `${round(p.x)} ${round(p.y)} l`)),
            'S',
            '0 G',
        );
    }

    toContent(): string {
        return this.ops.join('\n');
    }
}

export interface DocumentInfo {
    title: string;
    /** Shown in a reader's document properties. No patient data. */
    subject?: string;
}

/**
 * Build the file.
 *
 * Objects are written in order and their byte offsets recorded, then the
 * cross-reference table points at them. That table is the part a reader
 * actually needs to be right; everything else is content.
 */
export function buildPdf(pages: Page[], info: DocumentInfo, now: Date = new Date()): Buffer {
    if (pages.length === 0) throw new Error('A PDF needs at least one page');

    const objects: string[] = [];
    const add = (body: string): number => {
        objects.push(body);
        return objects.length; // 1-based object numbers
    };

    const catalogId = 1;
    const pagesId = 2;
    const fontRegularId = 3;
    const fontBoldId = 4;
    const infoId = 5;
    objects.push('', '', '', '', ''); // reserved, filled in below

    const pageIds: number[] = [];
    for (const page of pages) {
        const content = page.toContent();
        const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
        pageIds.push(add(
            `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] `
            + `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> `
            + `/Contents ${contentId} 0 R >>`,
        ));
    }

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    objects[fontRegularId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[fontBoldId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    const stamp = `D:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
        + `${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`
        + `${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}Z`;
    objects[infoId - 1] = `<< /Title ${pdfString(info.title)} `
        + (info.subject ? `/Subject ${pdfString(info.subject)} ` : '')
        + `/Producer (Izy Global Services) /CreationDate (${stamp}) >>`;

    const chunks: Buffer[] = [];
    let offset = 0;
    const push = (text: string) => {
        const buf = Buffer.from(text, 'latin1');
        chunks.push(buf);
        offset += buf.length;
    };

    /* The %âãÏÓ comment is conventional: it tells anything reading the file
     * that it contains binary, so a transfer does not mangle line endings. */
    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

    const offsets: number[] = [];
    for (const [index, body] of objects.entries()) {
        offsets.push(offset);
        push(`${index + 1} 0 obj\n${body}\nendobj\n`);
    }

    const xrefOffset = offset;
    const lines = [`xref`, `0 ${objects.length + 1}`, '0000000000 65535 f '];
    for (const at of offsets) lines.push(`${String(at).padStart(10, '0')} 00000 n `);
    push(`${lines.join('\n')}\n`);
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`);
    push(`startxref\n${xrefOffset}\n%%EOF\n`);

    return Buffer.concat(chunks);
}
