/* The contract manager resets their own counters' passwords.
 *
 *   GET  /api/projects/:pid/uh/portals                      who I may reset
 *   POST /api/projects/:pid/uh/portals/:username/password   reset one
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL.
 *
 * Until 9 October 2026 a password an administrator chose was temporary: the
 * server refused almost everything until the person replaced it. That rule is
 * gone, on the owner's decision, and the consequence has to be faced rather
 * than left implicit: the password we generate for a pharmacy portal and send
 * in a message now works until somebody changes it, and two parties know it.
 *
 * This is the thing that makes that survivable. The University Health contract
 * manager can rotate any of their own eight counters themselves, in the
 * afternoon, without a telephone call to Izy. A credential that has been
 * forwarded to the wrong address, read aloud in a dispensary, or left in a
 * leaver's mailbox stops being a reason to ring us and becomes a thing the
 * client fixes. Recovery in place of compulsion.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO CAN DO IT: A MEMBERSHIP SETTING, NOT A ROLE.
 *
 * `mayResetPortalPasswords` on the caller's own membership in this project.
 * Not a fifth project role, because a new role has to be taught to every
 * place that currently reasons about four, and the failure mode of forgetting
 * one is a client account quietly holding a dispatcher's view. A setting is
 * read in exactly one file -- this one -- and grants exactly one verb.
 *
 * It is written by the admin-only membership endpoint, the same endpoint that
 * already decides which pharmacies an account may see, so it is no easier to
 * grant by accident than the scope itself is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO CAN BE RESET: DERIVED FROM THE DATA, NOT A LIST IN THE CODE.
 *
 * A target qualifies only if ALL of these hold, and each one is a separate
 * way this could otherwise go wrong:
 *
 *   platform role `staff`      Not a driver: a courier's account is ours to
 *                              administer and lives in the phone app, and a
 *                              client must not be able to lock one out mid
 *                              round. Not `admin` either, for the obvious
 *                              reason.
 *
 *   a `pharmacy` membership    In THIS project. An Izy account has `admin`,
 *   in this project            `lead` or `courier` here, or no membership at
 *                              all, so none of them can be named -- which is
 *                              the check that keeps this from ever reaching
 *                              one of our own logins.
 *
 *   no `admin` membership      Belt and braces. An account that is a
 *   in ANY project             pharmacy here and an administrator of TVHS is
 *                              not a pharmacy counter, whatever this
 *                              project's row says.
 *
 *   sites ⊆ the caller's       A manager may reset the counters they can
 *   sites, and non-empty       already see, and nothing else. Nine counters
 *                              one day means the manager's membership grows
 *                              first, which is the right order.
 *
 *   not itself a resetter      No manager resets another manager, and none
 *                              resets themselves. Their own password goes
 *                              through /api/me/password like everybody
 *                              else's, which requires knowing the current
 *                              one.
 *
 * The subset rule is what makes this safe without a hard-coded list of eight
 * usernames: the authority is the scope the account already has, so it cannot
 * grow by someone forgetting to update a constant here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY SESSION OF THE TARGET ENDS.
 *
 * The point of a reset is usually that the old password is in the wrong
 * hands, and a live session is that password's child. Leaving one open would
 * mean whoever prompted the reset keeps the access it was meant to remove.
 * The caller's own session is untouched: they are not the account being
 * reset, so there is nothing to except.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LOUDLY AUDITED, AND NAMED FOR WHO DID IT.
 *
 * `uh.portal.password_reset`, carrying the actor, the target and how many
 * sessions went. A distinct action from `user.password_reset`, which is the
 * admin endpoint: when somebody asks six months from now why a pharmacist
 * was signed out on a Tuesday, "the client's own manager did it" and "Izy did
 * it" are different answers and must not share a row shape.
 *
 * The new password is never audited, logged, or echoed back. It goes to the
 * caller in the response body once, because they have to be able to tell the
 * pharmacy what it is, and nowhere else.
 */

import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import type { SessionStore } from '../../core/auth/sessions';
import { requireProjectRole } from '../../core/projects/middleware';
import { scopeFor } from './client-portal';
import { mayReset } from './portal-capability';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const BCRYPT_ROUNDS = 10;

/** The same floor the rest of the system holds. See core/users/routes.ts. */
const SetPassword = z.object({ password: z.string().min(8).max(200) });

/* The capability itself lives in portal-capability.ts, a leaf, because
   client-portal.ts reports it on the summary and this file imports scopeFor
   from client-portal.ts. See that file for why the cycle matters. */

interface PortalRow {
    id: number;
    username: string;
    name: string;
    status: string;
    role: string;
    settings: string;
    /** 1 when this account is an administrator of some project. */
    admin_anywhere: number;
}

function parseSettings(raw: unknown): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(String(raw ?? '{}'));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/**
 * Whether `theirs` is a non-empty subset of `mine`.
 *
 * Empty is NOT a subset here, deliberately, though set theory says otherwise:
 * an unscoped pharmacy membership sees nothing (scopeFor) and is far more
 * likely to be a half-finished settings edit than a real counter. Letting a
 * manager reset it would mean the one account whose scope nobody has checked
 * is the one anybody may take over.
 */
export function withinScope(mine: readonly number[], theirs: readonly number[]): boolean {
    if (theirs.length === 0) return false;
    const have = new Set(mine);
    return theirs.every((id) => have.has(id));
}

export function createPortalResetRouter({ client, store }: { client: Client; store: SessionStore }): Router {
    const router = Router();

    /* `pharmacy` and nothing else. A dispatcher wanting to reset a portal
       password has the admin endpoint, which is audited as us doing it. */
    router.use(requireProjectRole('pharmacy'));

    /* And then the capability, which almost no pharmacy membership carries. */
    router.use((req: Request, res: Response, next: NextFunction) => {
        if (mayReset(req.membership?.settings ?? {})) { next(); return; }
        res.status(403).json({
            error: 'Your account cannot change other pharmacies\' passwords.',
            code: 'portal.notAManager',
        });
        return;
    });

    /** Everybody in this project whose password this caller may set. */
    async function resettable(req: Request): Promise<Array<{ row: PortalRow; siteIds: number[] }>> {
        const mine = scopeFor(undefined, req.membership?.settings ?? {}).siteIds;
        const rs = await client.execute({
            sql: `SELECT u.id, u.username, u.name, u.status, u.role, m.settings,
                         EXISTS (SELECT 1 FROM memberships a WHERE a.user_id = u.id AND a.role = 'admin') AS admin_anywhere
                  FROM users u
                  JOIN memberships m ON m.user_id = u.id
                  WHERE m.project_id = ? AND m.role = 'pharmacy'
                  ORDER BY u.name`,
            args: [Number(req.project?.id)],
        });

        const out: Array<{ row: PortalRow; siteIds: number[] }> = [];
        for (const raw of rs.rows as unknown as PortalRow[]) {
            /* Every one of these is argued for in the header. */
            if (String(raw.role) !== 'staff') continue;
            if (Number(raw.admin_anywhere) === 1) continue;
            const settings = parseSettings(raw.settings);
            if (mayReset(settings)) continue;
            const siteIds = scopeFor(undefined, settings).siteIds;
            if (!withinScope(mine, siteIds)) continue;
            out.push({ row: raw, siteIds });
        }
        return out;
    }

    /* ─────────────────────────────────────────────────────── who I may reset
     *
     * A list rather than the manager typing a username they half remember.
     * It names the pharmacy and whether the account is disabled, and nothing
     * about the password: there is nothing true to say about a hash.
     */
    router.get('/', wrap(async (req, res) => {
        const rows = await resettable(req);
        const names = await client.execute({
            sql: `SELECT id, name FROM sites WHERE project_id = ?`,
            args: [Number(req.project?.id)],
        });
        const siteName = new Map(names.rows.map((s) => [Number(s['id']), String(s['name'])]));

        res.json(rows.map(({ row, siteIds }) => ({
            username: row.username,
            name: row.name,
            status: row.status,
            pharmacies: siteIds.map((id) => siteName.get(id) ?? `#${id}`),
        })));
    }));

    /* ────────────────────────────────────────────────────────── reset one */
    router.post('/:username/password', wrap(async (req, res) => {
        const wanted = String(req.params['username'] ?? '').trim().toLowerCase();
        const body = SetPassword.safeParse(req.body);
        if (!body.success) {
            res.status(400).json({
                error: 'A password must be at least 8 characters.',
                code: 'password.tooShort',
            });
            return;
        }

        /* Looked up through the same function that builds the list, so the
           thing the screen offered and the thing the server allows cannot
           drift apart. A username outside it is 404 rather than 403: whether
           uh.southwest exists is not this caller's business to learn by the
           shape of an error. */
        const target = (await resettable(req)).find((r) => r.row.username === wanted);
        if (!target) {
            res.status(404).json({
                error: 'No pharmacy of yours by that name.',
                code: 'portal.notYours',
            });
            return;
        }

        await client.execute({
            sql: 'UPDATE users SET password = ? WHERE id = ?',
            args: [bcrypt.hashSync(body.data.password, BCRYPT_ROUNDS), Number(target.row.id)],
        });

        /* Every session of theirs, for the reason in the header. */
        const revoked = await store.revokeAllForUser(Number(target.row.id));

        await req.audit('uh.portal.password_reset', 'user', target.row.username, {
            byManager: req.session.user?.username ?? null,
            revokedSessions: revoked,
        });

        res.json({ ok: true, username: target.row.username, revokedSessions: revoked });
    }));

    return router;
}
