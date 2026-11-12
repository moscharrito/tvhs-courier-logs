/* The zip container, checked by reading it back rather than by trusting it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THESE TESTS ARE WRITTEN THE WAY THEY ARE.
 *
 * A zip this code produces and this code parses would pass whatever we got
 * wrong, so neither half of that is the test. Two independent checks instead:
 *
 *   the CRC of every member is compared against node:zlib's own crc32, which
 *   knows nothing about this file;
 *
 *   the archive is taken apart by helpers/zip.mjs, which works from the
 *   FORMAT -- end-of-directory record, then the index, then each local header
 *   -- and knows nothing about this module. A field written in the wrong
 *   place or the wrong order fails to parse there, which is what every broken
 *   zip somebody cannot open actually is.
 *
 * The thing all of it is for: University Health's billing staff open this on
 * a Windows machine with no tool we chose, and a bundle that will not open is
 * indistinguishable from a bundle we never sent.
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { ZipWriter, crc32, zipSafeName, LIMITS } from '../src/core/zip/writer.ts';
import { readZip } from './helpers/zip.mjs';

/** Collects everything written, and can be told to stall so backpressure
 *  has something to push back with. */
function sink({ highWaterMark = 16 } = {}) {
    const chunks = [];
    const stream = new Writable({
        highWaterMark,
        write(chunk, _enc, cb) {
            chunks.push(Buffer.from(chunk));
            /* Asynchronously, which is what makes write() return false and
               the writer wait for 'drain'. A synchronous callback would let
               the backpressure path go untested. */
            setImmediate(cb);
        },
    });
    return { stream, bytes: () => Buffer.concat(chunks) };
}

describe('the checksum', () => {
    it('agrees with zlib, which has never read this file', () => {
        for (const sample of ['', 'a', 'proof of delivery', 'x'.repeat(5000)]) {
            const bytes = Buffer.from(sample, 'utf8');
            expect(crc32(bytes), `crc of ${sample.length} bytes`).toBe(zlibCrc32(bytes));
        }
    });

    it('is unsigned, because every field it goes into is', () => {
        /* A signed result writes as 0xffffffff-something and the archive
           fails its own integrity check in an unzipper that bothers. */
        for (const sample of ['delivery', 'University Health', '\u0000ÿ']) {
            expect(crc32(Buffer.from(sample, 'utf8'))).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('an archive', () => {
    it('reads back as the files that went into it, byte for byte', async () => {
        const { stream, bytes } = sink();
        const zip = new ZipWriter(stream);
        const sheet = Buffer.from('a spreadsheet', 'utf8');
        const pdf = Buffer.from('%PDF-1.4 proof', 'utf8');
        await zip.add('deliveries.xlsx', sheet);
        await zip.add('Robert B. Green Pharmacy/proof-of-delivery-41.pdf', pdf);
        await zip.finish();

        const files = readZip(bytes());
        expect(files.map((f) => f.name)).toEqual([
            'deliveries.xlsx',
            'Robert B. Green Pharmacy/proof-of-delivery-41.pdf',
        ]);
        expect(files[0].data.equals(sheet)).toBe(true);
        expect(files[1].data.equals(pdf)).toBe(true);
    });

    it('stores rather than compresses, and says so in the header', async () => {
        /* Not a performance note: a member declared deflated and written
           stored is an archive that opens and then fails on extract, which
           is the worst of the three outcomes. */
        const { stream, bytes } = sink();
        const zip = new ZipWriter(stream);
        await zip.add('a.pdf', Buffer.alloc(200, 7));
        await zip.finish();
        const [file] = readZip(bytes());
        expect(file.method).toBe(0);
        expect(file.data.length).toBe(file.size);
    });

    it('flags its names as UTF-8, so an accent is not a mojibake folder', async () => {
        const { stream, bytes } = sink();
        const zip = new ZipWriter(stream);
        await zip.add('Farmacia Peña/proof.pdf', Buffer.from('x'));
        await zip.finish();
        const [file] = readZip(bytes());
        expect(file.flags & 0x0800).toBe(0x0800);
        expect(file.name).toBe('Farmacia Peña/proof.pdf');
    });

    it('survives a reader that stalls, which is what a real download does', async () => {
        /* A 60 MB bundle going to somebody on hospital wifi spends most of
           its life waiting. If the writer ignored backpressure it would hold
           the whole archive in memory, which is the thing streaming exists
           to avoid -- and the stall path is the one that never runs in a
           test with a fast sink. */
        const { stream, bytes } = sink({ highWaterMark: 8 });
        const zip = new ZipWriter(stream);
        for (let i = 0; i < 25; i += 1) await zip.add(`doc-${i}.pdf`, Buffer.alloc(400, i));
        await zip.finish();

        const files = readZip(bytes());
        expect(files).toHaveLength(25);
        expect(files[24].data.every((b) => b === 24)).toBe(true);
    });

    it('is a valid archive with nothing in it', async () => {
        /* No caller does this -- the route refuses an empty range before it
           gets here -- but an empty zip that is malformed is a crash in an
           unzipper rather than an empty window, and that is a bad way to
           find out. */
        const { stream, bytes } = sink();
        const zip = new ZipWriter(stream);
        await zip.finish();
        expect(readZip(bytes())).toEqual([]);
    });

    it('refuses a second finish rather than writing two indexes', async () => {
        const { stream, bytes } = sink();
        const zip = new ZipWriter(stream);
        await zip.add('a.txt', Buffer.from('a'));
        await zip.finish();
        const after = bytes().length;
        await zip.finish();
        expect(bytes().length).toBe(after);
        await expect(zip.add('b.txt', Buffer.from('b'))).rejects.toThrow(/finished/);
    });

    it('rejects rather than hangs when the download is cancelled', async () => {
        /* Somebody closing the tab halfway through must not leave a request
           rendering documents for another two minutes. */
        const { stream } = sink({ highWaterMark: 8 });
        const zip = new ZipWriter(stream);
        const pending = (async () => {
            for (let i = 0; i < 500; i += 1) await zip.add(`doc-${i}.pdf`, Buffer.alloc(2000, 1));
        })();
        setImmediate(() => stream.destroy());
        await expect(pending).rejects.toThrow(/cancelled/);
    });

    it('counts and measures what it has written, for the caller to audit', async () => {
        const { stream } = sink();
        const zip = new ZipWriter(stream);
        await zip.add('a.txt', Buffer.from('12345'));
        expect(zip.count).toBe(1);
        expect(zip.written).toBe(30 + 'a.txt'.length + 5);
    });
});

describe('a name a zip and a filesystem will both take', () => {
    it('loses the characters Windows refuses, not only the ones we mind', () => {
        expect(zipSafeName('Green: Pharmacy/Annex*?')).toBe('Green- Pharmacy-Annex--');
        expect(zipSafeName('a\u0000b')).toBe('a-b');
    });

    it('never ends in a dot or a space, which Windows silently drops', () => {
        expect(zipSafeName('Pharmacy. ')).toBe('Pharmacy');
        expect(zipSafeName('   ')).toBe('unnamed');
    });

    it('keeps a name short enough to extract inside a deep folder', () => {
        expect(zipSafeName('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    });

    it('states the ceilings of the format, so a caller refuses before it starts', () => {
        /* The route checks these BEFORE the first byte: there is no way to
           refuse halfway through a download. */
        expect(LIMITS.entries).toBeLessThan(65_535);
        expect(LIMITS.bytes).toBe(0xffffffff);
    });
});
