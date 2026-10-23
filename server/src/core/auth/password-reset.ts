/* Resetting a password with a code sent by email.
 *
 *   POST /api/password-reset/request   { email }
 *   POST /api/password-reset/confirm   { email, code, password }
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BOTH ROUTES ARE PUBLIC, SO BOTH ARE WRITTEN AS IF SOMEBODY HOSTILE IS
 * CALLING THEM, BECAUSE SOMEBODY EVENTUALLY WILL BE.
 *
 * The request route answers the same way for an address that has an account
 * and one that does not: same status, same body, same work. An endpoint that
 * says "no such user" tells anybody who asks which of a list of addresses
 * works at Izy Global Services, which is a staff directory handed out for
 * free. A row is written either way (user_id null for the second), so even
 * the timing is similar.
 *
 * THE CODE IS A CREDENTIAL AND IS TREATED LIKE ONE. Six digits, from
 * randomInt rather than Math.random, bcrypt-hashed at rest, single use,
 * fifteen minutes, and capped at five guesses per row on top of the shared
 * throttle. Six digits is a million combinations; five guesses in fifteen
 * minutes is not a search.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT HAPPENS WHEN THE MAIL CANNOT BE SENT, WHICH IS TODAY.
 *
 * SES is still in sandbox, so it will only deliver to verified addresses. A
 * reset flow that silently fails is worse than none: somebody stands at a
 * pharmacy counter refreshing an inbox that will never receive anything.
 *
 * Two different failures, two different answers, and the difference is
 * whether the answer leaks anything:
 *
 *   The mailer is not configured at all. That is a property of the server,
 *   not of the address, so saying so reveals nothing and saves everyone the
 *   wait. 503, in words, with what to do instead.
 *
 *   The mailer is configured and the send fails -- an unverified recipient
 *   in sandbox, a suppression, a bounce. That DOES correlate with the
 *   address, so it cannot be reported to the caller. It is logged loudly and
 *   audited, and the caller gets the same 202 as everybody else.
 *
 * Which means: while SES is in sandbox, a reset for an unverified address
 * looks exactly like success and nothing arrives. The fix for that is
 * production access, not a different message here.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import type { Mailer } from '../notify/ses';
import type { SessionStore } from './sessions';
import { createThrottle, addressKey, identityKey, tooManyAttempts } from './throttle';

/** Fifteen minutes. Long enough to find the email on a phone at a counter,
 *  short enough that a code left in an inbox overnight is dead. */
export const CODE_TTL_MS = 15 * 60 * 1000;

/** Guesses against one issued code, on top of the shared throttle. */
export const MAX_CODE_ATTEMPTS = 5;

/* Deliberately separate from the login throttles. A reset is rarer than a
   sign-in and the cost of getting it wrong is higher, so it is tighter. */
export const RESET_LIMITS = {
    /** Per address asked about. Three in an hour covers a genuine mistype. */
    byEmail: { maxAttempts: 3, windowMs: 60 * 60 * 1000 },
    /** Per caller. A pharmacy behind one NAT may have several people. */
    byAddress: { maxAttempts: 20, windowMs: 60 * 60 * 1000 },
} as const;

const Email = z.string().trim().toLowerCase().email().max(200);
const RequestBody = z.object({ email: Email });
const ConfirmBody = z.object({
    email: Email,
    code: z.string().trim().regex(/^\d{6}$/, 'a six digit code'),
    password: z.string().min(8).max(200),
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Six digits, zero padded, from a CSPRNG. Math.random is not one. */
export function newCode(random: (min: number, max: number) => number = randomInt): string {
    return String(random(0, 1_000_000)).padStart(6, '0');
}

/** What the person is told, which is the same whoever they are. */
const ACCEPTED = {
    ok: true,
    message: 'If that address belongs to an account, a six digit code is on its way. '
        + 'It expires in 15 minutes. If nothing arrives, ring the office.',
} as const;

export function createPasswordResetRouter(deps: {
    client: Client;
    mailer: Mailer;
    store: SessionStore;
    /** Injected so a test does not wait fifteen real minutes. */
    now?: () => Date;
}) {
    const router = Router();
    const now = deps.now ?? (() => new Date());
    const sql = (text: string, args: unknown[] = []) => deps.client.execute({ sql: text, args: args as never[] });

    const byEmail = createThrottle(RESET_LIMITS.byEmail);
    const byAddress = createThrottle(RESET_LIMITS.byAddress);

    router.post('/request', wrap(async (req, res) => {
        const parsed = RequestBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'A valid email address is required.', code: 'reset.badEmail' });
            return;
        }
        const email = parsed.data.email;

        /* Checked before any work is done, so a refusal costs nothing and
           tells a caller nothing about the address either.
           EVERY REQUEST COUNTS AS A FAILURE. This throttle counts failures,
           which fits a password guess: a success forgets them. A reset
           request has no success to speak of -- the whole point is that it
           answers the same way every time -- so each one is recorded, and
           three for one address in an hour is the cap. */
        const ipKey = addressKey(req.ip);
        const emailKey = identityKey('reset', email);
        for (const [t, key] of [[byAddress, ipKey], [byEmail, emailKey]] as const) {
            if (t.blocked(key)) {
                res.status(429).set('Retry-After', String(t.retryAfter(key)))
                    .json(tooManyAttempts(t.retryAfter(key), 'ring the office'));
                return;
            }
        }
        byAddress.fail(ipKey);
        byEmail.fail(emailKey);

        /* NOT CONFIGURED IS A FACT ABOUT THIS SERVER, NOT ABOUT THE ADDRESS,
           so it can be said out loud. Said here rather than after writing a
           row, because issuing a code nobody can receive is worse than
           refusing: the account would have a live credential attached to it
           for fifteen minutes for no reason. */
        if (!deps.mailer.available) {
            res.status(503).json({
                error: 'Password reset by email is not available on this server. Ring the office and ask for a reset.',
                code: 'reset.mailUnavailable',
                reason: deps.mailer.reason ?? '',
            });
            return;
        }

        const at = now();
        const user = (await sql(
            "SELECT id, name, status FROM users WHERE lower(email) = ? AND status = 'active' LIMIT 1",
            [email],
        )).rows[0];

        const code = newCode();
        /* Cost 10, the same as a password and a device PIN. A code lives
           fifteen minutes, so the work factor is about somebody who has the
           table rather than about somebody guessing at the door. */
        const codeHash = bcrypt.hashSync(code, 10);
        const expiresAt = new Date(at.getTime() + CODE_TTL_MS).toISOString();

        /* Supersede anything outstanding for this address. Somebody who
           clicks twice expects the newest code to be the one that works, and
           two live codes double the guessing surface for no benefit. */
        await sql(
            'UPDATE password_resets SET used_at = ? WHERE email = ? AND used_at IS NULL',
            [at.toISOString(), email],
        );
        await sql(
            `INSERT INTO password_resets (email, user_id, code_hash, created_at, expires_at, requested_ip)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [email, user ? Number(user['id']) : null, codeHash, at.toISOString(), expiresAt, String(req.ip ?? '')],
        );

        /* Only send when there is somebody to send to. The row above exists
           for an unknown address so the two paths look alike from outside;
           emailing a stranger a code for an account they do not have would
           be the one difference anybody could actually observe. */
        if (user) {
            try {
                await deps.mailer.send({
                    to: email,
                    subject: 'Your TAG Courier reset code',
                    /* No name, no link, no account detail. If this lands in
                       the wrong inbox it should say as little as possible,
                       and a code with no context is nearly useless. */
                    text: [
                        'Somebody asked to reset the password for a TAG Courier account with this email address.',
                        '',
                        `Your code is ${code}`,
                        '',
                        'It expires in 15 minutes and can be used once.',
                        'If this was not you, ignore this message and nothing changes.',
                    ].join('\n'),
                }, at);
            } catch (err) {
                /* CANNOT BE REPORTED TO THE CALLER: a send failure
                   correlates with the address, so saying so answers the
                   question this route refuses to answer. Logged and audited
                   instead, because somebody has to be able to find out why a
                   courier never got their code. */
                console.error('[password-reset] could not send to a known address:',
                    err instanceof Error ? err.message : String(err));
                await req.audit?.('password_reset.send_failed', 'user', String(user['id']), {
                    reason: err instanceof Error ? err.message : 'unknown',
                });
            }
        }

        await req.audit?.('password_reset.requested', 'email', email, { known: Boolean(user) });
        res.status(202).json(ACCEPTED);
    }));

    router.post('/confirm', wrap(async (req, res) => {
        const parsed = ConfirmBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'A valid email, a six digit code and a password of at least 8 characters are required.',
                code: 'reset.badRequest',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
            });
            return;
        }
        const { email, code, password } = parsed.data;

        const ipKey = addressKey(req.ip);
        if (byAddress.blocked(ipKey)) {
            res.status(429).set('Retry-After', String(byAddress.retryAfter(ipKey)))
                .json(tooManyAttempts(byAddress.retryAfter(ipKey), 'ring the office'));
            return;
        }

        const at = now();
        const row = (await sql(
            `SELECT id, user_id, code_hash, expires_at, attempts FROM password_resets
              WHERE email = ? AND used_at IS NULL
              ORDER BY created_at DESC, id DESC LIMIT 1`,
            [email],
        )).rows[0];

        /* ONE REFUSAL FOR EVERY WAY THIS CAN FAIL. No code, wrong code,
           expired code, too many guesses, an address with no account: all of
           them answer the same thing. Distinguishing them would tell a
           caller which half of a guess was right. */
        const refuse = () => {
            res.status(400).json({
                error: 'That code is not valid, or it has expired. Ask for a new one.',
                code: 'reset.invalidCode',
            });
        };

        if (!row) { refuse(); return; }

        const attempts = Number(row['attempts'] ?? 0);
        if (attempts >= MAX_CODE_ATTEMPTS) {
            /* Burn it rather than leaving it to expire: a row that has been
               guessed at five times is a row somebody is working on. */
            await sql('UPDATE password_resets SET used_at = ? WHERE id = ?', [at.toISOString(), row['id']]);
            refuse();
            return;
        }
        if (new Date(String(row['expires_at'])).getTime() <= at.getTime()) { refuse(); return; }

        if (!bcrypt.compareSync(code, String(row['code_hash']))) {
            await sql('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', [row['id']]);
            byAddress.fail(ipKey);
            refuse();
            return;
        }

        /* Right code, no account. The row exists because the request route
           writes one for any address; there is nothing to reset, and saying
           so would be the leak the whole design avoids. */
        const userId = row['user_id'] === null ? null : Number(row['user_id']);
        if (userId === null) {
            await sql('UPDATE password_resets SET used_at = ? WHERE id = ?', [at.toISOString(), row['id']]);
            refuse();
            return;
        }

        const user = (await sql("SELECT id, username, status FROM users WHERE id = ? LIMIT 1", [userId])).rows[0];
        if (!user || String(user['status']) !== 'active') {
            await sql('UPDATE password_resets SET used_at = ? WHERE id = ?', [at.toISOString(), row['id']]);
            refuse();
            return;
        }

        await sql('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(password, 10), userId]);
        await sql('UPDATE password_resets SET used_at = ? WHERE id = ?', [at.toISOString(), row['id']]);

        /* EVERY SESSION GOES. Whoever asked for this could not sign in, so
           any session still open on this account belongs either to a device
           they have lost or to whoever made them need a reset. The person
           doing the reset signs in again with the password they just chose;
           everybody else is out. */
        byAddress.reset(ipKey);
        const revoked = await deps.store.revokeAllForUser(userId);

        await req.audit?.('password_reset.completed', 'user', String(user['username']), { revokedSessions: revoked });
        res.json({
            ok: true,
            username: String(user['username']),
            revokedSessions: revoked,
            message: 'Your password is changed and every device signed out. Sign in with the new password.',
        });
    }));

    return router;
}
