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
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        unique('memberships_user_project_unique').on(t.userId, t.projectId),
        index('memberships_project_id_idx').on(t.projectId),
        check('memberships_role_check', sql`${t.role} IN ('admin','ops_manager','dispatcher','courier','client_viewer')`),
    ],
);

export type Project = typeof projects.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
