/* The JPEG encoder that draws the seed's photographs.
 *
 * It only ever makes fixtures, so nothing a customer touches depends on it.
 * What does depend on it is a demonstration: if it emits a file a reader
 * refuses, the symptom is a blank page in a proof of delivery in front of a
 * room, and the cause is somewhere in a thousand lines of entropy coding.
 *
 * So these check the two things that are silent when wrong: that the writer's
 * own reader recognises the output, and that the stream obeys the rules a
 * decoder actually enforces. */

import { describe, it, expect } from 'vitest';
import { encodeJpeg } from '../scripts/lib/jpeg.mjs';
import { Paper, courierForm, idCard } from '../scripts/lib/paper.mjs';
import { jpegSize, buildPdf, Page } from '../src/core/pdf/writer.ts';

/** A small gradient with some detail in it, so the coefficients are not all
 *  zero and the AC path is actually exercised. */
function sample(w, h) {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) px[y * w + x] = (x * 7 + y * 3) % 256;
    }
    return px;
}

describe('the encoder', () => {
    it('produces something the PDF writer will embed', () => {
        const jpeg = encodeJpeg(sample(64, 48), 64, 48);
        expect(jpegSize(jpeg)).toEqual({ width: 64, height: 48 });
    });

    it('opens with SOI and closes with EOI', () => {
        const jpeg = encodeJpeg(sample(16, 16), 16, 16);
        expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
        expect([jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]]).toEqual([0xff, 0xd9]);
    });

    it('stuffs a zero after every 0xFF in the scan', () => {
        /* The one mistake that is invisible until a decoder stops halfway: an
           unstuffed 0xFF reads as the start of a marker. Everything after the
           start-of-scan is entropy-coded, so no 0xFF may be followed by
           anything but 0x00 until the final end-of-image. */
        const jpeg = encodeJpeg(sample(80, 80), 80, 80, 92);
        const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
        expect(sos).toBeGreaterThan(0);

        const scanFrom = sos + 2 + jpeg.readUInt16BE(sos + 2);
        for (let i = scanFrom; i < jpeg.length - 2; i += 1) {
            if (jpeg[i] !== 0xff) continue;
            expect(jpeg[i + 1], `unstuffed marker at ${i}`).toBe(0x00);
            i += 1;
        }
    });

    it('handles sizes that are not multiples of eight', () => {
        /* The block loop pads to a boundary. Getting that wrong gives a file
           whose declared size and real size disagree, which some readers show
           and some refuse. */
        for (const [w, h] of [[1, 1], [7, 3], [13, 29], [100, 41]]) {
            const jpeg = encodeJpeg(sample(w, h), w, h);
            expect(jpegSize(jpeg), `${w}x${h}`).toEqual({ width: w, height: h });
        }
    });

    it('refuses a pixel count that does not match the dimensions', () => {
        expect(() => encodeJpeg(new Uint8Array(10), 4, 4)).toThrow(/expected 16/);
    });

    it('spends more bytes on detail than on a flat field', () => {
        /* A cheap check that the DCT is doing something. A flat image is all
           DC and should compress to almost nothing; noise should not. */
        const flat = new Uint8Array(64 * 64).fill(200);
        const busy = new Uint8Array(64 * 64);
        for (let i = 0; i < busy.length; i += 1) busy[i] = (i * 2654435761) % 256;

        expect(encodeJpeg(busy, 64, 64).length).toBeGreaterThan(encodeJpeg(flat, 64, 64).length * 4);
    });

    it('is deterministic, so a fixture can be talked about', () => {
        const a = encodeJpeg(sample(32, 32), 32, 32);
        const b = encodeJpeg(sample(32, 32), 32, 32);
        expect(a.equals(b)).toBe(true);
    });
});

describe('the drawn fixtures', () => {
    const fields = {
        reference: 'RX-000001', serviceType: 'STAT', patient: 'Invented Name',
        address: '1 Invented Street, San Antonio TX 78229', items: 'ORAL SOLIDS', qty: 2,
        dispensedBy: 'A Tech', identifiers: ['NAME', 'ADDRESS', 'PHONE'],
        receivedBy: 'Invented Name', date: '2026-09-30', time: '14:22',
        courier: 'A Courier', notes: ['A NOTE.'],
    };

    it('draw at the size they claim', () => {
        const form = courierForm(fields);
        expect(form.px.length).toBe(form.width * form.height);
        const card = idCard({ maskedName: 'A. NAME', maskedNumber: '**** 0000', date: '2026-09-30' });
        expect(card.px.length).toBe(card.width * card.height);
    });

    it('put ink on the page rather than returning a blank sheet', () => {
        /* The failure this whole exercise exists to prevent: an image that is
           technically valid and entirely one colour. */
        const form = courierForm(fields);
        const dark = form.px.reduce((n, v) => n + (v < 120 ? 1 : 0), 0);
        expect(dark).toBeGreaterThan(2000);
    });

    it('survive the round trip into a real document', () => {
        const form = courierForm(fields);
        const jpeg = encodeJpeg(form.px, form.width, form.height, 74);

        const page = new Page();
        page.image('Ph0', 54, 300, 400, 520);
        const pdf = buildPdf([page], { title: 'Proof' }, new Date('2026-09-30T12:00:00Z'), [{ name: 'Ph0', bytes: jpeg }]);

        /* Written as latin1 throughout, so every byte survives. A utf8 slip
           here corrupts the picture and nothing says so. */
        expect(pdf.includes(jpeg)).toBe(true);
        expect(pdf.toString('latin1')).toContain('/Filter /DCTDecode');
        expect(pdf.toString('latin1')).toContain(`/Width ${form.width} /Height ${form.height}`);
    });

    it('keeps the specimen band inside the identity card', () => {
        /* It used to run off the card onto the desk and through the footer,
           which reads as a rendering fault rather than a watermark. */
        const card = idCard({ maskedName: 'A. NAME', maskedNumber: '**** 0000', date: '2026-09-30' });
        for (let y = 0; y < card.height; y += 1) {
            /* The desk margin either side of the card stays uniformly dark. */
            expect(card.get(6, y), `left margin at row ${y}`).toBeLessThan(190);
        }
    });
});

describe('the page it all goes on', () => {
    it('clips rather than throwing when something is drawn off the edge', () => {
        const p = new Paper(20, 20, 255);
        expect(() => {
            p.text('OFF THE EDGE ENTIRELY', -50, -50, 3, 0);
            p.rect(-10, -10, 200, 200, 128);
            p.line(-100, -100, 400, 400, 0, 4);
        }).not.toThrow();
        expect(p.px.length).toBe(400);
    });
});
