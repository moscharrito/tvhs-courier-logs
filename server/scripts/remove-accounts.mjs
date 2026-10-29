/* Delete duplicate accounts, and refuse to do it quietly when they hold work.
 *
 * `npm run remove:accounts -w server -- mohamed mohammed`            shows what it would do
 * `npm run remove:accounts -w server -- mohamed mohammed --apply`    deletes the clean ones
 * `... --apply --with-work`                                          also deletes their work
 * `... --apply --disable`                                            disables instead of deleting
 * `... --apply --disable --restore`                                  puts them back to active
 *
 * --disable IS THE RIGHT ANSWER FOR AN ACCOUNT THAT HAS SIGNED FOR THINGS.
 * It sets status to 'disabled', which takes the account off every sign-in
 * roster (/api/drivers/list filters on status) and refuses its password,
 * while leaving its runs, its orders and above all its custody events exactly
 * where they are. Deleting a signatory is the one outcome the append-only
 * trigger on custody_events exists to prevent; this gets the account out of
 * the way without making the chain of custody name somebody who is no longer
 * in the system. It is also reversible, with --restore.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT ONE DELETE STATEMENT.
 *
 * An account is not a standalone row. Four things can point at it, and they
 * want four different answers:
 *
 *   memberships, devices    Belong to the account. Go with it.
 *
 *   runs, orders            Operational. Deleting the account without them
 *                           leaves work assigned to a courier who does not
 *                           exist, which every board and report then has to
 *                           cope with.
 *
 *   custody_events          EVIDENCE, and append-only by database trigger.
 *                           `actor` names who did the handover. Deleting the
 *                           account behind a custody event turns a chain of
 *                           custody into a claim that somebody who is not in
 *                           the system signed for a prescription. That is
 *                           precisely the thing the append-only trigger
 *                           exists to make impossible, so this script will
 *                           not do it unless asked in so many words.
 *
 *   audit_events            KEPT, ALWAYS, and never touched here. It stores
 *                           the username as text rather than a foreign key
 *                           for exactly this reason: the record of what
 *                           somebody did has to outlive their account. An
 *                           audit trail that gets tidied up alongside the
 *                           thing it was auditing is not an audit trail.
 *
 * So an account with no runs, no orders and no custody events is deleted.
 * One that has any of them is skipped and named, and `--with-work` is the
 * explicit instruction to remove those too.
 *
 * `--with-work` drops the custody_events delete trigger while it works, puts
 * it back in a `finally`, and then CHECKS it came back, failing loudly if it
 * did not. Same discipline as clearSimulation in modules/uh/simulate.ts.
 * ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const withWork = args.includes('--with-work');
const disable = args.includes('--disable');
const restore = args.includes('--restore');
const meansProduction = args.includes('--i-mean-production');
const usernames = args.filter((a) => !a.startsWith('--'));

if (usernames.length === 0) {
    console.error('Name the accounts to remove, e.g. npm run remove:accounts -w server -- mohamed');
    process.exit(1);
}

const config = loadConfig();

/* ─────────────────────────────────────────────────────────────────────────
 * THE FLAG HAS TO AGREE WITH THE TARGET, BOTH WAYS ROUND.
 *
 * This talks to the database directly and takes it from TURSO_DATABASE_URL,
 * which lives on Render. clear-test-work.mjs grew this same guard after 30
 * September, when it was run with the live site in mind, cleaned the laptop,
 * printed "Done", and left the production rows exactly where they were.
 *
 * The mirror is worse, and is why this is a refusal rather than a warning: a
 * shell that happens to be holding Turso credentials, deleting accounts from
 * production while somebody believes they are tidying a local copy. These are
 * accounts that may have signed for a controlled drug.
 *
 * So asking for production and getting a file is refused, and changing a
 * remote database without asking for it is refused. A dry run is still
 * allowed either way: reading is harmless, and being told which database you
 * are reading is the point of the line below.
 * ───────────────────────────────────────────────────────────────────────── */
if (meansProduction && config.db.kind === 'file') {
    console.error('Refusing to run: you asked for production and this is a local file.');
    console.error('');
    console.error(`  target  ${config.db.url}`);
    console.error('');
    console.error('TURSO_DATABASE_URL lives on Render and not here, so without it every');
    console.error('command lands on this laptop. Nothing was changed.');
    console.error('');
    console.error('To act on the live database, take the values from the Render dashboard:');
    console.error('  ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=...');
    console.error('  node server/scripts/remove-accounts.mjs <usernames> --i-mean-production --apply --disable');
    console.error('');
    console.error('To act on this laptop, drop the flag: it is only for a remote database.');
    process.exit(1);
}
if (apply && config.db.kind !== 'file' && !meansProduction) {
    console.error('Refusing to run: this is not a local file database.');
    console.error(`  target  ${config.db.url}`);
    console.error('');
    console.error('These accounts may have signed for a controlled drug. If you mean it,');
    console.error('add --i-mean-production. Take a backup first:  npm run backup -w server');
    process.exit(1);
}
const database = createDatabase(config);
const client = database.client;
const run = (sql, a = []) => client.execute({ sql, args: a });
const count = async (sql, a) => Number((await run(sql, a)).rows[0].n);

console.log(`Database: ${config.db.url}`);
const verb = disable ? (restore ? 'restore to active' : 'disable') : 'delete';
console.log(`Mode: ${apply ? 'APPLY' : 'dry run. Pass --apply to make the change.'}  Action: ${verb}${!disable && withWork ? '  (work and custody events go too)' : ''}`);
console.log('');

const plan = [];

for (const username of usernames) {
    const found = await run('SELECT id, username, name, email, role, status FROM users WHERE username = ?', [username]);
    if (found.rows.length === 0) {
        console.log(`  ${username}: not found, nothing to do`);
        continue;
    }
    const u = found.rows[0];
    const id = Number(u.id);

    const held = {
        runs: await count('SELECT COUNT(*) n FROM runs WHERE courier_username = ?', [username]),
        orders: await count('SELECT COUNT(*) n FROM orders WHERE assigned_to_username = ?', [username]),
        custody: await count('SELECT COUNT(*) n FROM custody_events WHERE actor = ?', [username]),
        logs: await count('SELECT COUNT(*) n FROM logs WHERE username = ?', [username]),
        sessions: await count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', [id]),
        applications: await count('SELECT COUNT(*) n FROM driver_applications WHERE user_id = ?', [id]),
        checkins: await count('SELECT COUNT(*) n FROM checkins WHERE username = ?', [username]),
        devices: await count('SELECT COUNT(*) n FROM devices WHERE user_id = ?', [id]),
        memberships: await count('SELECT COUNT(*) n FROM memberships WHERE user_id = ?', [id]),
        audit: await count('SELECT COUNT(*) n FROM audit_events WHERE username = ?', [username]),
        /* ── THE THREE THINGS THAT USED TO MAKE THIS CRASH HALFWAY ──────
         *
         * `orders` is not a leaf. Seven tables carry a foreign key into it
         * and --with-work only ever cleared four of them, so the first
         * courier whose deliveries had a message thread or a reattempt
         * failed on SQLITE_CONSTRAINT_FOREIGNKEY -- after earlier accounts
         * in the same run were already gone and with the custody trigger
         * dropped. The trigger came back (that is what the finally is for)
         * but the run was left half done, which is the worst state for a
         * command somebody reaches for to tidy up.
         *
         * Found on 29 October: a demo courier with 38 orders carrying 4
         * threads and 17 reattempts pointing back at them.
         *
         * Counted here so the DRY RUN says so before anybody applies. */
        messages: await count(
            'SELECT COUNT(*) n FROM order_messages WHERE order_id IN (SELECT id FROM orders WHERE assigned_to_username = ?)',
            [username]),
        /* Another order naming one of these as the delivery it re-attempts.
           It may belong to a different courier, so it is NOT deleted: the
           pointer is cleared and that order stays. */
        reattempts: await count(
            'SELECT COUNT(*) n FROM orders WHERE reattempt_of_order_id IN (SELECT id FROM orders WHERE assigned_to_username = ?)',
            [username]),
        /* MONEY. An invoice line is a billed delivery, and deleting one
           silently changes what a client was charged. This refuses rather
           than cascades -- see the check below. */
        invoiced: await count(
            'SELECT COUNT(*) n FROM invoice_lines WHERE order_id IN (SELECT id FROM orders WHERE assigned_to_username = ?)',
            [username]),
    };

    const work = held.runs + held.orders + held.custody + held.logs + held.checkins;
    plan.push({ id, username, name: u.name, held, work });

    console.log(`  ${username}  (${u.name}${u.email ? ', ' + u.email : ''})`);
    console.log(`      runs ${held.runs}   orders ${held.orders}   custody events ${held.custody}   tvhs logs ${held.logs}   check-ins ${held.checkins}`);
    console.log(`      memberships ${held.memberships}   devices ${held.devices}   sessions ${held.sessions}   applications ${held.applications}`);
    console.log(`      audit events ${held.audit}: KEPT. audit_events has no foreign key to users, deliberately,`);
    console.log('                       so the record of what somebody did outlives their account.');
    if (held.messages > 0 || held.reattempts > 0) {
        console.log(`      message threads ${held.messages}   re-attempts pointing here ${held.reattempts}`);
    }
    if (held.invoiced > 0) {
        console.log(`      -> REFUSED: ${held.invoiced} invoice line${held.invoiced === 1 ? '' : 's'} bill these deliveries.`);
        console.log('                  Deleting them would change what the client was charged.');
    }
    if (disable) {
        const target = restore ? 'active' : 'disabled';
        console.log(u.status === target
            ? `      -> nothing to do: already ${target}`
            : `      -> ${target.toUpperCase()}: keeps its runs, orders and custody events`);
    } else if (work === 0) {
        console.log('      -> DELETE: holds no work');
    } else if (withWork) {
        console.log('      -> DELETE WITH WORK');
    } else {
        console.log('      -> SKIP: holds work. Re-run with --with-work to remove it too, or --disable to keep it.');
    }
    console.log('');
}

if (!apply) {
    console.log('Dry run. Nothing changed.');
    client.close();
    process.exit(0);
}

if (disable) {
    const target = restore ? 'active' : 'disabled';
    let changed = 0;
    for (const p of plan) {
        await run('UPDATE users SET status = ? WHERE id = ?', [target, p.id]);
        /* A disabled account with a live session stays signed in until that
           session expires, which is not what "disabled" means to anybody. */
        if (!restore) await run('DELETE FROM sessions WHERE user_id = ?', [p.id]);
        changed += 1;
        console.log(`  ${p.username} -> ${target}`);
    }
    const roster = await count(
        `SELECT COUNT(*) n FROM users u JOIN memberships m ON m.user_id = u.id JOIN projects p ON p.id = m.project_id
          WHERE p.code = 'uh' AND m.role = 'courier' AND u.status = 'active'`, []);
    console.log('');
    console.log(`Set ${changed} account${changed === 1 ? '' : 's'} to ${target}.`);
    console.log(`Active UH couriers remaining: ${roster}`);
    client.close();
    process.exit(0);
}

let deleted = 0;
let refused = 0;
for (const p of plan) {
    if (p.work > 0 && !withWork) continue;

    /* MONEY IS NOT WORK TO BE SWEPT UP. An invoice line is a delivery that
       has been billed, so deleting the order behind it changes what a
       client was charged and leaves the invoice pointing at nothing.
       --with-work does not cover this and no flag here does: take the
       account off the roster with --disable instead, which keeps every row
       and is reversible. */
    if (p.held.invoiced > 0) {
        console.log(`  ${p.username}: REFUSED, ${p.held.invoiced} billed deliver${p.held.invoiced === 1 ? 'y' : 'ies'}. Use --disable.`);
        refused += 1;
        continue;
    }

    if (p.work > 0) {
        /* custody_events refuses deletes by trigger. Drop it, delete, put it
           back in a finally, then prove it is back. */
        /* TWO append-only tables, not one. order_messages carries the same
           pair of triggers as custody_events -- a thread on a delivery is
           evidence of what was said about it -- and --with-work hit that
           wall the moment custody stopped being the only guard. Both come
           off together and both go back in the finally, because leaving
           either one dropped is the serious outcome here. */
        await run('DROP TRIGGER IF EXISTS custody_events_no_delete');
        await run('DROP TRIGGER IF EXISTS order_messages_no_delete');
        try {
            const orders = (await run('SELECT id FROM orders WHERE assigned_to_username = ?', [p.username])).rows.map((r) => Number(r.id));
            if (orders.length > 0) {
                const list = orders.map(() => '?').join(',');
                /* EVERY foreign key into orders, in dependency order. The
                   four that were here cleared custody, stops and packages;
                   order_messages and the reattempt self-reference were not,
                   and either one aborted the whole run on the first courier
                   that had one. PRAGMA foreign_key_list(orders) is the list
                   to check against if a table is added later. */
                await run(`DELETE FROM custody_events WHERE order_id IN (${list})`, orders);
                await run(`DELETE FROM run_stops WHERE order_id IN (${list})`, orders);
                await run(`DELETE FROM packages WHERE order_id IN (${list})`, orders);
                /* The thread on the delivery. It belongs to the delivery and
                   goes with it; patient_messages likewise. */
                await run(`DELETE FROM order_messages WHERE order_id IN (${list})`, orders);
                await run(`DELETE FROM patient_messages WHERE order_id IN (${list})`, orders);
                /* NOT a delete. Another order -- possibly another courier's
                   -- names one of these as the delivery it re-attempts.
                   Removing that order would take somebody else's work with
                   it, so the pointer is cleared and the order stays. What is
                   lost is the link, which is the honest cost of deleting the
                   original. */
                await run(`UPDATE orders SET reattempt_of_order_id = NULL WHERE reattempt_of_order_id IN (${list})`, orders);
                await run(`DELETE FROM orders WHERE id IN (${list})`, orders);
            }
            await run('DELETE FROM custody_events WHERE actor = ?', [p.username]);
            await run('DELETE FROM run_stops WHERE run_id IN (SELECT id FROM runs WHERE courier_username = ?)', [p.username]);
            await run('DELETE FROM runs WHERE courier_username = ?', [p.username]);
            await run('DELETE FROM logs WHERE username = ?', [p.username]);
            await run('DELETE FROM checkins WHERE username = ?', [p.username]);
        } finally {
            await run(`CREATE TRIGGER IF NOT EXISTS custody_events_no_delete
                BEFORE DELETE ON custody_events
                BEGIN SELECT RAISE(ABORT, 'custody_events is append-only'); END`);
            await run(`CREATE TRIGGER IF NOT EXISTS order_messages_no_delete
                BEFORE DELETE ON order_messages
                BEGIN SELECT RAISE(ABORT, 'order_messages is append-only'); END`);
        }
        /* Checked, not assumed. The finally above runs on the way out of a
           failure too, and the one thing this command must never leave
           behind is a database that quietly accepts deletes. */
        const back = await run(`SELECT name FROM sqlite_master WHERE type = 'trigger'
                                 AND name IN ('custody_events_no_delete', 'order_messages_no_delete')`);
        if (back.rows.length !== 2) {
            const have = back.rows.map((r) => String(r.name));
            throw new Error(
                'append-only triggers were not restored: missing '
                + ['custody_events_no_delete', 'order_messages_no_delete'].filter((n) => !have.includes(n)).join(', '));
        }
    }

    /* Everything holding a foreign key to users(id), or this fails with
       SQLITE_CONSTRAINT_FOREIGNKEY. A live session is the easy one to miss:
       it is not work, it leaves nothing worth keeping, and it blocks the
       delete just as hard as a run would. */
    await run('DELETE FROM sessions WHERE user_id = ?', [p.id]);
    await run('DELETE FROM devices WHERE user_id = ?', [p.id]);
    await run('DELETE FROM memberships WHERE user_id = ?', [p.id]);
    await run('DELETE FROM users WHERE id = ?', [p.id]);
    /* audit_events is deliberately untouched. */
    deleted += 1;
    console.log(`  deleted ${p.username}`);
}

const trigger = await run(`SELECT name FROM sqlite_master WHERE type = 'trigger'
                           AND name IN ('custody_events_no_delete', 'order_messages_no_delete')`);
console.log(`\nDeleted ${deleted} account${deleted === 1 ? '' : 's'}.`);
if (refused > 0) {
    console.log(`Refused ${refused} with billed deliveries. They are untouched; --disable takes them off the roster.`);
}
console.log(`append-only triggers present: ${trigger.rows.length}/2 (custody_events, order_messages)`);
const roster = await count(
    `SELECT COUNT(*) n FROM users u JOIN memberships m ON m.user_id = u.id JOIN projects p ON p.id = m.project_id
      WHERE p.code = 'uh' AND m.role = 'courier' AND u.status = 'active'`, []);
console.log(`Active UH couriers remaining: ${roster}`);

client.close();
