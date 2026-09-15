/* Ticket 5.13. What the courier's map is allowed to be.
 *
 * Most of these assert a refusal. That is deliberate: the interesting failure
 * mode of this feature is not a broken map, it is a working one nobody
 * decided to turn on, quietly sending patient addresses to a vendor with no
 * BAA because a key happened to be configured for geocoding pharmacy sites.
 */

import { describe, it, expect } from 'vitest';
import {
    directionsFor, destinationQuery, mapsUrl, parseOrigin, validOrigin, MAPS_EMBED_ORIGIN,
} from '../src/modules/uh/directions.ts';

const STOP = { address: '118 Cielo Vista Ct', city: 'San Antonio', zip: '78228' };
const ON = { geo: { googleApiKey: 'test-key', dailyCeiling: 2500, embedMaps: true } };
const OFF = { geo: { googleApiKey: 'test-key', dailyCeiling: 2500, embedMaps: false } };
const NO_KEY = { geo: { googleApiKey: undefined, dailyCeiling: 2500, embedMaps: true } };

describe('what may be embedded', () => {
    it('refuses the embed when the switch is off, even with a key sitting right there', () => {
        const answer = directionsFor(OFF, STOP);
        expect(answer.available).toBe(false);
        expect(answer.embedUrl).toBeNull();
        // And the courier still gets a way to drive there.
        expect(answer.mapsUrl).toContain('Cielo');
        expect(answer.why).toMatch(/turned off/i);
    });

    it('refuses the embed when the switch is on but nobody configured a key', () => {
        const answer = directionsFor(NO_KEY, STOP);
        expect(answer.available).toBe(false);
        expect(answer.embedUrl).toBeNull();
        expect(answer.why).toMatch(/no map key/i);
    });

    it('refuses a stop with no address rather than mapping an empty string', () => {
        const answer = directionsFor(ON, { address: '  ', city: '', zip: '' });
        expect(answer.available).toBe(false);
        expect(answer.why).toMatch(/no address/i);
    });

    it('draws a route when the phone said where it is', () => {
        const answer = directionsFor(ON, STOP, { lat: 29.4241, lng: -98.4936 });
        expect(answer.available).toBe(true);
        expect(answer.embedUrl).toContain('/maps/embed/v1/directions');
        expect(answer.embedUrl).toContain('origin=29.4241%2C-98.4936');
        expect(answer.embedUrl).toContain('mode=driving');
        expect(answer.why).toBe('');
    });

    it('falls back to the destination on a map when location is denied, and says so', () => {
        const answer = directionsFor(ON, STOP, null);
        expect(answer.available).toBe(true);
        expect(answer.embedUrl).toContain('/maps/embed/v1/place');
        expect(answer.why).toMatch(/destination rather than a route/i);
    });
});

describe('what crosses the boundary', () => {
    it('sends the address and never the patient', () => {
        const withName = { ...STOP, recipientName: 'Priscilla Ochoa' };
        for (const url of [directionsFor(ON, withName, { lat: 29.4, lng: -98.5 }).embedUrl, mapsUrl(withName)]) {
            expect(url).not.toMatch(/Priscilla/i);
            expect(url).not.toMatch(/Ochoa/i);
        }
    });

    it('only ever points at the one origin the CSP opened', () => {
        const urls = [
            directionsFor(ON, STOP, { lat: 29.4, lng: -98.5 }).embedUrl,
            directionsFor(ON, STOP).embedUrl,
            mapsUrl(STOP),
        ];
        for (const url of urls) expect(url.startsWith(`${MAPS_EMBED_ORIGIN}/`)).toBe(true);
    });

    it('escapes the address instead of letting it end the query string', () => {
        const nasty = { address: '1 A&B St #2', city: 'San Antonio', zip: '78228' };
        const url = directionsFor(ON, nasty).embedUrl;
        expect(url).toContain('1%20A%26B%20St%20%232');
        // One q parameter, not two. An unescaped & would have made a second.
        expect(url.split('&').filter((p) => p.startsWith('q=')).length).toBe(1);
    });

    it('joins the address the way a person writes it, skipping what is missing', () => {
        expect(destinationQuery(STOP)).toBe('118 Cielo Vista Ct, San Antonio, 78228');
        expect(destinationQuery({ address: '118 Cielo Vista Ct', city: '', zip: '78228' }))
            .toBe('118 Cielo Vista Ct, 78228');
    });
});

describe('the position the phone offers', () => {
    it('takes a real point', () => {
        expect(parseOrigin('29.4241,-98.4936')).toEqual({ lat: 29.4241, lng: -98.4936 });
        expect(validOrigin({ lat: 0, lng: 0 })).toBe(true);
    });

    it('refuses anything that is not one', () => {
        for (const raw of [undefined, '', 'here', '29.4', '29.4,-98.5,3', '91,0', '0,181', 'NaN,0', 'Infinity,0']) {
            expect(parseOrigin(raw)).toBeNull();
        }
    });

    it('falls back to the place map rather than failing when the position is junk', () => {
        const answer = directionsFor(ON, STOP, { lat: 999, lng: 999 });
        expect(answer.available).toBe(true);
        expect(answer.embedUrl).toContain('/maps/embed/v1/place');
    });
});
