/* Can the manual process be retired, and what did we tell the client.
 *
 * Ticket 5.3. Two endpoints for the two halves of a go-live.
 *
 *   GET /api/projects/:pid/uh/go-live   is everything that can be checked,
 *                                       checked
 *
 * The other half of a go-live, recording the daily SLA report as sent with
 * its figures frozen, lives with the rest of the reporting in reports.ts.
 *
 * THE READINESS CHECK DOES NOT DECIDE. It reports. Several of the things that
 * matter most cannot be checked by a program at all: whether the BAAs are
 * signed, whether anybody has been trained, whether the on-call list has real
 * names in it, whether somebody who did not write the runbook has followed it
 * once. Those are listed as attestations, unticked, because a checklist that
 * quietly marks the unverifiable as fine is worse than no checklist: it
 * converts an unknown into a green light.
 *
 * What it can check, it checks against the database and the configuration
 * rather than against anybody's memory.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import { requireProjectRole } from '../../core/projects/middleware';
import { verifyDatabase } from '../../db/verify';

interface Deps {
    client: Client;
    /** Facts about how this instance is configured, not what it could be. */
    deployment: {
        databaseKind: 'turso' | 'file';
        mfaEnforced: boolean;
        filesEnabled: boolean;
        geocoderConfigured: boolean;
        trustProxy: number;
        isProduction: boolean;
    };
    expectedMigrations: number;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export interface Check {
    id: string;
    what: string;
    /** True, false, or null when this instance genuinely cannot tell. */
    pass: boolean | null;
    detail: string;
    /** Blocks go-live on its own. */
    blocking: boolean;
}

export function createGoLiveRouter({ client, deployment, expectedMigrations }: Deps): Router {
    const router = Router({ mergeParams: true });
    const read = requireProjectRole('admin', 'ops_manager', 'dispatcher');

    async function count(sql: string, args: unknown[] = []): Promise<number> {
        const rs = await client.execute({ sql, args: args as never });
        return Number(rs.rows[0]?.[Object.keys(rs.rows[0] ?? {})[0] ?? 'n'] ?? 0);
    }

    router.get('/', read, wrap(async (req, res) => {
        const projectId = req.project!.id;
        const checks: Check[] = [];
        const add = (c: Check) => checks.push(c);

        /* ------------------------------------------------- the shadow week */

        const openCritical = await count(
            `SELECT COUNT(*) AS n FROM discrepancies WHERE project_id = ? AND status = 'open' AND severity = 'critical'`,
            [projectId],
        );
        const openAny = await count(
            `SELECT COUNT(*) AS n FROM discrepancies WHERE project_id = ? AND status = 'open'`,
            [projectId],
        );
        const everFiled = await count('SELECT COUNT(*) AS n FROM discrepancies WHERE project_id = ?', [projectId]);

        add({
            id: 'discrepancies.critical',
            what: 'No critical discrepancy is still open',
            pass: openCritical === 0,
            detail: openCritical === 0 ? 'None open.' : `${openCritical} open. A critical one means a delivery record was wrong or missing.`,
            blocking: true,
        });
        add({
            id: 'discrepancies.open',
            what: 'Every discrepancy is resolved or accepted',
            pass: openAny === 0,
            detail: openAny === 0 ? 'Nothing open.' : `${openAny} still open.`,
            blocking: true,
        });
        add({
            id: 'discrepancies.any',
            what: 'The shadow week actually found something',
            /* Silence is not success. A week with no reports means the
             * reporting path did not work, or nobody was looking. */
            pass: everFiled > 0,
            detail: everFiled > 0
                ? `${everFiled} filed.`
                : 'Nothing has ever been filed. Either the week has not happened, or nobody was looking, and neither is a pass.',
            blocking: true,
        });

        /* ------------------------------------------------------- the people */

        const enrolledAdmins = await count(
            `SELECT COUNT(*) AS n FROM users u
             JOIN mfa_enrolments m ON m.user_id = u.id
             WHERE u.role = 'admin' AND u.status = 'active' AND m.confirmed_at IS NOT NULL`,
        );
        add({
            id: 'admins.second_factor',
            what: 'At least two administrators hold a second factor',
            /* One is a single point of failure with no route back: if that
             * person loses their phone and their recovery codes, the only way
             * in is a database change. Two is five minutes of work. */
            pass: enrolledAdmins >= 2,
            detail: `${enrolledAdmins} enrolled. With one, losing a phone and the recovery codes means a database change to get back in.`,
            blocking: true,
        });

        const couriers = await count(
            `SELECT COUNT(*) AS n FROM memberships WHERE project_id = ? AND role = 'courier'`,
            [projectId],
        );
        add({
            id: 'couriers',
            what: 'Couriers exist on the project',
            pass: couriers > 0,
            detail: `${couriers} courier memberships.`,
            blocking: true,
        });

        /* ---------------------------------------------------- the contract */

        const today = new Date().toISOString().slice(0, 10);
        const schedule = await count(
            `SELECT COUNT(*) AS n FROM price_schedules WHERE project_id = ? AND effective_from <= ?`,
            [projectId, today],
        );
        add({
            id: 'pricing',
            what: 'A price schedule is in effect',
            pass: schedule > 0,
            detail: schedule > 0 ? 'In effect.' : 'Nothing to bill against.',
            blocking: true,
        });

        const sites = await count(`SELECT COUNT(*) AS n FROM sites WHERE project_id = ? AND status = 'active'`, [projectId]);
        const located = await count(
            `SELECT COUNT(*) AS n FROM sites WHERE project_id = ? AND status = 'active' AND lat IS NOT NULL`,
            [projectId],
        );
        add({
            id: 'sites.geocoded',
            what: 'Every pharmacy has coordinates',
            pass: sites > 0 && located === sites,
            detail: `${located} of ${sites}. Without them a run cannot be sequenced by distance and out-of-area miles cannot be measured.`,
            blocking: false,
        });

        /* --------------------------------------------------- the deployment */

        add({
            id: 'deploy.production',
            what: 'This is a production deployment',
            pass: deployment.isProduction && deployment.databaseKind === 'turso',
            detail: deployment.isProduction && deployment.databaseKind === 'turso'
                ? 'NODE_ENV is production against Turso.'
                : `NODE_ENV is ${deployment.isProduction ? 'production' : 'not production'} and the database is ${deployment.databaseKind}. A local file is lost on redeploy.`,
            blocking: true,
        });
        add({
            id: 'deploy.mfa',
            what: 'Two-factor authentication is enforced',
            pass: deployment.mfaEnforced,
            detail: deployment.mfaEnforced ? 'Enforced for staff.' : 'Not enforced. Set MFA_ENFORCED.',
            blocking: true,
        });
        add({
            id: 'deploy.proxy',
            what: 'The proxy hop count is set',
            pass: !deployment.isProduction || deployment.trustProxy > 0,
            detail: deployment.trustProxy > 0
                ? `${deployment.trustProxy} hop trusted.`
                : 'Not set, so every audit row records the proxy address and the per-address throttle counts the internet as one caller.',
            blocking: false,
        });
        add({
            id: 'deploy.files',
            what: 'Doorstep photographs can be stored',
            pass: deployment.filesEnabled,
            detail: deployment.filesEnabled
                ? 'A bucket is configured.'
                : 'No bucket, so a doorstep delivery is refused rather than recorded without evidence. Needs ticket 0.10.',
            blocking: false,
        });

        const db = await verifyDatabase(client, { expectedMigrations });
        add({
            id: 'database.sound',
            what: 'The database is sound and fully migrated',
            pass: db.ok,
            detail: db.ok ? `Integrity ok, ${db.migrations} migrations, append-only triggers present.` : db.problems.join(' '),
            blocking: true,
        });

        /* ------------------------------------------------- the unverifiable */

        const attestations = [
            'BAAs signed with Render, Turso and AWS (ticket 0.10).',
            'A real Turso snapshot has been taken and restored at least once (ticket 4.4).',
            'Somebody who did not write docs/runbook.md has followed it once.',
            'The on-call section of the runbook has real names and thresholds in it.',
            'The written privacy and security program exists (ticket 4.7).',
            'Couriers and dispatchers have been trained, and have the cards from docs/training.',
            'University Health has answered the clarification email: the dry-run surcharge, '
            + 'the billing unit, the completion formula, and the out-of-area basis (ticket 1.10).',
        ];
        add({
            id: 'attestations',
            what: 'Things no program can check',
            /* Deliberately null rather than false. A checklist that marks the
             * unverifiable as failed gets ignored; one that marks it as passed
             * converts an unknown into a green light. */
            pass: null,
            detail: `${attestations.length} items a person has to confirm. They are listed in this response.`,
            blocking: true,
        });

        const blockingFailures = checks.filter((c) => c.blocking && c.pass === false);
        const unknown = checks.filter((c) => c.pass === null);

        await req.audit('golive.check', 'project', String(projectId), {
            checks: checks.length, failing: blockingFailures.length,
        });

        res.json({
            checks,
            attestations,
            blocking: blockingFailures.map((c) => c.id),
            /* No "ready: true" anywhere. The most this can say is that it
               found nothing in the way, which is a different claim. */
            verdict: blockingFailures.length > 0
                ? `Not yet: ${blockingFailures.length} blocking ${blockingFailures.length === 1 ? 'check has' : 'checks have'} failed.`
                : `Nothing automatic is in the way. ${unknown.length > 0 ? 'The attestations above are not checked by anything and a person has to confirm each one.' : ''} `
                    + 'Retiring the manual process is a decision, and this is evidence for it rather than the decision itself.',
        });
    }));

    return router;
}
