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

/* Zone by destination ZIP. Addendum 1: a zone is the one-way loaded mileage
 * from the pickup location to the delivery location, and UH published the
 * mapping as a ZIP list per zone in Bid Table BT-89AO. A ZIP absent from this
 * table is out of area and bills per mile instead.
 *
 * Effective-dated so a future zone revision can be loaded without destroying
 * the mapping that priced past invoices. */
export const zoneZips = sqliteTable(
    'zone_zips',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        zip: text('zip').notNull(),
        zone: integer('zone').notNull(),
        /** Place name as printed in the bid table for zones 4 and 5 (Helotes, Boerne) */
        place: text('place'),
        effectiveFrom: text('effective_from').notNull(),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        unique('zone_zips_project_zip_from_unique').on(t.projectId, t.zip, t.effectiveFrom),
        index('zone_zips_project_zip_idx').on(t.projectId, t.zip),
        check('zone_zips_zone_check', sql`${t.zone} BETWEEN 1 AND 5`),
    ],
);

/* One complete price list, effective from a date. A contract price schedule
 * changes as a whole, so a row is the whole schedule rather than one rate.
 * Rates are the Izy BAFO figures; they are firm for the base term and the
 * renewals, so a second row should only ever appear after a mutually agreed
 * escalation (Addendum 1, fuel and labour). */
export const priceSchedules = sqliteTable(
    'price_schedules',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        effectiveFrom: text('effective_from').notNull(),
        label: text('label').notNull().default(''),
        zone1: real('zone1').notNull(),
        zone2: real('zone2').notNull(),
        zone3: real('zone3').notNull(),
        zone4: real('zone4').notNull(),
        zone5: real('zone5').notNull(),
        statSurcharge: real('stat_surcharge').notNull(),
        afterHoursSurcharge: real('after_hours_surcharge').notNull(),
        dryRunFee: real('dry_run_fee').notNull(),
        outOfAreaPerMile: real('out_of_area_per_mile').notNull(),
        notes: text('notes').notNull().default(''),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [unique('price_schedules_project_from_unique').on(t.projectId, t.effectiveFrom)],
);

export type ZoneZip = typeof zoneZips.$inferSelect;
export type PriceSchedule = typeof priceSchedules.$inferSelect;
