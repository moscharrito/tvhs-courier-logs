/* The morning where nobody dispatched anything.
 *
 * This is the silence modules/uh/check-in.ts cannot see. That watch reports
 * a courier who has a run and has not come on shift, which means it
 * measures against the run sheet -- and a day with no run sheet produces no
 * expected couriers and therefore no alarm. A day where the lists never
 * arrived is, to that watch, indistinguishable from a quiet day that went
 * perfectly.
 *
 * The two faults it separates are the point. "Nothing arrived" is somebody
 * ringing the pharmacies; "it arrived and nobody dispatched it" is our own
 * end, with deadlines already running. Telling somebody the wrong one
 * first costs the morning.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepDayStart } from '../src/modules/uh/day-start.ts';

const TZ = 'America/Chicago';
/* 2026-10-27 is a Tuesday. listRelease.latest defaults to 14:00, which in
   Chicago (CDT, UTC-5) is 19:00Z. 19:30Z is past it; 17:00Z is noon and is
   not. */
const SERVICE_DATE = '2026-10-27';
const PAST_DEADLINE = new Date('2026-10-27T19:30:00.000Z');
const BEFORE_DEADLINE = new Date('2026-10-27T17:00:00.000Z');

let srv, admin, projectId, dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
    await admin.post('/api/users').send({ username: 'day.lead', name: 'Site Manager', password: 'day-pass-1', role: 'staff' });
    await admin.put('/api/users/day.lead/memberships/uh').send({ role: 'lead', settings: {} });
    await admin.post('/api/users').send({ username: 'day.courier', name: 'A Courier', password: 'day-pass-1', role: 'driver' });
    await admin.put('/api/users/day.courier/memberships/uh').send({ role: 'courier', settings: {} });
});
afterAll(async () => { await srv.stop(); });

function sql(q, args = []) { return srv.core.client.execute({ sql: q, args }); }

beforeEach(async () => {
    await sql('DELETE FROM notifications');
    await sql('DELETE FROM run_stops');
    await sql('DELETE FROM runs');
    await sql('DELETE FROM orders');
    await sql("UPDATE projects SET settings = '{}' WHERE id = ?", [projectId]);
});

let seq = 0;
async function orderOn(date = SERVICE_DATE) {
    seq += 1;
    await sql(
        `INSERT INTO orders (project_id, site_id, service_date, service_type, status,
                             recipient_name, address_line, zip, received_at)
         VALUES (?, ?, ?, 'scheduled', 'ready', ?, ?, '78215', ?)`,
        [projectId, dischargeId, date, `Recipient ${seq}`, `${seq} Day Street`, new Date().toISOString()],
    );
}

async function runOn(date = SERVICE_DATE) {
    seq += 1;
    await sql(
        `INSERT INTO runs (project_id, courier_username, label, service_date, status, created_at)
         VALUES (?, 'day.courier', ?, ?, 'planned', ?)`,
        [projectId, `Run ${seq}`, date, new Date().toISOString()],
    );
}

const sweep = (now = PAST_DEADLINE) => sweepDayStart({ client: srv.core.client, projectId, timezone: TZ, now });
const told = async () => (await sql("SELECT username, body FROM notifications WHERE kind = 'dispatch.notStarted' ORDER BY id")).rows;

describe('nothing arrived', () => {
    it('says the lists never came, and whose end that is', async () => {
        const out = await sweep();
        expect(out).toMatchObject({ orders: 0, runs: 0, state: 'noOrders', told: 1 });

        const rows = await told();
        expect(rows.map((r) => String(r.username)).sort()).toEqual(['admin', 'day.lead']);
        const body = String(rows[0].body);
        expect(body).toContain(SERVICE_DATE);
        expect(body, 'the time they were due by').toContain('14:00');
        expect(body, 'what to do about it').toMatch(/Ring the pharmacies/i);
    });
});

describe('it arrived and nobody dispatched it', () => {
    it('says so differently, because the fix is ours and the clock is running', async () => {
        /* THE URGENT ONE. Collapsing this into "the day has not started"
           would send somebody to ring the pharmacies about deliveries that
           are already sitting on the board. */
        await orderOn();
        await orderOn();
        const out = await sweep();
        expect(out).toMatchObject({ orders: 2, runs: 0, state: 'noRuns', told: 1 });

        const body = String((await told())[0].body);
        expect(body).toContain('2 deliveries');
        expect(body).toMatch(/none of them is on a run/i);
        expect(body, 'not the other fault').not.toMatch(/Ring the pharmacies/i);
    });

    it('gets the singular right, because "1 deliveries" reads like a bug', async () => {
        await orderOn();
        await sweep();
        expect(String((await told())[0].body)).toContain('1 delivery is');
    });
});

describe('when the day did start', () => {
    it('says nothing once there is a run', async () => {
        await orderOn();
        await runOn();
        const out = await sweep();
        expect(out).toMatchObject({ orders: 1, runs: 1, state: 'ok', told: 0 });
        expect(await told()).toHaveLength(0);
    });
});

describe('when it must stay quiet', () => {
    it('says nothing before the lists are due', async () => {
        /* Noon. The lists are not late until two, and an alarm at the
           courier check-in time would be about nothing. */
        const out = await sweep(BEFORE_DEADLINE);
        expect(out.skipped).toBe('tooEarly');
        expect(await told()).toHaveLength(0);
    });

    it('says nothing on a day the contract does not serve', async () => {
        /* UH runs all seven, so this changes nothing for them and
           everything for the next contract that does not. */
        await sql('UPDATE projects SET settings = ? WHERE id = ?',
            [JSON.stringify({ businessHours: { days: [1, 2, 3, 4, 5] } }), projectId]);
        /* 2026-11-01 is a Sunday. */
        const out = await sweepDayStart({
            client: srv.core.client, projectId, timezone: TZ,
            now: new Date('2026-11-01T19:30:00.000Z'),
        });
        expect(out.skipped).toBe('notAServiceDay');
    });

    it('says nothing when the watch is switched off', async () => {
        await sql('UPDATE projects SET settings = ? WHERE id = ?',
            [JSON.stringify({ dayStart: { watch: false } }), projectId]);
        const out = await sweep();
        expect(out.skipped).toBe('off');
    });

    it('says it once, not once every two minutes', async () => {
        await orderOn();
        expect((await sweep()).told).toBe(1);
        expect((await sweep()).told, 'already said').toBe(0);
        expect((await sweep()).told).toBe(0);
        expect(await told(), 'one per dispatcher, from the first sweep').toHaveLength(2);
    });

    it('ignores another day\'s work entirely', async () => {
        await orderOn('2026-10-28');
        await runOn('2026-10-28');
        const out = await sweep();
        /* Tomorrow's list being in early does not mean today started. */
        expect(out).toMatchObject({ orders: 0, runs: 0, state: 'noOrders' });
    });
});

describe('it follows the list window rather than keeping its own', () => {
    it('waits longer when the pharmacies are given longer', async () => {
        /* The deadline is listRelease.latest and is not a second setting,
           so moving the window moves the alarm with it. A number of its own
           would eventually disagree with this one. */
        await sql('UPDATE projects SET settings = ? WHERE id = ?',
            [JSON.stringify({ listRelease: { earliest: '12:00', latest: '16:00' } }), projectId]);
        /* 19:30Z is 14:30 in Chicago: past the default, before this one. */
        expect((await sweep()).skipped).toBe('tooEarly');
        /* 21:30Z is 16:30, which is past it. */
        const later = await sweep(new Date('2026-10-27T21:30:00.000Z'));
        expect(later.state).toBe('noOrders');
    });
});
