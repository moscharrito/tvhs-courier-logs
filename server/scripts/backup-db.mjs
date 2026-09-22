/* Dump a database to a file you can restore from, with no CLI to install.
 *
 *   ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *     npm run backup -w server
 *
 * Writes `backups/<database>-<timestamp>.sql` and prints what it captured.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN `turso db shell .dump`.
 *
 * Two reasons, and the second is the serious one.
 *
 * The Turso CLI is not installed on the machine this project is developed on,
 * and on Windows installing it means WSL or Scoop, which is a detour at the
 * exact moment somebody wants a backup: right before a deploy.
 *
 * And docs/runbook.md says the restore procedure leans on Turso's
 * point-in-time restore, which is a PAID feature on a service still on the
 * free plan. So the snapshot half of that procedure has never been available,
 * let alone rehearsed. Until the paid plan lands with ticket 0.10, a dump
 * taken by hand before a deploy is the only thing standing between a bad
 * migration and two drivers' month of logs.
 *
 * It READS AND NEVER WRITES. A backup script that can modify the thing it is
 * backing up is a hazard, so every statement here is a SELECT.
 *
 * The output is plain SQL: a CREATE for each table, index and trigger exactly
 * as the database reports them, then the rows.
 *
 * RESTORE IT AS ONE SCRIPT, not statement by statement. The trigger bodies
 * contain semicolons, so anything that splits the file on `;` cuts them in
 * half; that is not a theory, it is how the first verification of this file
 * appeared to fail. `sqlite3 restored.db ".read file.sql"` is right, and so
 * is `client.executeMultiple(fs.readFileSync(file, 'utf8'))` with this
 * project's own libSQL client, which is how it was verified: 366 orders,
 * 1078 custody events and all four append-only triggers came back with zero
 * foreign key violations and `integrity_check` clean.
 * ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { loadConfig, describeConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const config = loadConfig();
const database = createDatabase(config);
const client = database.client;

console.log('Backing up:', JSON.stringify(describeConfig(config).database));

/* A literal SQLite understands. Numbers go bare, null goes NULL, blobs go as
   hex, and text is single-quoted with the quotes doubled. Anything else would
   produce a file that restores into different data than it came from. */
function literal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        return `X'${Buffer.from(v.buffer ?? v).toString('hex')}'`;
    }
    return `'${String(v).replace(/'/g, "''")}'`;
}

const objects = await client.execute(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
);

const allTables = objects.rows.filter((r) => r.type === 'table').map((r) => String(r.name));

/* PARENTS BEFORE CHILDREN, or the file will not restore.
 *
 * sqlite_master hands these back in name order, and the first version of this
 * script wrote the INSERTs in that order. Replaying it put `client_events`
 * rows in before the `users` row they point at and every insert after the
 * first foreign key failed: 2325 statements refused, zero orders restored.
 * The emitted `PRAGMA foreign_keys=OFF` did not save it, because whether that
 * survives depends on how somebody replays the file, and a backup that only
 * restores under one particular replay method is not a backup.
 *
 * So the order is computed from the foreign keys themselves. A cycle, which
 * SQLite permits, falls back to name order for the tables involved rather
 * than looping: FKs are off during the restore anyway, and a file that is
 * merely imperfectly ordered still restores. */
async function inDependencyOrder(names) {
    const parents = new Map();
    for (const t of names) {
        const fk = await client.execute(`PRAGMA foreign_key_list("${t}")`);
        parents.set(t, new Set(fk.rows.map((r) => String(r['table'])).filter((p) => p !== t && names.includes(p))));
    }
    const ordered = [];
    const placed = new Set();
    let progress = true;
    while (ordered.length < names.length && progress) {
        progress = false;
        for (const t of names) {
            if (placed.has(t)) continue;
            if ([...parents.get(t)].every((p) => placed.has(p))) {
                ordered.push(t);
                placed.add(t);
                progress = true;
            }
        }
    }
    for (const t of names) if (!placed.has(t)) ordered.push(t);
    return ordered;
}

const tables = await inDependencyOrder(allTables);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const label = String(describeConfig(config).database).replace(/[^A-Za-z0-9_-]+/g, '_').slice(-40);
const dir = path.resolve(import.meta.dirname, '..', '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${label}-${stamp}.sql`);
const out = fs.createWriteStream(file, { encoding: 'utf8' });
const write = (s) => new Promise((res) => { out.write(s) ? res() : out.once('drain', res); });

await write(`-- Backup of ${describeConfig(config).database}\n`);
await write(`-- Taken ${new Date().toISOString()}\n`);
await write('-- Restore with:  sqlite3 restored.db ".read this-file.sql"\n');
await write('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n');

/* Schema first, in dependency order: tables, then indexes, then triggers.
   The triggers MUST come last. custody_events and audit_events refuse writes
   through a BEFORE trigger, so creating them before the rows go in would make
   the backup refuse to restore itself. */
for (const o of objects.rows.filter((r) => r.type !== 'trigger')) {
    await write(`${String(o.sql)};\n`);
}
await write('\n');

const counts = {};
for (const table of tables) {
    const rs = await client.execute(`SELECT * FROM "${table}"`);
    counts[table] = rs.rows.length;
    if (rs.rows.length === 0) continue;
    const cols = rs.columns.map((c) => `"${c}"`).join(', ');
    await write(`-- ${table}: ${rs.rows.length} rows\n`);
    for (const row of rs.rows) {
        const values = rs.columns.map((c) => literal(row[c])).join(', ');
        await write(`INSERT INTO "${table}" (${cols}) VALUES (${values});\n`);
    }
    await write('\n');
}

for (const o of objects.rows.filter((r) => r.type === 'trigger')) {
    await write(`${String(o.sql)};\n`);
}

await write('\nCOMMIT;\nPRAGMA foreign_keys=ON;\n');
await new Promise((res) => out.end(res));

const bytes = fs.statSync(file).size;
console.log('');
console.log(`Wrote ${file}`);
console.log(`${(bytes / 1024).toFixed(1)} KB, ${tables.length} tables, ${objects.rows.filter((r) => r.type === 'trigger').length} triggers\n`);

/* The tables somebody actually cares about losing, named so the number is
   checked rather than glanced at. A backup whose logs count is zero is not a
   backup, and the only moment anybody can tell is now. */
for (const t of ['logs', 'checkins', 'users', 'orders', 'custody_events', 'signatures']) {
    if (t in counts) console.log(`  ${t.padEnd(16)} ${counts[t]} rows`);
}

const live = (counts['logs'] ?? 0) + (counts['checkins'] ?? 0);
if (live === 0) {
    console.log('\nNO TVHS LOGS OR CHECK-INS IN THIS BACKUP.');
    console.log('If this was meant to be production, it is pointed at the wrong database.');
    client.close();
    process.exit(1);
}

client.close();
