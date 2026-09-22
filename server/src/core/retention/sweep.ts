/* Finding what is past retention, and removing it only when told to.
 *
 * Ticket 4.6. Two operations with deliberately different characters.
 *
 * The SWEEP counts and writes down what it found. It runs on a schedule, it
 * never deletes anything, and it writes a row whether or not it found
 * anything, because "nothing was past retention on 3 November" is what an
 * auditor asks for and what nobody can prove afterwards.
 *
 * The PURGE deletes, and it is hard to trigger by accident on purpose: it
 * takes a category, a reason, and the exact number of rows the caller expects
 * to remove. If the count has moved since they looked, it refuses. That is
 * the manual approval the ticket asks for, in a form that survives being
 * pasted into a shell at the wrong moment.
 */

import type { Client } from '@libsql/client';
import {
    RETENTION, SWEPT, cutoffFor,
    type RetentionCategory, type RetentionFinding,
} from './policy';

const iso = (d: Date) => d.toISOString();

/* Each category knows how to count itself and how to name its oldest row.
 * `cutoff` is an ISO timestamp; service dates are YYYY-MM-DD and compare
 * correctly against its first ten characters. */
interface Counter {
    count(client: Client, cutoff: string): Promise<{ count: number; oldest: string | null }>;
}

const COUNTERS: Record<RetentionCategory, Counter | null> = {
    delivery_records: {
        async count(client, cutoff) {
            const rs = await client.execute({
                sql: `SELECT COUNT(*) AS n, MIN(service_date) AS oldest FROM orders WHERE service_date < ?`,
                args: [cutoff.slice(0, 10)],
            });
            return { count: Number(rs.rows[0]?.['n'] ?? 0), oldest: (rs.rows[0]?.['oldest'] as string | null) ?? null };
        },
    },
    proof_of_delivery_files: {
        async count(client, cutoff) {
            const rs = await client.execute({
                sql: `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM files WHERE created_at < ?`,
                args: [cutoff],
            });
            return { count: Number(rs.rows[0]?.['n'] ?? 0), oldest: (rs.rows[0]?.['oldest'] as string | null) ?? null };
        },
    },
    /* Counted like everything else, and it will report a growing pile until
       somebody decides how long a breadcrumb trail is kept. That pile showing
       up in the sweep is the point: an undecided period is visible rather
       than quietly becoming "forever". */
    location_traces: {
        async count(client, cutoff) {
            const rs = await client.execute({
                sql: `SELECT COUNT(*) AS n, MIN(at) AS oldest FROM shift_positions WHERE at < ?`,
                args: [cutoff],
            });
            return { count: Number(rs.rows[0]?.['n'] ?? 0), oldest: (rs.rows[0]?.['oldest'] as string | null) ?? null };
        },
    },
    signatures: {
        async count(client, cutoff) {
            const rs = await client.execute({
                sql: `SELECT COUNT(*) AS n, MIN(captured_at) AS oldest FROM signatures WHERE captured_at < ?`,
                args: [cutoff],
            });
            return { count: Number(rs.rows[0]?.['n'] ?? 0), oldest: (rs.rows[0]?.['oldest'] as string | null) ?? null };
        },
    },
    invoices: {
        async count(client, cutoff) {
            const rs = await client.execute({
                sql: `SELECT COUNT(*) AS n, MIN(period_to) AS oldest FROM invoices WHERE period_to < ?`,
                args: [cutoff.slice(0, 10)],
            });
            return { count: Number(rs.rows[0]?.['n'] ?? 0), oldest: (rs.rows[0]?.['oldest'] as string | null) ?? null };
        },
    },
    // Kept, so there is nothing to count. See the policy for why.
    audit_events: null,
    client_events: {
        async count(client, cutoff) {
            const rs = await client.execute({
                sql: `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM client_events WHERE created_at < ?`,
                args: [cutoff],
            });
            return { count: Number(rs.rows[0]?.['n'] ?? 0), oldest: (rs.rows[0]?.['oldest'] as string | null) ?? null };
        },
    },
};

export interface SweepResult {
    ranAt: string;
    findings: RetentionFinding[];
    /** Rows past retention across every category. */
    totalFlagged: number;
}

/**
 * Count what is past retention. Writes nothing but the run record.
 *
 * A category with no decided period still gets counted against its
 * placeholder, so the size of the eventual decision is visible before anybody
 * has to make it. `decided: false` travels with the number so nothing can act
 * on it by mistake.
 */
export async function sweep(
    client: Client,
    { now = new Date(), startedBy = 'scheduled', record = true }: { now?: Date; startedBy?: string; record?: boolean } = {},
): Promise<SweepResult> {
    const findings: RetentionFinding[] = [];

    for (const category of SWEPT) {
        const rule = RETENTION[category];
        const counter = COUNTERS[category];
        const cutoff = cutoffFor(rule, now);

        if (!counter || cutoff === null) {
            findings.push({ category, count: 0, oldest: null, cutoff, decided: rule.decided, purgeable: rule.purgeable });
            continue;
        }
        const { count, oldest } = await counter.count(client, cutoff);
        findings.push({ category, count, oldest, cutoff, decided: rule.decided, purgeable: rule.purgeable });
    }

    const totalFlagged = findings.reduce((sum, f) => sum + f.count, 0);

    if (record) {
        await client.execute({
            sql: `INSERT INTO retention_runs (kind, ran_at, started_by, category, detail, row_count, reason)
                  VALUES ('sweep', ?, ?, NULL, ?, ?, '')`,
            args: [iso(now), startedBy, JSON.stringify(findings), totalFlagged],
        });
    }

    return { ranAt: iso(now), findings, totalFlagged };
}

/** The most recent sweep, for the screen and for "when did this last run". */
export async function lastSweep(client: Client): Promise<{ ranAt: string; findings: RetentionFinding[]; totalFlagged: number } | null> {
    const rs = await client.execute(
        `SELECT ran_at, detail, row_count FROM retention_runs WHERE kind = 'sweep' ORDER BY id DESC LIMIT 1`,
    );
    const row = rs.rows[0];
    if (!row) return null;
    let findings: RetentionFinding[] = [];
    try { findings = JSON.parse(String(row['detail'])) as RetentionFinding[]; } catch { findings = []; }
    return { ranAt: String(row['ran_at']), findings, totalFlagged: Number(row['row_count']) };
}

/* ------------------------------------------------------------- the purge */

export type PurgeRefusal =
    | { ok: false; reason: 'undecided'; message: string }
    | { ok: false; reason: 'not_purgeable'; message: string }
    | { ok: false; reason: 'count_moved'; message: string; actual: number }
    | { ok: false; reason: 'files_unavailable'; message: string };

export interface PurgeResult {
    ok: true;
    category: RetentionCategory;
    removed: number;
    /** What the delete touched, table by table, for the run record. */
    detail: Record<string, number>;
}

export interface PurgeOptions {
    category: RetentionCategory;
    /** Exactly what the caller expects to remove. A mismatch refuses. */
    expected: number;
    reason: string;
    startedBy: string;
    now?: Date;
    /** Removes the object behind a file row. Absent when there is no bucket. */
    deleteObject?: ((key: string) => Promise<void>) | undefined;
}

/**
 * Remove one category's expired rows, if everything lines up.
 *
 * Refuses when: nobody has decided the period; the category is one this job
 * may never delete; the count has moved since the caller looked; or the
 * category is files and there is no bucket to delete from, in which case
 * deleting the rows would leave the photographs in place with nothing left
 * pointing at them.
 */
export async function purge(client: Client, options: PurgeOptions): Promise<PurgeResult | PurgeRefusal> {
    const { category, expected, reason, startedBy, now = new Date(), deleteObject } = options;
    const rule = RETENTION[category];

    if (!rule.decided) {
        return {
            ok: false,
            reason: 'undecided',
            message: `No retention period has been decided for ${category}. ${rule.basis}`,
        };
    }
    if (!rule.purgeable) {
        return { ok: false, reason: 'not_purgeable', message: `${category} is never purged by this job. ${rule.basis}` };
    }

    const cutoff = cutoffFor(rule, now);
    if (cutoff === null) {
        return { ok: false, reason: 'undecided', message: `No retention period is set for ${category}.` };
    }

    const counter = COUNTERS[category];
    if (!counter) return { ok: false, reason: 'not_purgeable', message: `${category} has nothing to count.` };
    const { count: actual } = await counter.count(client, cutoff);

    if (actual !== expected) {
        return {
            ok: false,
            reason: 'count_moved',
            actual,
            message: `Approved ${expected} rows, found ${actual}. Look again before approving: the number moving means `
                + 'either time has passed or something else is writing.',
        };
    }
    if (actual === 0) {
        return { ok: true, category, removed: 0, detail: {} };
    }

    const detail: Record<string, number> = {};

    if (category === 'proof_of_delivery_files') {
        if (!deleteObject) {
            return {
                ok: false,
                reason: 'files_unavailable',
                message: 'There is no bucket configured, so the photographs cannot be deleted. Removing the rows would '
                    + 'leave the objects in S3 with nothing pointing at them, which is worse than keeping both. Needs ticket 0.10.',
            };
        }
        const rs = await client.execute({
            sql: 'SELECT id, s3_key FROM files WHERE created_at < ?',
            args: [cutoff],
        });
        let removed = 0;
        for (const row of rs.rows) {
            /* The object first, then the row. The other order loses the key
               and with it any way to find the object again. A failure here
               stops the purge with the rows that are already gone recorded. */
            await deleteObject(String(row['s3_key']));
            await client.execute({ sql: 'DELETE FROM files WHERE id = ?', args: [Number(row['id'])] });
            removed += 1;
        }
        detail['files'] = removed;
        await recordPurge(client, { category, startedBy, reason, now, removed, detail });
        return { ok: true, category, removed, detail };
    }

    if (category === 'client_events') {
        const rs = await client.execute({ sql: 'DELETE FROM client_events WHERE created_at < ?', args: [cutoff] });
        detail['client_events'] = rs.rowsAffected;
        await recordPurge(client, { category, startedBy, reason, now, removed: rs.rowsAffected, detail });
        return { ok: true, category, removed: rs.rowsAffected, detail };
    }

    /* No trigger guards this table and nothing references it, so the rows go
       on their own. A track is not evidence of a delivery: the custody event
       is, and that is a separate category with a separate period. */
    if (category === 'location_traces') {
        const rs = await client.execute({ sql: 'DELETE FROM shift_positions WHERE at < ?', args: [cutoff] });
        detail['shift_positions'] = rs.rowsAffected;
        await recordPurge(client, { category, startedBy, reason, now, removed: rs.rowsAffected, detail });
        return { ok: true, category, removed: rs.rowsAffected, detail };
    }

    if (category === 'signatures') {
        const rs = await client.execute({ sql: 'DELETE FROM signatures WHERE captured_at < ?', args: [cutoff] });
        detail['signatures'] = rs.rowsAffected;
        await recordPurge(client, { category, startedBy, reason, now, removed: rs.rowsAffected, detail });
        return { ok: true, category, removed: rs.rowsAffected, detail };
    }

    // delivery_records: the order and everything hanging off it.
    const day = cutoff.slice(0, 10);
    const ids = (await client.execute({ sql: 'SELECT id FROM orders WHERE service_date < ?', args: [day] }))
        .rows.map((r) => Number(r['id']));

    /* custody_events is append-only, enforced by a trigger (migration 0009),
     * because a chain of custody that can be edited is not evidence. The
     * trigger is dropped and recreated around this delete, deliberately and
     * visibly, exactly as the simulator's cleanup does. It is never relaxed
     * for the application, only for a purge somebody approved by count. */
    await client.execute('DROP TRIGGER IF EXISTS custody_events_no_delete');
    try {
        for (const chunk of chunks(ids, 200)) {
            const list = chunk.map(() => '?').join(',');
            detail['custody_events'] = (detail['custody_events'] ?? 0)
                + (await client.execute({ sql: `DELETE FROM custody_events WHERE order_id IN (${list})`, args: chunk })).rowsAffected;
            detail['run_stops'] = (detail['run_stops'] ?? 0)
                + (await client.execute({ sql: `DELETE FROM run_stops WHERE order_id IN (${list})`, args: chunk })).rowsAffected;
            detail['packages'] = (detail['packages'] ?? 0)
                + (await client.execute({ sql: `DELETE FROM packages WHERE order_id IN (${list})`, args: chunk })).rowsAffected;
            detail['orders'] = (detail['orders'] ?? 0)
                + (await client.execute({ sql: `DELETE FROM orders WHERE id IN (${list})`, args: chunk })).rowsAffected;
        }
    } finally {
        await client.execute(`CREATE TRIGGER IF NOT EXISTS custody_events_no_delete BEFORE DELETE ON custody_events
BEGIN
	SELECT RAISE(ABORT, 'custody_events is append-only');
END`);
    }

    const removed = detail['orders'] ?? 0;
    await recordPurge(client, { category, startedBy, reason, now, removed, detail });
    return { ok: true, category, removed, detail };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
    for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

async function recordPurge(
    client: Client,
    args: { category: RetentionCategory; startedBy: string; reason: string; now: Date; removed: number; detail: Record<string, number> },
): Promise<void> {
    await client.execute({
        sql: `INSERT INTO retention_runs (kind, ran_at, started_by, category, detail, row_count, reason)
              VALUES ('purge', ?, ?, ?, ?, ?, ?)`,
        args: [iso(args.now), args.startedBy, args.category, JSON.stringify(args.detail), args.removed, args.reason],
    });
}

/* --------------------------------------------------------- the schedule */

/** A day. The sweep is a counting job; running it oftener tells nobody more. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs the sweep at boot and once a day after that.
 *
 * There is no cron in this application and adding one for a counting job
 * would be a piece of infrastructure to operate. The timer is unref'd, so it
 * never holds the process open, and a Render instance that sleeps simply
 * sweeps when it wakes. The run record is what proves it happened, so a
 * missed day is visible rather than assumed.
 */
export function startRetentionSweep(client: Client, onError: (err: unknown) => void = () => {}): () => void {
    const run = () => { void sweep(client).catch(onError); };
    run();
    const timer = setInterval(run, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}
