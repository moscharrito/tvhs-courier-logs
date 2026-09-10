/* GET /health. Public, no session. Runs a real query so a broken Turso
   connection shows up as 503 and the platform health check fails over.
   Reports only non-sensitive facts: status, database reachability, uptime,
   migration count, version. */

import { Router, type Request, type Response } from 'express';
import type { Client } from '@libsql/client';

interface Deps {
    client: Client;
    version: string;
}

export function createHealthRouter({ client, version }: Deps): Router {
    const router = Router();
    const started = Date.now();

    router.get('/health', async (_req: Request, res: Response) => {
        let db: 'ok' | 'error' = 'ok';
        let migrations: number | null = null;
        try {
            await client.execute('SELECT 1');
            const rs = await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations');
            migrations = Number(rs.rows[0]?.['n'] ?? 0);
        } catch {
            db = 'error';
        }
        const ok = db === 'ok';
        res.status(ok ? 200 : 503).json({
            status: ok ? 'ok' : 'degraded',
            db,
            migrations,
            uptimeSeconds: Math.round((Date.now() - started) / 1000),
            version,
        });
    });

    return router;
}
