/* Is this database sound, and how far back does it go?
 *
 * Ticket 4.4. The runbook's restore procedure used to say "check the obvious
 * counts", which is the kind of instruction that reads fine and means nothing
 * at two in the morning to somebody who has never seen the schema. This is
 * that step, as a command.
 *
 * It answers two questions, and they are different.
 *
 * SOUND: does the file hold a coherent database. Integrity, foreign keys, the
 * migrations applied, and the append-only triggers still in place. A restore
 * that silently lost the triggers would leave a chain of custody that could be
 * edited, which is the one property Scope 1.2.7 turns on, and nothing else
 * would notice.
 *
 * HOW FAR BACK: what is the newest thing in here. A point-in-time restore is
 * only ever to a point, and the gap between that point and the moment writing
 * stopped is the work that has to be reconstructed from the couriers' phones,
 * the audit trail and the pharmacy's paper. Reporting the newest row of each
 * kind is how somebody sizes that gap before they promise anybody anything.
 */

import type { Client } from '@libsql/client';

/** The triggers that make two tables append-only. Losing one is silent. */
export const REQUIRED_TRIGGERS = [
    'audit_events_no_delete',
    'audit_events_no_update',
    'custody_events_no_delete',
    'custody_events_no_update',
] as const;

/** Tables worth counting after a restore, in the order a person reads them. */
export const COUNTED_TABLES = [
    'projects', 'users', 'memberships',
    'sites', 'orders', 'packages', 'custody_events', 'signatures',
    'runs', 'run_stops', 'daily_lists',
    'invoices', 'invoice_lines',
    'audit_events', 'files',
] as const;

/** The newest row of each kind, which is what says where the restore lands. */
const FRESHNESS: Array<{ label: string; sql: string }> = [
    { label: 'newest order', sql: 'SELECT MAX(service_date) AS v FROM orders' },
    { label: 'newest custody event', sql: 'SELECT MAX(at) AS v FROM custody_events' },
    { label: 'newest audit event', sql: 'SELECT MAX(at) AS v FROM audit_events' },
    { label: 'newest session', sql: 'SELECT MAX(created_at) AS v FROM sessions' },
    { label: 'newest invoice', sql: 'SELECT MAX(issued_at) AS v FROM invoices' },
];

export interface VerifyResult {
    ok: boolean;
    /** Anything that makes the database unsound. Empty means sound. */
    problems: string[];
    integrity: string;
    foreignKeyViolations: number;
    migrations: number;
    triggers: string[];
    counts: Array<{ table: string; rows: number }>;
    freshness: Array<{ label: string; value: string | null }>;
}

async function scalar(client: Client, sql: string): Promise<string | null> {
    try {
        const rs = await client.execute(sql);
        const row = rs.rows[0];
        const v = row ? row[Object.keys(row)[0]!] : null;
        return v === null || v === undefined ? null : String(v);
    } catch {
        return null;
    }
}

/**
 * Read-only. Never repairs anything: a restore that quietly fixed itself
 * would hide the reason it was needed.
 */
export async function verifyDatabase(client: Client, { expectedMigrations }: { expectedMigrations?: number } = {}): Promise<VerifyResult> {
    const problems: string[] = [];

    const integrity = (await scalar(client, 'PRAGMA integrity_check')) ?? 'unavailable';
    if (integrity !== 'ok') problems.push(`integrity_check says "${integrity}"`);

    let foreignKeyViolations = 0;
    try {
        const fk = await client.execute('PRAGMA foreign_key_check');
        foreignKeyViolations = fk.rows.length;
        if (foreignKeyViolations > 0) {
            /* Worth failing on. A custody event pointing at an order that is
             * not there is a chain with a link missing, and it is exactly what
             * a restore to the wrong moment produces. */
            problems.push(`${foreignKeyViolations} foreign key violation(s)`);
        }
    } catch {
        problems.push('foreign_key_check could not be run');
    }

    const migrations = Number((await scalar(client, 'SELECT COUNT(*) FROM __drizzle_migrations')) ?? 0);
    if (migrations === 0) problems.push('no migrations are recorded: this is not a database this application made');
    if (expectedMigrations !== undefined && migrations !== expectedMigrations) {
        problems.push(`${migrations} migrations applied, this build expects ${expectedMigrations}. Run db:migrate against the restored copy before trusting it.`);
    }

    const trs = await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    const triggers = trs.rows.map((r) => String(r['name']));
    for (const required of REQUIRED_TRIGGERS) {
        if (!triggers.includes(required)) {
            problems.push(`the ${required} trigger is missing: ${required.startsWith('audit') ? 'the audit trail' : 'the chain of custody'} can be edited`);
        }
    }

    const counts: VerifyResult['counts'] = [];
    for (const table of COUNTED_TABLES) {
        const n = await scalar(client, `SELECT COUNT(*) FROM ${table}`);
        if (n === null) {
            problems.push(`table ${table} is missing`);
            counts.push({ table, rows: -1 });
        } else {
            counts.push({ table, rows: Number(n) });
        }
    }

    const freshness: VerifyResult['freshness'] = [];
    for (const f of FRESHNESS) freshness.push({ label: f.label, value: await scalar(client, f.sql) });

    return { ok: problems.length === 0, problems, integrity, foreignKeyViolations, migrations, triggers, counts, freshness };
}

/** The result as something to paste into an incident note. */
export function formatVerify(result: VerifyResult): string {
    const lines: string[] = [];
    lines.push(result.ok ? 'SOUND' : 'PROBLEMS FOUND');
    if (!result.ok) for (const p of result.problems) lines.push(`  - ${p}`);
    lines.push('');
    lines.push(`integrity_check      ${result.integrity}`);
    lines.push(`foreign key problems ${result.foreignKeyViolations}`);
    lines.push(`migrations applied   ${result.migrations}`);
    lines.push(`append-only triggers ${REQUIRED_TRIGGERS.filter((t) => result.triggers.includes(t)).length} of ${REQUIRED_TRIGGERS.length}`);
    lines.push('');
    lines.push('rows');
    for (const c of result.counts) lines.push(`  ${c.table.padEnd(16)} ${c.rows < 0 ? 'MISSING' : c.rows}`);
    lines.push('');
    lines.push('how far back this goes');
    for (const f of result.freshness) lines.push(`  ${f.label.padEnd(22)} ${f.value ?? 'none'}`);
    return lines.join('\n');
}
