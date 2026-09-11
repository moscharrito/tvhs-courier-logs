/* Request id and request logging. Installed first in the middleware chain.

   Every request gets req.id (a client-supplied X-Request-Id is honoured when
   it looks sane, otherwise a UUID) and the id is echoed on the response. On
   finish, one structured line: method, path (never the query string, which
   can carry usernames), status, duration, actor, ip. /health is logged at
   debug so the platform's pings do not flood the log.

   The path is captured on the way in, not read on finish. Express rewrites
   req.url as it descends into a mounted router, so by the time the response
   finishes, a request to /api/projects/uh/uh/imports/preview reports itself
   as "/preview". Every module router is mounted, so reading it late turns
   the log for exactly those routes into noise. */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Logger } from './logger';

declare module 'express-serve-static-core' {
    interface Request {
        id: string;
        log: Logger;
    }
}

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestId(header: string | undefined): string {
    return header && SAFE_ID.test(header) ? header : crypto.randomUUID();
}

export function createRequestMiddleware(logger: Logger): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const id = requestId(req.get('x-request-id'));
        req.id = id;
        req.log = logger.child({ req: id });
        res.setHeader('X-Request-Id', id);

        const started = process.hrtime.bigint();
        // Read now: routing mutates req.url beneath us.
        const path = req.path;
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : path === '/health' ? 'debug' : 'info';
            req.log.log(level, 'request', {
                method: req.method,
                path,
                status: res.statusCode,
                ms: Math.round(ms * 10) / 10,
                user: req.session?.user?.username ?? null,
                ip: req.ip ?? '',
            });
        });
        next();
    };
}
