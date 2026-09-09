/* Audit query endpoint. Platform admins only.
 *
 *   GET /api/audit?username=&action=&entity=&entityId=&projectId=&from=&to=&limit=&before=
 *
 * action matches as a prefix (action=logs matches logs.save, logs.clear).
 * Results are newest first; pass the returned nextBefore as `before` to page.
 * Reading the audit log is itself audited. */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AuditLog } from './audit';

const Query = z.object({
    username: z.string().trim().min(1).max(120).optional(),
    action: z.string().trim().min(1).max(80).regex(/^[a-z0-9_.]+$/).optional(),
    entity: z.string().trim().min(1).max(80).optional(),
    entityId: z.string().trim().min(1).max(200).optional(),
    projectId: z.coerce.number().int().positive().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    before: z.coerce.number().int().positive().optional(),
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

export function createAuditRouter({ log }: { log: AuditLog }): Router {
    const router = Router();

    router.get('/api/audit', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
        (async () => {
            const parsed = Query.safeParse(req.query);
            if (!parsed.success) {
                res.status(400).json({ error: 'Invalid query', details: parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`) });
                return;
            }
            const q = parsed.data;
            const result = await log.query(q);
            await req.audit('audit.read', 'audit', null, {
                filters: Object.keys(q).filter((k) => k !== 'limit' && k !== 'before'),
                returned: result.events.length,
            });
            res.json(result);
        })().catch(next);
    });

    return router;
}
