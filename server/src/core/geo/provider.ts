/* Turning an address into a point, and two points into road miles.
 *
 * Ticket 1.4.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE GEOCODING A PATIENT'S ADDRESS.
 *
 * A delivery address held by a pharmacy is protected health information. Send
 * one to a third party and that is a disclosure, which under HIPAA needs a
 * business associate agreement with that third party.
 *
 * **Google Maps Platform is not covered by Google's BAA.** Google signs BAAs
 * for a listed set of Workspace and Cloud services; the Maps APIs are not on
 * that list, and Google's own terms say the Maps services are not for
 * protected health information. So this integration, as the ticket originally
 * described it, cannot legally be pointed at patient addresses.
 *
 * What that leaves, and what this module is built for:
 *
 *   SITES ARE NOT PHI. A University Health pharmacy's street address is a
 *   business address. Geocoding those through anybody is fine, and it is what
 *   unblocks measuring a route FROM an origin.
 *
 *   PATIENT ADDRESSES NEED A DIFFERENT VENDOR. AWS Location Service is a
 *   HIPAA-eligible service under the AWS BAA, and ticket 0.10 already opens
 *   an AWS account with a BAA for the photograph bucket. That is the obvious
 *   answer and it is a decision, not a refactor: everything below is behind
 *   an interface for exactly that reason.
 *
 * Until that decision is made, the provider is configured with a scope, and
 * asking it to geocode something it is not scoped for is refused rather than
 * quietly allowed. A control that depends on nobody passing the wrong
 * argument is not a control.
 * ─────────────────────────────────────────────────────────────────────────
 */

export class GeoUnavailableError extends Error {
    constructor(public readonly reason: string) {
        super(reason);
        this.name = 'GeoUnavailableError';
    }
}

/** What a caller is asking us to look up, and therefore what may be sent. */
export type GeoScope =
    /** A business address: a pharmacy, a hospital, our own premises. */
    | 'site'
    /** A patient's delivery address. PHI. */
    | 'patient';

export interface Address {
    line1: string;
    line2?: string | undefined;
    city: string;
    state: string;
    zip: string;
}

export interface Point { lat: number; lng: number }

export type GeocodeQuality = 'rooftop' | 'interpolated' | 'centroid' | 'approximate';

export interface GeocodeResult {
    point: Point;
    quality: GeocodeQuality;
    /** What the provider thinks the address is. Never shown to a patient. */
    formatted: string;
    /** Which provider answered, recorded so a stale point can be traced. */
    provider: string;
}

export interface DistanceResult {
    /** One-way road miles, which is what the contract bills. */
    miles: number;
    /** Driving seconds, for sequencing rather than billing. */
    seconds: number;
    provider: string;
}

export interface GeoProvider {
    readonly name: string;
    readonly available: boolean;
    /** Why it is unavailable, in words somebody can act on. */
    readonly reason: string | null;
    /** Scopes this provider is permitted to be asked about. */
    readonly scopes: readonly GeoScope[];
    geocode(address: Address, scope: GeoScope): Promise<GeocodeResult>;
    /** One-way road distance. Origin first, as the contract measures it. */
    distance(from: Point, to: Point): Promise<DistanceResult>;
}

/** The address as one line, which is what every provider wants. */
export function formatAddress(a: Address): string {
    return [a.line1, a.line2, a.city, `${a.state} ${a.zip}`.trim()]
        .map((part) => (part ?? '').trim())
        .filter(Boolean)
        .join(', ');
}

/**
 * The cache key, and the reason the cache exists.
 *
 * Money is the small reason: the same pharmacy is looked up once rather than
 * once per delivery. The real reason is that a lookup is a disclosure, and a
 * cached answer is a disclosure that does not happen again.
 *
 * Case, spacing and punctuation are removed so that "1100 Broadway St." and
 * "1100 broadway st" are one key rather than two lookups of the same house.
 */
export function addressKey(a: Address): string {
    return formatAddress(a)
        .toLowerCase()
        .replace(/[.,#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A provider that refuses everything, and says why. */
export function unavailableProvider(reason: string): GeoProvider {
    return {
        name: 'none',
        available: false,
        reason,
        scopes: [],
        geocode() { return Promise.reject(new GeoUnavailableError(reason)); },
        distance() { return Promise.reject(new GeoUnavailableError(reason)); },
    };
}

/**
 * Wraps a provider so that it can only be asked about what it is permitted to
 * be asked about.
 *
 * The refusal is the point. Somebody will eventually write a loop that
 * geocodes orders, and if the only thing standing between that loop and a
 * disclosure is a comment, the comment loses.
 */
export function scopedTo(provider: GeoProvider, scopes: readonly GeoScope[]): GeoProvider {
    return {
        ...provider,
        scopes,
        async geocode(address, scope) {
            if (!scopes.includes(scope)) {
                throw new GeoUnavailableError(
                    `${provider.name} is not permitted to be sent a ${scope} address. `
                    + (scope === 'patient'
                        ? 'A delivery address is protected health information and this provider has no business associate agreement. See src/core/geo/provider.ts.'
                        : `Permitted: ${scopes.join(', ') || 'nothing'}.`),
                );
            }
            return provider.geocode(address, scope);
        },
    };
}
