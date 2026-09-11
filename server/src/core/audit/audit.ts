/* Audit trail.
 *
 * The middleware gives every request `req.audit(action, entity, entityId,
 * detail)`. It stamps the actor (from the session), the project (when the
 * request is project-scoped), the client IP, and the time, then inserts one
 * row. The insert is awaited: if the audit row cannot be written, the request
 * fails rather than completing unrecorded.
 *
 * Rules for callers:
 *   - action is a dotted verb: auth.login, logs.save, user.create, session.revoke
 *   - entity is the record type, entityId its stable key (username, "user:date")
 *   - detail carries ids, counts, field names, outcomes. Never PHI, never
 *     secrets, never free text copied from a request body. */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Client, InValue } from '@libsql/client';

export type AuditDetail = Record<string, string | number | boolean | null | string[] | number[]>;

export type AuditFn = (action: string, entity: string, entityId?: string | number | null, detail?: AuditDetail) => Promise<void>;

declare module 'express-serve-static-core' {
    interface Request {
        audit: AuditFn;
    }
}
// req.project is declared in core/projects/middleware.ts and set by either
// requireProject (TypeScript modules) or its legacy twin in server.js.

export interface AuditRow {
    id: number;
    at: string;
    project_id: number | null;
    user_id: number | null;
    username: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    ip: string;
    detail: Record<string, unknown>;
}

interface Deps {
    client: Client;
    now?: () => Date;
}

export class AuditLog {
    constructor(private readonly deps: Deps) {}

    async write(event: {
        action: string;
        entity: string;
        entityId?: string | number | null | undefined;
        detail?: AuditDetail | undefined;
        userId?: number | null | undefined;
        username?: string | null | undefined;
        projectId?: number | null | undefined;
        ip?: string | undefined;
    }): Promise<void> {
        const at = (this.deps.now ? this.deps.now() : new Date()).toISOString();
        await this.deps.client.execute({
            sql: `INSERT INTO audit_events (at, project_id, user_id, username, action, entity, entity_id, ip, detail)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                at,
                event.projectId ?? null,
                event.userId ?? null,
                event.username ?? null,
                event.action,
                event.entity,
                event.entityId == null ? null : String(event.entityId),
                (event.ip || '').slice(0, 64),
                JSON.stringify(event.detail ?? {}),
            ],
        });
    }

    /** Admin query. Newest first, cursor on id. */
    async query(filter: {
        username?: string | undefined;
        action?: string | undefined;
        entity?: string | undefined;
        entityId?: string | undefined;
        projectId?: number | undefined;
        from?: string | undefined;
        to?: string | undefined;
        before?: number | undefined;
        limit: number;
    }): Promise<{ events: AuditRow[]; nextBefore: number | null }> {
        const where: string[] = [];
        const args: InValue[] = [];
        if (filter.username) { where.push('username = ?'); args.push(filter.username.toLowerCase().trim()); }
        if (filter.action) { where.push('action LIKE ?'); args.push(`${filter.action}%`); }
        if (filter.entity) { where.push('entity = ?'); args.push(filter.entity); }
        if (filter.entityId) { where.push('entity_id = ?'); args.push(filter.entityId); }
        if (filter.projectId !== undefined) { where.push('project_id = ?'); args.push(filter.projectId); }
        if (filter.from) { where.push('at >= ?'); args.push(filter.from); }
        if (filter.to) { where.push('at <= ?'); args.push(filter.to); }
        if (filter.before !== undefined) { where.push('id < ?'); args.push(filter.before); }
        args.push(filter.limit + 1);

        const rs = await this.deps.client.execute({
            sql: `SELECT id, at, project_id, user_id, username, action, entity, entity_id, ip, detail
                  FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY id DESC LIMIT ?`,
            args,
        });
        const rows = rs.rows.map((r) => ({
            id: Number(r['id']),
            at: String(r['at']),
            project_id: r['project_id'] == null ? null : Number(r['project_id']),
            user_id: r['user_id'] == null ? null : Number(r['user_id']),
            username: r['username'] == null ? null : String(r['username']),
            action: String(r['action']),
            entity: String(r['entity']),
            entity_id: r['entity_id'] == null ? null : String(r['entity_id']),
            ip: String(r['ip']),
            detail: safeJson(String(r['detail'])),
        }));
        const hasMore = rows.length > filter.limit;
        const events = hasMore ? rows.slice(0, filter.limit) : rows;
        const last = events[events.length - 1];
        return { events, nextBefore: hasMore && last ? last.id : null };
    }
}

function safeJson(s: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(s);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function createAuditMiddleware(deps: Deps): { middleware: RequestHandler; log: AuditLog } {
    const log = new AuditLog(deps);
    const middleware: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
        req.audit = (action, entity, entityId, detail) => {
            const user = req.session?.user as (typeof req.session.user & { id?: number }) | null | undefined;
            return log.write({
                action,
                entity,
                entityId,
                detail,
                userId: user?.id ?? null,
                username: user?.username ?? null,
                projectId: req.project?.id ?? null,
                ip: req.ip,
            });
        };
        next();
    };
    return { middleware, log };
}
