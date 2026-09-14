/* Google Geocoding and Distance Matrix, by hand.
 *
 * Ticket 1.4. Two GET requests with a key in the query string; the AWS SDK
 * argument from the SigV4 signer applies again, only more so, because there
 * is nothing to sign here.
 *
 * SCOPE. This provider is wired up for SITE addresses only. A University
 * Health pharmacy's street address is a business address and sending it to
 * Google is unremarkable. A patient's delivery address is protected health
 * information, Google Maps Platform is not covered by Google's BAA, and its
 * terms exclude PHI. The refusal lives in scopedTo() in provider.ts rather
 * than in this comment, because a comment does not stop a loop.
 *
 * WHAT IT DOES NOT DO. No retries. A geocoding failure is not urgent: the
 * caller is a job that can run again, and a retry loop inside a paid API is
 * how a bill becomes a surprise. The daily ceiling in lookup.ts counts the
 * attempt either way.
 */

import {
    formatAddress, type Address, type DistanceResult, type GeoProvider,
    type GeocodeQuality, type GeocodeResult, GeoUnavailableError,
} from './provider';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const METRES_PER_MILE = 1609.344;

/** Google's location_type, mapped to what this application distinguishes. */
export function qualityOf(locationType: string): GeocodeQuality {
    switch (locationType) {
        case 'ROOFTOP': return 'rooftop';
        case 'RANGE_INTERPOLATED': return 'interpolated';
        case 'GEOMETRIC_CENTER': return 'centroid';
        default: return 'approximate';
    }
}

export interface GoogleDeps {
    apiKey: string;
    /** Injected so the tests can answer with a recorded response. */
    fetchImpl?: typeof fetch;
    /** Overridden in tests; never in production. */
    geocodeUrl?: string;
    matrixUrl?: string;
}

interface GeocodeResponse {
    status: string;
    error_message?: string;
    results?: Array<{
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
    }>;
}

interface MatrixResponse {
    status: string;
    error_message?: string;
    rows?: Array<{
        elements?: Array<{
            status?: string;
            distance?: { value?: number };
            duration?: { value?: number };
        }>;
    }>;
}

/** Google says OK and then tells you the truth in the body. */
function assertOk(status: string, message: string | undefined, what: string): void {
    if (status === 'OK') return;
    if (status === 'ZERO_RESULTS') {
        throw new GeoUnavailableError(`Google could not find ${what}. Check the address against the pharmacy's own record.`);
    }
    if (status === 'OVER_QUERY_LIMIT' || status === 'OVER_DAILY_LIMIT') {
        throw new GeoUnavailableError(`Google refused the request: ${status}. Billing or quota on the key needs attention.`);
    }
    if (status === 'REQUEST_DENIED') {
        throw new GeoUnavailableError(`Google denied the request: ${message ?? 'no reason given'}. The key is wrong, restricted, or the API is not enabled.`);
    }
    throw new GeoUnavailableError(`Google answered ${status}${message ? `: ${message}` : ''}.`);
}

export function createGoogleProvider({ apiKey, fetchImpl = fetch, geocodeUrl = GEOCODE_URL, matrixUrl = MATRIX_URL }: GoogleDeps): GeoProvider {
    return {
        name: 'google',
        available: true,
        reason: null,
        /* Sites only. The wiring in legacy.ts wraps this in scopedTo, and this
         * field is what that wrapper reports; it is stated here as well so
         * that reading the provider on its own does not suggest otherwise. */
        scopes: ['site'],

        async geocode(address: Address): Promise<GeocodeResult> {
            const url = new URL(geocodeUrl);
            /* The address and nothing else. No patient name, no delivery
             * note, no order reference: a URL leaves this application and
             * reaches a third party's logs. */
            url.searchParams.set('address', formatAddress(address));
            url.searchParams.set('key', apiKey);
            url.searchParams.set('region', 'us');

            const res = await fetchImpl(url.toString(), { method: 'GET' });
            if (!res.ok) throw new GeoUnavailableError(`Google geocoding answered HTTP ${res.status}.`);
            const body = await res.json() as GeocodeResponse;
            assertOk(body.status, body.error_message, 'that address');

            const first = body.results?.[0];
            const lat = first?.geometry?.location?.lat;
            const lng = first?.geometry?.location?.lng;
            if (typeof lat !== 'number' || typeof lng !== 'number') {
                throw new GeoUnavailableError('Google answered OK with no coordinates in it.');
            }
            return {
                point: { lat, lng },
                quality: qualityOf(String(first?.geometry?.location_type ?? '')),
                formatted: String(first?.formatted_address ?? ''),
                provider: 'google',
            };
        },

        async distance(from, to): Promise<DistanceResult> {
            const url = new URL(matrixUrl);
            /* Coordinates, not addresses: by this point the address has
             * already been resolved, and sending it again would be a second
             * disclosure for no gain. */
            url.searchParams.set('origins', `${from.lat},${from.lng}`);
            url.searchParams.set('destinations', `${to.lat},${to.lng}`);
            url.searchParams.set('units', 'imperial');
            url.searchParams.set('mode', 'driving');
            url.searchParams.set('key', apiKey);

            const res = await fetchImpl(url.toString(), { method: 'GET' });
            if (!res.ok) throw new GeoUnavailableError(`Google distance answered HTTP ${res.status}.`);
            const body = await res.json() as MatrixResponse;
            assertOk(body.status, body.error_message, 'a route between those points');

            const element = body.rows?.[0]?.elements?.[0];
            if (!element || element.status !== 'OK' || typeof element.distance?.value !== 'number') {
                throw new GeoUnavailableError(`Google found no route: ${element?.status ?? 'no answer'}.`);
            }
            return {
                /* Metres to miles here rather than trusting the text field,
                 * which is localised and rounded. The invoice multiplies this
                 * by a rate, so it is arithmetic and not a label. */
                miles: element.distance.value / METRES_PER_MILE,
                seconds: Number(element.duration?.value ?? 0),
                provider: 'google',
            };
        },
    };
}
