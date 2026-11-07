#!/usr/bin/env node
/* Remove one order from the database, permanently.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS NOT A CANCELLATION, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 * Cancelling leaves the order where it is with a status somebody can read a
 * year from now. This takes the row out, with its messages, its custody
 * events, its packages, its run stop, its invoice lines and its files. The
 * only thing left afterwards is the audit line the server writes, which is
 * why that line records the reference, the pharmacy, the service level, the
 * date, the status and which invoices it was on.
 *
 * Reach for it when an order should never have existed: a STAT taken
 * against the wrong pharmacy, a duplicate, a test row on a live board. For
 * anything that happened and then stopped happening, cancel it instead.
 *
 *   node server/scripts/delete-order.mjs --order 2938
 *   node server/scripts/delete-order.mjs --order 2938 --base https://... --i-mean-production
 *   node server/scripts/delete-order.mjs --order 2938 --apply --reason "duplicate of 2937" \
 *       --base https://... --i-mean-production
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT SHOWS BEFORE IT DELETES, AND --apply IS THE SECOND DECISION.
 *
 * Without --apply it prints the order and stops. An order id is four digits
 * and a typo in it is indistinguishable from a correct one until the wrong
 * patient's delivery is gone, so the thing being destroyed is put on screen
 * and read by a person first. The screen in Dispatch does the same job with
 * a two-step confirm; this exists for the times somebody is in a terminal
 * with the id in front of them.
 *
 * The admin password is asked for with the echo off. SEED_ADMIN_PASS wins
 * when it is already set, which is how the .ps1 wrappers pass it.
 */

import { adminPassword } from './lib/secret.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback) => {
    const joined = args.find((a) => a.startsWith(`--${name}=`));
    if (joined) return joined.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const next = args[at + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const base = (value('base', process.env['SEED_BASE'] ?? 'http://127.0.0.1:3000')).replace(/\/$/, '');
const project = value('project', 'uh');
const user = value('user', 'admin');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
const apply = has('apply');
const reason = value('reason', '');

const orderId = Number(value('order', ''));
if (!Number.isInteger(orderId) || orderId <= 0) {
    console.error('Pass --order with the order id, e.g. --order 2938.');
    process.exit(1);
}

/* The same two guards as every other script here. Reading costs nothing and
   needs no flag; deleting on a server that is not this laptop does. */
if (apply && !isLocal && !has('i-mean-production')) {
    console.error(`Refusing to delete order ${orderId} on ${base} without --i-mean-production.`);
    process.exit(1);
}
if (!isLocal && !/^https:/i.test(base)) {
    console.error('Refusing to send an admin password over plain HTTP.');
    process.exit(1);
}

let cookie = '';
async function call(pathname, options = {}) {
    const res = await fetch(base + pathname, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.headers ?? {}),
        },
        redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* an error page, kept as text */ }
    return { status: res.status, body };
}

const line = (label, v) => console.log(`    ${String(label).padEnd(14)}${v ?? ''}`);

async function main() {
    const pass = await adminPassword({ user, base, isLocal, label: 'delete-order.mjs', askLocally: true });
    if (pass === '') { console.error('No password given. Nothing was done.'); process.exitCode = 1; return; }

    console.log(`\n  SERVER   ${base}`);
    console.log(`  PROJECT  ${project}`);
    console.log(`  ${isLocal ? '** LOCAL server, not production **' : 'Remote server.'}`);
    console.log(`  MODE     ${apply ? '** DELETING, permanently **' : 'read only -- pass --apply to delete'}\n`);

    const login = await call('/api/login', {
        method: 'POST', body: JSON.stringify({ username: user, password: pass }),
    });
    if (login.status !== 200) {
        console.error(`  Could not sign in as ${user}: HTTP ${login.status}`);
        process.exitCode = 1;
        return;
    }

    const got = await call(`/api/projects/${project}/uh/orders/${orderId}`);
    if (got.status === 404) {
        console.error(`  There is no order ${orderId} on project ${project}. Nothing was done.`);
        process.exitCode = 1;
        return;
    }
    if (got.status !== 200) {
        console.error(`  Could not read order ${orderId}: HTTP ${got.status}`);
        process.exitCode = 1;
        return;
    }

    /* THE PHARMACY BY NAME, NOT BY ID. The order carries only siteId, and
       "site 4" is not something a person can check against the order in
       front of them -- while the wrong pharmacy is exactly the mistake this
       script is usually clearing up. One extra GET for a readable line. */
    const sites = await call(`/api/projects/${project}/uh/sites`);
    const siteName = (Array.isArray(sites.body) ? sites.body : [])
        .find((s) => Number(s.id) === Number((got.body ?? {}).siteId))?.name;

    /* WHAT IS ABOUT TO GO. Printed whether or not --apply was passed, so the
       run that deletes and the run that checks show the same thing. */
    const o = got.body ?? {};
    console.log(`  ORDER ${orderId}`);
    line('Reference', o.reference || o.externalRef || '(none)');
    line('Pharmacy', siteName ?? `site ${o.siteId}`);
    line('Service', `${o.serviceType ?? '?'} · ${o.serviceDate ?? '?'}`);
    line('Status', o.status);
    line('Recipient', o.recipientName);
    line('Address', [o.addressLine ?? o.address, o.city, o.zip].filter(Boolean).join(', '));
    line('Courier', o.assignedToName || o.assignedTo || 'not assigned');
    console.log('');

    if (!apply) {
        console.log('  Nothing was deleted. Read the above, then run again with --apply.');
        console.log('  There is no undo: the row, its custody events, its messages, its');
        console.log('  packages, its run stop, its invoice lines and its files all go.');
        return;
    }

    const res = await call(`/api/projects/${project}/uh/orders/${orderId}`, {
        method: 'DELETE',
        body: JSON.stringify(reason ? { reason } : {}),
    });
    if (res.status !== 200) {
        console.error(`  The delete was refused: HTTP ${res.status}`);
        console.error(typeof res.body === 'string' ? res.body.slice(0, 300) : JSON.stringify(res.body, null, 2));
        process.exitCode = 1;
        return;
    }

    const r = res.body ?? {};
    console.log('  DELETED');
    line('Rows', r.deleted);
    line('Files', `${r.filesDeleted ?? 0} recorded, ${r.filesRemovedFromStorage ?? 0} removed from storage`);
    if ((r.filesLeftInStorage ?? 0) > 0) {
        line('', `${r.filesLeftInStorage} could not be removed from storage and are now orphaned`);
    }
    if ((r.runsRemoved ?? 0) > 0) line('Runs', `${r.runsRemoved} left empty and were removed`);
    /* Named loudly: deleting a line off an issued invoice changes a figure
       somebody has already been sent. */
    if (Array.isArray(r.onInvoices) && r.onInvoices.length > 0) {
        console.log('');
        console.log(`  IT WAS ON ${r.onInvoices.length} INVOICE LINE(S): ${r.onInvoices.join(', ')}`);
        console.log('  Those totals have changed. If any of them was already issued, the');
        console.log('  copy University Health hold no longer matches ours.');
    }
    console.log('');
    console.log('  Recorded in the audit trail as order.delete with permanent: true.');
    console.log('  That line is now the only record this order ever existed.');
}

await main();
