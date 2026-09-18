/* Who is about to stop being allowed to work (ticket 8.4).
 *
 * Two halves. The arithmetic is pure and tested directly, because "expires
 * today" and "expired yesterday" are one day apart and opposite answers. The
 * endpoint is tested for the thing that makes the report trustworthy: it
 * counts the couriers nobody ever onboarded, rather than starting from the
 * applications table and reporting only the people we have paperwork for.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { daysBetween, standingOf, reportOn } from '../src/core/onboarding/standing.ts';

const verified = (kind, expiresAt) => ({
    kind, status: 'verified', verifiedBy: 'sam.ops', verifiedAt: '2026-09-01T10:00:00Z', expiresAt,
});
const ALL_FIVE = (over = {}) => [
    verified('hipaa_training', over.hipaa ?? '2027-01-01'),
    verified('confidentiality', null),
    verified('background_check', null),
    verified('drivers_licence', over.licence ?? '2029-01-04'),
    verified('insurance', over.insurance ?? '2027-03-01'),
];

const WHO = { username: 'ana.courier', name: 'Ana Ruiz', applicationId: 41 };

describe('the arithmetic', () => {
    it('counts whole days across a month boundary', () => {
        expect(daysBetween('2026-09-17', '2026-10-01')).toBe(14);
        expect(daysBetween('2026-09-17', '2026-09-17')).toBe(0);
    });

    it('goes negative for a date that has passed', () => {
        expect(daysBetween('2026-09-17', '2026-09-10')).toBe(-7);
    });

    it('survives the end of February in a leap year', () => {
        /* 2028 is a leap year. Date.UTC on the three integers knows that;
           adding 86400000 in a loop from a parsed string does not always. */
        expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
        expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
    });

    it('does not shift a day when the clock is west of UTC', () => {
        /* The bug this codebase hit three times in ticket 5.11: a civil date
           put through a timezone comes back as the day before. These are
           bare Y-M-D and must stay that way. */
        expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
    });
});

describe('one courier', () => {
    it('says nothing when everything is current and far off', () => {
        const s = standingOf(WHO, ALL_FIVE(), '2026-09-17', 30);
        expect(s.lapsed).toEqual([]);
        expect(s.soon).toEqual([]);
        expect(s.missing).toEqual([]);
    });

    it('treats the expiry date itself as still valid', () => {
        /* A licence is valid through its expiry date. clearanceOf already
           takes this line and the two must not disagree, or the report says
           somebody is fine on the morning the gate closes. */
        const s = standingOf(WHO, ALL_FIVE({ licence: '2026-09-17' }), '2026-09-17', 30);
        expect(s.lapsed).toEqual([]);
        expect(s.soon.map((r) => r.kind)).toEqual(['drivers_licence']);
        expect(s.soon[0].daysLeft).toBe(0);
    });

    it('calls yesterday lapsed, not expiring', () => {
        const s = standingOf(WHO, ALL_FIVE({ insurance: '2026-09-16' }), '2026-09-17', 30);
        expect(s.lapsed.map((r) => r.kind)).toEqual(['insurance']);
        expect(s.lapsed[0].daysLeft).toBe(-1);
        expect(s.soon).toEqual([]);
    });

    it('leaves alone what expires past the horizon', () => {
        const s = standingOf(WHO, ALL_FIVE({ hipaa: '2026-11-30' }), '2026-09-17', 30);
        expect(s.soon).toEqual([]);
    });

    it('lists the soonest first, because that is the order somebody works in', () => {
        const s = standingOf(
            WHO,
            ALL_FIVE({ hipaa: '2026-10-10', licence: '2026-09-20', insurance: '2026-10-01' }),
            '2026-09-17',
            30,
        );
        expect(s.soon.map((r) => r.kind)).toEqual(['drivers_licence', 'insurance', 'hipaa_training']);
    });

    it('reports a check that went back to pending as missing, not expiring', () => {
        /* Two different conversations: "do it again" and "do it". Somebody
           approved and then a check was set back to pending, which is a
           state 6.2 allows and nothing reported on. */
        const checks = ALL_FIVE().map((c) => (c.kind === 'background_check' ? { ...c, status: 'pending' } : c));
        const s = standingOf(WHO, checks, '2026-09-17', 30);
        expect(s.missing).toEqual(['background_check']);
        expect(s.lapsed).toEqual([]);
    });

    it('does not enumerate five missing checks for somebody who never applied', () => {
        const s = standingOf({ username: 'legacy.driver', name: 'Legacy Driver', applicationId: null }, [], '2026-09-17', 30);
        expect(s.neverOnboarded).toBe(true);
        expect(s.missing).toEqual([]);
    });
});

describe('the whole project', () => {
    const report = () => reportOn([
        { who: { username: 'a', name: 'A', applicationId: 1 }, checks: ALL_FIVE() },
        { who: { username: 'b', name: 'B', applicationId: 2 }, checks: ALL_FIVE({ insurance: '2026-09-01' }) },
        { who: { username: 'c', name: 'C', applicationId: 3 }, checks: ALL_FIVE({ licence: '2026-09-25' }) },
        { who: { username: 'd', name: 'D', applicationId: null }, checks: [] },
    ], '2026-09-17', 30);

    it('sorts the three conversations apart', () => {
        const r = report();
        expect(r.lapsed.map((s) => s.username)).toEqual(['b']);
        expect(r.soon.map((s) => s.username)).toEqual(['c']);
        expect(r.neverOnboarded.map((s) => s.username)).toEqual(['d']);
        expect(r.clearCount).toBe(1);
    });

    it('puts a lapsed courier in one bucket only', () => {
        /* Somebody with an expired insurance and a licence due next week is
           one row, in the loudest list. Counting them twice would make the
           number at the top of the screen wrong. */
        const r = reportOn([
            { who: { username: 'b', name: 'B', applicationId: 2 }, checks: ALL_FIVE({ insurance: '2026-09-01', licence: '2026-09-20' }) },
        ], '2026-09-17', 30);
        expect(r.lapsed).toHaveLength(1);
        expect(r.soon).toHaveLength(0);
        expect(r.lapsed[0].soon.map((x) => x.kind)).toEqual(['drivers_licence']);
    });

    it('says what is wrong in one sentence, with what it costs', () => {
        expect(report().why).toMatch(/1 courier is working with something that has already expired/);
        expect(report().why).toMatch(/no onboarding record at all/);
    });

    it('says so plainly when there is nothing to do', () => {
        const r = reportOn([{ who: { username: 'a', name: 'A', applicationId: 1 }, checks: ALL_FIVE() }], '2026-09-17', 30);
        expect(r.why).toMatch(/Every courier's onboarding is current/);
    });
});

describe('the endpoint', () => {
    let srv;
    let admin;
    let legacyCourier;
    let onboarded;

    const UH = '/api/projects/uh/driver-applications';

    /** A courier the way every environment already has them: a user and a
     *  membership, created before onboarding existed, with no application. */
    async function seedLegacyCourier(username) {
        await admin.post('/api/users').send({ username, name: username, password: 'stand-pass-1', role: 'driver' });
        await admin.put(`/api/users/${username}/memberships/uh`).send({ role: 'courier', settings: {} });
        const a = srv.agent();
        const res = await a.post('/api/login').send({ username, password: 'stand-pass-1' });
        expect(res.status, res.text).toBe(200);
        return a;
    }

    /** Somebody who went through 6.1 and 6.2 properly, with one artifact
     *  already expired so they land in the loudest list. */
    async function seedOnboardedCourier(email) {
        const apply = await srv.agent().post('/api/driver-applications').send({
            projectCode: 'uh', name: 'Lapsed Courier', email, phone: '210-555-0000',
            password: 'stand-pass-2', claims: '',
        });
        expect(apply.status, apply.text).toBe(202);
        const queue = await admin.get(`${UH}?status=submitted`);
        const app = queue.body.applications.find((x) => x.email === email);
        expect(app, 'the application should be in the queue').toBeTruthy();

        /* All five verified so approval is allowed, then insurance is pushed
           into the past. Which is not a contrivance: it is what happens to
           everybody eventually, and nothing in the system noticed until now. */
        for (const kind of ['hipaa_training', 'confidentiality', 'background_check', 'drivers_licence', 'insurance']) {
            const res = await admin.put(`${UH}/${app.id}/checks/${kind}`).send({
                status: 'verified', reference: 'seen by admin', expiresAt: null,
            });
            expect(res.status, res.text).toBe(200);
        }
        const approved = await admin.post(`${UH}/${app.id}/approve`).send({});
        expect(approved.status, approved.text).toBe(201);

        await srv.core.client.execute({
            sql: "UPDATE onboarding_checks SET expires_at = '2020-01-01' WHERE application_id = ? AND kind = 'insurance'",
            args: [app.id],
        });
        return app.id;
    }

    beforeAll(async () => {
        srv = await startServer();
        admin = await srv.login('admin');
        legacyCourier = await seedLegacyCourier('legacy.stand');
        onboarded = await seedOnboardedCourier('lapsed.stand@example.invalid');
    }, 60_000);
    afterAll(async () => { await srv?.stop(); });

    it('counts couriers who hold a membership and never applied', async () => {
        /* THE ASSERTION THAT MAKES THIS REPORT WORTH READING. Starting the
           query from driver_applications would report only the people we
           have paperwork for and silently omit everybody seeded before
           ticket 6.1: every TVHS driver and all twelve simulation couriers.
           A report that leaves out the people it knows nothing about is a
           report that says everybody is fine. */
        const res = await admin.get(`${UH}/standing`);
        expect(res.status, res.text).toBe(200);
        expect(res.body.neverOnboarded.map((s) => s.username)).toContain('legacy.stand');
        expect(res.body.why).toMatch(/no onboarding record at all/);
        for (const s of res.body.neverOnboarded) {
            expect(s.applicationId).toBeNull();
            expect(s.neverOnboarded).toBe(true);
        }
    });

    it('finds an approved courier whose insurance has lapsed', async () => {
        /* The gap this ticket exists for: clearanceOf is consulted at
           approval and never again, so this person has been assigned patient
           addresses since 2020 with no current insurance on file and nothing
           in the system said a word. */
        const res = await admin.get(`${UH}/standing`);
        const lapsed = res.body.lapsed.find((s) => s.username === 'lapsed.stand@example.invalid');
        expect(lapsed, 'the lapsed courier should be reported').toBeTruthy();
        expect(lapsed.applicationId).toBe(onboarded);
        expect(lapsed.lapsed.map((r) => r.kind)).toEqual(['insurance']);
        expect(lapsed.lapsed[0].daysLeft).toBeLessThan(0);
        expect(res.body.why).toMatch(/already expired/);
    });

    it('is not reachable by a courier', async () => {
        /* It names every courier on the project and what is wrong with their
           paperwork. Not a courier's to read, including about themselves:
           ticket 6.6 took the same line on location history. */
        const res = await legacyCourier.get(`${UH}/standing`);
        expect(res.status).toBe(403);
    });

    it('takes a horizon, and falls back rather than trusting the query string', async () => {
        expect((await admin.get(`${UH}/standing?withinDays=90`)).body.horizonDays).toBe(90);
        expect((await admin.get(`${UH}/standing?withinDays=-4`)).body.horizonDays).toBe(30);
        expect((await admin.get(`${UH}/standing?withinDays=banana`)).body.horizonDays).toBe(30);
        expect((await admin.get(`${UH}/standing?withinDays=99999`)).body.horizonDays).toBe(30);
    });

    it('is not read as an application id', async () => {
        /* Express matches in order, so a '/standing' route declared after
           '/:id' would answer 404 and look like the feature was missing. */
        const res = await admin.get(`${UH}/standing`);
        expect(res.status).toBe(200);
        expect(res.body.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('records who asked, because it is a read of people rather than of work', async () => {
        await admin.get(`${UH}/standing`);
        const rs = await srv.core.client.execute(
            "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'onboarding.standing_read'",
        );
        expect(Number(rs.rows[0].n)).toBeGreaterThan(0);
    });
});
