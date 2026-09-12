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

/* ---------------------------------------------------------------------------
 * Daily lists and orders (ticket 1.5).
 *
 * THIS IS WHERE PHI ENTERS THE SYSTEM. Every column below that names or
 * locates a patient is marked. The rules that follow are not style
 * preferences, they are the difference between a compliant system and a
 * reportable breach:
 *
 *   - Audit rows carry counts and ids from these tables, never values.
 *   - Log lines carry neither. The request logger already drops query
 *     strings; nothing here may be put in a path or a log field.
 *   - The uploaded spreadsheet is parsed in memory and never written to
 *     disk. There is no staging table and no temp file, so an abandoned
 *     import leaves nothing behind. Ticket 1.8 adds encrypted S3 storage if
 *     a copy of the source file is ever actually wanted.
 *   - Only what a delivery needs is stored. A pharmacy list usually carries
 *     more (date of birth, account number, drug name); the importer maps the
 *     fields it needs and drops the rest rather than keeping them in case.
 * ------------------------------------------------------------------------- */

export const LIST_STATUSES = ['draft', 'released', 'cancelled'] as const;
export const SERVICE_TYPES = ['scheduled', 'stat', 'adhoc'] as const;
/* 1.5 needs only the states an imported order passes through before dispatch
 * touches it. Ticket 1.6 owns the rest of the lifecycle and the transition
 * table; it extends this constraint rather than replacing it. */
export const ORDER_STATUSES = ['pending', 'ready', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'] as const;

/* One import of one pharmacy's list for one service date. A pharmacy may send
 * more than one batch in a day (Addendum 1 describes the list being compiled
 * and sent "based on operational needs"), so this is not unique per day. */
export const dailyLists = sqliteTable(
    'daily_lists',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        siteId: integer('site_id').notNull().references(() => sites.id),
        /** Date the deliveries are for, YYYY-MM-DD in the project timezone. */
        serviceDate: text('service_date').notNull(),
        status: text('status', { enum: LIST_STATUSES }).notNull().default('draft'),
        /** When the list reached dispatch. The SLA clock starts here (Addendum 1). */
        receivedAt: text('received_at').notNull(),
        /** Original file name, so an operator recognises it. Never a path. */
        sourceFilename: text('source_filename').notNull().default(''),
        /** SHA-256 of the uploaded bytes: catches the same file imported twice. */
        sourceSha256: text('source_sha256').notNull().default(''),
        rowCount: integer('row_count').notNull().default(0),
        orderCount: integer('order_count').notNull().default(0),
        skippedCount: integer('skipped_count').notNull().default(0),
        importedBy: text('imported_by').notNull().default(''),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        index('daily_lists_project_date_idx').on(t.projectId, t.serviceDate),
        index('daily_lists_site_date_idx').on(t.siteId, t.serviceDate),
        check('daily_lists_status_check', sql`${t.status} IN ('draft','released','cancelled')`),
    ],
);

export const orders = sqliteTable(
    'orders',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** Where the courier picks up. The zone is measured from here. */
        siteId: integer('site_id').notNull().references(() => sites.id),
        /** Null for a manually created STAT or ad hoc order (ticket 1.6). */
        dailyListId: integer('daily_list_id').references(() => dailyLists.id),
        /** The pharmacy's own reference for the row, when the list carries one. */
        externalRef: text('external_ref').notNull().default(''),
        serviceType: text('service_type', { enum: SERVICE_TYPES }).notNull().default('scheduled'),
        serviceDate: text('service_date').notNull(),

        /* PHI: identifies a patient. */
        recipientName: text('recipient_name').notNull(),
        /* PHI: contact detail. */
        recipientPhone: text('recipient_phone').notNull().default(''),
        /* PHI: a patient's home address. */
        addressLine: text('address_line').notNull(),
        addressLine2: text('address_line2').notNull().default(''),
        city: text('city').notNull().default(''),
        state: text('state').notNull().default('TX'),
        zip: text('zip').notNull(),
        /* PHI: free text from the pharmacy. May name the patient or the drug. */
        deliveryNotes: text('delivery_notes').notNull().default(''),

        /* Coordinates stay null until ticket 1.4 geocodes them. Nothing
         * invents them, exactly as with sites. */
        lat: real('lat'),
        lng: real('lng'),
        geocodeStatus: text('geocode_status', { enum: GEOCODE_STATUSES }).notNull().default('pending'),

        /** Billing zone resolved from the ZIP map. Null means out of area. */
        zone: integer('zone'),
        /** One-way loaded miles, needed only when zone is null. Ticket 1.4. */
        outOfAreaMiles: real('out_of_area_miles'),

        signatureRequired: integer('signature_required', { mode: 'boolean' }).notNull().default(true),

        /** When the request reached dispatch. Copied from the list. */
        receivedAt: text('received_at').notNull(),
        /** Computed by dueTimesFor from the project's clock rule. */
        dueAt: text('due_at'),
        /** STAT's second deadline, one hour from pickup. Set at pickup (1.6). */
        pickupDueAt: text('pickup_due_at'),
        pickupAt: text('pickup_at'),
        arrivedAt: text('arrived_at'),
        deliveredAt: text('delivered_at'),

        /* Assignment. A username, as everywhere else in the platform. */
        assignedToUsername: text('assigned_to_username'),
        assignedAt: text('assigned_at'),

        /* Scope 1.2.8 proof of delivery: the printed name of the authorised
         * sending and receiving personnel. PHI. */
        pickedUpBy: text('picked_up_by').notNull().default(''),
        receivedBy: text('received_by').notNull().default(''),

        /* Why a delivery failed or was called off. PHI-adjacent free text. */
        failureReason: text('failure_reason').notNull().default(''),
        /* Scope 1.2.9: undelivered packages go back to the origin pharmacy, or
         * to the Discharge Pharmacy after hours. Returning does not undo the
         * failure, so this is a timestamp and not a status: an order still in
         * a van is status 'failed' with returned_at null. */
        returnedAt: text('returned_at'),

        /* Duplicate detection within a site and a day: a hash of the external
         * reference, or of the normalised recipient and address when the list
         * carries no reference. A hash rather than the values themselves, so
         * neither the column nor its index can be read as a patient list. */
        dedupeKey: text('dedupe_key').notNull().default(''),

        status: text('status', { enum: ORDER_STATUSES }).notNull().default('pending'),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
        updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        index('orders_project_date_idx').on(t.projectId, t.serviceDate),
        index('orders_list_idx').on(t.dailyListId),
        index('orders_site_date_idx').on(t.siteId, t.serviceDate),
        index('orders_status_idx').on(t.projectId, t.status),
        index('orders_dedupe_idx').on(t.siteId, t.serviceDate, t.dedupeKey),
        check('orders_service_type_check', sql`${t.serviceType} IN ('scheduled','stat','adhoc')`),
        check('orders_status_check', sql`${t.status} IN ('pending','ready','assigned','picked_up','delivered','failed','cancelled')`),
        check('orders_zone_check', sql`${t.zone} IS NULL OR ${t.zone} BETWEEN 1 AND 5`),
    ],
);

export const packages = sqliteTable(
    'packages',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        orderId: integer('order_id').notNull().references(() => orders.id),
        /* Scope 1.2.6 and 1.2.8 require a description and quantity on the
         * tracking record and on the proof of delivery, so this is
         * contractually required rather than optional detail. */
        description: text('description').notNull().default(''),
        quantity: integer('quantity').notNull().default(1),
        /** Scope 1.2.3: doorstep delivery is allowed by medication type. */
        signatureRequired: integer('signature_required', { mode: 'boolean' }).notNull().default(true),
        /* Addendum 1 bills a dry run per item, so the outcome has to be
         * recordable per package and not only per stop. */
        outcome: text('outcome', { enum: ['pending', 'delivered', 'failed'] }).notNull().default('pending'),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        index('packages_order_idx').on(t.orderId),
        check('packages_outcome_check', sql`${t.outcome} IN ('pending','delivered','failed')`),
    ],
);

/* The column mapping a site's spreadsheet needs, saved after the first import
 * so nobody re-maps the same layout every day. headerFingerprint is a hash of
 * the header row: when a pharmacy changes its export, the fingerprint stops
 * matching and the operator is asked to confirm the mapping again rather than
 * the importer silently reading the wrong columns. */
export const importMappings = sqliteTable(
    'import_mappings',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        siteId: integer('site_id').notNull().references(() => sites.id),
        /** JSON: { field: "Header text in the sheet" } */
        mapping: text('mapping').notNull().default('{}'),
        headerFingerprint: text('header_fingerprint').notNull().default(''),
        updatedBy: text('updated_by').notNull().default(''),
        updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [unique('import_mappings_site_unique').on(t.projectId, t.siteId)],
);

export type DailyList = typeof dailyLists.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type ImportMapping = typeof importMappings.$inferSelect;

/* Chain of custody (ticket 1.6).
 *
 * Scope 1.2.7 requires the chain of custody to be secured and available for
 * regulatory audit, so this table is append-only the way audit_events is:
 * migration 0009 adds BEFORE UPDATE and BEFORE DELETE triggers that abort.
 * A custody record that can be edited after the fact is not evidence.
 *
 * This table is NOT the audit trail, and the difference matters. audit_events
 * records who touched the system and carries no PHI. custody_events records
 * what physically happened to a patient's medication and deliberately does
 * carry the names Scope 1.2.8 requires on a proof of delivery: the printed
 * name of the authorised sending and receiving personnel. Treat it like
 * orders, not like a log.
 */
export const CUSTODY_EVENT_TYPES = [
    'created', 'released', 'assigned', 'unassigned', 'picked_up',
    'arrived', 'delivered', 'attempted', 'returned', 'cancelled', 'note',
] as const;

export const PACKAGE_OUTCOMES = ['pending', 'delivered', 'failed'] as const;

export const custodyEvents = sqliteTable(
    'custody_events',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        orderId: integer('order_id').notNull().references(() => orders.id),
        /** Null when the event covers the whole order rather than one package. */
        packageId: integer('package_id').references(() => packages.id),
        type: text('type', { enum: CUSTODY_EVENT_TYPES }).notNull(),
        /** ISO timestamp of the event itself, which may predate the row. */
        at: text('at').notNull(),
        /** Who recorded it. A username, as everywhere else in the platform. */
        actor: text('actor').notNull().default(''),
        fromStatus: text('from_status').notNull().default(''),
        toStatus: text('to_status').notNull().default(''),

        /* PHI: Scope 1.2.8 requires the printed name of the sending and the
         * receiving personnel on the proof of delivery. */
        signedName: text('signed_name').notNull().default(''),
        /** S3 key of the signature image. Ticket 1.8 fills this in. */
        signatureKey: text('signature_key').notNull().default(''),
        /* PHI-adjacent: a courier's free text, which can name a patient. */
        reason: text('reason').notNull().default(''),

        /** Where the courier was. Scope 1.2.7 asks for GPS on custody. */
        lat: real('lat'),
        lng: real('lng'),

        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        index('custody_events_order_idx').on(t.orderId, t.at),
        index('custody_events_project_at_idx').on(t.projectId, t.at),
        check(
            'custody_events_type_check',
            sql`${t.type} IN ('created','released','assigned','unassigned','picked_up','arrived','delivered','attempted','returned','cancelled','note')`,
        ),
    ],
);

export type CustodyEvent = typeof custodyEvents.$inferSelect;
