/* Project scoping for module routers.
 *
 * requireProject resolves :pid (code or numeric id), checks the caller's
 * membership, and attaches req.project and req.membership. requireProjectRole
 * narrows further for write endpoints.
 *
 * THERE IS NO BYPASS FOR PLATFORM ADMINS, and this comment used to say they
 * were "enrolled in every project at boot", which was never quite true and is
 * now actively misleading. Their memberships were written by migrations --
 * 0005_uh_project.sql and its siblings -- for the administrators that existed
 * when those migrations ran. A migration that has run does not run again, so
 * an administrator created today has no membership at all unless somebody
 * grants one.
 *
 * What that produces is worth stating, because it passed a check designed to
 * catch it: a second administrator who satisfies go-live's `admins.second`,
 * can create users and read the audit trail, and gets 403 from the dispatch
 * board, because `req.membership` is undefined and the code below is honest
 * about that. Half an account. scripts/create-admin.mjs grants the
 * memberships for exactly this reason.
 *
 * This is the TypeScript twin of the copy still living in server.js; the
 * legacy one goes away when the TVHS handlers move into a module. */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Client } from '@libsql/client';
import type { ProjectRole } from '../../db/schema/core';

export interface RequestProject {
    id: number;
    code: string;
    name: string;
    timezone: string;
    settings: Record<string, unknown>;
}

declare module 'express-serve-static-core' {
    interface Request {
        /** Set by requireProject, or by its legacy twin in server.js. */
        project?: RequestProject | undefined;
        membership?: {
            role: ProjectRole;
            /* Per-project settings on the membership itself, not the project.
             * A client viewer's scope lives here: which pharmacies they are
             * allowed to see (ticket 3.1). */
            settings: Record<string, unknown>;
        } | undefined;
    }
}

function parseSettings(raw: unknown): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(String(raw ?? '{}'));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function createRequireProject(client: Client): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        (async () => {
            if (!req.session.user) {
                res.status(401).json({
            /* THE CODE IS LOAD-BEARING, not decoration.
             *
             * Two different facts arrive as 401 and the browser cannot tell
             * them apart from the status: this one ("your session is over")
             * and a password check that failed while you are perfectly well
             * signed in, which is what POST /devices/enrol answers when
             * somebody retypes their password wrongly to set up a PIN.
             *
             * The web app signs you out on the first and shows the message
             * on the second. Keying that off the URL meant a list of
             * exceptions that would rot; keying it off the sentence meant
             * reading English. The server knows which it means, so it says
             * so. */
            error: 'Not authenticated',
            code: 'auth.sessionEnded',
        });
                return;
            }
            const pid = String(req.params['pid'] ?? '');
            const byId = /^\d+$/.test(pid);
            const prs = await client.execute({
                sql: `SELECT id, code, name, timezone, settings FROM projects WHERE ${byId ? 'id = ?' : 'code = ?'}`,
                args: [byId ? Number(pid) : pid.toLowerCase()],
            });
            const project = prs.rows[0];
            if (!project) {
                res.status(404).json({ error: 'Project not found' });
                return;
            }

            const mrs = await client.execute({
                sql: `SELECT m.role, m.settings FROM memberships m JOIN users u ON u.id = m.user_id
                      WHERE u.username = ? AND m.project_id = ?`,
                args: [req.session.user.username, Number(project['id'])],
            });
            const membership = mrs.rows[0];
            if (!membership) {
                res.status(403).json({ error: 'Not a member of this project' });
                return;
            }

            req.project = {
                id: Number(project['id']),
                code: String(project['code']),
                name: String(project['name']),
                timezone: String(project['timezone']),
                settings: parseSettings(project['settings']),
            };
            req.membership = {
                role: String(membership['role']) as ProjectRole,
                settings: parseSettings(membership['settings']),
            };
            next();
        })().catch(next);
    };
}

/** Gate a route on the caller's role inside the resolved project. */
export function requireProjectRole(...allowed: ProjectRole[]): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const role = req.membership?.role;
        if (!role || !allowed.includes(role)) {
            res.status(403).json({ error: `Requires project role: ${allowed.join(' or ')}` });
            return;
        }
        next();
    };
}
