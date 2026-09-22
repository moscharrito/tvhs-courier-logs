/* How long each kind of record is kept, and who decided.
 *
 * Ticket 4.6. The engineering here is easy and the decision is not, so this
 * file separates them: the periods live in one table with the reason for each
 * beside it, and the ones nobody has decided yet are marked `decided: false`
 * rather than given a plausible-looking default that would quietly become
 * policy.
 *
 * A retention period that a developer picked is not a retention period. It is
 * a number that will be discovered during an audit, years later, attached to
 * deleted evidence. So an undecided category is swept and counted, and the
 * purge refuses it.
 *
 * WHAT DELETION MEANS HERE. Two of these tables are append-only in the
 * database, enforced by triggers (`audit_events` since migration 0004,
 * `custody_events` since 0009), because a record that can be edited after the
 * fact is not evidence. Retention and evidence pull in opposite directions
 * and the resolution is written down in `PURGE_MECHANICS` below rather than
 * discovered by whoever runs the purge first.
 */

export type RetentionCategory =
    | 'delivery_records'
    | 'proof_of_delivery_files'
    | 'signatures'
    | 'invoices'
    | 'audit_events'
    | 'client_events'
    | 'location_traces';

export interface RetentionRule {
    category: RetentionCategory;
    /** Days after the record's own date. Null when nobody has decided. */
    days: number | null;
    /** True only when a person with the authority to decide has decided. */
    decided: boolean;
    /** What it holds, in the terms the contract uses. */
    holds: string;
    /** Why this number, or why there is not one yet. */
    basis: string;
    /** Whether this job may ever delete it, once a period exists. */
    purgeable: boolean;
}

/* Seven years appears twice below as a PLACEHOLDER. It is the period Texas
 * requires of a healthcare provider for medical records, which is a different
 * question from what a courier's business associate must keep and for how
 * long. It is here so the sweep has something to count against, and it is
 * marked undecided so that nothing acts on it. */
const SEVEN_YEARS = 7 * 365;

/* Read ON EVERY ACCESS, not once at load, and that is deliberate.
 *
 * index.ts calls dotenv.config() at line 21, which is AFTER its imports have
 * already run. Those imports reach this file, so a value read at module load
 * is read before .env exists and is always null in development. The result
 * was the one state the comment on `location_traces` says cannot happen:
 * config reporting "tracking ON, 7 days" while this table still said the
 * period was undecided, so points were collected and never purged.
 *
 * Production never showed it, because Render puts the variable in the real
 * environment before node starts. A bug that only appears where it is not
 * being watched is the worst shape for this particular decision to have. */
function traceDays(): number | null {
    const raw = process.env['RETENTION_LOCATION_TRACE_DAYS'];
    if (raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 400 ? n : null;
}

export const RETENTION: Record<RetentionCategory, RetentionRule> = {
    delivery_records: {
        category: 'delivery_records',
        days: SEVEN_YEARS,
        decided: false,
        holds: 'Orders, packages and the custody events behind them: patient name, delivery address, what was carried.',
        basis: 'PLACEHOLDER. Scope 1.2.7 requires the chain of custody to be available for regulatory audit and does not say for how long. '
            + 'Needs University Health and Izy\'s compliance counsel, then the privacy and security program.',
        purgeable: true,
    },
    proof_of_delivery_files: {
        category: 'proof_of_delivery_files',
        days: SEVEN_YEARS,
        decided: false,
        holds: 'Doorstep photographs in S3. A patient\'s front door, often with their name on the package.',
        basis: 'PLACEHOLDER, and the same decision as the bucket lifecycle rule in docs/infra/s3-bucket.md, which is '
            + 'deliberately disabled for the same reason. Decide once, in both places.',
        purgeable: true,
    },
    signatures: {
        category: 'signatures',
        days: SEVEN_YEARS,
        decided: false,
        holds: 'The strokes of a signature captured at the door, and the printed name beside it.',
        basis: 'PLACEHOLDER. Scope 1.2.8 requires the signature; nothing says how long it is kept. '
            + 'Follows the delivery record it belongs to and should be decided with it.',
        purgeable: true,
    },
    invoices: {
        category: 'invoices',
        days: SEVEN_YEARS,
        decided: false,
        holds: 'Issued invoices, their lines and adjustments. No patient names; a ZIP, a reference and a charge.',
        basis: 'PLACEHOLDER. This is a financial record rather than a clinical one, so the period is likely to come from '
            + 'the contract and from tax law rather than from HIPAA. An issued invoice is a document that left the building '
            + 'and is voided, never deleted, so purging one is a records decision and not a tidy-up.',
        purgeable: false,
    },
    audit_events: {
        category: 'audit_events',
        days: null,
        decided: true,
        holds: 'Who did what: actor, action, entity, id, address. Never PHI, by construction.',
        basis: 'Kept. It holds no PHI, it is the evidence that everything else was handled correctly, and it is the only '
            + 'record that can answer a question about a deletion. Purging the audit trail to satisfy a retention policy '
            + 'would destroy the proof that the policy was followed. This job will not touch it.',
        purgeable: false,
    },
    client_events: {
        category: 'client_events',
        days: 7,
        decided: true,
        holds: 'Replies held for a phone that retried: the stored response body, which can contain a patient name.',
        basis: 'Decided, because it is not a record of anything. It exists so a courier\'s retry is answered rather than '
            + 'applied twice, and a week is far longer than any phone stays offline. Already swept automatically '
            + '(core/http/idempotency.ts).',
        purgeable: true,
    },
    location_traces: {
        category: 'location_traces',
        /* ONE SOURCE OF TRUTH with the endpoint that collects it. Setting
         * RETENTION_LOCATION_TRACE_DAYS is the decision: it makes the period
         * real here and switches tracking on there. Without it, this is
         * undecided AND nothing is collected, so the two can never disagree
         * about whether a track exists and how long it lives. */
        get days() { return traceDays(); },
        get decided() { return traceDays() !== null; },
        holds: 'Minute-by-minute positions of a courier while they were on shift (ticket 6.6). '
            + 'No patient name, but joined to orders it says which homes were visited and when.',
        basis: 'UNDECIDED, AND THE MOST IMPORTANT UNDECIDED ONE HERE. Every other category in this '
            + 'table errs toward keeping things: a delivery record is evidence and the risk is deleting '
            + 'it too early. This one is the opposite. A breadcrumb trail of an identified employee has '
            + 'almost no operational value the day after the shift, and every day it is kept is a day it '
            + 'can be subpoenaed, breached, or used for something nobody agreed to. Days, not years. '
            + 'Nothing in the contract asks for it at all, which is why it cannot be inherited from the '
            + 'delivery record. It needs a number from somebody with the authority to set one, and until '
            + 'then core/tracking refuses to accept a single point.',
        purgeable: true,
    },
};

/** The categories a sweep counts, in the order a person would read them. */
export const SWEPT: RetentionCategory[] = [
    'delivery_records', 'proof_of_delivery_files', 'signatures', 'invoices', 'audit_events', 'client_events',
    /* Swept whether or not a period has been set. While
       RETENTION_LOCATION_TRACE_DAYS is unset the endpoint collects nothing,
       so the count is zero and the sweep says so; once it is set, a declared
       period that nothing enforced would be worse than no period at all. */
    'location_traces',
];

/**
 * The awkward part, written down.
 *
 * `custody_events` is append-only, enforced by a trigger, because Scope 1.2.7
 * wants a chain of custody that is evidence rather than a table somebody can
 * tidy. Deleting a delivery record past retention means deleting its custody
 * events, which the database is built to refuse.
 *
 * The resolution is the one `clearSimulation` already uses: the trigger is
 * dropped and recreated around the delete, inside the purge, deliberately and
 * visibly, by a caller who has approved an exact count. It is not relaxed for
 * everybody, it is not relaxed for the application, and the purge writes what
 * it did to the audit trail before it does it.
 *
 * A purge that silently could not delete half of what it claimed to delete
 * would be worse than one that refuses.
 */
export const PURGE_MECHANICS = `custody_events and audit_events are append-only in the database.
The purge drops and recreates the custody trigger around its delete, the way the
simulator's cleanup does, and never touches audit_events at all.`;

export interface RetentionFinding {
    category: RetentionCategory;
    /** Rows past the period. Zero when there is no period to be past. */
    count: number;
    /** The oldest service date or timestamp found, for a person to sanity-check. */
    oldest: string | null;
    /** Null when nobody has decided a period, which is not the same as zero. */
    cutoff: string | null;
    decided: boolean;
    purgeable: boolean;
}

/** The date before which rows of this category are past retention. */
export function cutoffFor(rule: RetentionRule, now: Date): string | null {
    if (rule.days === null) return null;
    return new Date(now.getTime() - rule.days * 24 * 60 * 60 * 1000).toISOString();
}
