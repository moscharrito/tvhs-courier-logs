import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { priceFor, isAfterHours, resolveZone, localMinutes, pricingSettingsFrom, DEFAULT_PRICING_SETTINGS } from '../src/modules/uh/pricing.ts';

// The Izy BAFO schedule, as seeded from Bid Table BT-89AO.
const BAFO = {
    effectiveFrom: '2026-05-18',
    zoneRates: { 1: 12.5, 2: 14.5, 3: 22, 4: 36, 5: 52 },
    statSurcharge: 22,
    afterHoursSurcharge: 18,
    dryRunFee: 9,
    outOfAreaPerMile: 1.95,
};
const CT = (iso) => new Date(iso);

describe('priceFor: zones', () => {
    it('prices every zone at the BAFO rate', () => {
        for (const [zone, rate] of Object.entries(BAFO.zoneRates)) {
            const p = priceFor({ zone: Number(zone), serviceType: 'scheduled', afterHours: false }, BAFO);
            expect(p.zone).toBe(Number(zone));
            expect(p.base).toBe(rate);
            expect(p.total).toBe(rate);
            expect(p.currency).toBe('USD');
            expect(p.effectiveFrom).toBe('2026-05-18');
        }
    });

    it('adds the STAT surcharge to the zone rate, not instead of it', () => {
        const p = priceFor({ zone: 1, serviceType: 'stat', afterHours: false }, BAFO);
        expect(p).toMatchObject({ base: 12.5, statSurcharge: 22, afterHoursSurcharge: 0, total: 34.5 });
        expect(priceFor({ zone: 5, serviceType: 'stat', afterHours: false }, BAFO).total).toBe(74);
    });

    it('charges no STAT surcharge for scheduled or ad hoc work', () => {
        expect(priceFor({ zone: 2, serviceType: 'scheduled', afterHours: false }, BAFO).statSurcharge).toBe(0);
        expect(priceFor({ zone: 2, serviceType: 'adhoc', afterHours: false }, BAFO).statSurcharge).toBe(0);
    });

    it('stacks STAT and after hours', () => {
        const p = priceFor({ zone: 3, serviceType: 'stat', afterHours: true }, BAFO);
        expect(p).toMatchObject({ base: 22, statSurcharge: 22, afterHoursSurcharge: 18, total: 62 });
    });
});

describe('priceFor: after hours', () => {
    const settings = DEFAULT_PRICING_SETTINGS; // 20:00 to 07:00, America/Chicago

    it('applies the window from Addendum 1: 8 pm to 7 am Central', () => {
        // 2026-06-15 is CDT (UTC-5): 20:00 local = 01:00Z next day.
        expect(isAfterHours(CT('2026-06-16T01:00:00Z'), settings)).toBe(true);   // 20:00
        expect(isAfterHours(CT('2026-06-16T00:59:00Z'), settings)).toBe(false);  // 19:59
        expect(isAfterHours(CT('2026-06-16T11:59:00Z'), settings)).toBe(true);   // 06:59
        expect(isAfterHours(CT('2026-06-16T12:00:00Z'), settings)).toBe(false);  // 07:00 exactly
        expect(isAfterHours(CT('2026-06-16T17:00:00Z'), settings)).toBe(false);  // noon
    });

    it('honours the Scope 1.2.3 reading when the window is set to 8 am', () => {
        const scope = { ...settings, afterHoursEnd: '08:00' };
        // 07:30 Central is business hours under Addendum 1 but after hours under Scope 1.2.3.
        const at = CT('2026-06-16T12:30:00Z');
        expect(isAfterHours(at, settings)).toBe(false);
        expect(isAfterHours(at, scope)).toBe(true);
        expect(priceFor({ zone: 1, serviceType: 'scheduled', at }, BAFO, settings).total).toBe(12.5);
        expect(priceFor({ zone: 1, serviceType: 'scheduled', at }, BAFO, scope).total).toBe(30.5);
    });

    it('reads the clock in the project timezone, not the server timezone', () => {
        // 03:00Z is 22:00 the previous day in Chicago (after hours) and 03:00 in London (also after hours),
        // but 14:00 in Auckland (business hours).
        const at = CT('2026-06-16T03:00:00Z');
        expect(localMinutes(at, 'America/Chicago')).toBe(22 * 60);
        expect(isAfterHours(at, settings)).toBe(true);
        expect(isAfterHours(at, { ...settings, timezone: 'Pacific/Auckland' })).toBe(false);
    });

    it('handles the daylight saving shift', () => {
        // 2026-01-15 is CST (UTC-6): 20:00 local = 02:00Z next day.
        expect(isAfterHours(CT('2026-01-16T02:00:00Z'), settings)).toBe(true);
        expect(isAfterHours(CT('2026-01-16T01:59:00Z'), settings)).toBe(false);
    });

    it('derives after hours from `at` when not told, and says so when it has neither', () => {
        expect(priceFor({ zone: 1, serviceType: 'scheduled', at: CT('2026-06-16T03:00:00Z') }, BAFO).afterHoursSurcharge).toBe(18);
        const blind = priceFor({ zone: 1, serviceType: 'scheduled' }, BAFO);
        expect(blind.afterHoursSurcharge).toBe(0);
        expect(blind.notes.join(' ')).toMatch(/priced as business hours/i);
    });

    it('an explicit afterHours flag beats the clock', () => {
        const at = CT('2026-06-16T17:00:00Z'); // noon Central
        expect(priceFor({ zone: 1, serviceType: 'scheduled', at, afterHours: true }, BAFO).afterHoursSurcharge).toBe(18);
    });
});

describe('priceFor: dry run', () => {
    it('replaces the delivery charge by default, and is charged per item', () => {
        const one = priceFor({ zone: 4, serviceType: 'scheduled', afterHours: false, dryRun: true }, BAFO);
        expect(one).toMatchObject({ base: 0, dryRunFee: 9, total: 9 });
        expect(one.notes.join(' ')).toMatch(/replaces the delivery charge/i);

        const three = priceFor({ zone: 4, serviceType: 'scheduled', afterHours: false, dryRun: true, items: 3 }, BAFO);
        expect(three).toMatchObject({ dryRunFee: 27, total: 27 });
        expect(three.notes.join(' ')).toMatch(/3 items/);
    });

    it('adds to the delivery charge when the project is configured that way', () => {
        const added = { ...DEFAULT_PRICING_SETTINGS, dryRunReplacesBase: false };
        const p = priceFor({ zone: 4, serviceType: 'scheduled', afterHours: false, dryRun: true }, BAFO, added);
        expect(p).toMatchObject({ base: 36, dryRunFee: 9, total: 45 });
        expect(p.notes.join(' ')).toMatch(/added to the delivery charge/i);
    });

    it('keeps STAT and after-hours surcharges on a dry run', () => {
        // The courier still drove there at 2 am on an urgent request.
        const p = priceFor({ zone: 1, serviceType: 'stat', afterHours: true, dryRun: true }, BAFO);
        expect(p).toMatchObject({ base: 0, statSurcharge: 22, afterHoursSurcharge: 18, dryRunFee: 9, total: 49 });
    });
});

describe('priceFor: out of area', () => {
    it('bills one-way loaded miles when the destination has no zone', () => {
        const p = priceFor({ zone: null, serviceType: 'scheduled', afterHours: false, outOfAreaMiles: 40 }, BAFO);
        expect(p.zone).toBeNull();
        expect(p.base).toBe(0);
        expect(p.outOfArea).toEqual({ miles: 40, perMile: 1.95, amount: 78 });
        expect(p.total).toBe(78);
        expect(p.notes.join(' ')).toMatch(/outside the published zone list/i);
    });

    it('adds surcharges on top of mileage', () => {
        const p = priceFor({ zone: null, serviceType: 'stat', afterHours: true, outOfAreaMiles: 10 }, BAFO);
        expect(p.total).toBe(19.5 + 22 + 18);
    });

    it('flags out of area with no mileage rather than guessing a distance', () => {
        const p = priceFor({ zone: null, serviceType: 'scheduled', afterHours: false }, BAFO);
        expect(p.total).toBe(0);
        expect(p.notes.join(' ')).toMatch(/no mileage supplied/i);
    });

    it('rounds money to the cent without drift', () => {
        // 1.95 x 3 = 5.85 exactly, and 1.95 x 0.1 = 0.195 -> 0.20
        expect(priceFor({ zone: null, serviceType: 'scheduled', afterHours: false, outOfAreaMiles: 3 }, BAFO).total).toBe(5.85);
        expect(priceFor({ zone: null, serviceType: 'scheduled', afterHours: false, outOfAreaMiles: 0.1 }, BAFO).total).toBe(0.2);
        expect(priceFor({ zone: null, serviceType: 'scheduled', afterHours: false, outOfAreaMiles: 33.33 }, BAFO).total).toBe(64.99);
    });
});

describe('resolveZone and settings', () => {
    const map = new Map([['78229', 1], ['78223', 2], ['78154', 4]]);
    it('maps a ZIP, tolerates ZIP+4, and returns null when unknown', () => {
        expect(resolveZone('78229', map)).toBe(1);
        expect(resolveZone('78229-1234', map)).toBe(1);
        expect(resolveZone(' 78223 ', map)).toBe(2);
        expect(resolveZone('90210', map)).toBeNull();
        expect(resolveZone(null, map)).toBeNull();
        expect(resolveZone('', map)).toBeNull();
    });

    it('reads pricing settings from the project blob and falls back to the documented defaults', () => {
        expect(pricingSettingsFrom({}, 'America/Chicago')).toEqual(DEFAULT_PRICING_SETTINGS);
        expect(pricingSettingsFrom({ pricing: { afterHoursEnd: '08:00', dryRunReplacesBase: false } }, 'America/Chicago'))
            .toEqual({ ...DEFAULT_PRICING_SETTINGS, afterHoursEnd: '08:00', dryRunReplacesBase: false });
        expect(pricingSettingsFrom({ pricing: { afterHoursStart: '   ' } }, 'America/Chicago').afterHoursStart).toBe('20:00');
    });
});

describe('seeded data and endpoints', () => {
    const UH = '/api/projects/uh/uh/pricing';
    let srv;
    let admin;
    beforeAll(async () => {
        srv = await startServer();
        admin = await srv.login('admin');
    });
    afterAll(async () => { await srv.stop(); });

    it('loads the BAFO schedule from the bid table', async () => {
        const res = await admin.get(UH);
        expect(res.status).toBe(200);
        expect(res.body.schedule).toEqual({
            effectiveFrom: '2026-05-18',
            zoneRates: { 1: 12.5, 2: 14.5, 3: 22, 4: 36, 5: 52 },
            statSurcharge: 22, afterHoursSurcharge: 18, dryRunFee: 9, outOfAreaPerMile: 1.95,
        });
        expect(res.body.settings).toEqual(DEFAULT_PRICING_SETTINGS);
    });

    it('loads 72 zone ZIPs in the counts the bid table lists', async () => {
        const res = await admin.get(UH);
        expect(res.body.zoneZipCounts).toEqual([
            { zone: 1, zips: 38 }, { zone: 2, zips: 7 }, { zone: 3, zips: 13 }, { zone: 4, zips: 11 }, { zone: 5, zips: 3 },
        ]);
        const all = (await admin.get(`${UH}/zones`)).body;
        expect(all).toHaveLength(72);
        expect(new Set(all.map((z) => z.zip)).size).toBe(72);
        // Places are carried for the outlying towns only.
        expect(all.find((z) => z.zip === '78015')).toEqual({ zip: '78015', zone: 5, place: 'Boerne' });
        expect(all.find((z) => z.zip === '78229')).toEqual({ zip: '78229', zone: 1, place: null });
    });

    it('maps the ZIPs that carry the most volume', async () => {
        // The ten busiest ZIPs from UH's prior-year actuals.
        const expected = { 78237: 1, 78207: 1, 78223: 2, 78227: 1, 78228: 1, 78210: 1, 78242: 1, 78201: 1, 78214: 2, 78240: 1 };
        for (const [zip, zone] of Object.entries(expected)) {
            const res = await admin.get(`${UH}/zones?zip=${zip}`);
            expect(res.body).toEqual({ zip, zone, outOfArea: false, on: expect.any(String) });
        }
        const out = await admin.get(`${UH}/zones?zip=90210`);
        expect(out.body).toMatchObject({ zip: '90210', zone: null, outOfArea: true });
    });

    it('quotes a delivery end to end', async () => {
        const scheduled = await admin.post(`${UH}/quote`).send({ zip: '78229', at: '2026-06-16T17:00:00Z' });
        expect(scheduled.body).toMatchObject({ zip: '78229', zone: 1, base: 12.5, total: 12.5 });

        const stat = await admin.post(`${UH}/quote`).send({ zip: '78154', serviceType: 'stat', at: '2026-06-16T03:00:00Z' });
        expect(stat.body).toMatchObject({ zone: 4, base: 36, statSurcharge: 22, afterHoursSurcharge: 18, total: 76 });

        const dry = await admin.post(`${UH}/quote`).send({ zip: '78223', dryRun: true, items: 2, at: '2026-06-16T17:00:00Z' });
        expect(dry.body).toMatchObject({ zone: 2, base: 0, dryRunFee: 18, total: 18 });

        const far = await admin.post(`${UH}/quote`).send({ zip: '90210', outOfAreaMiles: 20, at: '2026-06-16T17:00:00Z' });
        expect(far.body).toMatchObject({ zone: null, total: 39 });
    });

    it('validates quote input and refuses to guess', async () => {
        expect((await admin.post(`${UH}/quote`).send({})).status).toBe(400);
        expect((await admin.post(`${UH}/quote`).send({ zip: '78229', serviceType: 'teleport' })).status).toBe(400);
        expect((await admin.post(`${UH}/quote`).send({ zone: 9 })).status).toBe(400);
        expect((await admin.post(`${UH}/quote`).send({ zip: '78229', at: 'tuesday' })).status).toBe(400);
    });

    it('is scoped to the project: tvhs has no schedule and no zones', async () => {
        expect((await admin.get('/api/projects/tvhs/uh/pricing')).body.schedule).toBeNull();
        expect((await admin.get('/api/projects/tvhs/uh/pricing/zones')).body).toEqual([]);
        const quote = await admin.post('/api/projects/tvhs/uh/pricing/quote').send({ zip: '78229' });
        expect(quote.status).toBe(409);
        expect(quote.body.error).toMatch(/no price schedule/i);
    });

    it('requires membership', async () => {
        expect((await srv.agent().get(UH)).status).toBe(401);
        const north = await srv.login('north');
        expect((await north.get(UH)).status).toBe(403);
    });

    it('prices nothing from a date before the schedule took effect', async () => {
        const res = await admin.get(`${UH}?on=2026-01-01`);
        expect(res.body.schedule).toBeNull();
        expect(res.body.zoneZipCounts).toEqual([]);
    });
});
