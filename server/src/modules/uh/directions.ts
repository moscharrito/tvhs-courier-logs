/* The map a courier looks at without leaving the app (ticket 5.13).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE TURNING THE EMBED ON.
 *
 * Until this file existed, a courier tapped "Directions" and their browser
 * went to Google Maps. The patient's address reached Google because a person
 * holding the package asked their own navigation app how to get there. That
 * is the same disclosure a courier makes by typing the address into the phone
 * they already carry, and it is attributable to them.
 *
 * An EMBED IS NOT THE SAME ACT. It makes this application the sender: every
 * stop on every run resolves a patient address through Google's Embed API
 * under OUR key, in OUR Cloud project, in a quota and a log we own, without
 * anybody tapping anything. Google's BAA does not cover the Maps Platform and
 * Google's terms say the Maps services are not for protected health
 * information, which is why src/core/geo/provider.ts refuses to geocode a
 * patient address at all. This module would drive a truck through that.
 *
 * So the embed is behind ITS OWN SWITCH, not behind the key. A key exists so
 * that PHARMACY SITES can be geocoded, which is lawful because a hospital's
 * street address is a business address. Letting the presence of that key also
 * start streaming patient addresses to Google would be exactly the kind of
 * quiet coupling this codebase keeps refusing. UH_MAPS_EMBED is a second,
 * deliberate decision, and the honest precondition for setting it is a signed
 * agreement that covers this traffic, or a map vendor that has one.
 *
 * When it is off, and it is off by default, the server says so and the phone
 * falls back to the link it has always had. The feature degrades to the
 * status quo rather than to a blank frame.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The ADDRESS ONLY crosses this boundary, never the patient's name. That rule
 * predates this file (see web/src/pages/uh/MyRun.tsx) and the reason is
 * unchanged: an address is what it takes to drive there, and the name adds
 * nothing to the navigation and everything to the disclosure.
 */

import type { Config } from '../../config';

export interface Destination {
    address: string;
    city: string;
    zip: string;
}

/** Where the courier is driving from, if the phone offered it. */
export interface Origin {
    lat: number;
    lng: number;
}

export interface DirectionsAnswer {
    /** Whether an in-app map may be drawn at all. */
    available: boolean;
    /** The iframe source, or null when it may not. */
    embedUrl: string | null;
    /** Always present: the link that has worked since day one. */
    mapsUrl: string;
    /** Said out loud on the screen when there is no embed. */
    why: string;
}

/** The origin the embed is served from. The CSP opens this and nothing else. */
export const MAPS_EMBED_ORIGIN = 'https://www.google.com';

/** Address, city and zip, joined the way a person would write them. */
export function destinationQuery(to: Destination): string {
    return [to.address, to.city, to.zip].map((s) => s.trim()).filter(Boolean).join(', ');
}

/** The tap-out link. The same URL the courier app has always opened. */
export function mapsUrl(to: Destination): string {
    return `${MAPS_EMBED_ORIGIN}/maps/search/?api=1&query=${encodeURIComponent(destinationQuery(to))}`;
}

/** A position is only usable if it is a real point on Earth. */
export function validOrigin(origin: Origin | null | undefined): origin is Origin {
    if (!origin) return false;
    const { lat, lng } = origin;
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/**
 * What the phone should show for one stop.
 *
 * With a position, this is a route: turn-by-turn from where the courier is
 * standing. Without one, it is the destination on a map, which is still worth
 * showing and is what a phone with location denied will get.
 */
export function directionsFor(
    config: Pick<Config, 'geo'>,
    to: Destination,
    origin?: Origin | null,
): DirectionsAnswer {
    const link = mapsUrl(to);
    const query = destinationQuery(to);

    if (!query) {
        return { available: false, embedUrl: null, mapsUrl: link, why: 'This stop has no address on it.' };
    }
    if (!config.geo.embedMaps) {
        return {
            available: false,
            embedUrl: null,
            mapsUrl: link,
            why: 'The in-app map is turned off, so directions open in Google Maps.',
        };
    }
    if (!config.geo.googleApiKey) {
        return {
            available: false,
            embedUrl: null,
            mapsUrl: link,
            why: 'No map key is configured, so directions open in Google Maps.',
        };
    }

    const key = encodeURIComponent(config.geo.googleApiKey);
    if (validOrigin(origin)) {
        const from = `${origin.lat},${origin.lng}`;
        return {
            available: true,
            embedUrl: `${MAPS_EMBED_ORIGIN}/maps/embed/v1/directions?key=${key}`
                + `&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(query)}&mode=driving`,
            mapsUrl: link,
            why: '',
        };
    }
    return {
        available: true,
        embedUrl: `${MAPS_EMBED_ORIGIN}/maps/embed/v1/place?key=${key}&q=${encodeURIComponent(query)}`,
        mapsUrl: link,
        why: 'Location is off on this phone, so this is the destination rather than a route.',
    };
}

/** Parses the `origin=lat,lng` query parameter. Anything else is no origin. */
export function parseOrigin(raw: string | undefined): Origin | null {
    if (!raw) return null;
    const parts = raw.split(',');
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    const origin = { lat, lng };
    return validOrigin(origin) ? origin : null;
}
