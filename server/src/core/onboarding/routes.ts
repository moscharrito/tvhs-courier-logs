/* Driver applications and the gates in front of a patient's address.
 *
 * Tickets 6.1 and 6.2.
 *
 *   POST   /api/driver-applications                             PUBLIC, throttled
 *   GET    /api/me/application                                  the applicant's own status
 *   PUT    /api/me/application/checks/:kind                     what the applicant can supply
 *   GET    /api/projects/:pid/driver-applications               admin, the queue
 *   GET    /api/projects/:pid/driver-applications/:id           admin, one, with its checks
 *   PUT    /api/projects/:pid/driver-applications/:id/checks/:kind   admin, record one
 *   POST   /api/projects/:pid/driver-applications/:id/approve   admin, creates the account
 *   POST   /api/projects/:pid/driver-applications/:id/reject    admin, reason required
 *
 * THE DOORDASH MODEL. Signup creates an account with the password the
 * applicant chose, and that account can sign in from the moment it exists.
 * It just cannot see anything. Approval does not mint a credential; it grants
 * a membership.
 *
 * The first cut of this had approval typing a username and a temporary
 * password for each driver. That is fine for two couriers and wrong for two
 * hundred: it makes an administrator the bottleneck on hiring and it puts a
 * password in an email, which is the weakest link in the whole flow.
 *
 * SO THE SECURITY PROPERTY MOVED, AND IT IS WORTH BEING PRECISE ABOUT WHERE.
 * It is no longer "an applicant has no account". It is **no membership, no
 * data**, which this codebase already enforced everywhere: every
 * project-scoped route goes through requireProject, and a user who belongs to
 * no project is refused all of them. An unvetted applicant holds a real login
 * that reaches exactly one thing, their own application status, and the
 * access matrix has a principal that proves it.
 *
 * The cost, stated plainly: there are now credentialed accounts for people
 * nobody has vetted, so the password-spraying surface is every applicant
 * rather than every employee. That is why signup is throttled, why a
 * rejection disables the account, and why the matrix pins the property.
 *
 * APPROVAL IS THE ONLY DOOR, and core/onboarding/clearance.ts is the lock.
 * Five artifacts verified by a named person and still current, or the
 * approval is refused with a sentence saying which are missing. There is no
 * override parameter. An override that exists is one that gets used at six on
 * a Friday when a van is short, and then the answer to University Health's
 * question about who has seen patient data is "usually".
 *
 * WHAT A PUBLIC ENDPOINT MUST NOT LEAK. It answers the same way whether or
 * not the email has applied before, because a signup form that says "you have
 * already applied" is a form that tells a stranger who drives for us. The
 * duplicate is caught on the way in and the applicant is told the same thing
 * either way.
 */

import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client, InValue } from '@libsql/client';
import { requireProjectRole } from '../projects/middleware';
import { CHECK_KINDS, CHECK_STATUSES, clearanceOf, type Check, type CheckKind } from './clearance';
import { todayIn } from '../dates';
import { createThrottle, LIMITS, addressKey } from '../auth/throttle';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const BCRYPT_ROUNDS = 10;

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

const Apply = z.object({
    projectCode: z.string().trim().toLowerCase().min(1).max(40),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().min(7).max(40),
    /* Theirs, chosen once, never seen by us and never emailed to them. */
    password: z.string().min(8).max(200),
    /* What they say about themselves. Capped because a free-text box on a
     * public endpoint is where somebody eventually pastes something that
     * should not be in a database. */
    claims: z.string().trim().max(2000).default(''),
});

const RecordCheck = z.object({
    status: z.enum(CHECK_STATUSES),
    reference: z.string().trim().max(200).default(''),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').nullable().default(null),
    note: z.string().trim().max(1000).default(''),
});

/* What an applicant can say about themselves from the phone (ticket 7.2).
 *
 * A reference and a sentence. Not a document: there is nowhere to put one
 * yet, because file storage waits on the AWS BAA in ticket 0.10, and even
 * once there is somewhere, a background check report in a courier database is
 * a second breach waiting for the first. What this unblocks is the waiting:
 * staff verifying a training certificate need its number, and an applicant
 * can type it at eleven at night instead of being telephoned for it. */
const Submit = z.object({
    reference: z.string().trim().max(200).default(''),
    note: z.string().trim().max(500).default(''),
});

const Reject = z.object({
    /* Required, and long enough to be a reason. A rejection nobody can
     * explain later is a rejection somebody has to defend later. */
    reason: z.string().trim().min(10).max(1000),
});

interface Deps {
    client: Client;
}

/* ------------------------------------------------------------------ public */

export function createPublicApplicationsRouter({ client }: Deps): Router {
    const router = Router();
    /* Its own counter, not the credential ones. Nothing here checks a
       secret, so sharing a limit with the sign-in endpoints would let a
       burst of applications lock somebody out of signing in. */
    const throttle = createThrottle(LIMITS.applications);
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });

    router.post('/api/driver-applications', wrap(async (req, res) => {
        /* Throttled by address only. There is no account here to spray at, so
           the thing being protected is the table itself and whoever reads the
           queue in the morning. */
        const key = addressKey(req.ip);
        if (throttle.blocked(key)) {
            res.status(429).set('Retry-After', String(throttle.retryAfter(key))).json({
                error: 'Too many applications from this connection. Try again later.',
            });
            return;
        }

        const body = parse(Apply, req.body, res);
        if (!body) return;

        const prs = await run('SELECT id, code FROM projects WHERE code = ?', [body.projectCode]);
        const project = prs.rows[0];

        /* An unknown project and a duplicate application get the SAME answer
           as a good one. A public form that distinguishes them is a form that
           enumerates our contracts and tells a stranger who already drives
           for us. The failure is counted so a script cannot sit here. */
        const accepted = { ok: true, message: 'Your application has been received. Somebody will be in touch.' };
        if (!project) {
            throttle.fail(key);
            res.status(202).json(accepted);
            return;
        }

        /* The email is the username. An address that already has an account
           gets the same 202 and nothing is written: this is the branch that
           must not tell a stranger whether somebody already drives for us,
           and it is also what stops the signup form being a way to probe for
           staff accounts by address. */
        const taken = await run('SELECT id FROM users WHERE username = ?', [body.email]);
        if (taken.rows.length > 0) {
            throttle.fail(key);
            res.status(202).json(accepted);
            return;
        }

        /* The account, with the password they chose. It can sign in from this
           moment, and it belongs to no project, so it reads nothing but its
           own application status. The header says why that is the property
           rather than "there is no account". */
        const user = await run(
            `INSERT INTO users (username, password, name, email, role, status)
             VALUES (?, ?, ?, ?, 'driver', 'active') RETURNING id`,
            [body.email, bcrypt.hashSync(body.password, BCRYPT_ROUNDS), body.name, body.email],
        );
        const userId = Number(user.rows[0]!['id']);

        const ins = await run(
            `INSERT INTO driver_applications (project_id, name, email, phone, claims, status, user_id)
             VALUES (?, ?, ?, ?, ?, 'submitted', ?) RETURNING id`,
            [Number(project['id']), body.name, body.email, body.phone, body.claims, userId],
        );
        const id = Number(ins.rows[0]!['id']);

        /* The five gates exist from the moment the application does, all
           pending. An operations manager opening a new application sees the
           work in front of them rather than an empty panel. */
        for (const kind of CHECK_KINDS) {
            await run('INSERT INTO onboarding_checks (application_id, kind, status) VALUES (?, ?, \'pending\')', [id, kind]);
        }

        /* Audited without a user: nobody is signed in. The address is the
           only handle there is, and applications are the one place a stranger
           writes to this database. */
        await req.audit('application.submitted', 'driver_application', String(id), {
            project: String(project['code']),
        });
        res.status(202).json(accepted);
    }));

    /* The one thing an unvetted account may read: its own application.
     *
     * It is deliberately thin. The applicant sees which gates are done and
     * which are not, because that is what tells them what to go and do. They
     * do NOT see the reference numbers, the verifier's name or the notes: a
     * background check reference is our record of somebody else's report, and
     * the internal note on a failed check is the last thing to hand back to
     * the person it is about. */
    router.get('/api/me/application', wrap(async (req, res) => {
        const me = req.session.user;
        if (!me) { res.status(401).json({ error: 'Not authenticated' }); return; }

        const rs = await run(
            `SELECT a.*, p.code AS project_code, p.name AS project_name, p.timezone AS project_timezone
               FROM driver_applications a
               JOIN projects p ON p.id = a.project_id
              WHERE a.user_id = (SELECT id FROM users WHERE username = ?)
              ORDER BY a.id DESC LIMIT 1`,
            [me.username],
        );
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'You have no application on file.' }); return; }

        const checks = await run(
            `SELECT kind, status, expires_at, submitted_reference, submitted_at
               FROM onboarding_checks WHERE application_id = ? ORDER BY kind`,
            [Number(row['id'])],
        );
        const shaped: Check[] = checks.rows.map((c) => ({
            kind: String(c['kind']) as CheckKind,
            status: String(c['status']) as Check['status'],
            verifiedBy: '',
            verifiedAt: null,
            expiresAt: c['expires_at'] === null ? null : String(c['expires_at']),
        }));

        res.json({
            project: { code: String(row['project_code']), name: String(row['project_name']) },
            status: String(row['status']),
            submittedAt: row['submitted_at'] === null ? null : String(row['submitted_at']),
            /* The reason IS handed back on a rejection. Being turned down
               without being told why is the thing people write in about. */
            decisionReason: String(row['decision_reason']),
            clearance: clearanceOf(shaped, todayIn(String(row['project_timezone']))),
            checks: shaped.map((c) => {
                const row = checks.rows.find((r) => String(r['kind']) === c.kind);
                return {
                    kind: c.kind,
                    status: c.status,
                    /* Echoed back so the phone can show what was already sent
                       rather than an empty box that looks like it failed. */
                    submittedReference: String(row?.['submitted_reference'] ?? ''),
                    submittedAt: row?.['submitted_at'] === null || row?.['submitted_at'] === undefined
                        ? null : String(row['submitted_at']),
                };
            }),
        });
    }));

    /* What the applicant can supply themselves.
     *
     * IT DOES NOT VERIFY ANYTHING, and that is the whole design. Ticket 6.2
     * says five artifacts are verified by a named person, and somebody typing
     * their own certificate number is not that. This writes to its own
     * columns, never touches `status`, `verified_by` or `verified_at`, and
     * there is a test asserting a submission cannot turn a gate green.
     *
     * What it removes is the telephone call: staff verifying a training
     * certificate need its number, and an applicant can type it at eleven at
     * night rather than being rung for it tomorrow.
     */
    router.put('/api/me/application/checks/:kind', wrap(async (req, res) => {
        const me = req.session.user;
        if (!me) { res.status(401).json({ error: 'Not authenticated' }); return; }

        const kind = String(req.params['kind']);
        if (!(CHECK_KINDS as readonly string[]).includes(kind)) {
            res.status(404).json({ error: `Unknown check. One of: ${CHECK_KINDS.join(', ')}` });
            return;
        }
        const body = parse(Submit, req.body ?? {}, res);
        if (!body) return;
        if (body.reference === '' && body.note === '') {
            res.status(400).json({ error: 'Invalid request', details: ['reference: say something, or a note'] });
            return;
        }

        const rs = await run(
            `SELECT a.id, a.status FROM driver_applications a
              WHERE a.user_id = (SELECT id FROM users WHERE username = ?)
              ORDER BY a.id DESC LIMIT 1`,
            [me.username],
        );
        const application = rs.rows[0];
        if (!application) { res.status(404).json({ error: 'You have no application on file.' }); return; }

        const status = String(application['status']);
        if (status !== 'submitted' && status !== 'in_review') {
            /* An approved application has an account with a membership; a
               rejected one is closed. Neither is a thing to keep filing
               paperwork against. */
            res.status(409).json({ error: `Your application is ${status}, so there is nothing to add to it.` });
            return;
        }

        await run(
            `UPDATE onboarding_checks
                SET submitted_reference = ?, submitted_note = ?, submitted_at = ?
              WHERE application_id = ? AND kind = ?`,
            [body.reference, body.note, new Date().toISOString(), Number(application['id']), kind],
        );
        await req.audit('onboarding.submitted', 'driver_application', String(application['id']), { kind });
        res.json({ ok: true, kind });
    }));

    return router;
}

/* ------------------------------------------------------------------- admin */

export function createApplicationsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const run = (sql: string, args: InValue[] = []) => client.execute({ sql, args });
    const staff = requireProjectRole('admin');

    async function checksOf(applicationId: number): Promise<Check[]> {
        const rs = await run(
            'SELECT kind, status, verified_by, verified_at, expires_at FROM onboarding_checks WHERE application_id = ? ORDER BY kind',
            [applicationId],
        );
        return rs.rows.map((r) => ({
            kind: String(r['kind']) as CheckKind,
            status: String(r['status']) as Check['status'],
            verifiedBy: String(r['verified_by']),
            verifiedAt: r['verified_at'] === null ? null : String(r['verified_at']),
            expiresAt: r['expires_at'] === null ? null : String(r['expires_at']),
        }));
    }

    async function loadOr404(req: Request, res: Response) {
        const id = Number(req.params['id']);
        if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'Application not found' }); return null; }
        const rs = await run('SELECT * FROM driver_applications WHERE id = ? AND project_id = ?', [id, req.project!.id]);
        const row = rs.rows[0];
        if (!row) { res.status(404).json({ error: 'Application not found' }); return null; }
        return row;
    }

    const present = (r: Record<string, unknown>) => ({
        id: Number(r['id']),
        name: String(r['name']),
        email: String(r['email']),
        phone: String(r['phone']),
        claims: String(r['claims']),
        status: String(r['status']),
        submittedAt: r['submitted_at'] === null ? null : String(r['submitted_at']),
        decidedAt: r['decided_at'] === null ? null : String(r['decided_at']),
        decidedBy: String(r['decided_by']),
        decisionReason: String(r['decision_reason']),
        /* Whether an account exists, never the id of one. */
        hasAccount: r['user_id'] !== null,
    });

    router.get('/', staff, wrap(async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const where = ['project_id = ?'];
        const args: InValue[] = [req.project!.id];
        if (q['status']) { where.push('status = ?'); args.push(String(q['status'])); }

        const rs = await run(
            `SELECT * FROM driver_applications WHERE ${where.join(' AND ')} ORDER BY submitted_at DESC, id DESC LIMIT 500`,
            args,
        );
        const today = todayIn(req.project!.timezone);
        const applications = [];
        for (const r of rs.rows) {
            const checks = await checksOf(Number(r['id']));
            applications.push({ ...present(r), clearance: clearanceOf(checks, today) });
        }
        res.json({ applications });
    }));

    router.get('/:id', staff, wrap(async (req, res) => {
        const row = await loadOr404(req, res);
        if (!row) return;
        const id = Number(row['id']);
        const detail = await run('SELECT * FROM onboarding_checks WHERE application_id = ? ORDER BY kind', [id]);
        const today = todayIn(req.project!.timezone);
        await req.audit('application.read', 'driver_application', String(id), {});
        res.json({
            ...present(row),
            clearance: clearanceOf(await checksOf(id), today),
            checks: detail.rows.map((c) => ({
                kind: String(c['kind']),
                status: String(c['status']),
                verifiedBy: String(c['verified_by']),
                verifiedAt: c['verified_at'] === null ? null : String(c['verified_at']),
                reference: String(c['reference']),
                expiresAt: c['expires_at'] === null ? null : String(c['expires_at']),
                note: String(c['note']),
                /* Nested rather than flattened alongside `reference`, so a
                   screen cannot accidentally show what somebody claimed as
                   though a colleague had checked it. */
                submitted: c['submitted_at'] === null ? null : {
                    reference: String(c['submitted_reference']),
                    note: String(c['submitted_note']),
                    at: String(c['submitted_at']),
                },
            })),
        });
    }));

    router.put('/:id/checks/:kind', staff, wrap(async (req, res) => {
        const row = await loadOr404(req, res);
        if (!row) return;
        const kind = String(req.params['kind']);
        if (!(CHECK_KINDS as readonly string[]).includes(kind)) {
            res.status(404).json({ error: `Unknown check. One of: ${CHECK_KINDS.join(', ')}` });
            return;
        }
        const body = parse(RecordCheck, req.body, res);
        if (!body) return;

        const who = req.session.user?.username ?? '';
        const verifying = body.status === 'verified';
        await run(
            `UPDATE onboarding_checks
                SET status = ?, reference = ?, expires_at = ?, note = ?,
                    verified_by = ?, verified_at = ?
              WHERE application_id = ? AND kind = ?`,
            [
                body.status, body.reference, body.expiresAt, body.note,
                /* Cleared when a check goes back to pending: the name on a
                   check is the name of whoever stands behind it, and nobody
                   stands behind a pending one. */
                body.status === 'pending' ? '' : who,
                body.status === 'pending' ? null : new Date().toISOString(),
                Number(row['id']), kind,
            ],
        );
        await req.audit(verifying ? 'onboarding.verified' : 'onboarding.recorded', 'driver_application', String(row['id']), {
            kind, status: body.status, expiresAt: body.expiresAt,
        });
        const today = todayIn(req.project!.timezone);
        res.json({ ok: true, clearance: clearanceOf(await checksOf(Number(row['id'])), today) });
    }));

    router.post('/:id/approve', staff, wrap(async (req, res) => {
        const row = await loadOr404(req, res);
        if (!row) return;
        const status = String(row['status']);
        if (status !== 'submitted' && status !== 'in_review') {
            res.status(409).json({ error: `This application is already ${status}.` });
            return;
        }

        /* THE GATE. Everything else in these two tickets is bookkeeping in
           front of this line. */
        const clearance = clearanceOf(await checksOf(Number(row['id'])), todayIn(req.project!.timezone));
        if (!clearance.ready) {
            await req.audit('application.approve_refused', 'driver_application', String(row['id']), {
                missing: clearance.missing, expired: clearance.expired, failed: clearance.failed,
            });
            res.status(409).json({ error: clearance.why, code: 'onboarding.incomplete', clearance });
            return;
        }

        /* The account already exists: it was created at signup and has been
           able to sign in and see nothing ever since. Approval grants the
           membership, which is the only thing it was missing. */
        const userId = row['user_id'] === null ? null : Number(row['user_id']);
        if (userId === null) {
            res.status(409).json({
                error: 'This application has no account behind it. It predates the current signup flow, so a user has to be created by hand.',
                code: 'application.noAccount',
            });
            return;
        }

        await run(
            `INSERT INTO memberships (user_id, project_id, role, settings) VALUES (?, ?, 'courier', '{}')
             ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role`,
            [userId, req.project!.id],
        );
        /* Re-enabled deliberately: a rejection disables the account, and an
           appeal that succeeds has to undo that or the approval is a lie. */
        await run("UPDATE users SET status = 'active' WHERE id = ?", [userId]);
        await run(
            `UPDATE driver_applications SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?`,
            [new Date().toISOString(), req.session.user?.username ?? '', Number(row['id'])],
        );

        await req.audit('application.approved', 'driver_application', String(row['id']), {
            username: String(row['email']), project: req.project!.code,
        });
        res.status(201).json({ ok: true, username: String(row['email']) });
    }));

    router.post('/:id/reject', staff, wrap(async (req, res) => {
        const row = await loadOr404(req, res);
        if (!row) return;
        const body = parse(Reject, req.body, res);
        if (!body) return;
        const status = String(row['status']);
        if (status === 'approved') {
            /* Approval created an account. Taking that back is disabling a
               user, which is a different screen with different consequences,
               and quietly flipping a status here would leave the account
               alive and nobody looking at it. */
            res.status(409).json({
                error: 'This application was approved and an account exists. Disable the user instead.',
                code: 'application.alreadyApproved',
            });
            return;
        }
        await run(
            `UPDATE driver_applications SET status = 'rejected', decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?`,
            [new Date().toISOString(), req.session.user?.username ?? '', body.reason, Number(row['id'])],
        );
        /* And the account goes with it. Leaving a live credential behind for
           somebody who failed a background check is the cost of the DoorDash
           model, paid here rather than left lying around. An appeal that
           succeeds re-enables it, which approve does. */
        if (row['user_id'] !== null) {
            await run("UPDATE users SET status = 'disabled' WHERE id = ?", [Number(row['user_id'])]);
        }
        await req.audit('application.rejected', 'driver_application', String(row['id']), { accountDisabled: row['user_id'] !== null });
        res.json({ ok: true });
    }));

    return router;
}
