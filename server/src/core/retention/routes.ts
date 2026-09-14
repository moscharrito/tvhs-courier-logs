/* Retention: what is past it, and removing what is.
 *
 * Ticket 4.6. Platform administrators only. Retention is a platform-wide
 * policy rather than a per-project setting, and the person who may act on it
 * is the same person who may read the audit trail.
 *
 *   GET  /api/retention          the policy, the last sweep, what is flagged
 *   POST /api/retention/sweep    count now, rather than waiting for the timer
 *   POST /api/retention/purge    remove one category, with an exact approval
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import type { FileStorage } from '../files/storage';
import { RETENTION, SWEPT, PURGE_MECHANICS, type RetentionCategory } from './policy';
import { sweep, lastSweep, purge } from './sweep';

interface Deps {
    client: Client;
    storage: FileStorage;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const Purge = z.object({
    category: z.enum(SWEPT as [RetentionCategory, ...RetentionCategory[]]),
    /* The count the approver saw. Not a checkbox: a number they had to read
     * off the screen, which is what makes this an approval rather than a
     * button. If it has moved, the purge refuses and they look again. */
    expected: z.number().int().min(0),
    reason: z.string().trim().min(8).max(500),
});

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.session.user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    if (req.session.user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
    }
    next();
}

export function createRetentionRouter({ client, storage }: Deps): Router {
    const router = Router();

    /** What the caller sees of the policy: no code, just the decision. */
    const policyView = () => SWEPT.map((category) => {
        const rule = RETENTION[category];
        return {
            category,
            days: rule.days,
            decided: rule.decided,
            purgeable: rule.purgeable,
            holds: rule.holds,
            basis: rule.basis,
        };
    });

    router.get('/api/retention', requireAdmin, wrap(async (req, res) => {
        const last = await lastSweep(client);
        const runs = await client.execute(
            `SELECT id, kind, ran_at, started_by, category, row_count, reason FROM retention_runs ORDER BY id DESC LIMIT 20`,
        );
        await req.audit('retention.read', 'policy', 'retention', { flagged: last?.totalFlagged ?? null });
        res.json({
            policy: policyView(),
            mechanics: PURGE_MECHANICS,
            lastSweep: last,
            recentRuns: runs.rows.map((r) => ({
                id: Number(r['id']),
                kind: String(r['kind']),
                ranAt: String(r['ran_at']),
                startedBy: String(r['started_by']),
                category: r['category'] === null ? null : String(r['category']),
                rowCount: Number(r['row_count']),
                reason: String(r['reason']),
            })),
        });
    }));

    router.post('/api/retention/sweep', requireAdmin, wrap(async (req, res) => {
        const result = await sweep(client, { startedBy: req.session.user!.username });
        await req.audit('retention.sweep', 'policy', 'retention', { flagged: result.totalFlagged });
        res.status(201).json(result);
    }));

    router.post('/api/retention/purge', requireAdmin, wrap(async (req, res) => {
        const parsed = Purge.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
            });
            return;
        }
        const { category, expected, reason } = parsed.data;

        /* Written before the delete, not after. If the process dies halfway
           through, the intention is on the record and the counts can be
           reconstructed from what is left. */
        await req.audit('retention.purge_requested', 'policy', category, { expected, reason: reason.slice(0, 200) });

        const result = await purge(client, {
            category,
            expected,
            reason,
            startedBy: req.session.user!.username,
            ...(storage.available ? { deleteObject: (key: string) => deleteFromBucket(storage, key) } : {}),
        });

        if (!result.ok) {
            await req.audit('retention.purge_refused', 'policy', category, { reason: result.reason });
            const status = result.reason === 'count_moved' ? 409 : 422;
            res.status(status).json({ error: result.message, code: `retention.${result.reason}`, ...('actual' in result ? { actual: result.actual } : {}) });
            return;
        }

        /* The audit detail takes scalars, so the per-table counts go in as a
           flat list of "table=n" rather than a nested object. The full
           breakdown is in the retention_runs row either way. */
        await req.audit('retention.purged', 'policy', category, {
            removed: result.removed,
            tables: Object.entries(result.detail).map(([table, n]) => `${table}=${n}`),
        });
        res.json(result);
    }));

    return router;
}

/**
 * Delete one object. The signer already produces a URL for any method, so
 * this reuses it rather than adding a second signing path: presign a short
 * DELETE and send it from here.
 *
 * A 404 counts as success. The object being gone is the desired state, and a
 * purge that fails because somebody already deleted the file by hand would
 * leave the row behind pointing at nothing.
 */
export async function deleteFromBucket(storage: FileStorage, key: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    const signed = storage.presignDelete(key);
    const res = await fetchImpl(signed.url, { method: 'DELETE', headers: signed.headers });
    if (res.status === 204 || res.status === 200 || res.status === 404) return;
    throw new Error(`S3 refused the delete: ${res.status}`);
}
