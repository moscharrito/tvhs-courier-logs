/* Photographs inside the proof of delivery.
 *
 * University Health asked for "proof-of-delivery documentation, including
 * recipient name, signature, delivery date and time, location, photographs".
 * The document could carry every one of those except the last: the writer
 * drew vectors and said so in its first comment, so a courier could
 * photograph a signed form and the PDF would only mention that one existed.
 *
 * PDF understands JPEG natively through DCTDecode, so the bytes go in exactly
 * as they came off the camera. These tests are mostly about what happens when
 * they are not what we expected. */

import { describe, it, expect } from 'vitest';
import { buildPdf, jpegSize, Page } from '../src/core/pdf/writer.ts';

/* A one-pixel JPEG. Enough to have a real start-of-frame marker to read. */
const JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const asText = (pdf) => pdf.toString('latin1');

describe('reading a JPEG', () => {
    it('finds the size in the start-of-frame marker', () => {
        expect(jpegSize(JPEG)).toEqual({ width: 1, height: 1 });
    });

    it('returns null for anything that is not one', () => {
        /* The caller leaves the photograph out on null. A picture a reader
           refuses to open is worse than a document saying there is one. */
        for (const junk of [
            Buffer.alloc(0),
            Buffer.from('not a jpeg at all'),
            Buffer.from([0xff, 0xd8]),                    // truncated
            Buffer.from([0x89, 0x50, 0x4e, 0x47]),        // a PNG
        ]) {
            expect(jpegSize(junk)).toBeNull();
        }
    });

    it('does not loop forever on a malformed segment length', () => {
        /* A zero length would step nowhere and spin. */
        const bad = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        expect(jpegSize(bad)).toBeNull();
    });
});

describe('embedding it', () => {
    const withPhoto = () => {
        const page = new Page();
        page.text('Proof of delivery', 54, 700);
        page.image('Ph0', 54, 400, 200, 150);
        return buildPdf([page], { title: 'Proof' }, new Date('2026-09-30T12:00:00Z'),
            [{ name: 'Ph0', bytes: JPEG }]);
    };

    it('writes an image object and names it on the page', () => {
        const pdf = asText(withPhoto());
        expect(pdf).toContain('/Subtype /Image');
        expect(pdf).toContain('/Filter /DCTDecode');
        expect(pdf).toContain('/XObject << /Ph0');
        expect(pdf).toContain('/Ph0 Do');
    });

    it('keeps the JPEG bytes intact', () => {
        /* Everything here is written as latin1, which maps 0..255 straight
           through. utf8 would corrupt the photograph and the only symptom
           would be a picture that will not open. */
        const pdf = withPhoto();
        expect(pdf.includes(JPEG)).toBe(true);
    });

    it('declares the pixel size it read, not the box it was drawn in', () => {
        const pdf = asText(withPhoto());
        expect(pdf).toContain('/Width 1 /Height 1');
    });

    it('positions with a matrix rather than resampling', () => {
        const pdf = asText(withPhoto());
        expect(pdf).toContain('200 0 0 150 54 400 cm');
        /* Saved and restored, so the transform cannot leak into later marks. */
        expect(pdf).toContain('q\n200 0 0 150 54 400 cm');
        expect(pdf).toContain('/Ph0 Do\nQ');
    });

    it('leaves out an unreadable photograph and does not name it', () => {
        /* The failure that matters: naming a resource that was dropped makes
           the whole file invalid, so a bad photo would take the document with
           it rather than just being absent. */
        const page = new Page();
        page.image('Ph0', 54, 400, 200, 150);
        const pdf = asText(buildPdf([page], { title: 'Proof' }, new Date(),
            [{ name: 'Ph0', bytes: Buffer.from('not a jpeg') }]));

        expect(pdf).not.toContain('/XObject');
        expect(pdf).not.toContain('/Subtype /Image');
    });

    it('still produces a document with no photographs at all', () => {
        const page = new Page();
        page.text('Proof of delivery', 54, 700);
        const pdf = asText(buildPdf([page], { title: 'Proof' }));
        expect(pdf.startsWith('%PDF-1.4')).toBe(true);
        expect(pdf).not.toContain('/XObject');
        expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    });

    it('keeps the cross-reference table honest once images are in it', () => {
        /* Byte offsets are what a reader seeks on. Adding binary objects is
           exactly where an off-by-one would appear, and a reader would report
           only "damaged file". */
        const pdf = asText(withPhoto());
        const xrefAt = Number(pdf.slice(pdf.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
        expect(pdf.slice(xrefAt, xrefAt + 4)).toBe('xref');

        const declared = Number(/\/Size (\d+)/.exec(pdf)[1]);
        const rows = pdf.slice(xrefAt).split('\n').filter((l) => / 00000 n $/.test(l) || / 65535 f $/.test(l));
        expect(rows.length).toBe(declared);
    });

    it('points every offset at the object it claims', () => {
        const pdf = asText(withPhoto());
        const xrefAt = Number(pdf.slice(pdf.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
        const rows = pdf.slice(xrefAt).split('\n').filter((l) => / 00000 n $/.test(l));
        rows.forEach((row, i) => {
            const at = Number(row.slice(0, 10));
            expect(pdf.slice(at, at + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`);
        });
    });
});
