/* Platform core: projects and memberships.
 *
 * A project is one courier contract (tvhs, uh). A membership gives a user a
 * role inside one project. Every project-scoped table carries project_id and
 * every project-scoped request is checked against memberships (requireProject
 * in server.js, moving to src/core/projects in a later ticket).
 *
 * users stays in tvhs.ts until ticket 0.7 turns it into the platform user
 * directory; memberships already reference it. */

import { sqliteTable, integer, text, unique, check, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './tvhs';

export const PROJECT_ROLES = ['admin', 'ops_manager', 'dispatcher', 'courier', 'client_viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const projects = sqliteTable('projects', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Short stable handle used in URLs: tvhs, uh */
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('America/Chicago'),
    /** JSON blob of per-project settings (clock rules, routes, list release times) */
    settings: text('settings').notNull().default('{}'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const memberships = sqliteTable(
    'memberships',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        userId: integer('user_id').notNull().references(() => users.id),
        projectId: integer('project_id').notNull().references(() => projects.id),
        role: text('role', { enum: PROJECT_ROLES }).notNull(),
        /** JSON blob of per-project, per-user settings. For tvhs couriers: { route: 'northbound' | 'southbound' } */
        settings: text('settings').notNull().default('{}'),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        unique('memberships_user_project_unique').on(t.userId, t.projectId),
        index('memberships_project_id_idx').on(t.projectId),
        check('memberships_role_check', sql`${t.role} IN ('admin','ops_manager','dispatcher','courier','client_viewer')`),
    ],
);

/* Server-side sessions. The browser cookie carries a random token; the row id
 * is the SHA-256 of that token, so a copy of the table cannot be replayed.
 * A session is live while revoked_at is null and both expiries are in the
 * future. Idle expiry moves forward on use (per-role lengths in config);
 * absolute expiry does not. */
export const sessions = sqliteTable(
    'sessions',
    {
        /** sha256(token), hex */
        id: text('id').primaryKey(),
        userId: integer('user_id').notNull().references(() => users.id),
        /** Short human label derived from the user agent, for the devices list */
        device: text('device').notNull().default(''),
        ip: text('ip').notNull().default(''),
        createdAt: text('created_at').notNull(),
        lastSeenAt: text('last_seen_at').notNull(),
        idleExpiresAt: text('idle_expires_at').notNull(),
        absoluteExpiresAt: text('absolute_expires_at').notNull(),
        revokedAt: text('revoked_at'),
    },
    (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/* Append-only audit trail. Migration 0004 adds BEFORE UPDATE and BEFORE
 * DELETE triggers that abort, so rows can only ever be inserted. Every write
 * endpoint and every read of one user's data records an event. `detail` is
 * JSON and must never contain PHI (ids, counts, and field names only). */
export const auditEvents = sqliteTable(
    'audit_events',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        /** ISO timestamp */
        at: text('at').notNull(),
        projectId: integer('project_id'),
        userId: integer('user_id'),
        /** Username at the time, kept even if the user row later changes */
        username: text('username'),
        /** dotted verb, e.g. auth.login, logs.save, user.create */
        action: text('action').notNull(),
        /** entity type, e.g. user, session, logs, checkin */
        entity: text('entity').notNull(),
        entityId: text('entity_id'),
        ip: text('ip').notNull().default(''),
        detail: text('detail').notNull().default('{}'),
    },
    (t) => [
        index('audit_events_at_idx').on(t.at),
        index('audit_events_user_id_idx').on(t.userId),
        index('audit_events_project_id_idx').on(t.projectId),
        index('audit_events_entity_idx').on(t.entity, t.entityId),
    ],
);

export type Project = typeof projects.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
