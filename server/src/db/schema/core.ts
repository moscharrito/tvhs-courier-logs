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

/* Multi-factor authentication for staff (ticket 4.3).
 *
 * A password is one secret, and the people gated by these tables can read
 * every patient address in the contract, change the price schedule and issue
 * an invoice. A stolen or reused password should not be enough for that, and
 * on a system holding PHI it is the control an auditor asks about first.
 *
 * Couriers are deliberately not here. Their second factor is the enrolled
 * phone: a PIN works only from a device registered with the full password
 * (ticket 2.3), which is something-you-have plus something-you-know already.
 * Asking a courier to read a rotating code off a second device at a pharmacy
 * counter, in the rain, would be a control they would find a way around.
 */

export const mfaEnrolments = sqliteTable('mfa_enrolments', {
    /** One enrolment per person. The row existing means enrolment started. */
    userId: integer('user_id').primaryKey().references(() => users.id),
    /** The shared secret, base32. Readable by this server by necessity:
     *  TOTP is symmetric, so there is nothing to hash. It is as sensitive as
     *  a password and must never appear in a log, a response or an audit row
     *  after enrolment is confirmed. */
    secret: text('secret').notNull(),
    /** Null until a first correct code proves the app really holds the
     *  secret. An unconfirmed enrolment grants nothing and blocks nothing. */
    confirmedAt: text('confirmed_at'),
    /** The last time step accepted for this person. A code at or before it is
     *  refused, so a code seen over a shoulder cannot be replayed inside its
     *  own thirty-second window. */
    lastStep: integer('last_step').notNull().default(-1),
    createdAt: text('created_at').notNull(),
});

export type MfaEnrolment = typeof mfaEnrolments.$inferSelect;

/* Recovery codes: what a person uses when the phone is lost, broken or in a
 * drawer at home. Without them, losing a phone means an administrator has to
 * reset the enrolment, and if the person who lost it IS the administrator
 * there is nobody left to do it. */
export const mfaRecoveryCodes = sqliteTable(
    'mfa_recovery_codes',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        userId: integer('user_id').notNull().references(() => users.id),
        /** sha256 of the code, hex. Not bcrypt: these are generated with 50
         *  bits of entropy rather than chosen by a person, so there is no
         *  dictionary to slow down, and ten bcrypt comparisons per sign-in
         *  attempt would be a second of server time per guess. */
        codeHash: text('code_hash').notNull(),
        createdAt: text('created_at').notNull(),
        /** Set when spent. The row is kept so "I used one last month" has an
         *  answer, and so the count of remaining codes is honest. */
        usedAt: text('used_at'),
    },
    (t) => [index('mfa_recovery_user_idx').on(t.userId)],
);

export type MfaRecoveryCode = typeof mfaRecoveryCodes.$inferSelect;

/* The gap between "the password was right" and "the second factor was right".
 *
 * Server-side, like sessions, rather than a signed token the client carries:
 * a stateless challenge cannot be revoked, cannot count its own attempts, and
 * would let one intercepted password be replayed against the code prompt for
 * as long as its lifetime lasts.
 */
export const mfaChallenges = sqliteTable(
    'mfa_challenges',
    {
        /** sha256(token), hex. The token itself only ever exists in the reply
         *  to the password step and in the caller's next request. */
        id: text('id').primaryKey(),
        userId: integer('user_id').notNull().references(() => users.id),
        createdAt: text('created_at').notNull(),
        /** Five minutes. Long enough to find the phone, short enough that an
         *  intercepted challenge is worth little. */
        expiresAt: text('expires_at').notNull(),
        /** Set when the challenge is spent, successfully or by giving up. */
        consumedAt: text('consumed_at'),
        /** Wrong codes against this one challenge. A six-digit code has a
         *  million possibilities and a whole window to be guessed in. */
        attempts: integer('attempts').notNull().default(0),
    },
    (t) => [index('mfa_challenges_user_idx').on(t.userId)],
);

export type MfaChallenge = typeof mfaChallenges.$inferSelect;

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
