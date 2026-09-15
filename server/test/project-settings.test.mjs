/* Project settings: the contract defaults, the due-time arithmetic that reads
   them, and the API that changes them.

   The default values are quoted from Addendum 1 in
   server/src/core/projects/settings.ts. A test that only checked "the code
   returns what the code says" would be worthless, so the numbers are written
   out here as literals: changing a service level has to be a deliberate edit
   in two places, not a typo in one. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    DEFAULT_PROJECT_SETTINGS, resolveSettings, mergeSettings, changedPaths,
    dueTimesFor, isValidTimezone,
} from '../src/core/projects/settings.ts';
import { pricingSettingsFrom, isAfterHours } from '../src/modules/uh/pricing.ts';

const UH = '/api/projects/uh/settings';
const TVHS = '/api/projects/tvhs/settings';

let srv;
let admin;
beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

async function memberWith(role, username) {
    await admin.post('/api/users').send({ username, name: `Test ${role}`, password: 'member-pass-12', role: 'staff' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password: 'member-pass-12' })).status).toBe(200);
    return a;
}

/** Put the uh project back on the defaults so test order cannot matter. */
async function reset() {
    await srv.core.client.execute({ sql: `UPDATE projects SET settings = '{}', timezone = 'America/Chicago' WHERE code = 'uh'` });
}

describe('contract defaults', () => {
    it('matches the service levels written in Addendum 1 and Scope 1.2.5', () => {
        expect(DEFAULT_PROJECT_SETTINGS.sla).toEqual({
            // "within two (2) hours of the courier receiving the delivery request"
            clockStart: 'receipt',
            scheduledMinutes: 120,
            // "The two (2) hours refers to the maximum overall delivery time"
            statMinutes: 120,
            // "delivery of the item is completed within one (1) hour of pickup"
            statFromPickupMinutes: 60,
            // Scope 1.2.5, "Non-scheduled Ad hoc: Four (4) hours"
            adhocMinutes: 240,
        });
        // "Business Hours: 8am-8pm", and UH runs weekends (227 weekend stops).
        expect(DEFAULT_PROJECT_SETTINGS.businessHours).toEqual({ start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] });
        // "This is typically provided between 12:00-2:00pm."
        expect(DEFAULT_PROJECT_SETTINGS.listRelease).toEqual({ earliest: '12:00', latest: '14:00' });
        // "specifically between 8:00 p.m. and 7:00 a.m."
        expect(DEFAULT_PROJECT_SETTINGS.pricing).toEqual({ afterHoursStart: '20:00', afterHoursEnd: '07:00', dryRunReplacesBase: true });
    });

    it('is the single source the pricing module reads, so the two cannot drift', () => {
        const p = pricingSettingsFrom({}, 'America/Chicago');
        expect(p).toEqual({ ...DEFAULT_PROJECT_SETTINGS.pricing, timezone: 'America/Chicago' });

        // And an override in the blob reaches pricing.
        const overridden = pricingSettingsFrom({ pricing: { afterHoursEnd: '08:00' } }, 'America/Chicago');
        expect(overridden.afterHoursEnd).toBe('08:00');
        // 07:30 CST: after hours under the Scope reading, business hours under the addendum's.
        const at = new Date('2026-01-15T13:30:00Z');
        expect(isAfterHours(at, overridden)).toBe(true);
        expect(isAfterHours(at, pricingSettingsFrom({}, 'America/Chicago'))).toBe(false);
    });
});

describe('resolveSettings', () => {
    it('fills an empty blob out to the defaults', () => {
        expect(resolveSettings({})).toEqual(DEFAULT_PROJECT_SETTINGS);
        expect(resolveSettings(null)).toEqual(DEFAULT_PROJECT_SETTINGS);
        expect(resolveSettings(undefined)).toEqual(DEFAULT_PROJECT_SETTINGS);
    });

    it('keeps stored values and defaults the rest', () => {
        const r = resolveSettings({ sla: { clockStart: 'pickup' }, listRelease: { latest: '15:00' } });
        expect(r.sla.clockStart).toBe('pickup');
        expect(r.sla.scheduledMinutes).toBe(120);
        expect(r.listRelease).toEqual({ earliest: '12:00', latest: '15:00' });
    });

    it('falls back rather than throwing when the blob is the wrong shape', () => {
        // A hand-edited or half-migrated blob must not break a read.
        const r = resolveSettings({ sla: 'nonsense', businessHours: { start: 7, days: 'all' }, pricing: [] });
        expect(r.sla).toEqual(DEFAULT_PROJECT_SETTINGS.sla);
        expect(r.businessHours).toEqual(DEFAULT_PROJECT_SETTINGS.businessHours);
        expect(r.pricing).toEqual(DEFAULT_PROJECT_SETTINGS.pricing);

        // A blank time must fall back, not reach the clock arithmetic: '' or
        // '   ' would throw out of minutesOfDay on an ordinary quote.
        expect(resolveSettings({ pricing: { afterHoursStart: '   ', afterHoursEnd: '' } }).pricing)
            .toEqual(DEFAULT_PROJECT_SETTINGS.pricing);
        expect(resolveSettings({ listRelease: { earliest: ' 13:00 ' } }).listRelease.earliest).toBe('13:00');
    });
});

describe('mergeSettings and changedPaths', () => {
    it('merges one section without disturbing the others', () => {
        const stored = { sla: { clockStart: 'pickup' }, pricing: { dryRunReplacesBase: false } };
        const next = mergeSettings(stored, { pricing: { afterHoursEnd: '08:00' } });
        expect(next).toEqual({
            sla: { clockStart: 'pickup' },
            pricing: { dryRunReplacesBase: false, afterHoursEnd: '08:00' },
        });
    });

    it('names only the leaves that actually moved', () => {
        const before = resolveSettings({});
        const after = resolveSettings({ sla: { clockStart: 'pickup' }, pricing: { afterHoursEnd: '08:00' } });
        expect(changedPaths(before, after).sort()).toEqual(['pricing.afterHoursEnd', 'sla.clockStart']);
        // Writing a value equal to the default is not a change.
        expect(changedPaths(before, resolveSettings({ sla: { clockStart: 'receipt' } }))).toEqual([]);
    });
});

describe('dueTimesFor', () => {
    const received = new Date('2026-09-14T17:00:00Z'); // noon CDT, when the lists land
    const pickup = new Date('2026-09-14T17:40:00Z');
    const settings = resolveSettings({});

    it('starts the scheduled clock at receipt, per Addendum 1', () => {
        const d = dueTimesFor({ serviceType: 'scheduled', receivedAt: received }, settings);
        expect(d.from).toBe('receipt');
        expect(d.pending).toBe(false);
        expect(d.dueAt.toISOString()).toBe('2026-09-14T19:00:00.000Z');
    });

    it('moves the scheduled clock to pickup when the setting says so', () => {
        const s = resolveSettings({ sla: { clockStart: 'pickup' } });
        const d = dueTimesFor({ serviceType: 'scheduled', receivedAt: received, pickupAt: pickup }, s);
        expect(d.from).toBe('pickup');
        // Forty minutes of slack the receipt rule does not give.
        expect(d.dueAt.toISOString()).toBe('2026-09-14T19:40:00.000Z');
    });

    it('has no due time yet when the clock starts at pickup and nothing was picked up', () => {
        const s = resolveSettings({ sla: { clockStart: 'pickup' } });
        const d = dueTimesFor({ serviceType: 'scheduled', receivedAt: received }, s);
        expect(d.dueAt).toBeNull();
        expect(d.pending).toBe(true);
        expect(d.basis).toMatch(/has not happened yet/);
    });

    it('gives STAT both of its deadlines', () => {
        const d = dueTimesFor({ serviceType: 'stat', receivedAt: received, pickupAt: pickup }, settings);
        expect(d.dueAt.toISOString()).toBe('2026-09-14T19:00:00.000Z');      // 2h from request
        expect(d.pickupDueAt.toISOString()).toBe('2026-09-14T18:40:00.000Z'); // 1h from pickup
    });

    it('never lets the pickup rule loosen STAT or ad hoc, which run from the request', () => {
        const s = resolveSettings({ sla: { clockStart: 'pickup' } });
        for (const serviceType of ['stat', 'adhoc']) {
            const d = dueTimesFor({ serviceType, receivedAt: received, pickupAt: pickup }, s);
            expect(d.from).toBe('receipt');
            expect(d.pending).toBe(false);
            expect(d.dueAt).not.toBeNull();
        }
        expect(dueTimesFor({ serviceType: 'adhoc', receivedAt: received }, s).dueAt.toISOString())
            .toBe('2026-09-14T21:00:00.000Z');
    });
});

describe('GET /api/projects/:pid/settings', () => {
    it('returns the resolved settings, the defaults, and worked examples', async () => {
        await reset();
        const res = await admin.get(UH);
        expect(res.status).toBe(200);
        expect(res.body.timezone).toBe('America/Chicago');
        expect(res.body.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
        expect(res.body.defaults).toEqual(DEFAULT_PROJECT_SETTINGS);
        expect(res.body.overridden).toEqual([]);
        expect(res.body.canManage).toBe(true);

        const scheduled = res.body.example.find((e) => e.serviceType === 'scheduled');
        expect(scheduled.minutes).toBe(120);
        expect(scheduled.from).toBe('receipt');
        expect(new Date(scheduled.dueAt) - new Date(scheduled.receivedAt)).toBe(120 * 60_000);
    });

    it('is readable by the people who run the contract, and by nobody else', async () => {
        expect((await srv.agent().get(UH)).status).toBe(401);

        /* A courier reads it because the courier app takes its business hours
           from here, and reads it without the right to change anything. */
        const courier = await memberWith('courier', 'settings.courier');
        const res = await courier.get(UH);
        expect(res.status).toBe(200);
        expect(res.body.canManage).toBe(false);

        /* A client viewer does not. These are the operating parameters of the
           contract, including the internal goal we hold ourselves to above the
           85% University Health measures (ticket 4.2). */
        const viewer = await memberWith('pharmacy', 'settings.viewer');
        expect((await viewer.get(UH)).status).toBe(403);

        // A TVHS-only courier is not a member of uh.
        const north = await srv.login('north');
        expect((await north.get(UH)).status).toBe(403);
    });

    it('serves each project its own settings', async () => {
        await reset();
        expect((await admin.patch(TVHS).send({ sla: { clockStart: 'pickup' } })).status).toBe(200);
        expect((await admin.get(TVHS)).body.settings.sla.clockStart).toBe('pickup');
        expect((await admin.get(UH)).body.settings.sla.clockStart).toBe('receipt');
        await srv.core.client.execute({ sql: `UPDATE projects SET settings = '{}' WHERE code = 'tvhs'` });
    });
});

describe('PATCH /api/projects/:pid/settings', () => {
    it('changes one leaf, leaves the rest alone, and reports what is overridden', async () => {
        await reset();
        const res = await admin.patch(UH).send({ sla: { clockStart: 'pickup' } });
        expect(res.status).toBe(200);
        expect(res.body.settings.sla.clockStart).toBe('pickup');
        expect(res.body.settings.sla.scheduledMinutes).toBe(120);
        expect(res.body.settings.pricing).toEqual(DEFAULT_PROJECT_SETTINGS.pricing);
        expect(res.body.overridden).toEqual(['sla.clockStart']);
        // and the example recomputes against the new rule
        expect(res.body.example.find((e) => e.serviceType === 'scheduled').pending).toBe(true);
    });

    it('changes the after-hours window and the price of the same delivery with it', async () => {
        await reset();
        // 07:30 CDT. The date has to sit inside the BAFO schedule's term:
        // `at` selects the effective price list as well as the window.
        const at = '2026-09-14T12:30:00Z';
        const quote = (body) => admin.post('/api/projects/uh/uh/pricing/quote').send(body);

        const before = await quote({ zip: '78229', serviceType: 'scheduled', at });
        expect(before.body.afterHoursSurcharge).toBe(0);
        expect(before.body.total).toBe(12.5);

        expect((await admin.patch(UH).send({ pricing: { afterHoursEnd: '08:00' } })).status).toBe(200);

        const after = await quote({ zip: '78229', serviceType: 'scheduled', at });
        expect(after.body.afterHoursSurcharge).toBe(18);
        expect(after.body.total).toBe(30.5);
        await reset();
    });

    it('changes the dry-run rule and the price with it', async () => {
        await reset();
        const quote = (body) => admin.post('/api/projects/uh/uh/pricing/quote').send(body);
        // Pin the instant to 14:00 Chicago. Without `at` the quote prices at
        // the wall clock, so this test passed by day and failed after 8pm,
        // when the $18 after-hours surcharge starts applying.
        const at = '2026-09-14T19:00:00Z';
        // 78154 is zone 4 ($36). Replace: the $9 fee stands alone.
        expect((await quote({ zip: '78154', serviceType: 'scheduled', dryRun: true, at })).body.total).toBe(9);
        await admin.patch(UH).send({ pricing: { dryRunReplacesBase: false } });
        expect((await quote({ zip: '78154', serviceType: 'scheduled', dryRun: true, at })).body.total).toBe(45);
        await reset();
    });

    it('sets the timezone, which moves what counts as after hours', async () => {
        await reset();
        const at = '2026-09-14T12:30:00Z'; // 07:30 Chicago, 05:30 Los Angeles
        const quote = () => admin.post('/api/projects/uh/uh/pricing/quote').send({ zip: '78229', serviceType: 'scheduled', at });
        expect((await quote()).body.afterHoursSurcharge).toBe(0);

        const res = await admin.patch(UH).send({ timezone: 'America/Los_Angeles' });
        expect(res.status).toBe(200);
        expect(res.body.timezone).toBe('America/Los_Angeles');
        expect((await quote()).body.afterHoursSurcharge).toBe(18);
        await reset();
    });

    it('rejects a bad time, a bad range, an unknown timezone, and an unknown key', async () => {
        await reset();
        const bad = [
            [{ pricing: { afterHoursStart: '8pm' } }, /HH:MM/],
            [{ pricing: { afterHoursStart: '25:00' } }, /HH:MM/],
            [{ sla: { scheduledMinutes: 0 } }, /greater than or equal to 1|too_small|>=1/i],
            [{ sla: { scheduledMinutes: 1.5 } }, /int/i],
            [{ timezone: 'Mars/Olympus' }, /IANA/],
            [{ sla: { clockStart: 'whenever' } }, /clockStart/],
            [{ sla: { clockstart: 'pickup' } }, /clockstart|unrecognized/i],
            [{ businessHours: { days: [1, 1, 2] } }, /distinct/],
            [{ businessHours: { days: [7] } }, /businessHours.days/],
            [{}, /nothing to update/],
        ];
        for (const [body, pattern] of bad) {
            const res = await admin.patch(UH).send(body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.body.details.join(' '), JSON.stringify(body)).toMatch(pattern);
        }
        // Nothing was written by any of them.
        expect((await admin.get(UH)).body.overridden).toEqual([]);
    });

    it('is read by a courier and written only by an admin', async () => {
        /* A courier reads these: the run screen needs the business hours and
           the clock rules. Writing them changes what the contract measures
           against, and that is an admin's.

           This used to test a third position, where a dispatcher could read
           but not write and an ops manager could do both. Ticket 5.12 merged
           those two, so the only line left is the one below. */
        await reset();
        const courier = await memberWith('courier', 'settings.driver');
        expect((await courier.get(UH)).status).toBe(200);
        const denied = await courier.patch(UH).send({ sla: { clockStart: 'pickup' } });
        expect(denied.status).toBe(403);
        expect((await admin.get(UH)).body.overridden).toEqual([]);

        const ops = await memberWith('admin', 'settings.ops');
        expect((await ops.patch(UH).send({ sla: { clockStart: 'pickup' } })).status).toBe(200);
        await reset();
    });

    it('records the change, with its new value, in the audit trail', async () => {
        await reset();
        await admin.patch(UH).send({ pricing: { afterHoursEnd: '08:00' }, timezone: 'America/Denver' });

        const res = await admin.get('/api/audit?action=project.settings&limit=5');
        expect(res.status).toBe(200);
        const event = res.body.events[0];
        expect(event.action).toBe('project.settings.update');
        expect(event.entity).toBe('project');
        expect(event.entity_id).toBe('uh');
        expect(event.username).toBe('admin');
        expect(event.detail.changed.sort()).toEqual(['pricing.afterHoursEnd', 'timezone']);
        expect(event.detail.to).toContain('pricing.afterHoursEnd="08:00"');
        expect(event.detail.to).toContain('timezone="America/Denver"');
        await reset();
    });

    it('writes nothing and records nothing when the patch changes no value', async () => {
        await reset();
        const before = (await admin.get('/api/audit?action=project.settings&limit=1')).body.events[0]?.id ?? 0;
        const res = await admin.patch(UH).send({ sla: { clockStart: 'receipt' } });
        expect(res.status).toBe(200);
        expect(res.body.overridden).toEqual([]);
        const after = (await admin.get('/api/audit?action=project.settings&limit=1')).body.events[0]?.id ?? 0;
        expect(after).toBe(before);
    });

    it('404s for a project that does not exist', async () => {
        expect((await admin.get('/api/projects/nope/settings')).status).toBe(404);
    });
});

describe('isValidTimezone', () => {
    it('accepts IANA names and rejects the rest', () => {
        expect(isValidTimezone('America/Chicago')).toBe(true);
        expect(isValidTimezone('UTC')).toBe(true);
        expect(isValidTimezone('Mars/Olympus')).toBe(false);
        expect(isValidTimezone('')).toBe(false);
    });
});
