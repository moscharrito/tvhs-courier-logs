/* JSON 404 for unknown API paths and the central error handler.
 *
 * The handler logs the full error (name, message, stack, request id) and
 * answers JSON. What the client sees:
 *   - 4xx errors that are safe to show (body-parser syntax errors, errors
 *     created with a status below 500, or with expose = true): the message.
 *   - everything else: a generic message. Never the stack, never an internal
 *     message, in any environment. In development the message is included
 *     under `detail` to save a trip to the logs.
 * The response always carries the request id so support can find the line. */

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { errorFields, type Logger } from './logger';

interface HttpishError extends Error {
    status?: number;
    statusCode?: number;
    expose?: boolean;
    type?: string;
}

export function apiNotFound(req: Request, res: Response, next: NextFunction): void {
    if (!req.path.startsWith('/api/')) return next();
    res.status(404).json({ error: 'Not found', requestId: req.id });
}

export function statusOf(err: unknown): number {
    const e = err as HttpishError;
    const s = Number(e?.status ?? e?.statusCode);
    return Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
}

/** What may be shown to the client for this error, or null for the generic message. */
export function exposedMessage(err: unknown, status: number): string | null {
    const e = err as HttpishError;
    if (status >= 500) return null;
    // body-parser errors are marked expose, but their messages describe the
    // parser internals; replace them with stable wording.
    if (e?.type === 'entity.parse.failed') return 'Malformed JSON body';
    if (e?.type === 'entity.too.large') return 'Request body too large';
    if (e?.expose === true) return e.message;
    return e?.message || 'Request failed';
}

export function createErrorHandler(opts: { logger: Logger; isProduction: boolean }): ErrorRequestHandler {
    return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
        const status = statusOf(err);
        const log = req.log ?? opts.logger;
        log.log(status >= 500 ? 'error' : 'warn', 'request error', { status, method: req.method, path: req.path, ...errorFields(err) });

        if (res.headersSent) {
            res.end();
            return;
        }
        const shown = exposedMessage(err, status);
        const body: Record<string, unknown> = {
            error: shown ?? (status >= 500 ? 'Internal server error' : 'Request failed'),
            requestId: req.id,
        };
        if (!opts.isProduction && shown === null && err instanceof Error) body['detail'] = err.message;
        res.status(status).json(body);
    };
}
