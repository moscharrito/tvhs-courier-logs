/* TVHS RMD courier log tables.
 *
 * Mirrors the legacy schema in server.js exactly. The baseline migration
 * (drizzle/0000_baseline.sql) carries the legacy CREATE TABLE text verbatim
 * with IF NOT EXISTS, so existing databases adopt it without change.
 *
 * Ticket 0.5 adds project_id to logs and checkins. */

import { sqliteTable, integer, text, real, unique, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable(
    'users',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        username: text('username').notNull().unique(),
        password: text('password').notNull(),
        pin: text('pin'),
        name: text('name').notNull(),
        role: text('role', { enum: ['driver', 'admin'] }).notNull(),
        route: text('route'),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [check('users_role_check', sql`${t.role} IN ('driver','admin')`)],
);

export const logs = sqliteTable(
    'logs',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        username: text('username').notNull().references(() => users.username),
        date: text('date').notNull(),
        legIndex: integer('leg_index').notNull(),
        legFrom: text('leg_from').default(''),
        legTo: text('leg_to').default(''),
        startTime: text('start_time').default(''),
        endTime: text('end_time').default(''),
        sterile: integer('sterile').default(0),
        soiled: integer('soiled').default(0),
        miles: real('miles').default(0),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
        updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [unique('logs_username_date_leg_index_unique').on(t.username, t.date, t.legIndex)],
);

export const checkins = sqliteTable(
    'checkins',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        username: text('username').notNull().references(() => users.username),
        date: text('date').notNull(),
        checkinAt: text('checkin_at').notNull(),
    },
    (t) => [unique('checkins_username_date_unique').on(t.username, t.date)],
);

export type User = typeof users.$inferSelect;
export type Log = typeof logs.$inferSelect;
export type Checkin = typeof checkins.$inferSelect;
