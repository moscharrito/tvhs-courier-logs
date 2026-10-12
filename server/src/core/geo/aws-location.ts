/* Amazon Location Service, by hand.
 *
 * Ticket 7.11.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS PROVIDER EXISTS AND GOOGLE'S DOES NOT COVER IT.
 *
 * A patient's delivery address is protected health information. Google Maps
 * Platform is not on Google's BAA covered-services list and their terms
 * exclude PHI, so google.ts is scoped to `site` and refuses everything else
 * -- in provider.ts, in code, not in a comment.
 *
 * Amazon Location Service is HIPAA-eligible and the BAA covering it was
 * signed on 12 October 2026. That is the whole reason this file can be
 * scoped to `patient` when the other one cannot. If that agreement ever
 * lapses, the fix is to drop 'patient' from `scopes` below and the refusal
 * reappears everywhere at once.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IntendedUse=Storage IS A LEGAL SETTING, NOT A PERFORMANCE ONE.
 *
 * A place index is created with IntendedUse either SingleUse or Storage.
 * SingleUse means the result may be displayed and then must be thrown away;
 * Storage means it may be kept. This system writes lat/lng onto the order
 * row and keeps it, so the index MUST be created with Storage or every
 * geocode is a licence breach. docs/infra/create-location-resources.sh
 * creates it that way and says so; there is no way for this file to check
 * it from here, which is exactly why it is written down in both places.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * [LONGITUDE, LATITUDE]. IN THAT ORDER.
 *
 * Amazon Location speaks GeoJSON, where a position is [lng, lat]. Almost
 * every other thing in this codebase says lat first, because that is how a
 * person says it. Getting this backwards does not throw: it silently puts
 * San Antonio in the Indian Ocean, every distance becomes enormous, and the
 * out-of-area mileage line on an invoice is wrong rather than missing. The
 * conversion happens here, once, at the boundary, and the tests assert the
 * order explicitly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO RETRIES, same as google.ts. A geocoding failure is not urgent -- the
 * caller is a job that can run again -- and a retry loop inside a paid API
 * is how a bill becomes a surprise.
 */

import {
    formatAddress, type Address, type DistanceResult, type GeoProvider,
    type GeocodeQuality, type GeocodeResult, GeoUnavailableError,
} from './provider';
import { signedHeaders } from '../files/sigv4';

export interface AwsLocationDeps {
    region: string;
    /** The place index, created with IntendedUse=Storage. */
    placeIndexName: string;
    /** The route calculator, for road miles. */
    routeCalculatorName: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Injected so the tests can answer with a recorded response. */
    fetchImpl?: typeof fetch;
    /** Overridden in tests; never in production. Host only, no scheme. */
    placesHost?: string;
    routesHost?: string;
    /** Overridden in tests so a signature is reproducible. */
    now?: () => Date;
}

interface SearchResponse {
    Results?: Array<{
        Place?: {
            Geometry?: { Point?: number[] };
            Label?: string;
        };
        /** 0 to 1. Amazon's confidence, not a location type. */
        Relevance?: number;
    }>;
}

interface RouteResponse {
    Summary?: {
        Distance?: number;
        DurationSeconds?: number;
        DistanceUnit?: string;
    };
}

/**
 * Relevance, mapped onto what this application distinguishes.
 *
 * Amazon gives a 0-to-1 score rather than Google's location_type, so this is
 * a judgement rather than a translation. The bands are deliberately
 * pessimistic: `rooftop` is the only one that lets a dispatcher stop
 * checking, and claiming it for a 0.8 match would be the sort of quiet
 * overstatement that puts a courier on the wrong street.
 */
export function qualityOf(relevance: number | undefined): GeocodeQuality {
    if (typeof relevance !== 'number') return 'approximate';
    if (relevance >= 0.95) return 'rooftop';
    if (relevance >= 0.85) return 'interpolated';
    if (relevance >= 0.6) return 'centroid';
    return 'approximate';
}

const MILES_PER_KM = 0.621371;

export function createAwsLocationProvider(deps: AwsLocationDeps): GeoProvider {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const now = deps.now ?? (() => new Date());
    const placesHost = deps.placesHost ?? `places.geo.${deps.region}.amazonaws.com`;
    const routesHost = deps.routesHost ?? `routes.geo.${deps.region}.amazonaws.com`;

    /** One signed POST. The body is signed, so it is sent byte for byte. */
    async function call<T>(host: string, path: string, payload: unknown, what: string): Promise<T> {
        /* Serialised ONCE and both signed and sent. Serialising twice can
           produce different bytes and the signature then does not match the
           body, which AWS answers as 403 with nothing useful in it. */
        const body = JSON.stringify(payload);
        const headers = signedHeaders({
            method: 'POST',
            host,
            path,
            region: deps.region,
            service: 'geo',
            accessKeyId: deps.accessKeyId,
            secretAccessKey: deps.secretAccessKey,
            body,
            at: now(),
            headers: { 'content-type': 'application/json' },
        });

        let res: Response;
        try {
            res = await fetchImpl(`https://${host}${path}`, { method: 'POST', headers, body });
        } catch (err) {
            /* A DNS failure or a timeout. Never the address in the message:
               this error is logged, and a delivery address in a log is the
               disclosure the whole provider exists to control. */
            throw new GeoUnavailableError(
                `Amazon Location could not be reached (${err instanceof Error ? err.name : 'error'}).`,
            );
        }

        if (!res.ok) {
            /* The status and AWS's own error type, never the body, for the
               same reason. A 403 here is almost always the signature or a
               missing geo:SearchPlaceIndexForText on the key. */
            const type = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? `HTTP ${res.status}`;
            throw new GeoUnavailableError(`Amazon Location refused the ${what}: ${type}.`);
        }

        return await res.json() as T;
    }

    return {
        name: 'aws-location',
        available: true,
        reason: null,
        /* Both, which is the point of this file. The refusal that matters is
           still enforced in provider.ts by scopedTo(), so dropping 'patient'
           here is all it takes to turn patient geocoding off everywhere. */
        scopes: ['site', 'patient'],

        async geocode(address: Address): Promise<GeocodeResult> {
            const body = await call<SearchResponse>(
                placesHost,
                `/places/v0/indexes/${encodeURIComponent(deps.placeIndexName)}/search/text`,
                {
                    Text: formatAddress(address),
                    MaxResults: 1,
                    /* The contract is Bexar County. Without this a thin
                       address can match a street of the same name in another
                       country and arrive looking like a confident answer. */
                    FilterCountries: ['USA'],
                },
                'address lookup',
            );

            const top = body.Results?.[0];
            const point = top?.Place?.Geometry?.Point;
            if (!Array.isArray(point) || point.length < 2
                || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
                throw new GeoUnavailableError('Amazon Location returned no match for that address.');
            }

            /* [lng, lat] in, lat/lng out. See the header. */
            return {
                point: { lat: point[1], lng: point[0] },
                quality: qualityOf(top?.Relevance),
                formatted: top?.Place?.Label ?? formatAddress(address),
                provider: 'aws-location',
            };
        },

        async distance(from, to): Promise<DistanceResult> {
            const body = await call<RouteResponse>(
                routesHost,
                `/routes/v0/calculators/${encodeURIComponent(deps.routeCalculatorName)}/calculate/route`,
                {
                    DeparturePosition: [from.lng, from.lat],
                    DestinationPosition: [to.lng, to.lat],
                    TravelMode: 'Car',
                    /* Asked for in miles because miles are what the contract
                       bills. The unit is checked on the way out anyway: a
                       calculator that answered in kilometres and was read as
                       miles would overbill out-of-area mileage by 60%. */
                    DistanceUnit: 'Miles',
                },
                'distance lookup',
            );

            const summary = body.Summary;
            if (typeof summary?.Distance !== 'number' || typeof summary.DurationSeconds !== 'number') {
                throw new GeoUnavailableError('Amazon Location returned no route between those points.');
            }

            const unit = (summary.DistanceUnit ?? 'Miles').toLowerCase();
            const miles = unit.startsWith('kilo') || unit === 'km'
                ? summary.Distance * MILES_PER_KM
                : summary.Distance;

            return { miles, seconds: summary.DurationSeconds, provider: 'aws-location' };
        },
    };
}
