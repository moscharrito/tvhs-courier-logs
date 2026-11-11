/* Bring back proof-of-delivery photographs that a delete marker is hiding.
 *
 *   S3_BUCKET=... S3_REGION=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *     node server/scripts/restore-pods.mjs --dates 2026-11-05,2026-11-06,2026-11-07,2026-11-08
 *
 *   ... --apply --i-mean-production      to actually remove the markers
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHY IT HAS A DEADLINE.
 *
 * On 9 November 2026 twenty-five daily lists were deleted in six minutes.
 * The database rows came back out of a point-in-time branch -- see
 * merge-recovered.mjs -- and 361 `files` rows across the 5th to the 8th
 * came back with them. The OBJECTS those rows point at did not, because the
 * delete also reached the bucket.
 *
 * The bucket is versioned. A delete in a versioned bucket does not destroy
 * anything: it lays a DELETE MARKER on top, the real version underneath
 * becomes NONCURRENT, and a GET of the key answers 404 as though the object
 * were gone. Removing the marker makes the version underneath current
 * again, and the photograph is simply back.
 *
 * The lifecycle rule on this bucket is NoncurrentVersionExpiration with
 * NoncurrentDays 30. Those versions became noncurrent on 9 November. On or
 * about 9 DECEMBER 2026 AWS deletes them for real, and at that point the
 * `files` rows point at nothing and the photographs are gone for good.
 *
 * That is the whole of the hurry. Nothing else about this is urgent.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL AND WILL NOT DELETE.
 *
 * A versioned DELETE -- `DELETE /key?versionId=...` -- is the one S3 call
 * that destroys data permanently and cannot be undone by anything. Used on
 * a delete marker it is a restore. Used on a real version it is the thing
 * this whole script exists to undo, done again and for ever.
 *
 * So the version id it sends is never constructed, guessed or carried in
 * from a flag. It comes only from a <DeleteMarker> element of a
 * ListObjectVersions response that also said <IsLatest>true</IsLatest>, and
 * remove() asserts that again at the call site. A <Version> element cannot
 * reach it: the two are parsed separately and only one of them is ever put
 * in a delete.
 *
 * It also never touches a key that is not referenced by a `files` row on
 * one of the given dates. Listing is by prefix and returns everything under
 * it, including objects that were deleted on purpose months ago; those are
 * counted and left exactly where they are.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CREDENTIAL IS NOT THE ONE RENDER HOLDS, PROBABLY.
 *
 * The bucket key the application runs on is scoped to what the application
 * does: put an object, get one, delete one. This needs two actions it has
 * almost certainly never been granted --
 *
 *   s3:ListBucketVersions     on the bucket
 *   s3:DeleteObjectVersion    on the objects
 *
 * -- and the second of those is the permanent one. Widening the running
 * application's key to hold it leaves a credential on a web server that can
 * destroy the evidence archive, for ever, and this is a job that happens
 * once.
 *
 * So: make a separate IAM user, give it those two actions on this bucket
 * alone, run this, and delete the user. The script says the same thing when
 * AWS answers 403, because that is the moment somebody will be reading.
 */

import { createClient } from '@libsql/client';
import { signedHeaders, canonicalQuery, encodeKeyPath, bucketHost } from '../src/core/files/sigv4.ts';
import { parseVersionPage, verdictFor } from '../src/core/files/s3-versions.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const dates = value('dates', '2026-11-05,2026-11-06,2026-11-07,2026-11-08')
    .split(',').map((s) => s.trim()).filter(Boolean);
const projectCode = value('project', 'uh');
const apply = flag('apply');
const say = (s = '') => console.log(s);

/* Keys and tokens come from the environment, never from the command line:
   an argument lands in the shell history and in the process list. */
const bucket = process.env['S3_BUCKET'] ?? '';
const region = process.env['S3_REGION'] ?? '';
const accessKeyId = process.env['S3_ACCESS_KEY_ID'] ?? '';
const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY'] ?? '';
const dbUrl = process.env['TURSO_DATABASE_URL'] ?? '';
const dbToken = process.env['TURSO_AUTH_TOKEN'] ?? '';

const dbHost = (() => { try { return new URL(dbUrl).host; } catch { return '(unreadable)'; } })();

say('');
say(`  BUCKET    ${bucket || '(not set)'}  ${region}`);
say(`  DATABASE  ${dbHost}`);
say(`  PROJECT   ${projectCode}`);
say(`  DATES     ${dates.join(', ')}`);
say(`  MODE      ${apply ? '** REMOVING DELETE MARKERS in the bucket **' : 'read only. Nothing is changed.'}`);
say('');

if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    say('  Need S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
    process.exit(1);
}
if (!dbUrl || !dbToken) {
    say('  Need TURSO_DATABASE_URL and TURSO_AUTH_TOKEN: the list of photographs');
    say('  worth restoring comes from the files table, not from the bucket.');
    process.exit(1);
}
if (apply && !flag('i-mean-production')) {
    say('  --apply needs --i-mean-production as well.');
    process.exit(1);
}

const host = bucketHost(bucket, region);
const db = createClient({ url: dbUrl, authToken: dbToken });

/* ─────────────────────────────────────────── talking to S3 ───────────── */

/** One signed request. The query is built once and used for both the
 *  signature and the URL, which is the whole reason canonicalQuery is
 *  exported -- see the note on it. */
async function s3(method, path, query) {
    const at = new Date();
    const headers = signedHeaders({
        method, host, path, region, service: 's3',
        accessKeyId, secretAccessKey, body: '', at, query,
    });
    const qs = canonicalQuery(query);
    const res = await fetch(`https://${host}${path}${qs ? `?${qs}` : ''}`, { method, headers });
    const text = await res.text();
    return { status: res.status, text };
}

/**
 * Every version and every delete marker under a prefix, paged to the end.
 *
 * Paging is by key-marker AND version-id-marker together: a key with many
 * versions can straddle a page boundary, and carrying only the key marker
 * would re-read the same key for ever.
 */
async function listVersions(prefix) {
    const versions = [];
    const markers = [];
    let keyMarker = '';
    let versionIdMarker = '';
    let pages = 0;

    for (;;) {
        const query = { versions: '', prefix, 'max-keys': '1000' };
        if (keyMarker) query['key-marker'] = keyMarker;
        if (versionIdMarker) query['version-id-marker'] = versionIdMarker;

        const res = await s3('GET', '/', query);
        if (res.status === 403) {
            say('');
            say('  AWS REFUSED THE LISTING (403).');
            say('');
            say('  This key almost certainly lacks s3:ListBucketVersions. The application');
            say('  key is scoped to putting, getting and deleting an object and nothing');
            say('  else, which is correct and should stay that way.');
            say('');
            say('  Make a separate IAM user with exactly these two actions on this bucket,');
            say('  run this with its key, and delete the user afterwards:');
            say('');
            say('      s3:ListBucketVersions    on arn:aws:s3:::' + bucket);
            say('      s3:DeleteObjectVersion   on arn:aws:s3:::' + bucket + '/' + projectCode + '/*');
            say('');
            process.exit(1);
        }
        if (res.status !== 200) {
            say(`  S3 answered ${res.status} to the listing. Nothing was changed.`);
            say(`  ${res.text.slice(0, 400)}`);
            process.exit(1);
        }

        /* Parsed in core/files/s3-versions.ts, which is where the tests
           are. The two lists come back separate and stay separate: that
           separation is the only thing between a restore and a permanent
           deletion. */
        const page = parseVersionPage(res.text);
        versions.push(...page.versions);
        markers.push(...page.markers);

        pages += 1;
        if (!page.truncated) break;
        keyMarker = page.nextKeyMarker;
        versionIdMarker = page.nextVersionIdMarker;
        if (!keyMarker) break;
        if (pages > 500) { say('  Listing did not end after 500 pages. Stopping.'); process.exit(1); }
    }
    return { versions, markers, pages };
}

/**
 * Remove ONE delete marker.
 *
 * The assertion is not decoration. Everything above it is parsing, and this
 * is the line between a restore and a permanent deletion.
 */
async function remove(marker) {
    if (marker.kind !== 'DeleteMarker' || marker.isLatest !== true || !marker.versionId) {
        throw new Error(`refusing to delete a version that is not a current delete marker: ${marker.key}`);
    }
    const res = await s3('DELETE', encodeKeyPath(marker.key), { versionId: marker.versionId });
    /* 204 is the success. 404 means somebody or something already removed
       it, which is the same end state and not a failure. */
    if (res.status === 204 || res.status === 200 || res.status === 404) return { ok: true };
    return { ok: false, status: res.status, body: res.text.slice(0, 200) };
}

/* ───────────────────────────────────── which photographs matter ──────── */

const q = async (sql, params = []) => (await db.execute({ sql, args: params })).rows;

const project = (await q('SELECT id FROM projects WHERE code = ?', [projectCode]))[0];
if (!project) { say(`  No project with code ${projectCode}.`); process.exit(1); }
const projectId = Number(project['id']);

const marks = dates.map(() => '?').join(',');
const wanted = await q(
    `SELECT f.s3_key AS key, f.order_id AS orderId, f.kind AS kind, o.service_date AS day
       FROM files f JOIN orders o ON o.id = f.order_id
      WHERE f.project_id = ? AND o.service_date IN (${marks})
      ORDER BY o.service_date, f.id`,
    [projectId, ...dates],
);

say(`  ${wanted.length} proof-of-delivery rows on those dates reference an object.`);
if (wanted.length === 0) {
    say('  Nothing to do. If that is a surprise, check the dates and the project.');
    process.exit(0);
}

const byKey = new Map();
for (const r of wanted) byKey.set(String(r['key']), { day: String(r['day']), orderId: Number(r['orderId']) });

/* ─────────────────────────────────────────── look in the bucket ──────── */

const markerFor = new Map();
const versionsFor = new Map();
let seenNotOurs = 0;

for (const day of dates) {
    /* The prefix is exactly what buildKey produces: project/date/... So one
       listing covers a whole day rather than one request per photograph. */
    const prefix = `${projectCode}/${day}/`;
    const { versions, markers, pages } = await listVersions(prefix);
    say(`  ${prefix}  ${versions.length} versions, ${markers.length} delete markers, ${pages} page${pages === 1 ? '' : 's'}`);

    for (const v of versions) {
        if (!byKey.has(v.key)) { seenNotOurs += 1; continue; }
        const list = versionsFor.get(v.key) ?? [];
        list.push(v);
        versionsFor.set(v.key, list);
    }
    for (const m of markers) {
        if (!byKey.has(m.key)) { seenNotOurs += 1; continue; }
        if (m.isLatest) markerFor.set(m.key, { ...m, kind: 'DeleteMarker' });
    }
}

say('');

/* ───────────────────────────────────────────────── classify ──────────── */

const restorable = [];
const alreadyFine = [];
const noVersionLeft = [];
const missingEntirely = [];

for (const [key, about] of byKey) {
    const marker = markerFor.get(key) ?? null;
    const versions = versionsFor.get(key) ?? [];
    const allMarkers = marker === null ? [] : [marker];
    switch (verdictFor(versions, allMarkers)) {
        case 'hidden': restorable.push({ key, ...about, marker, versions }); break;
        case 'current': alreadyFine.push({ key, ...about }); break;
        case 'absent': missingEntirely.push({ key, ...about }); break;
        default: noVersionLeft.push({ key, ...about, marker }); break;
    }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

say('  -- WHAT IS IN THE BUCKET ------------------------------------------');
say('');
say(`  ${plural(restorable.length, 'photograph', 'photographs')} behind a delete marker, with the real version still there.`);
say(`  ${plural(alreadyFine.length, 'photograph is', 'photographs are')} already current. Nothing to do for those.`);
if (noVersionLeft.length > 0) {
    say(`  ${plural(noVersionLeft.length, 'row has', 'rows have')} a delete marker and NO version under it.`);
    say('     Expired, or never uploaded. Those are gone and this cannot help.');
}
if (missingEntirely.length > 0) {
    say(`  ${plural(missingEntirely.length, 'row references', 'rows reference')} a key the bucket has never heard of.`);
}
if (seenNotOurs > 0) {
    say(`  ${seenNotOurs} other objects under those prefixes belong to no row on these dates. Left alone.`);
}

/* ─────────────────────────────────────── how long is left ────────────── */

if (restorable.length > 0) {
    const oldest = restorable
        .map((r) => Date.parse(r.marker.lastModified))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b)[0];
    if (oldest !== undefined) {
        const expiresAt = oldest + 30 * 24 * 60 * 60 * 1000;
        const daysLeft = Math.floor((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
        say('');
        say(`  THE CLOCK. The earliest of these became noncurrent on ${new Date(oldest).toISOString().slice(0, 10)}.`);
        say(`  NoncurrentDays is 30, so AWS deletes it for real around ${new Date(expiresAt).toISOString().slice(0, 10)}`);
        say(`  -- ${daysLeft} day${daysLeft === 1 ? '' : 's'} from now. After that there is nothing to restore.`);
    }
}

say('');

if (restorable.length === 0) {
    say('  No delete markers to remove. Nothing to do.');
    process.exit(0);
}

const byDay = new Map();
for (const r of restorable) byDay.set(r.day, (byDay.get(r.day) ?? 0) + 1);
say('  -- WHAT WOULD BE RESTORED -----------------------------------------');
say('');
for (const day of [...byDay.keys()].sort()) say(`    ${day}   ${plural(byDay.get(day), 'photograph', 'photographs')}`);
say('');

if (!apply) {
    say('  DRY RUN. Nothing was changed.');
    say('  Re-run with --apply --i-mean-production to remove the markers.');
    process.exit(0);
}

/* ──────────────────────────────────────────────────── do it ──────────── */

let restored = 0;
const failures = [];
for (const r of restorable) {
    const res = await remove(r.marker);
    if (res.ok) restored += 1;
    else failures.push({ key: r.key, status: res.status, body: res.body });

    if (failures.length === 1 && failures[0].status === 403) {
        say('');
        say('  AWS REFUSED THE DELETE (403), so this key can list versions but not');
        say('  remove them. It needs s3:DeleteObjectVersion as well:');
        say('');
        say('      s3:DeleteObjectVersion   on arn:aws:s3:::' + bucket + '/' + projectCode + '/*');
        say('');
        say(`  ${restored} markers were removed before this. Re-running is safe: a key`);
        say('  whose marker is already gone is simply counted as already current.');
        process.exit(1);
    }
}

say(`  Removed ${plural(restored, 'delete marker', 'delete markers')}.`);
if (failures.length > 0) {
    say(`  ${plural(failures.length, 'failure', 'failures')}:`);
    for (const f of failures.slice(0, 10)) say(`    ${f.status}  ${f.key}  ${f.body}`);
}

/* ─────────────────────────────────── say it actually worked ──────────── */

say('');
say('  -- CHECKING ---------------------------------------------------------');
say('');

/* Re-listing rather than trusting the 204s. The whole point of this run is
   that the photographs can be opened again, and the only thing that proves
   it is the bucket answering with a current version. */
let current = 0;
let stillHidden = 0;
for (const day of dates) {
    const { versions, markers } = await listVersions(`${projectCode}/${day}/`);
    const latest = new Set(versions.filter((v) => v.isLatest).map((v) => v.key));
    const hidden = new Set(markers.filter((m) => m.isLatest).map((m) => m.key));
    for (const r of restorable) {
        if (r.day !== day) continue;
        if (latest.has(r.key)) current += 1;
        else if (hidden.has(r.key)) stillHidden += 1;
    }
}

say(`  ${current} of ${restorable.length} are now the current version and can be opened.`);
if (stillHidden > 0) say(`  ${stillHidden} are still behind a delete marker. Re-run; this is safe to repeat.`);
say('');
say('  The files rows were never broken -- they always held the right key.');
say('  What changed is that the key now answers with a photograph again.');
say('');
