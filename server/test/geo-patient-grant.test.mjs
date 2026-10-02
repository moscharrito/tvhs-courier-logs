/* The permission to send a delivery address to the geocoder, and the fact
 * that it expires.
 *
 * Normally this is refused in code, because a delivery address is a patient's
 * home and Google Maps is not covered by a BAA. It is granted for a test
 * phase in which every address in the system is invented, so nothing
 * disclosed is protected health information.
 *
 * The property these tests exist for is not that the grant works. It is that
 * the grant CANNOT QUIETLY SURVIVE the test phase it was given for. */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.ts';

const day = (offsetDays) => {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
};

/* Enough environment for the config to parse at all. */
const base = {
    SESSION_SECRET: 'x'.repeat(48),
    APP_TIMEZONE: 'America/Chicago',
    GOOGLE_MAPS_API_KEY: 'test-key-not-real',
};

const load = (over = {}) => loadConfig({ ...base, ...over });

describe('permission to geocode a delivery address', () => {
    it('is refused when nobody has granted it', () => {
        const config = load();
        expect(config.geo.patientGeocodeAllowed).toBe(false);
        expect(config.geo.patientGeocodeUntil).toBeUndefined();
    });

    it('is granted while the date is in the future', () => {
        const config = load({ UH_PATIENT_GEOCODE_UNTIL: day(30) });
        expect(config.geo.patientGeocodeAllowed).toBe(true);
    });

    it('LAPSES ON ITS OWN, with no deploy and nobody remembering', () => {
        /* The whole reason this is a date and not a flag. A boolean switched
           on for a test phase stays on: turning it off is on nobody's list
           and nothing breaks when nobody does.
           An expired grant is the system working, so the server still starts
           and simply refuses delivery addresses again. */
        const config = load({ UH_PATIENT_GEOCODE_UNTIL: day(-1) });
        expect(config.geo.patientGeocodeAllowed).toBe(false);
    });

    it('refuses to start at all on a grant stretched past ninety days', () => {
        /* "Until 2099" is not a way around an expiry, and this is a boot
           failure rather than a silent downgrade: somebody typing that date
           meant to have the permission, and should find out immediately that
           they do not, rather than a week later from a map that never loads. */
        expect(() => load({ UH_PATIENT_GEOCODE_UNTIL: day(400) })).toThrow(/more than 90 days/i);
    });

    it('refuses something that is not a date', () => {
        expect(() => load({ UH_PATIENT_GEOCODE_UNTIL: 'soon' })).toThrow();
    });

    it('is exactly the difference between the two scope lists', () => {
        /* What the grant actually changes, stated once here so a future
           reader does not have to infer it from legacy.ts. */
        expect(load().geo.patientGeocodeAllowed).toBe(false);
        expect(load({ UH_PATIENT_GEOCODE_UNTIL: day(10) }).geo.patientGeocodeAllowed).toBe(true);
    });
});

/* ------------------------------------------------- an agreement that covers it
 *
 * Everything above exists because Google's BAA did not extend to the Maps
 * APIs and their terms excluded protected health information, so the only
 * permission was a dated grant for a test phase of invented addresses.
 *
 * With an executed agreement naming the geocoding service, a delivery address
 * is a disclosure to a business associate like any other. The distinction the
 * code has to keep is between that and the temporary grant, because one is
 * fine to go live on and the other is not. */
describe('a signed agreement rather than a dated grant', () => {
    it('permits patient addresses with no expiry', () => {
        const config = load({ GEO_BAA_COVERS_PATIENT_ADDRESSES: 'true' });
        expect(config.geo.patientGeocodeAllowed).toBe(true);
        expect(config.geo.patientGeocodeBasis).toBe('baa');
    });

    it('needs no date beside it', () => {
        /* The whole point: an agreement does not lapse, so requiring a date
           alongside it would reintroduce the thing it replaces. */
        const config = load({ GEO_BAA_COVERS_PATIENT_ADDRESSES: 'true' });
        expect(config.geo.patientGeocodeUntil).toBeUndefined();
        expect(config.geo.patientGeocodeAllowed).toBe(true);
    });

    it('wins over an expired grant rather than being blocked by it', () => {
        const config = load({
            GEO_BAA_COVERS_PATIENT_ADDRESSES: 'true',
            UH_PATIENT_GEOCODE_UNTIL: day(-1),
        });
        expect(config.geo.patientGeocodeAllowed).toBe(true);
        expect(config.geo.patientGeocodeBasis).toBe('baa');
    });

    it('is off unless it is actually set', () => {
        /* Defaults matter most on the control that permits a disclosure. */
        expect(load({}).geo.patientGeocodeAllowed).toBe(false);
        expect(load({}).geo.patientGeocodeBasis).toBe('none');
        expect(load({ GEO_BAA_COVERS_PATIENT_ADDRESSES: 'false' }).geo.patientGeocodeAllowed).toBe(false);
    });

    it('still calls a dated grant what it is', () => {
        /* So go-live can block on the temporary one and pass the agreement.
           If both reported the same basis the check would be useless. */
        const config = load({ UH_PATIENT_GEOCODE_UNTIL: day(30) });
        expect(config.geo.patientGeocodeAllowed).toBe(true);
        expect(config.geo.patientGeocodeBasis).toBe('temporary grant');
    });
});
