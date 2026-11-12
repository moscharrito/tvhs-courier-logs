/* A zip file, written to a socket as it goes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HAND-WRITTEN RATHER THAN A DEPENDENCY.
 *
 * The only thing this is for is handing University Health a month of their
 * own deliveries with the proof of each one beside it. That is a container
 * format, not an algorithm: every member is stored uncompressed, because a
 * PDF whose own streams are already deflated and whose photographs are
 * already JPEG does not compress, and spending CPU to discover that on
 * several hundred documents is worse than not spending it.
 *
 * So the whole job is four record layouts and a CRC, which is less code than
 * the audit of a package would be. core/pdf/writer.ts was written for the
 * same reason and the same way.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT STREAMS, AND THAT IS THE POINT RATHER THAN AN OPTIMISATION.
 *
 * A bundle of five hundred proofs of delivery is a few hundred megabytes.
 * Building that in memory and then sending it would mean the server holding
 * all of it at once -- on an instance sized for a dispatch board -- and
 * sending nothing for the two minutes it took to assemble, which is long
 * enough for a proxy to give up on a request that was going perfectly well.
 *
 * The format is built for this: every member carries its own header, so each
 * one can go out as soon as it exists, and the index comes last. Nothing
 * here holds more than the document it is currently writing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * No compression (method 0), no encryption, no zip64. Zip64 is the one worth
 * naming: without it a member must be under 4 GB, the whole file must be
 * under 4 GB, and there must be fewer than 65,535 members. A caller that
 * could exceed any of those has to refuse before it starts rather than
 * discover it here, because by then the response has begun and there is no
 * way left to say no. See `LIMITS` and the check in client-portal.ts.
 */

import type { Writable } from 'node:stream';

/** What a caller must stay inside, because this writes the 32-bit format. */
export const LIMITS = {
    /** Members. The end-of-directory record counts them in 16 bits. */
    entries: 65_534,
    /** Bytes, per member and in total. Offsets and sizes are 32-bit. */
    bytes: 0xffff_ffff,
} as const;

/* ------------------------------------------------------------------- crc32 */

/** The ordinary reflected CRC-32, built once. */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

/** Unsigned, because every field this goes into is unsigned. */
export function crc32(bytes: Uint8Array): number {
    let c = ~0;
    for (let i = 0; i < bytes.length; i += 1) {
        c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (~c) >>> 0;
}

/* ------------------------------------------------------- the clock in a zip
 *
 * MS-DOS time: two-second resolution, no zone, and the epoch is 1980. Every
 * unzipper reads it as local time with no way to know whose. It is written
 * because the format has the field, and nothing anywhere should read a date
 * back out of it -- what a bundle covers is said in the spreadsheet inside
 * it, where it can be said in words and with a timezone.
 */
function dosStamp(at: Date): { time: number; date: number } {
    const year = Math.max(1980, at.getFullYear());
    return {
        time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    };
}

/* ------------------------------------------------------------- backpressure
 *
 * A write that returns false means the kernel buffer is full and the right
 * thing to do is wait. Ignoring it is how a process writing a 300 MB
 * response ends up holding all 300 MB in its own memory, which is the thing
 * streaming was supposed to avoid.
 *
 * A closed socket rejects rather than hanging: somebody who cancelled a
 * download should not leave a request rendering documents for another two
 * minutes.
 */
function send(out: Writable, chunk: Buffer): Promise<void> {
    if (out.destroyed || out.writableEnded) {
        return Promise.reject(new Error('The download was cancelled before the file was finished.'));
    }
    if (out.write(chunk)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const onClose = () => {
            out.off('drain', onDrain);
            reject(new Error('The download was cancelled before the file was finished.'));
        };
        const onDrain = () => {
            out.off('close', onClose);
            resolve();
        };
        out.once('close', onClose);
        out.once('drain', onDrain);
    });
}

/* ------------------------------------------------------------- the records */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** 2.0, which is all that storing files without zip64 needs. */
const VERSION = 20;
/** Bit 11: the name is UTF-8. Set always, so a pharmacy with an accent in
 *  its name is not a mojibake folder on somebody's desktop. */
const UTF8_NAME = 0x0800;
/** Stored. See the header. */
const STORED = 0;

interface Member {
    name: Buffer;
    crc: number;
    size: number;
    /** Where this member's local header began. */
    offset: number;
}

/**
 * One zip, one response.
 *
 * `add` writes a whole member; `finish` writes the index. Both must be
 * awaited, and a caller that throws in between has produced a truncated file
 * -- which is why the route doing this sends the spreadsheet first, so an
 * interrupted download is still obviously incomplete rather than quietly
 * short of a few documents.
 */
export class ZipWriter {
    private readonly members: Member[] = [];
    private offset = 0;
    private readonly at: Date;
    private done = false;

    constructor(private readonly out: Writable, at: Date = new Date()) {
        this.at = at;
    }

    /** Members written so far. */
    get count(): number {
        return this.members.length;
    }

    /** Bytes written so far, index excluded. */
    get written(): number {
        return this.offset;
    }

    /**
     * A file, at `name`, whose bytes are `body`.
     *
     * A forward slash in the name is a folder, which is how the pharmacies
     * end up in their own folders. No directory members are written: every
     * unzipper creates the path a file needs, and the ones that did not
     * predate the contract by twenty years.
     */
    async add(name: string, body: Buffer): Promise<void> {
        if (this.done) throw new Error('This zip has already been finished.');
        const nameBytes = Buffer.from(name, 'utf8');
        const crc = crc32(body);
        const { time, date } = dosStamp(this.at);

        if (this.members.length >= LIMITS.entries) throw new Error('Too many files for a zip of this format.');
        if (body.length > LIMITS.bytes || this.offset + body.length > LIMITS.bytes) {
            throw new Error('Too large for a zip of this format.');
        }

        const header = Buffer.alloc(30);
        header.writeUInt32LE(LOCAL_SIGNATURE, 0);
        header.writeUInt16LE(VERSION, 4);
        header.writeUInt16LE(UTF8_NAME, 6);
        header.writeUInt16LE(STORED, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(body.length, 18);
        header.writeUInt32LE(body.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        header.writeUInt16LE(0, 28);

        this.members.push({ name: nameBytes, crc, size: body.length, offset: this.offset });
        await send(this.out, Buffer.concat([header, nameBytes]));
        await send(this.out, body);
        this.offset += header.length + nameBytes.length + body.length;
    }

    /** The index, and nothing more written afterwards. */
    async finish(): Promise<void> {
        if (this.done) return;
        this.done = true;
        const { time, date } = dosStamp(this.at);
        const start = this.offset;

        for (const m of this.members) {
            const entry = Buffer.alloc(46);
            entry.writeUInt32LE(CENTRAL_SIGNATURE, 0);
            entry.writeUInt16LE(VERSION, 4);
            entry.writeUInt16LE(VERSION, 6);
            entry.writeUInt16LE(UTF8_NAME, 8);
            entry.writeUInt16LE(STORED, 10);
            entry.writeUInt16LE(time, 12);
            entry.writeUInt16LE(date, 14);
            entry.writeUInt32LE(m.crc, 16);
            entry.writeUInt32LE(m.size, 20);
            entry.writeUInt32LE(m.size, 24);
            entry.writeUInt16LE(m.name.length, 28);
            entry.writeUInt16LE(0, 30);
            entry.writeUInt16LE(0, 32);
            entry.writeUInt16LE(0, 34);
            entry.writeUInt16LE(0, 36);
            entry.writeUInt32LE(0, 38);
            entry.writeUInt32LE(m.offset, 42);
            await send(this.out, Buffer.concat([entry, m.name]));
            this.offset += entry.length + m.name.length;
        }

        const end = Buffer.alloc(22);
        end.writeUInt32LE(END_SIGNATURE, 0);
        end.writeUInt16LE(0, 4);
        end.writeUInt16LE(0, 6);
        end.writeUInt16LE(this.members.length, 8);
        end.writeUInt16LE(this.members.length, 10);
        end.writeUInt32LE(this.offset - start, 12);
        end.writeUInt32LE(start, 16);
        end.writeUInt16LE(0, 20);
        await send(this.out, end);
    }
}

/**
 * A name a zip, a filesystem and Windows will all accept.
 *
 * Reserved characters go, not just the ones this platform minds: a bundle is
 * extracted on whatever the person who asked for it uses, and a colon in a
 * pharmacy's name should not be the reason a folder cannot be created. Dots
 * and spaces at the end go for the same reason.
 */
export function zipSafeName(raw: string): string {
    const cleaned = raw
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');
    return cleaned === '' ? 'unnamed' : cleaned.slice(0, 80);
}
