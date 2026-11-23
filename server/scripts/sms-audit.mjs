/* Who has actually been texted, and when -- without naming any of them.
 *
 *   $env:TURSO_DATABASE_URL / $env:TURSO_AUTH_TOKEN set, then
 *   node server/scripts/sms-audit.mjs
 *
 * Or use the wrapper, which prompts for the token rather than leaving it in
 * a shell's history:  .\sms-audit.ps1
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE QUESTION THIS EXISTS FOR.
 *
 * On 23 November 2026 /health learned to report the patient-text queue, and
 * the first thing it said was:
 *
 *   PAUSED for every project -- nothing is queued and nothing will send:
 *   112 sent, 0 waiting
 *
 * Both halves of that are surprising together. `paused` defaults to true,
 * lives in the database, is moved by no deploy, and set-patient-sms.mjs
 * states in its own header that this flag "is the only thing that has kept
 * it from running" since September. If that is true there should be no sent
 * rows at all. There are a hundred and twelve.
 *
 * So either the project was unpaused at some point and real patients were
 * texted, or those rows predate the pause check covering that path. Those
 * are very different facts and the difference is a hundred and twelve
 * people. /health cannot answer it: it counts rows deliberately, because it
 * is unauthenticated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT PRINT, AND WHY THAT IS THE DESIGN RATHER THAN A SETTING.
 *
 * No phone number, no message body, no patient name, no address, and no
 * order reference. A phone number beside the words "delivery" and "patient"
 * identifies somebody as receiving medication, which is the whole reason
 * the text itself names no pharmacy and no drug.
 *
 * External references are grouped BY PREFIX and never printed whole: on
 * this contract a reference is an RX number, and an RX number is not a
 * thing to put in a report that gets pasted into a chat window. The prefix
 * is enough to answer the question that matters -- whether these rows sit
 * behind real imported deliveries or behind test data.
 *
 * Distinct recipients are COUNTED, not listed, for the same reason.
 *
 * READ-ONLY. There is no UPDATE, INSERT or DELETE anywhere in this file, so
 * it is safe against production while deciding what to do.
 */

import { createClient } from '@libsql/client';

const url = process.env['TURSO_DATABASE_URL'] ?? '';
const authToken = process.env['TURSO_AUTH_TOKEN'] ?? '';
if (url === '' || /[<>]/.test(url)) {
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first, or use .\\sms-audit.ps1');
    process.exit(1);
}

const client = createClient({ url, authToken });
const rows = async (sql, args = []) => (await client.execute({ sql, args })).rows;

const head = (text) => console.log(`\n── ${text}`);
const line = (label, value) => console.log(`   ${String(label).padEnd(30)} ${value}`);
const none = () => console.log('   (none)');

console.log('\n  PATIENT TEXTS: what has been sent, and when.');
console.log('  Read-only. No number, body, name or reference is printed.');

/* ─────────────────────────────── the switch, so the report stands alone */
head('The pause, per project');
for (const r of await rows('SELECT code, settings FROM projects ORDER BY id')) {
    let paused = true;
    try {
        const stored = JSON.parse(String(r.settings ?? '{}'));
        /* The DEFAULT IS PAUSED, so an absent key reads as paused -- which
           is what resolveSettings does and what the server acts on. Reading
           it as "not paused" here would report the opposite of the truth
           about every project that has never been configured. */
        paused = stored?.patientSms?.paused !== false;
    } catch { paused = true; }
    line(String(r.code), paused ? 'PAUSED' : 'armed -- will text on assignment');
}

/* ─────────────────────────────── the totals /health reports */
head('Every row in patient_messages');
const totals = (await rows(
    `SELECT COUNT(*) AS all_rows,
            SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN sent_at IS NOT NULL AND failed_reason = '' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN failed_reason != '' THEN 1 ELSE 0 END) AS failed,
            COUNT(DISTINCT phone) AS people
       FROM patient_messages`,
))[0];
line('rows', Number(totals.all_rows ?? 0));
line('accepted by Twilio', Number(totals.sent ?? 0));
line('waiting', Number(totals.waiting ?? 0));
line('failed or opted out', Number(totals.failed ?? 0));
/* Counted, never listed. The figure answers "how many people" without
   answering "which people", and only the first is anybody's business. */
line('distinct numbers', Number(totals.people ?? 0));

/* ─────────────────────────────── by project and kind */
head('By project and message kind');
const byKind = await rows(
    `SELECT p.code, m.kind,
            COUNT(*) AS n,
            SUM(CASE WHEN m.sent_at IS NOT NULL AND m.failed_reason = '' THEN 1 ELSE 0 END) AS sent
       FROM patient_messages m JOIN projects p ON p.id = m.project_id
      GROUP BY p.code, m.kind ORDER BY COUNT(*) DESC`,
);
if (byKind.length === 0) none();
for (const r of byKind) {
    const n = Number(r.n);
    line(`${r.code} / ${r.kind}`, `${n} row${n === 1 ? '' : 's'}, ${r.sent ?? 0} sent`);
}

/* ─────────────────────────────── THE ONE THAT ANSWERS THE QUESTION */
head('When they were sent, by day');
console.log('   If every one of these is an old day, the pause has held since.');
console.log('   A recent day means the project was armed then, and somebody');
console.log('   should know who turned it on and who received them.\n');
const days = await rows(
    `SELECT substr(sent_at, 1, 10) AS day, COUNT(*) AS n
       FROM patient_messages
      WHERE sent_at IS NOT NULL AND failed_reason = ''
      GROUP BY substr(sent_at, 1, 10) ORDER BY day`,
);
if (days.length === 0) none();
for (const r of days) line(String(r.day), `${r.n} sent`);

head('When the rows were WRITTEN, by day');
console.log('   Queued and sent are different moments: a queue made before a');
console.log('   pause is left where it is, and goes out when it resumes.\n');
const made = await rows(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM patient_messages GROUP BY substr(created_at, 1, 10) ORDER BY day`,
);
if (made.length === 0) none();
for (const r of made) line(String(r.day), `${r.n} queued`);

/* ─────────────────────────────── real deliveries, or test rows? */
head('What the orders behind them look like');
console.log('   Grouped by reference PREFIX. A reference is an RX number on');
console.log('   this contract and is never printed whole.\n');
const sources = await rows(
    `SELECT CASE
              WHEN o.external_ref LIKE 'DEMO-%' THEN 'DEMO-   (seed-demo)'
              WHEN o.external_ref LIKE 'MOCK-%' THEN 'MOCK-   (mock-list.mjs)'
              WHEN o.external_ref LIKE 'SMS-%'  THEN 'SMS-    (test fixture)'
              WHEN o.external_ref LIKE 'RX-%'   THEN 'RX-     (seed-one-delivery)'
              WHEN o.external_ref IS NULL OR o.external_ref = '' THEN '(no reference)'
              ELSE 'other   (looks like a real import)'
            END AS source,
            COUNT(*) AS n,
            MIN(o.service_date) AS first_day,
            MAX(o.service_date) AS last_day
       FROM patient_messages m JOIN orders o ON o.id = m.order_id
      GROUP BY source ORDER BY COUNT(*) DESC`,
);
if (sources.length === 0) none();
for (const r of sources) {
    line(String(r.source), `${r.n} -- ${r.first_day ?? '?'} to ${r.last_day ?? '?'}`);
}

/* ─────────────────────────────── failures, by reason */
head('Why sends failed');
console.log('   The reason, which is the half that decides the fix. Never the');
console.log('   recipient.\n');
const why = await rows(
    `SELECT failed_reason, COUNT(*) AS n FROM patient_messages
      WHERE failed_reason != '' GROUP BY failed_reason ORDER BY COUNT(*) DESC LIMIT 20`,
);
if (why.length === 0) none();
for (const r of why) line(String(r.failed_reason).slice(0, 60), Number(r.n));

head('People who have opted out');
const outs = (await rows('SELECT COUNT(*) AS n FROM patient_optouts'))[0];
line('numbers suppressed', Number(outs.n ?? 0));
console.log('   Their decision, recorded once and permanently. Twilio refuses');
console.log('   these at their end whatever this table says.');

console.log('');
