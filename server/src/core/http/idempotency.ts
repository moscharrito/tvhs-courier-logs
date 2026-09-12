/* Answering the same request twice without doing it twice.
 *
 * A courier's phone loses signal mid-request more often than it loses it
 * cleanly. The request reaches the server, the delivery is recorded, the reply
 * never arrives, and the phone retries. Without something here that retry is a
 * second `delivered` event on the same order, or a second pickup, and the
 * chain of custody stops being a chain.
 *
 * So the PHONE generates the id. A server-generated id cannot help: the phone
 * would have to receive it first, which is exactly the round trip that failed.
 * The first request to claim an id wins and its reply is stored; a retry
 * carrying the same id is answered with that stored reply and the handler is
 * never entered.
 *
 * Rules this follows, each of which is a way it could go wrong:
 *
 *   A key belongs to the user who claimed it. Answering somebody else's key
 *   would hand one courier another courier's reply, which may name a patient.
 *
 *   A failed request does not burn its key. If the handler 500s, the claim is
 *   released, or a transient database error would make that id permanently
 *   unusable and the courier's queue would be stuck on it for ever.
 *
 *   A claim in flight is told to come back, not made to wait. Two phones (or
 *   one phone and its own retry) racing on the same key get one answer and one
 *   "still being recorded"; holding the second request open would tie up a
 *   connection on a network that has already proven unreliable.
 *
 *   Stored replies are swept. They can contain PHI, because they are what the
 *   app would have received. A replay cache is useful for hours, not years.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Client } from '@libsql/client';

/** How long a reply stays replayable. Long enough for a phone left in a van
 *  over a weekend, short enough that this is not an archive. */
export const CLIENT_EVENT_RETENTION_DAYS = 7;

/** How often one process sweeps. Cheap, indexed, and not on every request. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Shape of an id a phone may claim. Deliberately narrow: it becomes part of
 *  a unique key, and a 4KB "id" is a way to fill a table. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const CLIENT_EVENT_FIELD = 'clientEventId';

export interface IdempotencyDeps {
    client: Client;
    /** Overridable so tests do not have to wait an hour to see a sweep. */
    now?: () => Date;
}

function keyFrom(req: Request): string | null {
    const body = req.body as Record<string, unknown> | undefined;
    const raw = body?.[CLIENT_EVENT_FIELD] ?? req.get('Idempotency-Key');
    if (typeof raw !== 'string') return null;
    const key = raw.trim();
    return key === '' ? null : key;
}

export async function sweepClientEvents(client: Client, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - CLIENT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rs = await client.execute({
        sql: 'DELETE FROM client_events WHERE created_at < ?',
        args: [cutoff.toISOString()],
    });
    return Number(rs.rowsAffected ?? 0);
}

/**
 * Middleware. Put it on mutating courier routes, after the project and session
 * middleware so `req.project` and the username are known.
 *
 * A request with no id passes straight through: the dispatch board and the
 * admin screens are used by people watching a reply arrive, and forcing an id
 * on them would be ceremony with no failure mode behind it.
 */
export function createIdempotency({ client, now = () => new Date() }: IdempotencyDeps): RequestHandler {
    let lastSweep = 0;

    const sweep = () => {
        const at = now().getTime();
        if (at - lastSweep < SWEEP_INTERVAL_MS) return;
        lastSweep = at;
        // Not awaited: a sweep must never delay a courier's delivery. A failed
        // sweep is retried an hour later and costs nothing in the meantime.
        void sweepClientEvents(client, now()).catch(() => { lastSweep = 0; });
    };

    return function idempotency(req: Request, res: Response, next: NextFunction): void {
        const key = keyFrom(req);
        if (key === null) { next(); return; }

        const projectId = req.project?.id;
        const username = req.session?.user?.username ?? '';
        if (projectId === undefined || username === '') { next(); return; }

        if (!KEY_PATTERN.test(key)) {
            res.status(400).json({
                error: 'Invalid request',
                details: [`${CLIENT_EVENT_FIELD}: 8 to 64 characters, letters, digits, hyphen and underscore`],
            });
            return;
        }

        void (async () => {
            sweep();
            const at = now().toISOString();

            let claimed = true;
            try {
                await client.execute({
                    sql: `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
                          VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`,
                    args: [projectId, key, username, req.method, req.originalUrl.split('?')[0] ?? '', at],
                });
            } catch (err) {
                // Any insert failure other than "taken" is a real problem.
                if (!/UNIQUE|constraint/i.test(String((err as Error).message))) throw err;
                claimed = false;
            }

            if (!claimed) {
                const rs = await client.execute({
                    sql: 'SELECT username, state, status, response FROM client_events WHERE project_id = ? AND client_event_id = ?',
                    args: [projectId, key],
                });
                const row = rs.rows[0];
                if (!row) {
                    /* Swept between the failed insert and this read. Vanishingly
                       unlikely, and letting the request through is the safe
                       answer: the id is gone, so nothing can be replayed. */
                    next();
                    return;
                }
                if (String(row['username']) !== username) {
                    res.status(409).json({
                        error: 'That event id was already used by somebody else.',
                        code: 'idempotency.otherUser',
                    });
                    return;
                }
                if (String(row['state']) !== 'done') {
                    res.status(409).json({
                        error: 'That event is still being recorded. Try again in a moment.',
                        code: 'idempotency.inFlight',
                    });
                    return;
                }
                let body: unknown = null;
                try { body = JSON.parse(String(row['response'] || 'null')); } catch { body = null; }
                const status = Number(row['status'] ?? 200);
                res.status(status).json(
                    body && typeof body === 'object' && !Array.isArray(body)
                        // Said plainly so the app can tell "recorded now" from
                        // "recorded earlier" without guessing.
                        ? { ...(body as Record<string, unknown>), replayed: true }
                        : body,
                );
                return;
            }

            const release = async () => {
                await client.execute({
                    sql: 'DELETE FROM client_events WHERE project_id = ? AND client_event_id = ? AND state = ?',
                    args: [projectId, key, 'in_progress'],
                });
            };

            const store = async (status: number, body: unknown) => {
                await client.execute({
                    sql: `UPDATE client_events SET state = 'done', status = ?, response = ?, completed_at = ?
                          WHERE project_id = ? AND client_event_id = ?`,
                    args: [status, JSON.stringify(body ?? null), now().toISOString(), projectId, key],
                });
            };

            /* Capture the reply on its way out. The handler stays unaware of
               any of this: making every endpoint remember to record itself is
               how one of them eventually forgets. */
            const originalJson = res.json.bind(res);
            let settled = false;
            res.json = (body: unknown) => {
                if (settled) return originalJson(body);
                settled = true;
                const status = res.statusCode;
                const finish = status >= 500 ? release() : store(status, body);
                finish.then(() => originalJson(body)).catch(() => originalJson(body));
                return res;
            };

            res.on('close', () => {
                /* No JSON ever went out: the handler threw, or the client hung
                   up. Either way the claim must not outlive the attempt. */
                if (!settled) { settled = true; void release().catch(() => { }); }
            });

            next();
        })().catch(next);
    };
}
