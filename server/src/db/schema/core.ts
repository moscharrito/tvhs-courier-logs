/* Platform core: projects and memberships.
 *
 * A project is one courier contract (tvhs, uh). A membership gives a user a
 * role inside one project. Every project-scoped table carries project_id and
 * every project-scoped request is checked against memberships (requireProject
 * in server.js, moving to src/core/projects in a later ticket).
 *
 * users stays in tvhs.ts until ticket 0.7 turns it into the platform user
 * directory; memberships already reference it. */

import { sqliteTable, integer, text, real, unique, check, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './tvhs';

/* Three, since ticket 5.12, because three is how many kinds of person
 * actually exist on this contract:
 *
 *   admin     runs the operation. Imports the lists, works the board, edits
 *             the rate card, issues the invoices. Was three roles (admin,
 *             ops_manager, dispatcher) whose boundaries nobody could state
 *             out loud, and which mattered most in a two-person company by
 *             making somebody ask an administrator to do a five-second job.
 *   courier   drives. Sees their own run and nothing else.
 *   pharmacy  the University Health contact. Sees their own pharmacy's
 *             deliveries and nothing else. Was called client_viewer.
 *
 * The consolidation gave the people who were dispatchers the power to change
 * the price schedule and issue an invoice, which they did not have before.
 * That is the trade, and it is on the record in docs/build-backlog.md. */
export const PROJECT_ROLES = ['admin', 'courier', 'pharmacy'] as const;
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
        check('memberships_role_check', sql`${t.role} IN ('admin','courier','pharmacy')`),
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
        /** The registered device this session was started from (ticket 2.3).
         *  Null for a browser that was never enrolled, which is every staff
         *  sign-in. Revoking a device revokes its live sessions with it. */
        deviceId: text('device_id'),
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

/* Registered courier devices (ticket 2.3).
 *
 * A four-digit PIN is not an authentication factor on its own: ten thousand
 * possibilities is a number a person can work through. It is only acceptable
 * as the second half of "this phone, plus a PIN", which is what this table
 * makes possible. Enrolling a phone needs the courier's full password once;
 * after that the phone identifies who is signing in and the PIN proves it is
 * them holding it.
 *
 * The row id is the SHA-256 of the device token, exactly as sessions are, so
 * a copy of this table cannot be replayed as a device.
 *
 * A courier's phone is personal property that will be lost, sold and handed
 * on, so revoking has to be immediate and has to be visible: revoked_at is
 * set rather than the row being deleted, and the courier and an admin can
 * both see the list.
 */
export const devices = sqliteTable(
    'devices',
    {
        /** sha256(token), hex. The token itself lives only in the cookie. */
        id: text('id').primaryKey(),
        userId: integer('user_id').notNull().references(() => users.id),
        /** What the courier calls it: "Ada's phone". Never a serial number. */
        label: text('label').notNull().default(''),
        /** Short description derived from the user agent, for recognition. */
        userAgent: text('user_agent').notNull().default(''),
        /**
         * bcrypt of the PIN that signs in on THIS phone, and nowhere else.
         *
         * It lived on users.pin until ticket 5.8, shared with the route PIN
         * the legacy TVHS quick-login is keyed on. One column meant enrolling
         * a phone silently rewrote the route PIN, which is accepted from any
         * device: a four-digit secret whose whole justification is that it
         * only works on the phone it was set on became one that worked
         * everywhere. It also meant a second phone changed the first one's
         * PIN, and that an administrator resetting somebody's PIN set what
         * their phone expected.
         */
        pin: text('pin'),
        createdAt: text('created_at').notNull(),
        lastSeenAt: text('last_seen_at').notNull(),
        /** Set on revocation; the row is kept so the history stays readable. */
        revokedAt: text('revoked_at'),
        revokedBy: text('revoked_by').notNull().default(''),
    },
    (t) => [index('devices_user_id_idx').on(t.userId)],
);

export type Device = typeof devices.$inferSelect;

/* Stored files (ticket 1.8).
 *
 * The bytes live in S3 under a signed URL; this table is what the platform
 * knows about them. Without it the only way to find out what exists would be
 * to list the bucket, which is slow, unscoped, and would hand any caller a
 * directory of every proof of delivery in the project.
 *
 * A row is created before the upload and marked stored afterwards, because
 * the browser PUTs straight to S3 and the server never sees the bytes. A
 * pending row whose upload never happened is an orphan; the bucket lifecycle
 * rule in docs/infra/s3-bucket.md expires those.
 *
 * PHI: a doorstep photo shows a patient's front door and often their name on
 * a package. The key is scoped by project, date and order so that access can
 * be reasoned about, and no URL to it is ever valid for longer than five
 * minutes.
 */

export const FILE_KINDS = ['doorstep', 'pod', 'exception', 'signature'] as const;
export const FILE_STATUSES = ['pending', 'stored'] as const;

export const files = sqliteTable(
    'files',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        /** The delivery it belongs to. Null for anything not about one order. */
        orderId: integer('order_id'),
        kind: text('kind', { enum: FILE_KINDS }).notNull(),
        /** project/date/order/kind/uuid.ext. Built by the server, never by a client. */
        s3Key: text('s3_key').notNull(),
        contentType: text('content_type').notNull(),
        bytes: integer('bytes').notNull().default(0),
        status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),
        uploadedBy: text('uploaded_by').notNull().default(''),
        createdAt: text('created_at').notNull(),
        storedAt: text('stored_at'),
    },
    (t) => [
        unique('files_key_unique').on(t.s3Key),
        index('files_order_idx').on(t.orderId),
        index('files_project_status_idx').on(t.projectId, t.status),
        check('files_kind_check', sql`${t.kind} IN ('doorstep','pod','exception','signature')`),
        check('files_status_check', sql`${t.status} IN ('pending','stored')`),
    ],
);

export type StoredFile = typeof files.$inferSelect;

/* Multi-factor authentication for staff was here, tickets 4.3 and 5.10.
 *
 * Three tables, a TOTP implementation and an enrolment screen, removed on the
 * owner's decision: a second factor was judged too much friction for the size
 * of this operation. Staff sign in with a username and a password; couriers
 * keep the device-bound PIN from ticket 2.3, which never involved TOTP and is
 * unchanged.
 *
 * Migration 0027 drops mfa_enrolments, mfa_recovery_codes and mfa_challenges.
 * The argument for having them is on the record in docs/security-review-2026-09-13.md
 * and the decision to remove them in docs/build-backlog.md, so whoever asks
 * "was this considered" gets both halves of the answer.
 */

/* Retention sweeps and purges (ticket 4.6).
 *
 * Evidence that the job ran, and evidence of what a purge removed. The audit
 * trail records who approved a purge and why; this table records the counts,
 * which are too large and too structured to belong in an audit detail blob.
 *
 * A sweep writes a row whether or not it found anything. "Nothing was past
 * retention on 3 November" is exactly the kind of thing an auditor asks for
 * and exactly the kind of thing nobody can prove after the fact.
 */

export const RETENTION_RUN_KINDS = ['sweep', 'purge'] as const;

export const retentionRuns = sqliteTable(
    'retention_runs',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        kind: text('kind', { enum: RETENTION_RUN_KINDS }).notNull(),
        ranAt: text('ran_at').notNull(),
        /** 'scheduled' for the timer, or the username who asked for it. */
        startedBy: text('started_by').notNull(),
        /** Null for a sweep, which covers every category at once. */
        category: text('category'),
        /** JSON: the per-category findings for a sweep, the counts for a purge. */
        detail: text('detail').notNull().default('{}'),
        /** Rows found past retention (sweep), or actually removed (purge). */
        rowCount: integer('row_count').notNull().default(0),
        /** Why this purge was approved. Empty for a sweep. */
        reason: text('reason').notNull().default(''),
    },
    (t) => [index('retention_runs_ran_at_idx').on(t.ranAt)],
);

export type RetentionRun = typeof retentionRuns.$inferSelect;

/* Geocoding results, cached (ticket 1.4).
 *
 * The obvious reason is money: the same nine pharmacies would otherwise be
 * looked up once per delivery. The reason that matters is that every lookup
 * is a disclosure to a third party, and a cached answer is a disclosure that
 * does not happen a second time.
 *
 * `scope` records what kind of address this was, so a question nobody can
 * answer later ("did we ever send patient addresses to Google?") has an
 * answer in the data rather than in somebody's memory.
 *
 * The key is the normalised address and never a patient name, an order id or
 * a delivery note. A row here is an address and a point: the same pair the
 * postal service holds.
 */

export const GEO_SCOPES = ['site', 'patient'] as const;
export const GEOCODE_QUALITIES = ['rooftop', 'interpolated', 'centroid', 'approximate'] as const;

export const geocodes = sqliteTable(
    'geocodes',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        /** Normalised address. See addressKey in core/geo/provider.ts. */
        addressKey: text('address_key').notNull(),
        scope: text('scope', { enum: GEO_SCOPES }).notNull(),
        lat: real('lat').notNull(),
        lng: real('lng').notNull(),
        quality: text('quality', { enum: GEOCODE_QUALITIES }).notNull(),
        /** What the provider believed the address to be. */
        formatted: text('formatted').notNull().default(''),
        /** Which provider answered, so a bad batch can be found and redone. */
        provider: text('provider').notNull(),
        lookedUpAt: text('looked_up_at').notNull(),
    },
    (t) => [unique('geocodes_key_unique').on(t.addressKey)],
);

export type Geocode = typeof geocodes.$inferSelect;

/* How many lookups have been made today, per provider.
 *
 * A geocoding bill is one runaway loop away from being a surprise, and the
 * loop that causes it is always a retry. This is the guard the ticket asks
 * for: a hard daily ceiling, counted in the database so it survives a restart
 * and is shared by however many instances there are.
 */
export const geoUsage = sqliteTable(
    'geo_usage',
    {
        /** provider + local date, so the count resets with the day. */
        id: text('id').primaryKey(),
        provider: text('provider').notNull(),
        day: text('day').notNull(),
        lookups: integer('lookups').notNull().default(0),
        /** Refused because the ceiling was reached, which is worth knowing. */
        refused: integer('refused').notNull().default(0),
    },
    (t) => [index('geo_usage_day_idx').on(t.day)],
);

export type GeoUsage = typeof geoUsage.$inferSelect;

/* ------------------------------------------------- the courier network
 *
 * Tickets 6.1 and 6.2. Twenty drivers signing themselves up is a compliance
 * problem before it is a feature, so signup produces an APPLICATION and never
 * an account. The rule that stands between a submitted form and a patient's
 * address is in core/onboarding/clearance.ts, deliberately as a pure function
 * over these two tables rather than as a screen that declines to draw.
 */

export const APPLICATION_STATUSES = ['submitted', 'in_review', 'approved', 'rejected', 'withdrawn'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const driverApplications = sqliteTable(
    'driver_applications',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        projectId: integer('project_id').notNull().references(() => projects.id),
        name: text('name').notNull(),
        email: text('email').notNull(),
        phone: text('phone').notNull(),
        /** What the applicant said about themselves. Verified by nothing, and
         *  named so that nobody mistakes it for a fact. */
        claims: text('claims').notNull().default(''),
        status: text('status', { enum: APPLICATION_STATUSES }).notNull().default('submitted'),
        submittedAt: text('submitted_at').default(sql`CURRENT_TIMESTAMP`),
        decidedAt: text('decided_at'),
        decidedBy: text('decided_by').notNull().default(''),
        /** Required on a rejection. A rejection nobody can explain later is a
         *  rejection somebody will have to defend later. */
        decisionReason: text('decision_reason').notNull().default(''),
        /** Null until approval creates the account. That null IS ticket 6.1:
         *  an application is not an account and cannot sign in to anything. */
        userId: integer('user_id').references(() => users.id),
    },
    (t) => [
        index('driver_applications_project_idx').on(t.projectId),
        index('driver_applications_status_idx').on(t.status),
        check(
            'driver_applications_status_check',
            sql`${t.status} IN ('submitted','in_review','approved','rejected','withdrawn')`,
        ),
    ],
);

export type DriverApplication = typeof driverApplications.$inferSelect;

/* One row per (application, requirement). The document itself is never here:
 * this records that a named person saw it, when, and what it was called. A
 * background check report in a courier database is a second breach waiting
 * for the first one. */
export const onboardingChecks = sqliteTable(
    'onboarding_checks',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        applicationId: integer('application_id').notNull().references(() => driverApplications.id),
        kind: text('kind').notNull(),
        status: text('status').notNull().default('pending'),
        verifiedBy: text('verified_by').notNull().default(''),
        verifiedAt: text('verified_at'),
        /** A certificate number, a vendor's report id. A pointer, not a copy. */
        reference: text('reference').notNull().default(''),
        /** YYYY-MM-DD. Training three years old is a filename, not training. */
        expiresAt: text('expires_at'),
        note: text('note').notNull().default(''),
    },
    (t) => [
        unique('onboarding_checks_application_kind_unique').on(t.applicationId, t.kind),
        index('onboarding_checks_application_idx').on(t.applicationId),
        check('onboarding_checks_status_check', sql`${t.status} IN ('pending','verified','failed')`),
        check(
            'onboarding_checks_kind_check',
            sql`${t.kind} IN ('hipaa_training','confidentiality','background_check','drivers_licence','insurance')`,
        ),
    ],
);

export type OnboardingCheck = typeof onboardingChecks.$inferSelect;
