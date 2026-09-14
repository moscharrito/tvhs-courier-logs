/* Keeping things, and stopping keeping them.
 *
 * Ticket 4.6. The sweep is easy to get right and the purge is easy to get
 * catastrophically wrong, so most of this file is about the purge refusing:
 * refusing a category nobody has decided a period for, refusing when the
 * count has moved since the approver looked, refusing to delete photographs
 * it has no way to actually delete.
 *
 * The one case that deletes checks the whole chain, custody events included,
 * because custody_events is append-only in the database and a purge that
 * silently could not remove half of what it claimed to remove would be worse
 * than one that refuses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { RETENTION, SWEPT, cutoffFor } from '../src/core/retention/policy.ts';
import { sweep, purge, lastSweep, SWEEP_INTERVAL_MS } from '../src/core/retention/sweep.ts';

let srv;
let admin;
let client;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => client.execute({ sql: q, args });
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const dayOf = (d) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------- the policy */

describe('the policy', () => {
    it('marks as undecided every period a developer would otherwise have chosen', () => {
        /* The whole point. A retention period somebody invented is not a
           retention period; it is a number that turns up in an audit years
           later attached to deleted evidence. */
        for (const category of ['delivery_records', 'proof_of_delivery_files', 'signatures', 'invoices']) {
            expect(RETENTION[category].decided, category).toBe(false);
            expect(RETENTION[category].basis, category).toMatch(/PLACEHOLDER/);
        }
    });

    it('keeps the audit trail, and says why in the policy rather than in a comment', () => {
        expect(RETENTION.audit_events.days).toBeNull();
        expect(RETENTION.audit_events.purgeable).toBe(false);
        expect(RETENTION.audit_events.basis).toMatch(/destroy the proof/);
    });

    it('has one period that really was decided, because it is not a record of anything', () => {
        expect(RETENTION.client_events.decided).toBe(true);
        expect(RETENTION.client_events.days).toBe(7);
    });

    it('turns a period into a date, and no period into no date', () => {
        const now = new Date('2026-09-13T12:00:00Z');
        expect(cutoffFor({ days: 7 }, now)).toBe('2026-09-06T12:00:00.000Z');
        expect(cutoffFor({ days: null }, now)).toBeNull();
    });
});

/* -------------------------------------------------------------- the sweep */

describe('the sweep', () => {
    it('counts every category and writes down that it ran', async () => {
        const result = await sweep(client, { startedBy: 'test' });
        expect(result.findings.map((f) => f.category)).toEqual(SWEPT);

        const recorded = await lastSweep(client);
        expect(recorded.ranAt).toBe(result.ranAt);
        expect(recorded.totalFlagged).toBe(result.totalFlagged);
    });

    it('writes a row even when it finds nothing, which is the point', async () => {
        /* "Nothing was past retention on 3 November" is exactly what an
           auditor asks for and exactly what nobody can prove afterwards. */
        const before = Number((await sql("SELECT COUNT(*) AS n FROM retention_runs WHERE kind = 'sweep'")).rows[0].n);
        const result = await sweep(client, { startedBy: 'test' });
        const after = Number((await sql("SELECT COUNT(*) AS n FROM retention_runs WHERE kind = 'sweep'")).rows[0].n);
        expect(after).toBe(before + 1);
        expect(result.findings.every((f) => typeof f.count === 'number')).toBe(true);
    });

    it('carries "nobody decided this" alongside the number', async () => {
        const result = await sweep(client, { record: false });
        const delivery = result.findings.find((f) => f.category === 'delivery_records');
        expect(delivery.decided).toBe(false);
        expect(delivery.cutoff).toBeTruthy();
        // Counted against the placeholder, so the size of the decision is visible.
        expect(typeof delivery.count).toBe('number');
    });

    it('gives the audit trail no cutoff at all, rather than a far-off one', async () => {
        const result = await sweep(client, { record: false });
        const audit = result.findings.find((f) => f.category === 'audit_events');
        expect(audit.cutoff).toBeNull();
        expect(audit.count).toBe(0);
    });

    it('finds an old record once there is one', async () => {
        const old = dayOf(daysAgo(9 * 365));
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
             VALUES (1, 'retention-old-1', 'someone', 'POST', '/x', 'done', ?)`,
            [daysAgo(30).toISOString()],
        );
        const result = await sweep(client, { record: false });
        const events = result.findings.find((f) => f.category === 'client_events');
        expect(events.count).toBeGreaterThanOrEqual(1);
        expect(events.oldest).toBeTruthy();
        expect(old).toBeTruthy();
    });

    it('runs daily, which is as often as a counting job tells anybody anything', () => {
        expect(SWEEP_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    });
});

/* -------------------------------------------------------------- the purge */

describe('the purge refuses', () => {
    it('a category nobody has decided a period for', async () => {
        const res = await purge(client, { category: 'delivery_records', expected: 0, reason: 'tidying up', startedBy: 'test' });
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('undecided');
        expect(res.message).toMatch(/PLACEHOLDER/);
    });

    it('the audit trail, always', async () => {
        const res = await purge(client, { category: 'audit_events', expected: 0, reason: 'tidying up', startedBy: 'test' });
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('not_purgeable');
    });

    it('an issued invoice, which is a document that left the building', async () => {
        const res = await purge(client, { category: 'invoices', expected: 0, reason: 'tidying up', startedBy: 'test' });
        expect(res.ok).toBe(false);
        // Undecided first, and not purgeable either way.
        expect(['undecided', 'not_purgeable']).toContain(res.reason);
    });

    it('when the count has moved since the approver looked at it', async () => {
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
             VALUES (1, 'retention-moved-1', 'someone', 'POST', '/x', 'done', ?)`,
            [daysAgo(40).toISOString()],
        );
        const res = await purge(client, { category: 'client_events', expected: 999, reason: 'approved from a stale screen', startedBy: 'test' });
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('count_moved');
        expect(res.actual).toBeGreaterThan(0);
        expect(res.message).toMatch(/Look again/);
    });

    it('photographs it has no way to actually delete', async () => {
        /* Deleting the rows without the objects would leave the photographs
           in S3 with nothing pointing at them: unreachable, undeletable, and
           still PHI. Worse than keeping both. */
        await sql(
            `INSERT INTO files (project_id, order_id, kind, s3_key, content_type, bytes, status, uploaded_by, created_at)
             VALUES (1, NULL, 'doorstep', 'uh/2019-01-01/unassigned/doorstep/a.jpg', 'image/jpeg', 10, 'stored', 'someone', ?)`,
            [daysAgo(9 * 365).toISOString()],
        );
        const decided = { ...RETENTION.proof_of_delivery_files };
        RETENTION.proof_of_delivery_files.decided = true;
        try {
            const res = await purge(client, {
                category: 'proof_of_delivery_files', expected: 1, reason: 'past retention, approved', startedBy: 'test',
            });
            expect(res.ok).toBe(false);
            expect(res.reason).toBe('files_unavailable');
            expect(res.message).toMatch(/ticket 0\.10/);
        } finally {
            RETENTION.proof_of_delivery_files.decided = decided.decided;
        }
        // The row is still there, because nothing was removed.
        expect(Number((await sql("SELECT COUNT(*) AS n FROM files WHERE s3_key LIKE 'uh/2019-01-01/%'")).rows[0].n)).toBe(1);
    });
});

describe('the purge, when everything lines up', () => {
    it('removes exactly the approved rows and writes down what it did', async () => {
        await sql('DELETE FROM client_events');
        for (let i = 0; i < 3; i += 1) {
            await sql(
                `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
                 VALUES (1, ?, 'someone', 'POST', '/x', 'done', ?)`,
                [`retention-purge-${i}`, daysAgo(30).toISOString()],
            );
        }
        // And one that is not past retention, which must survive.
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
             VALUES (1, 'retention-fresh', 'someone', 'POST', '/x', 'done', ?)`,
            [new Date().toISOString()],
        );

        const res = await purge(client, { category: 'client_events', expected: 3, reason: 'past the seven day window', startedBy: 'admin' });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.removed).toBe(3);

        expect(Number((await sql('SELECT COUNT(*) AS n FROM client_events')).rows[0].n)).toBe(1);

        const run = (await sql("SELECT * FROM retention_runs WHERE kind = 'purge' ORDER BY id DESC LIMIT 1")).rows[0];
        expect(run.category).toBe('client_events');
        expect(Number(run.row_count)).toBe(3);
        expect(run.reason).toBe('past the seven day window');
        expect(run.started_by).toBe('admin');
    });

    it('takes the custody events with the order, and puts the trigger back', async () => {
        /* custody_events is append-only, enforced by a trigger, because a
           chain of custody that can be edited is not evidence. The purge
           drops and recreates it around the delete. If it ever failed to put
           it back, the table would silently stop being evidence. */
        const siteId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
        const created = await admin.post('/api/projects/uh/uh/orders').send({
            siteId, serviceType: 'stat', recipientName: 'Old Recipient', addressLine: '1 Old Street',
            zip: '78215', description: 'Oral solids', quantity: 1, externalRef: 'RX-OLD-1', signatureRequired: false,
        });
        expect(created.status, created.text).toBe(201);
        const orderId = created.body.id;
        const old = dayOf(daysAgo(9 * 365));
        await sql('UPDATE orders SET service_date = ? WHERE id = ?', [old, orderId]);

        expect(Number((await sql('SELECT COUNT(*) AS n FROM custody_events WHERE order_id = ?', [orderId])).rows[0].n)).toBeGreaterThan(0);

        const decided = RETENTION.delivery_records.decided;
        RETENTION.delivery_records.decided = true;
        let res;
        try {
            const expected = Number((await sql('SELECT COUNT(*) AS n FROM orders WHERE service_date < ?', [dayOf(daysAgo(7 * 365))])).rows[0].n);
            res = await purge(client, { category: 'delivery_records', expected, reason: 'past retention, approved by the count', startedBy: 'admin' });
        } finally {
            RETENTION.delivery_records.decided = decided;
        }
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.removed).toBeGreaterThanOrEqual(1);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM orders WHERE id = ?', [orderId])).rows[0].n)).toBe(0);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM custody_events WHERE order_id = ?', [orderId])).rows[0].n)).toBe(0);

        // The trigger is back, so the table is append-only again.
        const triggers = await sql("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custody_events_no_delete'");
        expect(triggers.rows).toHaveLength(1);

        /* And it actually fires. A BEFORE DELETE trigger runs per deleted
           row, so this has to aim at a row that exists: `WHERE id = -1`
           deletes nothing and passes whether the trigger is there or not,
           which is how a test like this quietly stops testing anything. */
        const survivor = await admin.post('/api/projects/uh/uh/orders').send({
            siteId, serviceType: 'stat', recipientName: 'Current Recipient', addressLine: '2 New Street',
            zip: '78215', description: 'Oral solids', quantity: 1, externalRef: 'RX-NEW-1', signatureRequired: false,
        });
        expect(survivor.status, survivor.text).toBe(201);
        const event = (await sql('SELECT id FROM custody_events WHERE order_id = ? LIMIT 1', [survivor.body.id])).rows[0];
        expect(event).toBeTruthy();
        await expect(sql('DELETE FROM custody_events WHERE id = ?', [Number(event.id)])).rejects.toThrow(/append-only/);
    });
});

/* --------------------------------------------------------------- the API */

describe('over HTTP', () => {
    it('shows the policy, the last sweep and the recent runs', async () => {
        const res = await admin.get('/api/retention');
        expect(res.status).toBe(200);
        expect(res.body.policy.map((p) => p.category)).toEqual(SWEPT);
        expect(res.body.policy.find((p) => p.category === 'audit_events').purgeable).toBe(false);
        expect(res.body.mechanics).toMatch(/append-only/);
        expect(res.body.recentRuns.length).toBeGreaterThan(0);
    });

    it('sweeps on request', async () => {
        const res = await admin.post('/api/retention/sweep').send({});
        expect(res.status).toBe(201);
        expect(res.body.findings).toHaveLength(SWEPT.length);
    });

    it('wants a reason long enough to be a reason', async () => {
        const res = await admin.post('/api/retention/purge').send({ category: 'client_events', expected: 0, reason: 'x' });
        expect(res.status).toBe(400);
    });

    it('refuses an undecided category with the reason a person can act on', async () => {
        const res = await admin.post('/api/retention/purge')
            .send({ category: 'delivery_records', expected: 0, reason: 'clearing out old deliveries' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('retention.undecided');
        expect(res.body.error).toMatch(/compliance counsel/);
    });

    it('answers a moved count with a conflict and the real number', async () => {
        await sql(
            `INSERT INTO client_events (project_id, client_event_id, username, method, path, state, created_at)
             VALUES (1, 'retention-http-1', 'someone', 'POST', '/x', 'done', ?)`,
            [daysAgo(40).toISOString()],
        );
        const res = await admin.post('/api/retention/purge')
            .send({ category: 'client_events', expected: 99, reason: 'approved from a stale screen' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('retention.count_moved');
        expect(res.body.actual).toBeGreaterThan(0);
    });

    it('records the request before the delete, so an interrupted purge still says what was meant', async () => {
        const actual = Number((await sql("SELECT COUNT(*) AS n FROM client_events WHERE created_at < datetime('now','-7 days')")).rows[0].n);
        const res = await admin.post('/api/retention/purge')
            .send({ category: 'client_events', expected: actual, reason: 'past the seven day window' });
        expect(res.status, res.text).toBe(200);

        const actions = (await sql(
            "SELECT action FROM audit_events WHERE action LIKE 'retention.%' ORDER BY id DESC LIMIT 6",
        )).rows.map((r) => r.action);
        expect(actions).toContain('retention.purged');
        expect(actions).toContain('retention.purge_requested');
    });

    it('is closed to everybody but a platform administrator', async () => {
        const north = await srv.login('north');
        expect((await north.get('/api/retention')).status).toBe(403);
        expect((await srv.agent().get('/api/retention')).status).toBe(401);
    });
});
