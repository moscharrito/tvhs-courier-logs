/* An account whose password somebody else chose does nothing until it is
 * replaced.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ON THE SERVER, NOT ON THE SCREEN.
 *
 * A client that redirects to a change-password form is a suggestion: the
 * session is valid, so anything that talks to the API directly, including the
 * same browser with the form closed, carries on as normal. The whole point of
 * forcing a change is that the credential two people know cannot be used for
 * anything else in the meantime, and only the server can hold that.
 *
 * So this refuses almost everything and the client's redirect is a courtesy
 * on top of it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT STAYS OPEN, AND WHY EACH ONE HAS TO.
 *
 * Refusing literally everything would refuse the request that fixes it. The
 * list is as short as it can be and each entry earns its place:
 *
 *   POST /api/me/password   the way out. Refusing this is a locked account.
 *   GET  /api/session       how a client learns it is in this state at all.
 *   POST /api/logout        somebody must always be able to leave.
 *
 * Nothing here reads patient data, which is the test an entry has to pass.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 403 AND A CODE, NOT A REDIRECT.
 *
 * An API that answers a data request with a redirect to a form produces a
 * client that follows it and renders an HTML page into a JSON parser. The
 * code is what the browser app keys on, and the message is written to be read
 * by somebody who sees it raw.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Exactly what an account in this state may still call. */
export const ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
    { method: 'POST', path: '/api/me/password' },
    { method: 'GET', path: '/api/session' },
    { method: 'POST', path: '/api/logout' },
];

export const MUST_CHANGE_CODE = 'password.mustChange';

const isAllowed = (method: string, path: string): boolean =>
    ALLOWED.some((a) => a.method === method && a.path === path);

/**
 * Refuse everything but the way out, for a session whose password was set by
 * somebody else.
 *
 * Only guards /api: the web shell, its assets, /health and /privacy are not
 * the account doing anything, and a person who cannot load the page cannot
 * reach the form either.
 */
export function createMustChangeMiddleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const user = req.session?.user;
        if (!user || !user.mustChangePassword) { next(); return; }
        if (!req.path.startsWith('/api/')) { next(); return; }
        if (isAllowed(req.method, req.path)) { next(); return; }

        res.status(403).json({
            error: 'Your password was set for you and has to be changed before you can go further. '
                + 'Open Devices and sign-in, and change it there.',
            code: MUST_CHANGE_CODE,
        });
    };
}
