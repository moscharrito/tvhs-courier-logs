/* Gzip on the way out.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DISPATCH BOARD IS 361 KB AND IT IS POLLED EVERY FIFTEEN SECONDS.
 *
 * Measured, by scripts/board-payload.mjs, against a real Tuesday of 1,417
 * deliveries. Four dispatchers leaving the board open for a ten hour day is
 * 3.3 GB out of Render. The same document gzips to 28 KB, which is 92 percent
 * of it, because a board is seven hundred objects with the same sixteen keys
 * and that is the shape compression was invented for.
 *
 * Cloudflare already brotli-compresses what reaches the dispatcher, so this
 * is not about their wifi, which was always fine. It is the Render to
 * Cloudflare leg, which is uncompressed, billed, and nobody's screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WRAPS res.json AND NOTHING ELSE, DELIBERATELY.
 *
 * The usual shape for this is a filter over the whole response stream, and it
 * is the shape that breaks things: this server also hands back proof-of-
 * delivery JPEGs, generated PDFs and spreadsheet exports, all already
 * compressed formats, some written straight to the socket. Re-compressing
 * those wastes CPU to make them slightly larger, and a stream filter that
 * mishandles one of them corrupts a signed document.
 *
 * Every large response this platform produces that is worth compressing goes
 * through res.json. So that is the only thing touched. A PDF cannot be
 * affected by this file, which is a property worth having rather than a
 * limitation to apologise for.
 *
 * No dependency. zlib is in Node, the negotiation is three lines, and this
 * server carries seven production dependencies on purpose.
 */

import type { Request, Response, NextFunction } from 'express';
import { gzipSync } from 'node:zlib';

/* Below this, compressing costs more than it saves: the gzip header alone is
 * eighteen bytes and a small JSON object can come out larger than it went in.
 * Every response that matters here is measured in hundreds of kilobytes. */
const MINIMUM_BYTES = 1024;

/* Level 6 is zlib's default and the reason it is the default. On the board,
 * 9 buys about another one percent for several times the CPU, and this runs
 * on a shared Render instance that would rather be answering the next poll. */
const LEVEL = 6;

/** Does the caller say it can read gzip? */
export function acceptsGzip(header: string | undefined): boolean {
    if (!header) return false;
    /* q=0 is a client saying "not this one". Rare, and cheap to honour
       correctly rather than shipping a body it asked us not to send. */
    for (const part of header.split(',')) {
        const [name, ...params] = part.trim().split(';');
        if (name?.trim().toLowerCase() !== 'gzip' && name?.trim() !== '*') continue;
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        if (q && Number(q.slice(2)) === 0) return false;
        return true;
    }
    return false;
}

export function createCompressionMiddleware() {
    return function compressJson(req: Request, res: Response, next: NextFunction): void {
        const original = res.json.bind(res);

        res.json = function json(body: unknown): Response {
            /* Content-Encoding already set means something upstream has
               already encoded this body. Leave it alone rather than wrapping
               an encoding in another one. */
            if (res.getHeader('Content-Encoding')) return original(body);

            let text: string;
            try {
                text = JSON.stringify(body);
            } catch {
                /* Circular or otherwise unserialisable: hand it back to
                   Express, whose error is the one the caller expects. */
                return original(body);
            }
            if (text === undefined) return original(body);

            const bytes = Buffer.from(text, 'utf8');
            if (bytes.length < MINIMUM_BYTES || !acceptsGzip(req.headers['accept-encoding'] as string | undefined)) {
                return original(body);
            }

            const packed = gzipSync(bytes, { level: LEVEL });

            if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Encoding', 'gzip');

            /* send, not end. Express's send computes the ETag, sets the
               length, and answers a matching If-None-Match with a 304 and no
               body at all. A polled board revalidating for free is worth more
               than the compression is, and writing to the socket directly
               would have thrown that away without anything failing to say so. */
            return res.send(packed);
        } as Response['json'];

        /* vary(), not setHeader: this appends to whatever is already there
           rather than replacing it. Set unconditionally, including on the
           responses that end up too small to compress, because what the
           header describes is that this endpoint's representation depends on
           Accept-Encoding at all. A cache holding a gzipped body and handing
           it to a client that did not ask for gzip is a page of mojibake. */
        res.vary('Accept-Encoding');
        next();
    };
}
