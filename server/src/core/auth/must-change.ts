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
 *   the /api/login family   signing in is not "going further".
 *
 * Nothing here reads patient data, which is the test an entry has to pass.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SIGNING IN IS ON THE LIST, WHICH IT WAS NOT.
 *
 * Reported from production: a new pharmacy account typed its password and
 * got this rule's own message back AS A SIGN-IN ERROR, with the form still in
 * front of it. Once the first sign-in succeeds the session carries the flag,
 * and /api/login is an /api/* request like any other, so the SECOND attempt
 * was refused by the rule rather than by the credentials. The message then
 * told somebody to open their account screen, which is not reachable from a
 * sign-in page.
 *
 * It is the same shape as the shell lockout fixed in 38e5912 and a separate
 * instance of it: that one was the client failing to show the form, this one
 * is the server refusing the request that gets somebody back to it. Both end
 * with a person typing a working password at a screen that will not let them
 * past, which is the exact failure this rule is supposed to be worth having.
 *
 * Signing in GRANTS NOTHING the session did not already carry. Somebody
 * holding a must-change session can already do precisely what a fresh one
 * could, which is almost nothing. So refusing it protects no data and only
 * ever locks somebody out of the fix. The reads the sign-in page itself makes
 * are on the list for the same reason: a page that renders an error before
 * anybody has typed anything is a page nobody can use.
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
    /* Establishing who somebody is, which grants nothing. See the header. */
    { method: 'POST', path: '/api/login' },
    { method: 'POST', path: '/api/login/pin' },
    { method: 'POST', path: '/api/login/pin/setup' },
    { method: 'POST', path: '/api/login/device' },
    /* What the sign-in page reads before anybody types: the project picker
       and whether this phone is enrolled. */
    { method: 'GET', path: '/api/login/projects' },
    { method: 'GET', path: '/api/login/device' },
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

        /* NOT "open Devices and sign-in", which is what this said while the
           web shell was the only client that could comply. There is a screen
           on the phone now, called something else, and a courier sent looking
           for a page the app does not have reads it as a dead end. The clients
           key on the code; the sentence has to be true on both of them. */
        res.status(403).json({
            error: 'Your password was set for you and has to be changed before you can go further. '
                + 'Change it on your own account screen.',
            code: MUST_CHANGE_CODE,
        });
    };
}
