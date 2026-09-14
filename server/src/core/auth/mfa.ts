/* A second factor for the people who can read the whole contract.
 *
 * Ticket 4.3. A password is one secret, and the roles gated here can read
 * every patient address University Health sends us, change the price
 * schedule, and issue an invoice. A password that is reused, phished or
 * guessed should not be enough for that.
 *
 *   GET    /api/me/mfa                     where I stand
 *   POST   /api/me/mfa/enrol               start: returns a secret, once
 *   POST   /api/me/mfa/confirm             prove the app has it; get codes
 *   POST   /api/me/mfa/recovery-codes      new codes, the old ones dead
 *   DELETE /api/me/mfa                     turn it off, if policy allows
 *   POST   /api/users/:username/mfa/reset  admin: a lost phone
 *
 * WHO. Project roles admin, ops_manager and dispatcher, plus any platform
 * administrator. Couriers are excluded by design: their second factor is the
 * enrolled phone, since a PIN works only from a device registered with the
 * full password (ticket 2.3). Asking a courier to read a rotating code off a
 * second device at a pharmacy counter in the rain is a control they would
 * find a way around, and a control people work around is worse than none
 * because it looks like one. Client viewers are excluded for the same reason
 * in a different key: they are outside contacts we cannot support through a
 * lost-phone call, and they see only their own pharmacy's deliveries.
 *
 * WHEN. Enforcement is on in production and off elsewhere, so development and
 * the test suite are not gated, while a staff member who signs in to
 * production without it can do nothing except enrol. Enrolment itself is
 * available everywhere, so it can be exercised before go-live.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import { generateSecret, verifyTotp, otpauthUri, formatSecret } from './totp';
import type { AuthThrottles } from './throttle';
import { tooManyAttempts } from './throttle';

/** What a person sees in an authenticator app next to the code. */
export const ISSUER = 'TAG';
export const RECOVERY_CODE_COUNT = 10;
/** Wrong codes allowed against one challenge before it is torn up. */
export const MAX_CHALLENGE_ATTEMPTS = 5;
/** Long enough to find the phone; short enough to be worth little if stolen. */
export const CHALLENGE_MINUTES = 5;
/** Project roles that have to hold a second factor. */
export const MFA_PROJECT_ROLES = ['admin', 'ops_manager', 'dispatcher'] as const;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const iso = (d: Date) => d.toISOString();

/* --------------------------------------------------------- recovery codes */

/* Ten characters from an alphabet with no 0/O, 1/I/L or 5/S, because these
 * get printed, photographed and read aloud down a phone line. Twenty-eight
 * letters, ten characters: about 48 bits, which is not guessable and is still
 * short enough that somebody will actually write it down. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';

export function generateRecoveryCode(): string {
    const chars: string[] = [];
    /* Rejection sampling rather than modulo: 256 is not a multiple of 29, so
     * a plain modulo would make the first few letters slightly likelier. */
    const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
    while (chars.length < 10) {
        for (const byte of crypto.randomBytes(16)) {
            if (byte >= limit) continue;
            chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!);
            if (chars.length === 10) break;
        }
    }
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Uppercase, hyphens and spaces removed, so what a person types matches. */
export const normaliseRecoveryCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();

/* ------------------------------------------------------------- the policy */

export interface MfaFacts {
    /** This person must hold a second factor. */
    required: boolean;
    /** They have one, and have proved the app holds the secret. */
    confirmed: boolean;
}

/** True when the person's roles put them inside the policy. */
export function requiredForRoles(platformRole: string, projectRoles: readonly string[]): boolean {
    if (platformRole === 'admin') return true;
    return projectRoles.some((r) => (MFA_PROJECT_ROLES as readonly string[]).includes(r));
}

export async function factsFor(client: Client, userId: number, platformRole: string): Promise<MfaFacts> {
    const rs = await client.execute({
        sql: `SELECT
                (SELECT confirmed_at FROM mfa_enrolments WHERE user_id = ?) AS confirmed_at,
                (SELECT COUNT(*) FROM memberships WHERE user_id = ? AND role IN ('admin','ops_manager','dispatcher')) AS staff_memberships`,
        args: [userId, userId],
    });
    const row = rs.rows[0];
    const staffMemberships = Number(row?.['staff_memberships'] ?? 0);
    return {
        required: platformRole === 'admin' || staffMemberships > 0,
        confirmed: Boolean(row?.['confirmed_at']),
    };
}

/* --------------------------------------------------------- the middleware */

declare module 'express-serve-static-core' {
    interface Request {
        /** Set by the session middleware for a signed-in caller. */
        mfa?: MfaFacts | undefined;
    }
}

/* Paths a session that still owes a second factor may reach. Everything else
 * is refused, because enforcement that lives only in the frontend is a
 * suggestion: the API is what holds the PHI. */
const SETUP_ALLOWED = [
    /^\/api\/me\/mfa(\/|$)/,
    /^\/api\/session$/,
    /^\/api\/logout$/,
    /^\/api\/config$/,
    /^\/api\/me\/projects$/,
    /^\/health$/,
];

/**
 * Refuses a session that is subject to the policy and has not satisfied it.
 *
 * This is the whole of "enforced in production". It cannot be a check at
 * sign-in, because a person who is required to enrol has to be able to sign
 * in far enough to do it.
 */
export function createMfaEnforcement({ enforced }: { enforced: boolean }): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!enforced) return next();
        if (!req.session?.user) return next();
        const facts = req.mfa;
        if (!facts?.required || facts.confirmed) return next();
        if (SETUP_ALLOWED.some((p) => p.test(req.path))) return next();

        res.status(403).json({
            error: 'Set up two-factor authentication before using this account.',
            code: 'mfa.setup_required',
        });
    };
}

/* ------------------------------------------------------------- the routes */

interface Deps {
    client: Client;
    throttles: AuthThrottles;
    /** Whether the policy is being enforced, which decides whether a person
     *  inside it may switch their own second factor off. */
    enforced: boolean;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const Enrol = z.object({ password: z.string().min(1).max(200) });
const Confirm = z.object({ code: z.string().trim().min(1).max(20) });
const Disable = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(1).max(20) });

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.output<S> | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data as z.output<S>;
    res.status(400).json({ error: 'Invalid request', details: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    return null;
}

export function createMfaRouter({ client, throttles, enforced }: Deps): Router {
    const router = Router();

    function requireAuth(req: Request, res: Response, next: NextFunction): void {
        if (!req.session.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        next();
    }

    async function passwordOf(userId: number): Promise<string> {
        const rs = await client.execute({ sql: 'SELECT password FROM users WHERE id = ?', args: [userId] });
        return String(rs.rows[0]?.['password'] ?? '');
    }

    async function enrolmentOf(userId: number) {
        const rs = await client.execute({ sql: 'SELECT * FROM mfa_enrolments WHERE user_id = ?', args: [userId] });
        return rs.rows[0] ?? null;
    }

    async function remainingCodes(userId: number): Promise<number> {
        const rs = await client.execute({
            sql: 'SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL',
            args: [userId],
        });
        return Number(rs.rows[0]?.['n'] ?? 0);
    }

    /** Ten fresh codes, the old ones deleted. Returned once and never again. */
    async function issueRecoveryCodes(userId: number): Promise<string[]> {
        await client.execute({ sql: 'DELETE FROM mfa_recovery_codes WHERE user_id = ?', args: [userId] });
        const now = iso(new Date());
        const codes: string[] = [];
        for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
            const code = generateRecoveryCode();
            codes.push(code);
            await client.execute({
                sql: 'INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
                args: [userId, sha256(normaliseRecoveryCode(code)), now],
            });
        }
        return codes;
    }

    /* ------------------------------------------------------------ status */

    router.get('/api/me/mfa', requireAuth, wrap(async (req, res) => {
        const user = req.session.user!;
        const facts = req.mfa ?? await factsFor(client, user.id, user.role);
        const enrolment = await enrolmentOf(user.id);
        res.json({
            required: facts.required,
            /* What the frontend acts on: not "should you", but "must you,
               right now, before anything else works". */
            enforced: enforced && facts.required,
            enrolled: Boolean(enrolment),
            confirmed: Boolean(enrolment?.['confirmed_at']),
            recoveryCodesRemaining: await remainingCodes(user.id),
        });
    }));

    /* ------------------------------------------------------------- enrol */

    router.post('/api/me/mfa/enrol', requireAuth, wrap(async (req, res) => {
        const body = parse(Enrol, req.body, res);
        if (!body) return;
        const user = req.session.user!;

        /* The password again, even though they are signed in. Otherwise an
           unlocked laptop is enough to point the second factor at a phone
           that is not theirs, which turns the control upside down. */
        const wait = throttles.password.check(req.ip, user.username);
        if (wait) {
            res.set('Retry-After', String(wait.retryAfterSeconds));
            res.status(429).json(tooManyAttempts(wait.retryAfterSeconds, 'ask an administrator to reset your password'));
            return;
        }
        if (!bcrypt.compareSync(body.password, await passwordOf(user.id))) {
            throttles.password.fail(req.ip, user.username);
            await req.audit('mfa.enrol_failed', 'user', user.username, { reason: 'bad_password' });
            res.status(401).json({ error: 'Incorrect password' });
            return;
        }
        throttles.password.reset(req.ip, user.username);

        const existing = await enrolmentOf(user.id);
        if (existing?.['confirmed_at']) {
            /* Re-enrolling silently would let anybody who reaches an unlocked
               screen swap the factor out. Turn it off first, deliberately. */
            res.status(409).json({
                error: 'Two-factor authentication is already set up. Turn it off first, or ask an administrator to reset it.',
                code: 'mfa.already_enrolled',
            });
            return;
        }

        /* A new secret on every start. An abandoned enrolment must not leave
           a secret lying about that somebody could still confirm later. */
        const secret = generateSecret();
        const now = iso(new Date());
        await client.execute({
            sql: `INSERT INTO mfa_enrolments (user_id, secret, confirmed_at, last_step, created_at)
                  VALUES (?, ?, NULL, -1, ?)
                  ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, confirmed_at = NULL, last_step = -1, created_at = excluded.created_at`,
            args: [user.id, secret, now],
        });
        await req.audit('mfa.enrol_started', 'user', user.username, {});

        res.status(201).json({
            /* The only time the secret leaves this server. It is shown once,
               on the screen of somebody who just proved their password. */
            secret: formatSecret(secret),
            uri: otpauthUri({ secret, account: user.username, issuer: ISSUER }),
        });
    }));

    router.post('/api/me/mfa/confirm', requireAuth, wrap(async (req, res) => {
        const body = parse(Confirm, req.body, res);
        if (!body) return;
        const user = req.session.user!;

        const enrolment = await enrolmentOf(user.id);
        if (!enrolment) {
            res.status(409).json({ error: 'Start setting up two-factor authentication first.', code: 'mfa.not_started' });
            return;
        }
        if (enrolment['confirmed_at']) {
            res.status(409).json({ error: 'Already set up.', code: 'mfa.already_enrolled' });
            return;
        }

        const wait = throttles.pin.check(req.ip, `mfa:${user.username}`);
        if (wait) {
            res.set('Retry-After', String(wait.retryAfterSeconds));
            res.status(429).json(tooManyAttempts(wait.retryAfterSeconds, 'wait for the next code'));
            return;
        }

        const result = verifyTotp(String(enrolment['secret']), body.code, { afterStep: Number(enrolment['last_step']) });
        if (!result.ok) {
            throttles.pin.fail(req.ip, `mfa:${user.username}`);
            await req.audit('mfa.confirm_failed', 'user', user.username, {});
            res.status(401).json({ error: 'That code is not right. Check the time on your phone and try the next one.' });
            return;
        }
        throttles.pin.reset(req.ip, `mfa:${user.username}`);

        await client.execute({
            sql: 'UPDATE mfa_enrolments SET confirmed_at = ?, last_step = ? WHERE user_id = ?',
            args: [iso(new Date()), result.step, user.id],
        });
        const codes = await issueRecoveryCodes(user.id);
        await req.audit('mfa.enrolled', 'user', user.username, { recoveryCodes: codes.length });

        /* The codes are returned here and nowhere else, ever. They are stored
           as hashes, so this response is the only copy that exists. */
        res.status(201).json({ confirmed: true, recoveryCodes: codes });
    }));

    /* --------------------------------------------------- recovery codes */

    router.post('/api/me/mfa/recovery-codes', requireAuth, wrap(async (req, res) => {
        const body = parse(Disable, req.body, res);
        if (!body) return;
        const user = req.session.user!;
        const enrolment = await enrolmentOf(user.id);
        if (!enrolment?.['confirmed_at']) {
            res.status(409).json({ error: 'Two-factor authentication is not set up.', code: 'mfa.not_enrolled' });
            return;
        }
        if (!await proveItIsThem(req, res, user.id, user.username, enrolment, body)) return;

        const codes = await issueRecoveryCodes(user.id);
        await req.audit('mfa.recovery_codes_reissued', 'user', user.username, { recoveryCodes: codes.length });
        res.json({ recoveryCodes: codes });
    }));

    /* ------------------------------------------------------------ disable */

    router.delete('/api/me/mfa', requireAuth, wrap(async (req, res) => {
        const body = parse(Disable, req.body, res);
        if (!body) return;
        const user = req.session.user!;
        const facts = req.mfa ?? await factsFor(client, user.id, user.role);

        if (enforced && facts.required) {
            /* Not a thing an administrator may do to themselves. Removing the
               policy is a change to the policy, not a change to an account. */
            res.status(403).json({
                error: 'Your role requires two-factor authentication. It cannot be turned off.',
                code: 'mfa.required',
            });
            return;
        }

        const enrolment = await enrolmentOf(user.id);
        if (!enrolment?.['confirmed_at']) {
            res.status(409).json({ error: 'Two-factor authentication is not set up.', code: 'mfa.not_enrolled' });
            return;
        }
        if (!await proveItIsThem(req, res, user.id, user.username, enrolment, body)) return;

        await client.execute({ sql: 'DELETE FROM mfa_recovery_codes WHERE user_id = ?', args: [user.id] });
        await client.execute({ sql: 'DELETE FROM mfa_enrolments WHERE user_id = ?', args: [user.id] });
        await req.audit('mfa.disabled', 'user', user.username, { by: 'self' });
        res.json({ ok: true });
    }));

    /** Password and a current code, for a change to the factor itself. */
    async function proveItIsThem(
        req: Request, res: Response, userId: number, username: string,
        enrolment: Record<string, unknown>, body: { password: string; code: string },
    ): Promise<boolean> {
        const wait = throttles.password.check(req.ip, username);
        if (wait) {
            res.set('Retry-After', String(wait.retryAfterSeconds));
            res.status(429).json(tooManyAttempts(wait.retryAfterSeconds, 'ask an administrator to reset your password'));
            return false;
        }
        if (!bcrypt.compareSync(body.password, await passwordOf(userId))) {
            throttles.password.fail(req.ip, username);
            res.status(401).json({ error: 'Incorrect password' });
            return false;
        }
        const result = verifyTotp(String(enrolment['secret']), body.code, { afterStep: Number(enrolment['last_step']) });
        if (!result.ok) {
            throttles.pin.fail(req.ip, `mfa:${username}`);
            res.status(401).json({ error: 'That code is not right.' });
            return false;
        }
        throttles.password.reset(req.ip, username);
        await client.execute({ sql: 'UPDATE mfa_enrolments SET last_step = ? WHERE user_id = ?', args: [result.step, userId] });
        return true;
    }

    /* -------------------------------------------------- the lost phone */

    router.post('/api/users/:username/mfa/reset', wrap(async (req, res) => {
        if (!req.session.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        if (req.session.user.role !== 'admin') {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }
        const username = String(req.params['username']).toLowerCase().trim();
        const rs = await client.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
        const row = rs.rows[0];
        if (!row) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        const userId = Number(row['id']);
        await client.execute({ sql: 'DELETE FROM mfa_recovery_codes WHERE user_id = ?', args: [userId] });
        await client.execute({ sql: 'DELETE FROM mfa_enrolments WHERE user_id = ?', args: [userId] });
        /* Every live session of theirs goes too. A reset is what happens
           after a phone is lost, and a lost phone may be holding one. */
        await client.execute({
            sql: 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
            args: [iso(new Date()), userId],
        });
        await req.audit('mfa.reset', 'user', username, { by: req.session.user.username });
        res.json({ ok: true });
    }));

    return router;
}

/* ------------------------------------------------------ the login challenge */

export interface ChallengeStore {
    /** Opens a challenge for a user who has proved their password. */
    open(userId: number): Promise<{ token: string; expiresAt: Date }>;
    /** Checks a code or a recovery code. Consumes the challenge either way
     *  once the attempts run out. */
    answer(token: string, code: string): Promise<ChallengeResult>;
}

export type ChallengeResult =
    | { ok: true; userId: number; usedRecoveryCode: boolean; recoveryCodesRemaining: number }
    | { ok: false; reason: 'unknown' | 'expired' | 'exhausted' | 'wrong' };

export function createChallengeStore(client: Client, now: () => Date = () => new Date()): ChallengeStore {
    return {
        async open(userId) {
            const token = crypto.randomBytes(32).toString('base64url');
            const at = now();
            const expiresAt = new Date(at.getTime() + CHALLENGE_MINUTES * 60_000);
            /* Any older challenge for this person is torn up. Two live
               challenges would mean two chances to guess at once. */
            await client.execute({
                sql: 'UPDATE mfa_challenges SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL',
                args: [iso(at), userId],
            });
            await client.execute({
                sql: 'INSERT INTO mfa_challenges (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
                args: [sha256(token), userId, iso(at), iso(expiresAt)],
            });
            return { token, expiresAt };
        },

        async answer(token, code) {
            const id = sha256(token);
            const at = now();
            const rs = await client.execute({ sql: 'SELECT * FROM mfa_challenges WHERE id = ?', args: [id] });
            const challenge = rs.rows[0];
            if (!challenge || challenge['consumed_at']) return { ok: false, reason: 'unknown' };
            if (String(challenge['expires_at']) <= iso(at)) return { ok: false, reason: 'expired' };
            if (Number(challenge['attempts']) >= MAX_CHALLENGE_ATTEMPTS) {
                await client.execute({ sql: 'UPDATE mfa_challenges SET consumed_at = ? WHERE id = ?', args: [iso(at), id] });
                return { ok: false, reason: 'exhausted' };
            }

            const userId = Number(challenge['user_id']);
            const ers = await client.execute({ sql: 'SELECT * FROM mfa_enrolments WHERE user_id = ?', args: [userId] });
            const enrolment = ers.rows[0];
            if (!enrolment) return { ok: false, reason: 'unknown' };

            const totp = verifyTotp(String(enrolment['secret']), code, { at, afterStep: Number(enrolment['last_step']) });
            if (totp.ok) {
                await client.execute({ sql: 'UPDATE mfa_enrolments SET last_step = ? WHERE user_id = ?', args: [totp.step, userId] });
                await client.execute({ sql: 'UPDATE mfa_challenges SET consumed_at = ? WHERE id = ?', args: [iso(at), id] });
                const remaining = await countCodes(client, userId);
                return { ok: true, userId, usedRecoveryCode: false, recoveryCodesRemaining: remaining };
            }

            /* Not a code; try the recovery codes. Spending one is a single
               UPDATE guarded on used_at, so two requests racing with the same
               code can only spend it once. */
            const spent = await client.execute({
                sql: 'UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
                args: [iso(at), userId, sha256(normaliseRecoveryCode(code))],
            });
            if (spent.rowsAffected > 0) {
                await client.execute({ sql: 'UPDATE mfa_challenges SET consumed_at = ? WHERE id = ?', args: [iso(at), id] });
                return { ok: true, userId, usedRecoveryCode: true, recoveryCodesRemaining: await countCodes(client, userId) };
            }

            await client.execute({ sql: 'UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?', args: [id] });
            return { ok: false, reason: 'wrong' };
        },
    };
}

async function countCodes(client: Client, userId: number): Promise<number> {
    const rs = await client.execute({
        sql: 'SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL',
        args: [userId],
    });
    return Number(rs.rows[0]?.['n'] ?? 0);
}

/** Old challenges are rubbish after their window. Swept on boot. */
export async function sweepChallenges(client: Client, now: Date = new Date()): Promise<number> {
    const rs = await client.execute({
        sql: 'DELETE FROM mfa_challenges WHERE expires_at <= ?',
        args: [iso(new Date(now.getTime() - 60 * 60 * 1000))],
    });
    return rs.rowsAffected;
}
