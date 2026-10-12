/* Amazon Location, which is the only provider allowed near a patient.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS WORTH TESTING, WHICH IS NOT "DOES IT PARSE JSON".
 *
 * Three of these failures are silent and expensive:
 *
 *   [lng, lat] read as [lat, lng] does not throw. It puts San Antonio in the
 *   Indian Ocean, every road distance becomes enormous, and the out-of-area
 *   mileage line on an invoice is WRONG rather than missing.
 *
 *   A route answered in kilometres and read as miles overbills the same line
 *   by about 60%.
 *
 *   An error message carrying the address it failed on is a delivery address
 *   in a log, which is the disclosure this whole provider exists to control.
 *
 * The fourth is not silent but is the reason the file exists at all: the
 * scope. Google is sited-only; this one may see a patient address, and that
 * permission comes from a signed BAA rather than from convenience.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAwsLocationProvider, qualityOf } from '../src/core/geo/aws-location.ts';
import { GeoUnavailableError } from '../src/core/geo/provider.ts';

const ADDRESS = {
    line1: '1100 Broadway St',
    city: 'San Antonio',
    state: 'TX',
    zip: '78215',
};

/* San Antonio. Latitude 29, longitude -98: the two are not close and cannot
   be confused by a reader, which is the point of choosing a real city. */
const SAT = { lat: 29.4241, lng: -98.4936 };

const reply = (body, { ok = true, status = 200, errorType = null } = {}) => ({
    ok,
    status,
    headers: { get: (h) => (h === 'x-amzn-errortype' ? errorType : null) },
    json: async () => body,
});

const provider = (fetchImpl, over = {}) => createAwsLocationProvider({
    region: 'us-east-1',
    placeIndexName: 'izy-uh-places',
    routeCalculatorName: 'izy-uh-routes',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: () => new Date('2026-11-02T12:00:00.000Z'),
    fetchImpl,
    ...over,
});

describe('what it is allowed to look up', () => {
    it('may see a patient address, which is the whole reason it exists', () => {
        /* Google's provider is scoped to site only because Maps Platform is
           not on Google's BAA. This one is scoped to both because Amazon
           Location is HIPAA-eligible and the agreement is signed. Removing
           'patient' here is all it takes to turn that off everywhere. */
        const p = provider(async () => reply({}));
        expect(p.scopes).toContain('patient');
        expect(p.scopes).toContain('site');
    });
});

describe('geocoding an address', () => {
    it('reads [longitude, latitude] in that order', async () => {
        /* The silent one. Reversed, this answers lat -98 lng 29, which is
           the Indian Ocean, and nothing throws. */
        const p = provider(async () => reply({
            Results: [{ Place: { Geometry: { Point: [SAT.lng, SAT.lat] }, Label: '1100 Broadway St' }, Relevance: 0.97 }],
        }));
        const got = await p.geocode(ADDRESS, 'patient');
        expect(got.point.lat).toBeCloseTo(29.4241, 4);
        expect(got.point.lng).toBeCloseTo(-98.4936, 4);
        expect(got.provider).toBe('aws-location');
    });

    it('asks the place index by name and sends the address as one line', async () => {
        let seen = null;
        const p = provider(async (url, init) => {
            seen = { url: String(url), body: JSON.parse(init.body) };
            return reply({ Results: [{ Place: { Geometry: { Point: [SAT.lng, SAT.lat] } }, Relevance: 0.9 }] });
        });
        await p.geocode(ADDRESS, 'site');

        expect(seen.url).toContain('places.geo.us-east-1.amazonaws.com');
        expect(seen.url).toContain('/places/v0/indexes/izy-uh-places/search/text');
        expect(seen.body.Text).toBe('1100 Broadway St, San Antonio, TX 78215');
        /* Bexar County contract: without this a thin address can match a
           street of the same name abroad and look like a confident answer. */
        expect(seen.body.FilterCountries).toEqual(['USA']);
    });

    it('signs the body it actually sends', async () => {
        /* Serialising twice can produce different bytes, and a signature
           over bytes that were not sent is a 403 with nothing useful in it. */
        let seen = null;
        const p = provider(async (_url, init) => {
            seen = init;
            return reply({ Results: [{ Place: { Geometry: { Point: [SAT.lng, SAT.lat] } }, Relevance: 0.9 }] });
        });
        await p.geocode(ADDRESS, 'site');

        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha256').update(seen.body).digest('hex');
        expect(seen.headers['x-amz-content-sha256']).toBe(hash);
        expect(seen.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
        /* The credential scope names the service, and geo is not s3. */
        expect(seen.headers.Authorization).toContain('/us-east-1/geo/aws4_request');
    });

    it('refuses rather than inventing a point when nothing matched', async () => {
        const p = provider(async () => reply({ Results: [] }));
        await expect(p.geocode(ADDRESS, 'patient')).rejects.toBeInstanceOf(GeoUnavailableError);
    });

    it('refuses a result whose point is not two numbers', async () => {
        const p = provider(async () => reply({ Results: [{ Place: { Geometry: { Point: ['x'] } } }] }));
        await expect(p.geocode(ADDRESS, 'patient')).rejects.toBeInstanceOf(GeoUnavailableError);
    });

    it('never puts the address in the error, because errors are logged', async () => {
        for (const answer of [
            () => reply({ Results: [] }),
            () => reply({}, { ok: false, status: 403, errorType: 'AccessDeniedException:' }),
            () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }); },
        ]) {
            const p = provider(answer);
            const err = await p.geocode(ADDRESS, 'patient').catch((e) => e);
            expect(err).toBeInstanceOf(GeoUnavailableError);
            expect(err.message).not.toContain('Broadway');
            expect(err.message).not.toContain('78215');
        }
    });

    it('reports AWS own error type, which is what says whether it is the key or the signature', async () => {
        const p = provider(async () => reply({}, { ok: false, status: 403, errorType: 'AccessDeniedException:' }));
        const err = await p.geocode(ADDRESS, 'site').catch((e) => e);
        expect(err.message).toContain('AccessDeniedException');
    });
});

describe('road miles between two points', () => {
    it('sends [longitude, latitude] for both ends', async () => {
        let body = null;
        const p = provider(async (_url, init) => {
            body = JSON.parse(init.body);
            return reply({ Summary: { Distance: 12.3, DurationSeconds: 900, DistanceUnit: 'Miles' } });
        });
        await p.distance(SAT, { lat: 29.5, lng: -98.6 });

        expect(body.DeparturePosition).toEqual([-98.4936, 29.4241]);
        expect(body.DestinationPosition).toEqual([-98.6, 29.5]);
        expect(body.DistanceUnit).toBe('Miles');
    });

    it('bills the miles it was given', async () => {
        const p = provider(async () => reply({
            Summary: { Distance: 12.3, DurationSeconds: 900, DistanceUnit: 'Miles' },
        }));
        const got = await p.distance(SAT, { lat: 29.5, lng: -98.6 });
        expect(got.miles).toBeCloseTo(12.3, 3);
        expect(got.seconds).toBe(900);
    });

    it('converts when the calculator answers in kilometres', async () => {
        /* Not hypothetical: the unit is a property of the request and a
           calculator can be configured otherwise. Read as miles, a
           kilometre figure overbills out-of-area mileage by about 60%. */
        const p = provider(async () => reply({
            Summary: { Distance: 20, DurationSeconds: 900, DistanceUnit: 'Kilometers' },
        }));
        const got = await p.distance(SAT, { lat: 29.5, lng: -98.6 });
        expect(got.miles).toBeCloseTo(12.427, 2);
    });

    it('refuses rather than returning nought when there is no route', async () => {
        const p = provider(async () => reply({}));
        await expect(p.distance(SAT, { lat: 29.5, lng: -98.6 })).rejects.toBeInstanceOf(GeoUnavailableError);
    });

    it('asks the route calculator by name', async () => {
        let url = '';
        const p = provider(async (u) => {
            url = String(u);
            return reply({ Summary: { Distance: 1, DurationSeconds: 1, DistanceUnit: 'Miles' } });
        });
        await p.distance(SAT, SAT);
        expect(url).toContain('routes.geo.us-east-1.amazonaws.com');
        expect(url).toContain('/routes/v0/calculators/izy-uh-routes/calculate/route');
    });
});

describe('how confident the match was', () => {
    it('claims rooftop only for a very strong match', () => {
        /* Rooftop is the one that lets a dispatcher stop checking. Claiming
           it for a 0.8 match is the quiet overstatement that puts a courier
           on the wrong street. */
        expect(qualityOf(0.97)).toBe('rooftop');
        expect(qualityOf(0.9)).toBe('interpolated');
        expect(qualityOf(0.7)).toBe('centroid');
        expect(qualityOf(0.2)).toBe('approximate');
        expect(qualityOf(undefined)).toBe('approximate');
    });
});

describe('it does not retry', () => {
    it('calls once and gives up, because a retry loop inside a paid API is a surprise bill', async () => {
        const fetchImpl = vi.fn(async () => reply({}, { ok: false, status: 500 }));
        const p = provider(fetchImpl);
        await p.geocode(ADDRESS, 'site').catch(() => {});
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
