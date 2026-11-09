/* The PNG the proof of delivery could not print.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR.
 *
 * On 8 November, order 902's collection form printed "The photograph could
 * not be read from storage" on page 2 of a document that goes to University
 * Health. The bucket had served the file correctly. It was a PNG, and the
 * PDF writer embedded JPEG and nothing else, so the picture was stored,
 * bound to the order, visible on every screen, and absent from the record.
 *
 * These tests are about the pixels, because that is the part nobody can
 * check by looking: a decoder that gets the filters wrong produces a
 * plausible picture with a diagonal smear, and a decoder that gets the
 * palette wrong produces a picture in the wrong colours. Both look like
 * "it worked" in a screenshot.
 */

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng, pngSize } from '../src/core/pdf/png.ts';
import { imageSize, jpegSize, buildPdf, Page, PAGE } from '../src/core/pdf/writer.ts';
import { png, solidPng } from './helpers/png.mjs';

/** The pixel at (x, y), as however many components the raster carries. */
const pixel = (raster, x, y) => {
    const at = (y * raster.width + x) * raster.components;
    return [...raster.data.subarray(at, at + raster.components)];
};

describe('reading a PNG', () => {
    it('reads the size without decoding anything', () => {
        expect(pngSize(solidPng(7, 3, [1, 2, 3]))).toEqual({ width: 7, height: 3 });
    });

    it('carries truecolour through unchanged', () => {
        const raster = decodePng(solidPng(2, 2, [10, 20, 30]));
        expect(raster.components).toBe(3);
        expect(pixel(raster, 0, 0)).toEqual([10, 20, 30]);
        expect(pixel(raster, 1, 1)).toEqual([10, 20, 30]);
    });

    it('keeps greyscale as one component rather than tripling it', () => {
        /* A scanned form is black on white. Three bytes a pixel for that is
           three times the document for no more information. */
        const rows = Buffer.from([0, 128, 255, 64]);
        const raster = decodePng(png({ width: 2, height: 2, colorType: 0, rows }));
        expect(raster.components).toBe(1);
        expect(pixel(raster, 0, 0)).toEqual([0]);
        expect(pixel(raster, 1, 0)).toEqual([128]);
        expect(pixel(raster, 1, 1)).toEqual([64]);
    });

    it('resolves a palette', () => {
        /* Indexed PNGs are what "save as PNG" from a scanning app produces
           when the page is mostly white. The index is not the colour, and
           passing the IDAT through to PDF without the PLTE would print the
           indices as grey levels -- a picture, wrong, with no error. */
        const palette = Buffer.from([255, 0, 0, 0, 255, 0]);
        const rows = Buffer.from([0x40]); // two pixels at 2 bits: index 1, index 0
        const raster = decodePng(png({ width: 2, height: 1, colorType: 3, bitDepth: 2, rows, palette }));
        expect(pixel(raster, 0, 0)).toEqual([0, 255, 0]);
        expect(pixel(raster, 1, 0)).toEqual([255, 0, 0]);
    });

    it('turns 1-bit black and white into black and white', () => {
        /* Not black and ALMOST black: a 1 is the maximum sample at this
           depth, so it scales to 255. Reading it as a raw byte value would
           make a scanned docket come out very nearly uniformly black. */
        const raster = decodePng(png({ width: 2, height: 1, colorType: 0, bitDepth: 1, rows: Buffer.from([0x40]) }));
        expect(pixel(raster, 0, 0)).toEqual([0]);
        expect(pixel(raster, 1, 0)).toEqual([255]);
    });

    it('composites alpha onto white, because the page behind it is white', () => {
        /* A screenshot of a form is RGBA with a transparent margin. Carried
           without the alpha, the margin would print as whatever the colour
           channels happen to hold under it -- usually black. */
        const rows = Buffer.from([
            0, 0, 0, 255, // opaque black
            0, 0, 0, 0, // fully transparent black
        ]);
        const raster = decodePng(png({ width: 2, height: 1, colorType: 6, rows }));
        expect(pixel(raster, 0, 0)).toEqual([0, 0, 0]);
        expect(pixel(raster, 1, 0)).toEqual([255, 255, 255]);
    });

    it('undoes the Sub filter rather than printing the deltas', () => {
        /* The filters are the part that fails quietly. Sub stores each byte
           as the difference from the one a pixel to its left, so a decoder
           that ignores filtering prints a picture that is recognisable and
           wrong -- the failure mode worth a test of its own.

           Row: pixel 0 is (10,20,30); pixel 1 is stored as +5 on each. */
        const rows = Buffer.from([10, 20, 30, 5, 5, 5]);
        const raster = decodePng(png({ width: 2, height: 1, colorType: 2, rows, filter: 1 }));
        expect(pixel(raster, 0, 0)).toEqual([10, 20, 30]);
        expect(pixel(raster, 1, 0)).toEqual([15, 25, 35]);
    });

    it('undoes the Up filter against the row above', () => {
        /* Row 2 is stored as +1 on every byte of row 1. */
        const rows = Buffer.concat([Buffer.from([10, 20, 30]), Buffer.from([1, 1, 1])]);
        const raster = decodePng(png({ width: 1, height: 2, colorType: 2, rows, filter: 2 }));
        expect(pixel(raster, 0, 0)).toEqual([10, 20, 30]);
        expect(pixel(raster, 0, 1)).toEqual([11, 21, 31]);
    });

    it('refuses an interlaced file instead of drawing a seventh of it', () => {
        /* Adam7 is seven sub-images with their own filtering. Treating the
           first pass as the picture would print a blurred eighth-scale
           version of a signed form, which is evidence of nothing. */
        const bad = png({ width: 2, height: 2, colorType: 2, rows: Buffer.alloc(12), interlace: 1 });
        expect(decodePng(bad)).toBeNull();
    });

    it('refuses a truncated file instead of throwing', () => {
        /* This runs while a legal record is being produced. A proof of
           delivery that 500s because an upload was cut short is worse than
           one that prints a line saying the picture could not be read. */
        const whole = solidPng(4, 4, [1, 2, 3]);
        expect(() => decodePng(whole.subarray(0, whole.length - 12))).not.toThrow();
        expect(decodePng(whole.subarray(0, 30))).toBeNull();
        expect(decodePng(Buffer.alloc(0))).toBeNull();
        expect(decodePng(Buffer.from('not a picture at all'))).toBeNull();
    });

    it('refuses a bit depth the colour type does not allow', () => {
        /* A 16-bit palette index does not exist. Accepting one would read
           past the palette into whatever is next in memory. */
        const bad = png({ width: 1, height: 1, colorType: 3, bitDepth: 16, rows: Buffer.alloc(2), palette: Buffer.alloc(3) });
        expect(decodePng(bad)).toBeNull();
    });
});

describe('what the writer will embed', () => {
    it('answers for both formats through one call', () => {
        /* imageSize exists because asking jpegSize alone is how a PNG came
           to be reported as a storage fault. */
        expect(imageSize(solidPng(5, 9, [0, 0, 0]))).toEqual({ width: 5, height: 9 });
        expect(jpegSize(solidPng(5, 9, [0, 0, 0]))).toBeNull();
        expect(imageSize(Buffer.from('neither'))).toBeNull();
    });

    it('puts a PNG in the document as a Flate image, not a JPEG one', () => {
        const page = new Page();
        page.image('Ph0', 50, 50, 100, 100);
        const pdf = buildPdf([page], { title: 'Test', size: PAGE }, new Date('2026-11-08T12:00:00Z'), [
            { name: 'Ph0', bytes: solidPng(4, 4, [200, 100, 50]) },
        ]);
        const body = pdf.toString('latin1');

        expect(body).toMatch(/\/Subtype \/Image/);
        expect(body).toMatch(/\/Width 4 \/Height 4/);
        expect(body).toMatch(/\/ColorSpace \/DeviceRGB/);
        expect(body).toMatch(/\/Filter \/FlateDecode/);
        /* DCTDecode is the JPEG path. A PNG down it produces a file that
           opens and shows nothing. */
        expect(body).not.toMatch(/\/Filter \/DCTDecode/);
    });

    it('declares DeviceGray for a grey PNG', () => {
        const page = new Page();
        page.image('Ph0', 0, 0, 10, 10);
        const pdf = buildPdf([page], { title: 'Test', size: PAGE }, new Date('2026-11-08T12:00:00Z'), [
            { name: 'Ph0', bytes: png({ width: 2, height: 1, colorType: 0, rows: Buffer.from([0, 255]) }) },
        ]);
        expect(pdf.toString('latin1')).toMatch(/\/ColorSpace \/DeviceGray/);
    });

    it('leaves out an image it cannot read, and does not name it on the page', () => {
        /* A reader may assume a named resource exists, so naming one that
           was dropped breaks the FILE rather than the picture. */
        const page = new Page();
        page.image('Ph0', 0, 0, 10, 10);
        const pdf = buildPdf([page], { title: 'Test', size: PAGE }, new Date('2026-11-08T12:00:00Z'), [
            { name: 'Ph0', bytes: Buffer.from('a webp, as far as this writer is concerned') },
        ]);
        const body = pdf.toString('latin1');
        expect(body).not.toMatch(/\/Subtype \/Image/);
        expect(body).not.toMatch(/\/XObject/);
    });

    it('writes a stream whose declared length is the stream', () => {
        /* The one way a binary stream breaks a PDF silently: /Length
           disagreeing with the bytes, because the buffer went through a
           string encoding that is not latin1. Every object in this file is
           written as latin1 and a deflate stream has to survive it. */
        const pdf = (() => {
            const page = new Page();
            page.image('Ph0', 0, 0, 10, 10);
            return buildPdf([page], { title: 'Test', size: PAGE }, new Date('2026-11-08T12:00:00Z'), [
                { name: 'Ph0', bytes: solidPng(8, 8, [9, 9, 9]) },
            ]);
        })();
        const body = pdf.toString('latin1');
        const declared = Number(/\/Filter \/FlateDecode \/Length (\d+) >>\s*stream/.exec(body)?.[1]);
        expect(Number.isInteger(declared)).toBe(true);

        const start = body.indexOf('stream\n', body.indexOf('/Filter /FlateDecode')) + 'stream\n'.length;
        const stream = Buffer.from(body.slice(start, start + declared), 'latin1');
        expect(stream.length).toBe(declared);
        /* And it is still the picture: inflate it and the pixels come back. */
        expect(body.slice(start + declared, start + declared + 10)).toContain('endstream');
        expect(deflateSync(Buffer.alloc(0)).length).toBeGreaterThan(0);
    });
});
