/* A zip, read from the format.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE READER, AND IT IS NOT THE WRITER TURNED ROUND.
 *
 * core/zip/writer.ts produces the bundles University Health's billing staff
 * download. A test that parsed them with the writer's own variables would
 * pass whatever we got wrong, so this works the way an unzipper works and
 * knows nothing about that module: find the end-of-central-directory record,
 * read the index, then go to the offset the index claims and check the local
 * header agrees with it.
 *
 * It THROWS rather than returning a verdict. Every failure here is an archive
 * somebody cannot open, which is not a soft finding.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Every member, in index order.
 *
 * `{ name, data, crc, method, flags, size }` — `data` is the stored bytes, so
 * a caller comparing it against what went in is comparing the whole path
 * through the format.
 */
export function readZip(buf) {
    const end = buf.lastIndexOf(END);
    if (end < 0) throw new Error('not a zip: no end-of-central-directory record');
    const count = buf.readUInt16LE(end + 10);
    const size = buf.readUInt32LE(end + 12);
    const start = buf.readUInt32LE(end + 16);
    if (start + size !== end) throw new Error(`the index ends at ${start + size}, not at ${end}`);

    const files = [];
    let at = start;
    for (let i = 0; i < count; i += 1) {
        if (buf.readUInt32LE(at) !== CENTRAL) throw new Error(`member ${i}: no central directory header`);
        const flags = buf.readUInt16LE(at + 8);
        const method = buf.readUInt16LE(at + 10);
        const crc = buf.readUInt32LE(at + 16);
        const compressed = buf.readUInt32LE(at + 20);
        const uncompressed = buf.readUInt32LE(at + 24);
        const nameLength = buf.readUInt16LE(at + 28);
        const extraLength = buf.readUInt16LE(at + 30);
        const commentLength = buf.readUInt16LE(at + 32);
        const offset = buf.readUInt32LE(at + 42);
        const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');

        /* And now from the front, at the offset the index claims. A writer
           that recorded the wrong one produces an archive that lists its
           files and cannot extract them. */
        if (buf.readUInt32LE(offset) !== LOCAL) throw new Error(`${name}: no local header at ${offset}`);
        const localNameLength = buf.readUInt16LE(offset + 26);
        const localExtraLength = buf.readUInt16LE(offset + 28);
        const localName = buf.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8');
        if (localName !== name) throw new Error(`${name}: the local header calls it ${localName}`);
        if (buf.readUInt32LE(offset + 14) !== crc) throw new Error(`${name}: the two headers disagree about the checksum`);
        if (buf.readUInt32LE(offset + 22) !== uncompressed) throw new Error(`${name}: the two headers disagree about the size`);

        const dataAt = offset + 30 + localNameLength + localExtraLength;
        files.push({
            name,
            data: buf.subarray(dataAt, dataAt + compressed),
            crc,
            method,
            flags,
            size: uncompressed,
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

/** The members by name, for a caller that wants to look one up. */
export const zipMap = (buf) => new Map(readZip(buf).map((f) => [f.name, f]));
