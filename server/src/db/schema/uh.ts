/* UH Pharmacy Courier module tables (RFP-226-03-068-SVC).
 *
 * sites are the places a run starts or ends: the pharmacies that release
 * daily lists, and later the community hospitals. Every delivery's zone is
 * measured as one-way loaded miles from its origin site, so a site's
 * coordinates are part of pricing, not just display.
 *
 * lat/lng are null until ticket 1.4 geocodes them; nothing may invent them.
 * geocodeStatus records how the coordinates were obtained. */

import { sqliteTable, integer, text, real, unique, check, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { projects } from './core';

export const SITE_TYPES = ['pharmacy', 'hospital', 'other'] as const;
export const SITE_STATUSES = ['active', 'inactive'] as const;
export const GEOCODE_STATUSES = ['pending', 'ok', 'failed', 'manual'] as const;

export const sites = sqliteTable(
    'sites',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** Short stable handle, unique within the project: pavilion, green, tdi */
        code: text('code').notNull(),
        name: text('name').notNull(),
        type: text('type', { enum: SITE_TYPES }).notNull().default('pharmacy'),
        addressLine: text('address_line').notNull(),
        city: text('city').notNull().default('San Antonio'),
        state: text('state').notNull().default('TX'),
        zip: text('zip').notNull(),
        lat: real('lat'),
        lng: real('lng'),
        geocodeStatus: text('geocode_status', { enum: GEOCODE_STATUSES }).notNull().default('pending'),
        geocodedAt: text('geocoded_at'),
        /** Releases a daily delivery list (Addendum 1: each pharmacy compiles its own) */
        releasesList: integer('releases_list', { mode: 'boolean' }).notNull().default(true),
        status: text('status', { enum: SITE_STATUSES }).notNull().default('active'),
        notes: text('notes').notNull().default(''),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
        updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        unique('sites_project_code_unique').on(t.projectId, t.code),
        index('sites_project_id_idx').on(t.projectId),
        check('sites_type_check', sql`${t.type} IN ('pharmacy','hospital','other')`),
        check('sites_status_check', sql`${t.status} IN ('active','inactive')`),
        check('sites_geocode_status_check', sql`${t.geocodeStatus} IN ('pending','ok','failed','manual')`),
    ],
);

export type Site = typeof sites.$inferSelect;
