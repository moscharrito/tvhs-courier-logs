/* UH Pharmacy Courier module tables (RFP-226-03-068-SVC).
 *
 * sites are the places a run starts or ends: the pharmacies that release
 * daily lists, and later the community hospitals. Every delivery's zone is
 * measured as one-way loaded miles from its origin site, so a site's
 * coordinates are part of pricing, not just display.
 *
 * lat/lng are null until the site lookup runs (ticket 1.4); nothing invents them.
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

        /* Coordinates stay null. A delivery address may not be sent to the
         * geocoder this system has (ticket 1.9), so unlike sites these are not
         * filled in yet. Nothing
         * invents them, exactly as with sites. */
        lat: real('lat'),
        lng: real('lng'),
        geocodeStatus: text('geocode_status', { enum: GEOCODE_STATUSES }).notNull().default('pending'),

        /** Billing zone resolved from the ZIP map. Null means out of area. */
        zone: integer('zone'),
        outOfAreaMiles: real('out_of_area_miles'),
        /* HOW those miles were arrived at, because an invoice line that bills
         * a distance has to be able to say where the distance came from when
         * University Health asks. Empty until something measures it.
         * See src/modules/uh/mileage.ts (ticket 1.9). */
        outOfAreaBasis: text('out_of_area_basis').notNull().default(''),

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
        /* Scope 1.2.3 allows a doorstep delivery "depending on the medication
         * type". When one happens there is no receiver signature, so the
         * record has to say why instead of simply being blank. */
        noSignatureReason: text('no_signature_reason').notNull().default(''),
        /* Scope 1.2.9: undelivered packages go back to the origin pharmacy, or
         * to the Discharge Pharmacy after hours. Returning does not undo the
         * failure, so this is a timestamp and not a status: an order still in
         * a van is status 'failed' with returned_at null. */
        returnedAt: text('returned_at'),
        /* Which pharmacy took them back, and who signed for them. Not always
         * the origin: after hours the Discharge Pharmacy is the one that is
         * open, and an origin that shut early sends a courier elsewhere. */
        returnedToSiteId: integer('returned_to_site_id').references(() => sites.id),
        returnedBy: text('returned_by').notNull().default(''),

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
        /* Why this particular item was not delivered. Addendum 1 lists the
         * circumstances a dry run covers, and DRY_RUN_REASONS below is that
         * list; a free-text note carries anything outside it.
         *
         * No CHECK constraint on purpose: SQLite cannot add one without
         * rebuilding the table, and a rebuild of a table holding delivery
         * records is a risk out of proportion to a six-value enum that zod
         * already enforces at the edge. */
        failureReasonCode: text('failure_reason_code').notNull().default(''),
        failureNote: text('failure_note').notNull().default(''),
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

/* Addendum 1: a dry run applies when a delivery "is attempted but cannot be
 * completed due to circumstances such as an incorrect address, inability to
 * locate the recipient, lack of access, or incomplete or unavailable shipment
 * information". These are that list, in the contract's own terms, so an
 * invoice line can be defended by pointing at the clause. */
export const DRY_RUN_REASONS = [
    'incorrect_address',
    'recipient_not_located',
    'no_access',
    'incomplete_shipment',
    'refused',
    'other',
] as const;
export type DryRunReason = (typeof DRY_RUN_REASONS)[number];

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
        /** Where the signature is. See modules/uh/pickup for the shape. */
        signatureKey: text('signature_key').notNull().default(''),
        /** The photo that proves a doorstep delivery (ticket 1.8 stores it). */
        fileId: integer('file_id'),
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

/* Runs and their stops (ticket 2.1).
 *
 * A run is one courier's work for part of a day: the batch the explainer
 * video calls a "dense loop". Addendum 1 describes the pharmacies releasing
 * lists between noon and 2pm, and after-hours work happens too, so a courier
 * can have more than one run in a day. Runs are therefore labelled rather
 * than being one-per-courier-per-date.
 *
 * A stop is one order on one run, in sequence. Ordering matters: the
 * sequence is the route the courier drives, and ticket 2.2 will propose one
 * by nearest-neighbour from the origin site once ticket 1.9 supplies
 * coordinates. Until then a dispatcher sets it by hand.
 *
 * Adding a stop is what assigns an order, and it goes through the same
 * transition table as everything else (modules/uh/order-events). There is no
 * path that puts an order on a run without recording the custody event that
 * says so.
 */

export const RUN_STATUSES = ['planned', 'started', 'completed', 'cancelled'] as const;

export const runs = sqliteTable(
    'runs',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** The courier driving it. A username, as everywhere else. */
        courierUsername: text('courier_username').notNull(),
        /** The day the work belongs to, YYYY-MM-DD in the project timezone. */
        serviceDate: text('service_date').notNull(),
        /** "Noon wave", "After hours". Distinguishes a courier's second run. */
        label: text('label').notNull().default(''),
        status: text('status', { enum: RUN_STATUSES }).notNull().default('planned'),
        startedAt: text('started_at'),
        completedAt: text('completed_at'),
        notes: text('notes').notNull().default(''),
        createdBy: text('created_by').notNull().default(''),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
        updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        index('runs_project_date_idx').on(t.projectId, t.serviceDate),
        index('runs_courier_date_idx').on(t.courierUsername, t.serviceDate),
        check('runs_status_check', sql`${t.status} IN ('planned','started','completed','cancelled')`),
    ],
);

export const runStops = sqliteTable(
    'run_stops',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        runId: integer('run_id').notNull().references(() => runs.id),
        orderId: integer('order_id').notNull().references(() => orders.id),
        /** 1-based position in the route. Rewritten as a block on reorder. */
        sequence: integer('sequence').notNull(),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        /* An order is on at most one run. Two couriers each believing a
         * package is theirs is the failure this prevents, and a unique index
         * prevents it in the database rather than only in a handler. */
        unique('run_stops_order_unique').on(t.projectId, t.orderId),
        index('run_stops_run_seq_idx').on(t.runId, t.sequence),
        /* The courier's pickup manifest filters on project AND run (ticket
         * 4.8). Without an index whose leading columns are exactly those,
         * SQLite picked the unique index above, used only its project_id
         * prefix, and walked every stop in the project to return one
         * courier's twenty. Statistics happen to correct that today and are
         * not something to rely on: an index the planner cannot get wrong is
         * cheaper than a plan that depends on ANALYZE having run. */
        index('run_stops_project_run_idx').on(t.projectId, t.runId, t.sequence),
    ],
);

export type Run = typeof runs.$inferSelect;
export type RunStop = typeof runStops.$inferSelect;

/* Captured signatures (ticket 2.4).
 *
 * Scope 1.2.8 requires the printed name AND signature of the authorised
 * sending and receiving personnel on a proof of delivery, so a name alone
 * does not satisfy the contract.
 *
 * The signature is stored as the STROKES the finger drew, not as a rendered
 * image. A few hundred points is one or two kilobytes, it renders crisply at
 * any size on a POD PDF, and it keeps the platform out of the business of
 * storing binary blobs before the S3 service in ticket 1.8 exists. It is also
 * better evidence than a raster: the stroke order and timing are part of the
 * record.
 *
 * One row per signing, not per package. A pharmacy technician handing over
 * forty packages signs once; making a courier collect forty signatures at a
 * counter would guarantee the feature goes unused and the record goes blank.
 * The custody events for all forty point at the same row.
 *
 * This is personal data about the person who signed, not about a patient, but
 * it lives with custody and is protected the same way: append-only in
 * practice, never in a log, never in the audit trail.
 */

/* 'return' joins these in 0015: handing undelivered medication back over a
 * counter is the same kind of custody handover as collecting it, and calling
 * it a delivery in the record would be a lie that reaches a proof of
 * delivery. */
/* Invoicing.
 *
 * MONEY IS STORED IN CENTS, as integers. A dollar is not representable in
 * binary floating point, and an invoice is the one place in this system where
 * a rounding difference of a hundredth becomes a letter from somebody's
 * accounts department.
 *
 * AN ISSUED INVOICE IS FROZEN. A draft is recomputed from the orders every
 * time it is opened, because a late-arriving courier event or a corrected zone
 * should change it. The moment it is issued, every line is written down as
 * billed and never recomputed: you cannot send accounts payable a number and
 * then have the system quietly show a different one. That is the whole reason
 * invoice_lines exists rather than the invoice being a query.
 *
 * NO PATIENT NAMES. An invoice goes to a finance team, who need the date, the
 * pharmacy, the reference and the charge, and have no need of the person the
 * medication was for. The delivery ZIP is carried because it is what justifies
 * the zone on the line, and a ZIP without a name or a street is not a patient.
 */
export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'] as const;

export const invoices = sqliteTable(
    'invoices',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** Human reference: IZY-UH-2026-09-0001. Unique within the project. */
        number: text('number').notNull(),
        periodFrom: text('period_from').notNull(),
        periodTo: text('period_to').notNull(),
        /** Null for the whole contract; set when a pharmacy is billed alone. */
        siteId: integer('site_id').references(() => sites.id),
        status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),
        currency: text('currency').notNull().default('USD'),
        /** Frozen at issue. Zero while a draft, which recomputes on read. */
        subtotalCents: integer('subtotal_cents').notNull().default(0),
        adjustmentsCents: integer('adjustments_cents').notNull().default(0),
        totalCents: integer('total_cents').notNull().default(0),
        lineCount: integer('line_count').notNull().default(0),
        /** Deliveries in the period that could not be priced at issue time.
         *  Recorded on the invoice because leaving them out is a decision
         *  somebody made, not an absence. */
        excludedCount: integer('excluded_count').notNull().default(0),
        excludedNote: text('excluded_note').notNull().default(''),
        notes: text('notes').notNull().default(''),
        issuedAt: text('issued_at'),
        issuedBy: text('issued_by').notNull().default(''),
        paidAt: text('paid_at'),
        voidedAt: text('voided_at'),
        voidReason: text('void_reason').notNull().default(''),
        createdAt: text('created_at').notNull(),
        createdBy: text('created_by').notNull().default(''),
    },
    (t) => [
        unique('invoices_project_number_unique').on(t.projectId, t.number),
        index('invoices_project_period_idx').on(t.projectId, t.periodFrom),
        check('invoices_status_check', sql`${t.status} IN ('draft','issued','paid','void')`),
    ],
);

export const invoiceLines = sqliteTable(
    'invoice_lines',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        invoiceId: integer('invoice_id').notNull().references(() => invoices.id),
        orderId: integer('order_id').notNull().references(() => orders.id),
        serviceDate: text('service_date').notNull(),
        /** The pharmacy's own reference, which is what they reconcile against. */
        reference: text('reference').notNull().default(''),
        pharmacy: text('pharmacy').notNull().default(''),
        /** Justifies the zone. Not a patient: no name, no street. */
        deliveryZip: text('delivery_zip').notNull().default(''),
        zone: integer('zone'),
        serviceType: text('service_type').notNull(),
        dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
        items: integer('items').notNull().default(1),
        baseCents: integer('base_cents').notNull().default(0),
        statCents: integer('stat_cents').notNull().default(0),
        afterHoursCents: integer('after_hours_cents').notNull().default(0),
        dryRunCents: integer('dry_run_cents').notNull().default(0),
        /* The instant the invoice priced against: delivered, else picked up,
         * else requested. It is the evidence for the after-hours surcharge on
         * this line, so a frozen line carries it rather than pointing at an
         * order that may since have changed. */
        performedAt: text('performed_at').notNull().default(''),
        outOfAreaMiles: real('out_of_area_miles'),
        outOfAreaCents: integer('out_of_area_cents').notNull().default(0),
        amountCents: integer('amount_cents').notNull().default(0),
        note: text('note').notNull().default(''),
    },
    (t) => [
        index('invoice_lines_invoice_idx').on(t.invoiceId),
        unique('invoice_lines_invoice_order_unique').on(t.invoiceId, t.orderId),
    ],
);

/* A correction with a reason attached. Credits are negative. Nothing is ever
 * edited into a line: an invoice that was issued and then quietly altered is
 * not an invoice, it is an argument waiting to happen. */
export const invoiceAdjustments = sqliteTable(
    'invoice_adjustments',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        invoiceId: integer('invoice_id').notNull().references(() => invoices.id),
        description: text('description').notNull(),
        amountCents: integer('amount_cents').notNull(),
        reason: text('reason').notNull().default(''),
        createdAt: text('created_at').notNull(),
        createdBy: text('created_by').notNull().default(''),
    },
    (t) => [index('invoice_adjustments_invoice_idx').on(t.invoiceId)],
);

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;

/* One row per event a courier's phone sent, keyed by the id the PHONE chose.
 *
 * A phone with no signal queues what the courier did and sends it later. The
 * dangerous case is not the missing signal, it is the ambiguous one: the
 * request reached the server, the reply did not, and the phone retries. Without
 * this table that retry is a second delivery on the same order, or a second
 * pickup, and the chain of custody is no longer a chain.
 *
 * So the phone stamps every mutation with an id it generated, and the first
 * request to claim that id wins. A retry carrying the same id is answered with
 * the first reply instead of being applied again.
 *
 * The stored reply can contain PHI, because it is the reply the courier's app
 * would have received. It is kept for CLIENT_EVENT_RETENTION_DAYS and swept,
 * rather than forever: a replay cache is useful for hours, not for years, and
 * an unbounded copy of every delivery response is a liability with no reader.
 */
export const CLIENT_EVENT_STATES = ['in_progress', 'done'] as const;

export const clientEvents = sqliteTable(
    'client_events',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** The id the phone generated. Unique within a project. */
        clientEventId: text('client_event_id').notNull(),
        /** Whose phone. A key is answered only for the user who claimed it. */
        username: text('username').notNull(),
        method: text('method').notNull().default(''),
        path: text('path').notNull().default(''),
        state: text('state', { enum: CLIENT_EVENT_STATES }).notNull().default('in_progress'),
        /** The HTTP status and body of the first reply, replayed verbatim. */
        status: integer('status'),
        response: text('response').notNull().default(''),
        createdAt: text('created_at').notNull(),
        completedAt: text('completed_at'),
    },
    (t) => [
        unique('client_events_key_unique').on(t.projectId, t.clientEventId),
        index('client_events_created_idx').on(t.createdAt),
        check('client_events_state_check', sql`${t.state} IN ('in_progress','done')`),
    ],
);

export type ClientEvent = typeof clientEvents.$inferSelect;

export const SIGNATURE_KINDS = ['pickup', 'delivery', 'return'] as const;

export const signatures = sqliteTable(
    'signatures',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        kind: text('kind', { enum: SIGNATURE_KINDS }).notNull(),
        /** Printed name, as Scope 1.2.8 requires alongside the signature. */
        signedName: text('signed_name').notNull(),
        /** JSON: [[{x,y,t},...], ...] in a 0..1 coordinate space, so the
         *  capture is independent of the phone's screen size. */
        strokes: text('strokes').notNull().default('[]'),
        /** Who captured it, where and when. */
        capturedBy: text('captured_by').notNull().default(''),
        capturedAt: text('captured_at').notNull(),
        lat: real('lat'),
        lng: real('lng'),
        createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    },
    (t) => [
        index('signatures_project_idx').on(t.projectId, t.capturedAt),
        check('signatures_kind_check', sql`${t.kind} IN ('pickup','delivery','return')`),
    ],
);

export type Signature = typeof signatures.$inferSelect;

/* Discrepancies found while the system runs alongside the manual process
 * (ticket 5.2).
 *
 * The shadow week's acceptance criterion is "every discrepancy logged and
 * fixed", and a criterion with no mechanism behind it becomes a pile of
 * messages in a group chat that nobody can count on the Friday. This is the
 * mechanism: one row per thing that did not match, raised by whoever noticed,
 * carried to a resolution or to a decision that it does not need one.
 *
 * PHI: `expected` and `actual` are free text typed by a person under time
 * pressure, so they may contain a patient's name however firmly the screen
 * asks otherwise. They are therefore treated as PHI: never logged, never put
 * in an audit detail, and covered by the same retention decision as a
 * delivery record. `orderId` is the right way to point at a delivery, and the
 * screen says so.
 */

export const DISCREPANCY_KINDS = [
    /** The list the pharmacy sent and what the import created. */
    'import',
    /** Who the system says has it, against who actually has it. */
    'assignment',
    /** What the system recorded at the door, against what happened. */
    'delivery',
    /** Times: arrival, due, or the SLA measurement itself. */
    'timing',
    /** What it would be billed, against what the manual process billed. */
    'billing',
    /** The application did something wrong, slowly, or not at all. */
    'system',
    'other',
] as const;

export const DISCREPANCY_SEVERITIES = [
    /** A delivery record is wrong or missing. Stops go-live on its own. */
    'critical',
    /** Wrong, but caught and correctable within the day. */
    'major',
    /** Awkward, confusing, or slow. Worth fixing, not worth stopping for. */
    'minor',
] as const;

export const DISCREPANCY_STATUSES = ['open', 'resolved', 'accepted'] as const;

export const discrepancies = sqliteTable(
    'discrepancies',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** The operating day it was about, not the day it was typed. */
        serviceDate: text('service_date').notNull(),
        kind: text('kind', { enum: DISCREPANCY_KINDS }).notNull(),
        severity: text('severity', { enum: DISCREPANCY_SEVERITIES }).notNull(),
        /** The delivery it concerns, when it concerns one. */
        orderId: integer('order_id'),
        /* PHI. What the system said, and what actually happened. */
        expected: text('expected').notNull(),
        actual: text('actual').notNull(),
        reportedBy: text('reported_by').notNull(),
        reportedAt: text('reported_at').notNull(),
        status: text('status', { enum: DISCREPANCY_STATUSES }).notNull().default('open'),
        /** What was done, or why nothing needed doing. PHI, same as above. */
        resolution: text('resolution').notNull().default(''),
        resolvedBy: text('resolved_by').notNull().default(''),
        resolvedAt: text('resolved_at'),
    },
    (t) => [
        index('discrepancies_project_date_idx').on(t.projectId, t.serviceDate),
        index('discrepancies_status_idx').on(t.projectId, t.status),
    ],
);

export type Discrepancy = typeof discrepancies.$inferSelect;

/* Daily SLA reports, as sent (ticket 5.3).
 *
 * Scope 1.2 requires reporting to University Health, and the report is a
 * statement about how well the contract was performed. A statement made to a
 * client is a document: "what did we tell them on the third of December" has
 * to have an answer in a year, and recomputing today's numbers from today's
 * data does not answer it, because the data will have moved.
 *
 * So the figures are frozen at the moment of sending, exactly as an issued
 * invoice freezes its lines. The row also records HOW it went, because the
 * transmission channel is not decided: an email, an attachment, a link to the
 * client portal, a printout at a meeting. Whichever it is, a person records
 * that it happened, and the record is what an audit reads.
 */

export const REPORT_CHANNELS = ['email', 'portal', 'meeting', 'other'] as const;

export const reportSends = sqliteTable(
    'report_sends',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** The operating day the report is about. */
        serviceDate: text('service_date').notNull(),
        /** JSON: the totals and rates as they stood when it was sent. */
        figures: text('figures').notNull(),
        /** Who it went to, in words. A role or a name, never a patient. */
        recipient: text('recipient').notNull(),
        channel: text('channel', { enum: REPORT_CHANNELS }).notNull(),
        note: text('note').notNull().default(''),
        sentBy: text('sent_by').notNull(),
        sentAt: text('sent_at').notNull(),
    },
    (t) => [unique('report_sends_day_unique').on(t.projectId, t.serviceDate)],
);

export type ReportSend = typeof reportSends.$inferSelect;
