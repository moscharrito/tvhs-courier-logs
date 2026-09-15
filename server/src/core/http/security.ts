/* Response headers that constrain the browser.
 *
 * Ticket 4.2. Written here rather than taken from helmet for the same reason
 * as the PDF writer and the SigV4 signer: the whole requirement is a fixed set
 * of headers whose values this application has to decide anyway, and a
 * dependency in the path of every response is a dependency to patch, audit and
 * explain to University Health. Sixty lines, and every value has a reason next
 * to it.
 *
 * The policy below is deliberately strict enough that it would break if
 * somebody added a third-party script to a page holding PHI. That is the
 * point: the CSP is a tripwire as much as a defence.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Config } from '../../config';
import { MAPS_EMBED_ORIGIN } from '../../modules/uh/directions';

export interface SecurityOptions {
    isProduction: boolean;
    /** Origins the browser may fetch from and send to, beyond our own. */
    connectOrigins?: string[];
    /** Origins images may be loaded from, beyond our own. */
    imageOrigins?: string[];
    /** Origins that may be put in an iframe. Empty keeps frame-src 'none'. */
    frameOrigins?: string[];
}

/** The S3 origin, when a bucket is configured. Presigned PUTs go straight
 *  there from the phone, and a presigned GET renders a doorstep photo. */
export function s3Origin(config: Pick<Config, 'files'>): string | null {
    const s3 = config.files.s3;
    if (!config.files.enabled || !s3) return null;
    return `https://${s3.bucket}.s3.${s3.region}.amazonaws.com`;
}

export function buildCsp(options: SecurityOptions): string {
    const connect = ["'self'", ...(options.connectOrigins ?? [])];
    const img = ["'self'", 'data:', 'blob:', ...(options.imageOrigins ?? [])];
    const frame = options.frameOrigins ?? [];

    const directives: Array<[string, string[]]> = [
        // Nothing loads from anywhere unless a directive below says otherwise.
        ['default-src', ["'self'"]],
        /* No inline scripts anywhere, and no CDN. The shell is one module
         * bundle from our own origin; the legacy TVHS page's date picker is
         * served from server/public/vendor rather than cdnjs, which is what
         * lets this line stay this short. */
        ['script-src', ["'self'"]],
        /* 'unsafe-inline' covers style attributes, which React components set
         * in about fifty places, and the boot styles in index.html that paint
         * the loading state before the bundle arrives. It is the one relaxed
         * directive here. Style injection cannot execute code; the cost is
         * that a successful HTML injection could restyle the page, and the
         * price of removing it is a nonce through the whole render path. */
        ['style-src', ["'self'", "'unsafe-inline'"]],
        // data: for signatures drawn on a canvas, blob: for a photo preview.
        ['img-src', img],
        ['font-src', ["'self'"]],
        ['connect-src', connect],
        // No plugins, no applets, nothing with its own parser.
        ['object-src', ["'none'"]],
        // A <base> tag rewritten by an injection would repoint every relative URL.
        ['base-uri', ["'none'"]],
        // Forms post to us. Nothing here should ever post somewhere else.
        ['form-action', ["'self'"]],
        /* Not framed by anyone. Clickjacking a dispatch board into approving
         * something is a real shape of attack, and this app has no reason to
         * be embedded. */
        ['frame-ancestors', ["'none'"]],
        /* Nothing may be framed BY us either, unless an origin was named. The
         * only caller that names one is the courier map (ticket 5.13), and it
         * only names one when that embed is explicitly switched on. Keeping
         * the default 'none' means an injected iframe still has nowhere to
         * point, which is most of what this directive was doing. */
        ['frame-src', frame.length > 0 ? frame : ["'none'"]],
        ['worker-src', ["'self'"]],
        // The service worker's scope, which must stay ours.
        ['manifest-src', ["'self'"]],
    ];

    /* Only in production: the development server is plain HTTP on localhost,
     * and upgrading those requests breaks the dev shell. */
    if (options.isProduction) directives.push(['upgrade-insecure-requests', []]);

    return directives.map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name)).join('; ');
}

/**
 * Sets the headers on every response, API and shell alike.
 *
 * HSTS is production-only and deliberate: sending it from a development server
 * would pin localhost to HTTPS in the developer's browser for a year.
 */
export function createSecurityHeaders(options: SecurityOptions): RequestHandler {
    const csp = buildCsp(options);

    return (_req: Request, res: Response, next: NextFunction) => {
        res.setHeader('Content-Security-Policy', csp);
        // A .txt that the browser decides is HTML is a stored XSS.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // frame-ancestors above says the same thing to browsers that read CSP.
        res.setHeader('X-Frame-Options', 'DENY');
        /* Referrers leak URLs. Ours carry order ids, which are not PHI on
         * their own but are a handle to it, and there is no reason to send
         * them to another site at all. */
        res.setHeader('Referrer-Policy', 'no-referrer');
        /* The courier app asks for the camera and for position, from our own
         * pages. Nothing else, and nothing from an embedded frame. */
        res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), interest-cohort=()');
        // Isolates this origin's browsing context from any opener.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

        if (options.isProduction) {
            // Two years, subdomains included. Render terminates TLS in front.
            res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
        }

        next();
    };
}

/** Everything the boot sequence needs, derived from the config. */
export function securityHeadersFor(config: Pick<Config, 'files' | 'isProduction' | 'geo'>): RequestHandler {
    const s3 = s3Origin(config);
    /* The courier's in-app map. Opened only when the embed is switched on, so
     * an installation that leaves it off keeps frame-src 'none' exactly as it
     * was before ticket 5.13. */
    const maps = config.geo.embedMaps ? [MAPS_EMBED_ORIGIN] : [];
    return createSecurityHeaders({
        isProduction: config.isProduction,
        connectOrigins: s3 ? [s3] : [],
        imageOrigins: s3 ? [s3] : [],
        frameOrigins: maps,
    });
}
