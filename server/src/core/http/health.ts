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
   and a service name plus a region is a map for somebody.

   ─────────────────────────────────────────────────────────────────────────
   WHY `statistics` IS HERE, AND WHY IT IS ONLY ONE WORD.

   Query planner statistics decide whether the order detail page reads four
   custody rows or walks every event in the project: measured at 0.5 ms
   against 84 ms on a month of volume. PRAGMA optimize is allowed to fail on
   a hosted database and does so silently, so db/optimize.ts logs the outcome
   at boot. That left the same problem the sms field above was added to fix:
   the only place that answered "is the planner guessing?" was one line in a
   log, and everyone who is not holding the Render dashboard could not answer
   it at all.

   ONE WORD, not the detail, because of the rule above. "ok" or "missing" is
   a fact about this process. Which tables lack statistics is a count and a
   list of table names, which is a map of the schema for somebody and is
   exactly what that rule forbids. The boot log keeps the detail for whoever
   has the log; this endpoint says only whether somebody should go and read
   it. */

import { Router, type Request, type Response } from 'express';
import type { Client } from '@libsql/client';
import type { FilesHealth } from '../files/probe';

interface Deps {
    client: Client;
    version: string;
    /** Seconds between sweeps, or undefined when the timer is not running. */
    sweepIntervalSeconds?: number | undefined;
    /** Whether outbound email is configured. Not where it goes. */
    mailConfigured?: boolean | undefined;
    /** Whether proof-of-delivery storage is usable. Not which bucket.
     *
     *  SUPERSEDED BY filesHealth where that is supplied, and kept for the
     *  callers that have not got a probe: it reports that the values are
     *  filled in, which is a weaker fact than it reads as. */
    filesConfigured?: boolean | undefined;
    /** The cached result of actually writing to the bucket and deleting it
     *  again. See core/files/probe.ts for why S3 is proved when mail and
     *  SMS are only reported. A function because it changes after boot. */
    filesHealth?: (() => FilesHealth) | undefined;
    /** Whether patient texting is configured. Not the number it sends from:
     *  a from-number is on the list above of things that never appear here. */
    smsConfigured?: boolean | undefined;
    /** The planner's statistics, as of the last optimise. A function rather
     *  than a value because it changes after boot, and because asking the
     *  database on every health check would add five queries to an endpoint
     *  a platform hits every few seconds. */
    statistics?: (() => StatisticsState) | undefined;
}

/** `unknown` is honest rather than optimistic: the first optimise runs at
 *  boot and a health check can arrive before it has finished. Reporting "ok"
 *  in that window would be a guess, and a guess is what this field exists to
 *  remove. */
export type StatisticsState = 'ok' | 'missing' | 'unknown';

export function createHealthRouter({
    client, version, sweepIntervalSeconds, mailConfigured, filesConfigured, smsConfigured,
    statistics, filesHealth,
}: Deps): Router {
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
                /* Same rule as mail, for the same reason: proving Twilio
                   answers would mean sending a text, and a health check that
                   texts somebody is a health check that texts a patient.

                   Here at all because it was not, and the only place that
                   said whether texting was on was a line in the boot log.
                   Anybody without access to that log -- which includes
                   everyone who is not holding the Render dashboard -- had no
                   way to answer "are the messages going out?" at all. */
                sms: smsConfigured ? 'configured' : 'off',
            },
            /* Off means a doorstep delivery is refused outright rather than
               recorded without its photograph, so this is an operational
               fact somebody needs, not a configuration detail.
            
               "configured" USED TO BE THE WHOLE ANSWER AND IT WAS NOT ONE.
               It meant the five S3 values were present; nothing had ever
               contacted AWS. The field read green for weeks against a
               bucket that refused every upload, and what found that was a
               production dry run three weeks before go-live rather than
               this endpoint. Where a probe is supplied this now says
               whether the bucket actually took a write -- ok, checking, or
               unreachable with S3's own error code. See files/probe.ts. */
            files: filesHealth ? filesHealth() : (filesConfigured ? 'configured' : 'off'),
            /* "missing" means a table that needs planner statistics has none,
               and somebody should read the boot log for which. See the note
               at the top for why this is one word and not the list. */
            statistics: statistics === undefined ? 'unknown' : statistics(),
        });
    });

    return router;
}
