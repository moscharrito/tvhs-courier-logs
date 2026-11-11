/* Removing orders and everything that points at them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE.
 *
 * It was the back half of "delete a list" in modules/uh/imports.ts and
 * nothing else could reach it. Deleting ONE order -- the ad hoc call taken
 * for the wrong pharmacy, the STAT typed twice -- needs the identical dance
 * for a list of length one, and the comment on CHILDREN_BY_ORDER says
 * exactly why a second copy of it would be a bad idea:
 *
 *     "Listed rather than discovered, so adding a table that references
 *      orders and forgetting this list is a failed DELETE in a test rather
 *      than a row left pointing at nothing in production."
 *
 * Two copies of that list is the forgetting, built in. So there is one, and
 * both callers use it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE POLICY, SET ON 4 NOVEMBER AND UNCHANGED HERE.
 *
 * This DELETES. It does not cancel. A deleted order is gone from
 * everywhere, including one a courier collected, delivered, photographed
 * and got signed for, and including one already on an invoice that has been
 * issued. There is no undo and nothing to restore from.
 *
 * WHAT SURVIVES IS THE AUDIT ROW. audit_events is never touched here, so
 * the record that something was deleted -- by whom, when, and how much went
 * with it -- outlives the data. That is the difference between a deletion
 * and a disappearance. Every caller must write one; this module cannot,
 * because it does not know what the caller was asked to do.
 *
 * THE TRIGGERS COME BACK IN A `finally`. custody_events and order_messages
 * are append-only by database trigger. The protection is never relaxed for
 * the application, only for an operation somebody asked for. The residual
 * risk is real and unchanged: a process killed between the DROP and the
 * CREATE leaves the evidence tables unprotected until the next deploy runs
 * migrations again. It is a narrow window, it is the price of the
 * instruction, and it is written down rather than discovered.
 *
 * ORDER MATTERS, children first: SQLite enforces the foreign keys, so a
 * parent deleted before its children fails the whole statement and leaves
 * half the work done.
 */

import type { Client, InValue } from '@libsql/client';
import type { FileStorage } from '../../core/files/storage';
import { deleteFromBucket } from '../../core/retention/routes';

/* Everything that points at an order, children first.
 *
 * Listed rather than discovered, so adding a table that references orders
 * and forgetting this list is a failed DELETE in a test rather than a row
 * left pointing at nothing in production. The two guarded tables are first
 * because they are the ones the triggers protect and the window they are
 * unprotected for should be as short as the work allows. */
export const CHILDREN_BY_ORDER = [
    'order_messages',
    'custody_events',
    'patient_messages',
    'delivery_requests',
    'discrepancies',
    'invoice_lines',
    'notifications',
    'run_stops',
    'packages',
    'daily_list_rows',
] as const;

export const APPEND_ONLY = [
    { table: 'custody_events', trigger: 'custody_events_no_delete' },
    { table: 'order_messages', trigger: 'order_messages_no_delete' },
] as const;

/* The same DDL the migrations and the retention purge use. Kept here beside
   the DROP so the two cannot drift into a trigger that is recreated with a
   different body than the one migration 0009 installed. */
const RECREATE: Record<string, string> = {
    custody_events_no_delete: `CREATE TRIGGER IF NOT EXISTS custody_events_no_delete BEFORE DELETE ON custody_events
BEGIN
\tSELECT RAISE(ABORT, 'custody_events is append-only');
END`,
    order_messages_no_delete: `CREATE TRIGGER IF NOT EXISTS order_messages_no_delete BEFORE DELETE ON order_messages
BEGIN
\tSELECT RAISE(ABORT, 'order_messages is append-only');
END`,
};

/** What was found before any of it went, and what went. */
export interface OrderRemoval {
    /** Rows actually deleted from `orders`. */
    removed: number;
    /** S3 keys that were attached. Rows are gone; the objects are not yet. */
    fileKeys: string[];
    /** How many were in each status, counted BEFORE the delete. */
    byStatus: Record<string, number>;
    /** Runs that held any of this work, read before the stops went. */
    touchedRuns: number[];
}

/**
 * Delete these orders and everything that references them.
 *
 * ROWS ONLY. The bucket is a separate call, because it has to happen after
 * the rows and must never be fatal -- see removeObjects.
 *
 * The caller is responsible for deciding WHETHER these ids may be deleted:
 * this does no scoping and no permission check, and will happily remove an
 * order from any project it is given.
 */
export async function deleteOrders(
    client: Client,
    projectId: number,
    ids: readonly number[],
): Promise<OrderRemoval> {
    if (ids.length === 0) {
        return { removed: 0, fileKeys: [], byStatus: {}, touchedRuns: [] };
    }
    const marks = ids.map(() => '?').join(',');

    /* Counted before anything goes, because afterwards there is nothing left
       to count and the audit row is the only account of what this removed. */
    const statusRs = await client.execute({
        sql: `SELECT status FROM orders WHERE project_id = ? AND id IN (${marks})`,
        args: [projectId, ...ids],
    });
    const byStatus: Record<string, number> = {};
    for (const r of statusRs.rows) {
        const k = String(r['status']);
        byStatus[k] = (byStatus[k] ?? 0) + 1;
    }

    /* WHICH RUNS HELD THIS WORK, read before the stops go: afterwards
       nothing says which runs they were on. */
    const held = await client.execute({
        sql: `SELECT DISTINCT run_id FROM run_stops WHERE project_id = ? AND order_id IN (${marks})`,
        args: [projectId, ...ids],
    });
    const touchedRuns = held.rows.map((r) => Number(r['run_id']));

    /* THE PHOTOGRAPHS. The rows go with everything else below; the objects
       in the bucket would not, and a deleted delivery whose identity
       photograph is still sitting in S3 is the opposite of what was asked
       for. Keys are read now and the objects removed after the rows, so a
       failure to reach S3 cannot leave a row pointing at an object that is
       already gone. */
    const fileRs = await client.execute({
        sql: `SELECT s3_key FROM files WHERE project_id = ? AND order_id IN (${marks})`,
        args: [projectId, ...ids],
    });
    const fileKeys = fileRs.rows.map((f) => String(f['s3_key']));

    let removed = 0;
    for (const { trigger } of APPEND_ONLY) {
        await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    try {
        for (const table of CHILDREN_BY_ORDER) {
            await client.execute({
                sql: `DELETE FROM ${table} WHERE order_id IN (${marks})`,
                args: ids as InValue[],
            });
        }
        await client.execute({
            sql: `DELETE FROM files WHERE project_id = ? AND order_id IN (${marks})`,
            args: [projectId, ...ids],
        });
        /* A second go at one of these deliveries is its own order on its own
           list. It keeps existing; it just stops claiming to be a reattempt
           of a row that is not there. */
        await client.execute({
            sql: `UPDATE orders SET reattempt_of_order_id = NULL WHERE reattempt_of_order_id IN (${marks})`,
            args: ids as InValue[],
        });
        const gone = await client.execute({
            sql: `DELETE FROM orders WHERE project_id = ? AND id IN (${marks})`,
            args: [projectId, ...ids],
        });
        removed = Number(gone.rowsAffected ?? 0);
    } finally {
        /* ALWAYS. A delete that threw halfway must not also leave the
           evidence tables writable. */
        for (const { trigger } of APPEND_ONLY) {
            await client.execute(RECREATE[trigger]!);
        }
    }

    return { removed, fileKeys, byStatus, touchedRuns };
}

/**
 * Delete any of these runs that this emptied.
 *
 * A PLANNED run left with no stops is a round nobody is doing. Only the ones
 * it emptied, and only planned ones: a started run is a thing that happened,
 * and deleting it would remove the record that a courier went out.
 */
export async function emptyPlannedRuns(
    client: Client,
    projectId: number,
    runIds: readonly number[],
): Promise<number> {
    if (runIds.length === 0) return 0;
    const marks = runIds.map(() => '?').join(',');
    const emptied = await client.execute({
        sql: `DELETE FROM runs
               WHERE project_id = ? AND status = 'planned' AND id IN (${marks})
                 AND id NOT IN (SELECT run_id FROM run_stops)`,
        args: [projectId, ...runIds],
    });
    return Number(emptied.rowsAffected ?? 0);
}

/**
 * Remove the objects, after the rows and after the audit row.
 *
 * NEVER FATAL. The record is already gone; a network blip reaching S3 must
 * not turn a completed delete into a 500 that invites somebody to press it
 * again. Orphans are findable by key prefix and the lifecycle rule collects
 * them. The caller is told how many the bucket kept, which is the number
 * somebody would need to go and look for.
 */
export async function removeObjects(
    storage: FileStorage,
    keys: readonly string[],
): Promise<{ filesRemoved: number; filesLeftBehind: number }> {
    if (!storage.available) return { filesRemoved: 0, filesLeftBehind: keys.length };
    let filesRemoved = 0;
    let filesLeftBehind = 0;
    for (const key of keys) {
        try {
            await deleteFromBucket(storage, key);
            filesRemoved += 1;
        } catch {
            filesLeftBehind += 1;
        }
    }
    return { filesRemoved, filesLeftBehind };
}

/* ───────────────────────────────── the guard, added 11 November ──────────
 *
 * WHAT HAPPENED. On 9 November between 12:06:41 and 12:12:12 UTC, twenty-
 * five daily lists were deleted. Five hundred and some deliveries went with
 * them, across the 5th, 6th, 7th and 8th, and the drivers found out when
 * their completed work vanished from their phones. Recovering it took a
 * point-in-time branch of the database, two scripts, and most of two days,
 * and the proof-of-delivery photographs are still only alive because S3
 * keeps noncurrent versions for thirty days.
 *
 * Twenty-five lists in three hundred and thirty-one seconds is thirteen
 * seconds each. Nobody read anything. The dialog was one `confirm()` and
 * `confirm()` is a reflex, not a decision.
 *
 * WHAT THIS DOES NOT DO. It does not make the delete reversible and it does
 * not take it away from dispatch. Deleting a bad import is the right call
 * and it is made constantly -- on the 9th and 10th alone, ten lists and two
 * hundred and seventeen deliveries were deleted, every one of them still
 * `assigned`, `ready` or empty, all of it correct housekeeping by people
 * doing their jobs. A guard that got in the way of that would be worked
 * around by the end of the week.
 *
 * So it asks for nothing at all when nothing has been driven, and it draws
 * a hard line exactly where the damage was: a list holding work a driver has
 * physically handled cannot be deleted by pressing a button. The caller has
 * to send back the count -- the real one, which it has to have read -- and
 * say why. The 9 November burst is then not thirteen seconds of work per
 * list; it is reading a number and typing a sentence, twenty-five times,
 * which is the point at which somebody asks what they are doing.
 */

/**
 * The states in which a driver has physically handled the package.
 *
 * `picked_up` is in here deliberately. It is not a completed delivery, but
 * it is a parcel in somebody's car and a custody chain that has started,
 * and deleting the order is how a medication goes missing with no record of
 * who last had it.
 *
 * `cancelled` is NOT in here. A cancelled delivery is one everybody agreed
 * would not happen; `pending`, `ready` and `assigned` are ones nobody has
 * reached yet. Deleting those destroys an import, not a day's work, which
 * is why withdrawing a wrongly-uploaded list stays a single click.
 */
export const WORKED_STATUSES = ['picked_up', 'delivered', 'failed'] as const;

/** What a caller has to be told before it may delete these. */
export interface WorkedCount {
    /** How many of them a driver has handled. Zero means delete freely. */
    worked: number;
    /** The breakdown, for a message that says what is at stake. */
    byStatus: Record<string, number>;
    /** Proof-of-delivery photographs attached to the worked ones. */
    files: number;
}

/**
 * How much of this is work somebody did.
 *
 * READ BEFORE, not after. deleteOrders returns a `byStatus` of its own, but
 * it counts on its way past and by then the decision has been taken. This
 * exists so the decision can be taken first.
 */
export async function workedAmong(
    client: Client,
    projectId: number,
    ids: readonly number[],
): Promise<WorkedCount> {
    if (ids.length === 0) return { worked: 0, byStatus: {}, files: 0 };

    const marks = ids.map(() => '?').join(',');
    const states = WORKED_STATUSES.map(() => '?').join(',');
    const rs = await client.execute({
        sql: `SELECT status, COUNT(*) AS n FROM orders
               WHERE project_id = ? AND id IN (${marks}) AND status IN (${states})
               GROUP BY status`,
        args: [projectId, ...ids, ...WORKED_STATUSES] as InValue[],
    });

    const byStatus: Record<string, number> = {};
    let worked = 0;
    for (const r of rs.rows) {
        const n = Number(r['n']);
        byStatus[String(r['status'])] = n;
        worked += n;
    }
    if (worked === 0) return { worked: 0, byStatus: {}, files: 0 };

    /* Only the photographs on the worked ones. A POD attached to an order
       nobody drove is a scan of the pharmacy's sheet, and counting it here
       would overstate what is being destroyed. */
    const fileRs = await client.execute({
        sql: `SELECT COUNT(*) AS n FROM files
               WHERE project_id = ? AND order_id IN (
                   SELECT id FROM orders
                    WHERE project_id = ? AND id IN (${marks}) AND status IN (${states})
               )`,
        args: [projectId, projectId, ...ids, ...WORKED_STATUSES] as InValue[],
    });

    return { worked, byStatus, files: Number(fileRs.rows[0]?.['n'] ?? 0) };
}

/** The least a reason can say and still be a reason rather than a keystroke. */
export const DELETE_REASON_MIN = 10;
