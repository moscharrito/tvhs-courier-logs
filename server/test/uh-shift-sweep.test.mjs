/* Shifts nobody closed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS WORTH TESTING HERE.
 *
 * The sweep has one interesting property and it is a refusal. Closing a
 * forgotten empty shift is housekeeping and a test of it proves little.
 * Declining to close one that is still carrying packages is the whole
 * design: shifts.ts will not let a courier go off shift with medication in
 * the van, and a sweep that tidied those rows away at midnight would defeat
 * that rule quietly, leaving the packages exactly where they were and
 * removing the only thing that said so.
 *
 * The 145-hour shift that prompted this was real, and was on the board on
 * 28 October 2026.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepStaleShifts, STALE_AFTER_HOURS } from '../src/modules/uh/shift-sweep.ts';

const UH = '/api/projects/uh/uh';

let srv;
let admin;
let projectId;
let siteId;

const hoursAgo = (n) => new Date(Date.now() - n * 3600_000).toISOString();

/** An open shift for `username`, started `hours` ago. */
async function openShift(username, hours) {
    await srv.core.client.execute({
        sql: 'DELETE FROM shifts WHERE courier_username = ?',
        args: [username],
    });
    const rs = await srv.core.client.execute({
        sql: 'INSERT INTO shifts (project_id, courier_username, started_at) VALUES (?, ?, ?) RETURNING id',
        args: [projectId, username, hoursAgo(hours)],
    });
    return Number(rs.rows[0].id);
}

const shiftRow = async (id) => (await srv.core.client.execute({
    sql: 'SELECT ended_at, ended_by, ended_reason FROM shifts WHERE id = ?',
    args: [id],
})).rows[0];

async function makeDriver(username, name) {
    await admin.post('/api/users').send({ username, name, password: `${username}-pass-1`, role: 'driver' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
}

/** An order picked up by `username` and never delivered: still in the van. */
async function packageInTheVan(username) {
    const created = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'adhoc', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id;
    expect((await admin.post(`${UH}/orders/${id}/events`).send({ type: 'assigned', courierUsername: username })).status).toBe(201);
    expect((await admin.post(`${UH}/orders/${id}/events`).send({ type: 'picked_up', signedName: 'Pharmacy Tech' })).status).toBe(201);
    return id;
}

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    projectId = Number((await srv.core.client.execute({
        sql: "SELECT id FROM projects WHERE code = 'uh'", args: [],
    })).rows[0].id);

    await makeDriver('sweep.empty', 'Empty Van');
    await makeDriver('sweep.loaded', 'Loaded Van');
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('sweeping stale shifts', () => {
    it('leaves a shift that is merely long alone', async () => {
        /* Noon to eight is eight hours. Nothing should close under the
           threshold, or a courier working a late STAT gets signed off
           mid-delivery. */
        const id = await openShift('sweep.empty', STALE_AFTER_HOURS - 2);
        const r = await sweepStaleShifts({ client: srv.core.client, projectId });
        expect(r.stale).toBe(0);
        expect(r.closed).toBe(0);
        expect((await shiftRow(id)).ended_at).toBeNull();
    });

    it('closes one left open overnight, and marks it as swept', async () => {
        const id = await openShift('sweep.empty', 145);
        const r = await sweepStaleShifts({ client: srv.core.client, projectId });
        expect(r.closed).toBe(1);

        const row = await shiftRow(id);
        expect(row.ended_at).not.toBeNull();
        /* Not the courier's own name. A timesheet has to be able to tell a
           shift somebody signed off from one a sweep guessed at. */
        expect(String(row.ended_by)).toBe('system');
        expect(String(row.ended_reason)).toMatch(/left open overnight/i);
    });

    it('REFUSES to close a shift that is still carrying packages', async () => {
        /* The one that matters. shifts.ts will not let a courier leave with
           medication in the van; a sweep that closed the row anyway would
           defeat that rule and hide the packages at the same time. */
        const id = await openShift('sweep.loaded', 145);
        await packageInTheVan('sweep.loaded');

        const r = await sweepStaleShifts({ client: srv.core.client, projectId });
        expect(r.carrying.map((c) => c.courier)).toContain('sweep.loaded');
        expect((await shiftRow(id)).ended_at).toBeNull();
    });

    it('tells dispatch about the carrying one, once', async () => {
        const told = await srv.core.client.execute({
            sql: "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'shift.carryingOvernight'",
            args: [],
        });
        expect(Number(told.rows[0].n)).toBeGreaterThan(0);

        /* The sweep runs every couple of minutes and this condition lasts
           until somebody drives the packages back. Saying it each time
           would bury every other notification by morning. */
        const before = Number((await srv.core.client.execute({
            sql: "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'shift.carryingOvernight'",
            args: [],
        })).rows[0].n);
        await sweepStaleShifts({ client: srv.core.client, projectId });
        const after = Number((await srv.core.client.execute({
            sql: "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'shift.carryingOvernight'",
            args: [],
        })).rows[0].n);
        expect(after).toBe(before);
    });

    it('never names a patient in what it tells dispatch', async () => {
        /* A notification is read on a lock screen. It carries a courier, a
           count and a shift id, and must not carry who the medication was
           for -- the order is in the van, so the recipient is the one piece
           of this that is patient data. */
        const rows = await srv.core.client.execute({
            sql: "SELECT body FROM notifications WHERE kind = 'shift.carryingOvernight'",
            args: [],
        });
        for (const row of rows.rows) {
            expect(String(row.body)).not.toMatch(/Ines Vargas/i);
            expect(String(row.body)).not.toMatch(/Broadway/i);
        }
    });

    it('returns an empty result rather than throwing when the table is unreadable', async () => {
        /* It runs on the scheduler's interval. An unhandled rejection there
           takes the process down with it. */
        const r = await sweepStaleShifts({ client: srv.core.client, projectId: -1 });
        expect(r).toMatchObject({ stale: 0, closed: 0, told: 0 });
    });
});
