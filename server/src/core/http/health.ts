/* GET /health. Public, no session. Runs a real query so a broken Turso
   connection shows up as 503 and the platform health check fails over.
   Reports only non-sensitive facts: status, database reachability, uptime,
   migration count, version, and whether the background timers are running.

   ─────────────────────────────────────────────────────────────────────────
   WHY THE SCHEDULER IS REPORTED HERE, ON A PUBLIC ENDPOINT.

   "Is unclaimed work actually being escalated" is an operational question
   that gets asked repeatedly and could previously only be answered by
   scrolling a host's log for one boot line. An environment variable that
   silently failed to arrive is exactly the kind of fault that stays
   undetected for weeks, and the thing it switches off is a promise made to a
   hospital: that an unclaimed STAT is never nobody's problem.

   So it is answerable with curl, by whoever is asking, in five seconds.

   WHAT MAY GO IN HERE: whether a timer is running, and how often. Facts about
   this process, of no use to anybody attacking it.

   WHAT MUST NEVER: a hostname, a bucket, a region, a from-address, a key id,
   a count of anything in the database, or any word that came from a row. This
   endpoint is unauthenticated and indexed by anyone who looks. The rule is
   not "is this secret" but "would I be content to see this in a pastebin",
   and a service name plus a region is a map for somebody. */

import { Router, type Request, type Response } from 'express';
import type { Client } from '@libsql/client';

interface Deps {
    client: Client;
    version: string;
    /** Seconds between sweeps, or undefined when the timer is not running. */
    sweepIntervalSeconds?: number | undefined;
    /** Whether outbound email is configured. Not where it goes. */
    mailConfigured?: boolean | undefined;
}

export function createHealthRouter({ client, version, sweepIntervalSeconds, mailConfigured }: Deps): Router {
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
            scheduler: {
                /* The sweep that escalates unclaimed work to dispatch 45
                   minutes before its deadline, and drains queued email. */
                sweep: sweepIntervalSeconds === undefined ? 'off' : `every ${sweepIntervalSeconds}s`,
                /* Configured, not reachable: proving SES answers would mean
                   sending something, and a health check that sends email is a
                   health check that mails a hospital every thirty seconds. */
                mail: mailConfigured ? 'configured' : 'off',
            },
        });
    });

    return router;
}
