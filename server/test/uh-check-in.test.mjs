/* The driver who had work today and never came on shift.
 *
 * "Ensure every driver checks in on the App at 10AM" is the site manager's
 * job (Izy Business, 26 October 2026) and nothing watched it, because the
 * failure is silent: a courier who does not appear produces no error and no
 * row. The board shows them not on shift, which looks exactly like somebody
 * running ten minutes late.
 *
 * MOST OF THESE TESTS ARE ABOUT STAYING QUIET. An alarm that fires on a
 * courier who is simply off today, or fires again every two minutes, is an
 * alarm people learn to scroll past -- and then the one that matters
 * scrolls past too. So the cases here are mostly the ones where it must say
 * nothing at all.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepCheckIn } from '../src/modules/uh/check-in.ts';

const ORDERS = '/api/projects/uh/uh/orders';
const RUNS = '/api/projects/uh/uh/runs';
const TZ = 'America/Chicago';

let srv, admin, projectId, dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;

    for (const [username, name] of [['late.courier', 'Late Courier'], ['keen.courier', 'Keen Courier']]) {
        await admin.post('/api/users').send({ username, name, password: 'checkin-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
    }
    /* Somebody to tell. dispatchersOf returns admins and leads. */
    await admin.post('/api/users').send({ username: 'watch.lead', name: 'Site Manager', password: 'checkin-pass-1', role: 'staff' });
    await admin.put('/api/users/watch.lead/memberships/uh').send({ role: 'lead', settings: {} });
});
afterAll(async () => { await srv.stop(); });

function sql(q, args = []) { return srv.core.client.execute({ sql: q, args }); }

/* 2026-10-27 is a Tuesday. 15:30Z is 10:30 in Chicago (CDT, UTC-5), so it
   is half an hour past a 10:00 deadline; 13:00Z is 08:00 and is not. */
const SERVICE_DATE = '2026-10-27';
const PAST_DEADLINE = new Date('2026-10-27T15:30:00.000Z');
const BEFORE_DEADLINE = new Date('2026-10-27T13:00:00.000Z');

beforeEach(async () => {
    await sql('DELETE FROM notifications');
    await sql('DELETE FROM shifts');
    await sql('DELETE FROM run_stops');
    await sql('DELETE FROM runs');
    await sql("UPDATE projects SET settings = '{}' WHERE id = ?", [projectId]);
});

/** A run for that courier on the service date, straight into the table:
 *  the API would put it on today, and these tests pick their own day. */
let seq = 0;
async function runFor(username, date = SERVICE_DATE) {
    seq += 1;
    await sql(
        `INSERT INTO runs (project_id, courier_username, label, service_date, status, created_at)
         VALUES (?, ?, ?, ?, 'planned', ?)`,
        [projectId, username, `Run ${seq}`, date, new Date().toISOString()],
    );
}

/** A shift that started at a given instant. */
async function shiftStartedAt(username, at) {
    await sql(
        'INSERT INTO shifts (project_id, courier_username, started_at, ended_at) VALUES (?, ?, ?, ?)',
        [projectId, username, at.toISOString(), null],
    );
}

const sweep = (now = PAST_DEADLINE) => sweepCheckIn({ client: srv.core.client, projectId, timezone: TZ, now });
const missedRows = async () => (await sql("SELECT username, body FROM notifications WHERE kind = 'shift.missed' ORDER BY id")).rows;

describe('when it must say something', () => {
    it('reports a courier with a run who has not come on shift', async () => {
        await runFor('late.courier');
        const out = await sweep();

        expect(out).toMatchObject({ expected: 1, missing: 1, told: 1 });
        const rows = await missedRows();
        /* One per person who runs the board. */
        expect(rows.map((r) => String(r.username)).sort()).toEqual(['admin', 'watch.lead']);
        expect(String(rows[0].body)).toContain('late.courier');
        expect(String(rows[0].body), 'the deadline it missed').toContain('10:00');
    });

    it('names how much work is sitting there, because that is the size of it', async () => {
        await runFor('late.courier');
        await runFor('late.courier');
        await sweep();
        expect(String((await missedRows())[0].body)).toContain('2 runs');
        expect(String((await missedRows())[0].body), 'names its own day').toContain(SERVICE_DATE);
    });

    it('reports each missing courier separately', async () => {
        await runFor('late.courier');
        await runFor('keen.courier');
        const out = await sweep();
        expect(out).toMatchObject({ expected: 2, missing: 2 });
        const bodies = (await missedRows()).map((r) => String(r.body));
        expect(bodies.some((b) => b.includes('late.courier'))).toBe(true);
        expect(bodies.some((b) => b.includes('keen.courier'))).toBe(true);
    });
});

describe('when it must stay quiet', () => {
    it('says nothing before the deadline', async () => {
        /* 08:00 in Chicago. A courier who starts at nine is not late at
           eight, and a warning then is a warning about nothing. */
        await runFor('late.courier');
        const out = await sweep(BEFORE_DEADLINE);
        expect(out.skipped).toBe('tooEarly');
        expect(await missedRows()).toHaveLength(0);
    });

    it('says nothing about a courier with no work today', async () => {
        /* THE REASON IT MEASURES AGAINST THE RUN SHEET. Some couriers are
           off on any given day, and firing for them every morning is how an
           alarm becomes background noise. */
        const out = await sweep();
        expect(out).toMatchObject({ expected: 0, missing: 0, told: 0 });
        expect(await missedRows()).toHaveLength(0);
    });

    it('counts a shift that started and already ended as checked in', async () => {
        /* Came on at 09:40, worked, went off at 09:55. Asking whether a
           shift is open RIGHT NOW would call that missing at 10:00, which
           is wrong and is the kind of wrong that teaches people to ignore
           the alarm. */
        await runFor('keen.courier');
        await shiftStartedAt('keen.courier', new Date('2026-10-27T14:40:00.000Z'));
        await sql("UPDATE shifts SET ended_at = ? WHERE courier_username = 'keen.courier'", ['2026-10-27T14:55:00.000Z']);

        const out = await sweep();
        expect(out).toMatchObject({ expected: 1, missing: 0 });
        expect(await missedRows()).toHaveLength(0);
    });

    it('does not count yesterday\'s shift as today\'s check-in', async () => {
        /* The window is the service date in the project's own timezone. A
           shift that started yesterday evening is not this morning. */
        await runFor('late.courier');
        await shiftStartedAt('late.courier', new Date('2026-10-26T20:00:00.000Z'));
        const out = await sweep();
        expect(out).toMatchObject({ expected: 1, missing: 1 });
    });

    it('ignores a run for a different day', async () => {
        await runFor('late.courier', '2026-10-28');
        const out = await sweep();
        expect(out).toMatchObject({ expected: 0, missing: 0 });
    });

    it('says it once, not once every two minutes', async () => {
        /* THE SWEEP RUNS EVERY 120 SECONDS and a missing driver stays
           missing. Without this it would say so three hundred times before
           lunch, which is the same as saying it never. */
        await runFor('late.courier');
        const first = await sweep();
        const second = await sweep();
        const third = await sweep();

        expect(first.told).toBe(1);
        expect(second.told, 'already said').toBe(0);
        expect(third.told).toBe(0);
        /* Two rows: one per dispatcher, from the first sweep only. */
        expect(await missedRows()).toHaveLength(2);
        /* And it still reports the state, so the caller is not told the
           problem went away. */
        expect(second).toMatchObject({ expected: 1, missing: 1 });
    });

    it('says nothing when the watch is switched off', async () => {
        await sql("UPDATE projects SET settings = ? WHERE id = ?", [JSON.stringify({ checkIn: { watch: false } }), projectId]);
        await runFor('late.courier');
        const out = await sweep();
        expect(out.skipped).toBe('off');
        expect(await missedRows()).toHaveLength(0);
    });
});

describe('the deadline is the contract\'s, not ours', () => {
    it('uses the time the project was given', async () => {
        /* A depot that starts at eight should not have to edit TypeScript.
           09:00 Chicago is 14:00Z, so an 08:00 deadline has passed. */
        await sql("UPDATE projects SET settings = ? WHERE id = ?", [JSON.stringify({ checkIn: { deadline: '08:00' } }), projectId]);
        await runFor('late.courier');
        const out = await sweep(new Date('2026-10-27T14:00:00.000Z'));
        expect(out).toMatchObject({ expected: 1, missing: 1, told: 1 });
        expect(String((await missedRows())[0].body)).toContain('08:00');
    });

    it('is still before a later deadline at the same moment', async () => {
        await sql("UPDATE projects SET settings = ? WHERE id = ?", [JSON.stringify({ checkIn: { deadline: '11:00' } }), projectId]);
        await runFor('late.courier');
        const out = await sweep(new Date('2026-10-27T15:30:00.000Z'));
        expect(out.skipped).toBe('tooEarly');
    });

    it('falls back rather than throwing on a deadline somebody broke', async () => {
        /* settings are a hand-editable blob. A bad value must not take the
           timer down with it. */
        await sql("UPDATE projects SET settings = ? WHERE id = ?", [JSON.stringify({ checkIn: { deadline: 'half ten' } }), projectId]);
        await runFor('late.courier');
        const out = await sweep();
        /* resolveSettings refuses the wrong shape and hands back the
           default, so the watch carries on at 10:00 rather than stopping. */
        expect(out).toMatchObject({ expected: 1, missing: 1 });
    });
});
