/* Looking an address up once, and not more than N times a day.
 *
 * Ticket 1.4. The provider in provider.ts knows how to ask a vendor. This
 * knows when not to.
 *
 * CACHE FIRST, ALWAYS. Every lookup is a disclosure to a third party, so the
 * cheapest lookup is the one that does not happen. A cached answer is not an
 * optimisation here, it is a control: the nine University Health pharmacies
 * are sent to a vendor once, not once per delivery for a year.
 *
 * THEN THE CEILING. A geocoding bill is one runaway retry loop away from
 * being a surprise, and the count lives in the database rather than in memory
 * so that it survives a restart and is shared by however many instances there
 * are. Reaching it refuses; it never silently returns a worse answer, because
 * a made-up coordinate is worse than no coordinate and this system already
 * refuses rather than guessing everywhere else that matters.
 */

import type { Client } from '@libsql/client';
import {
    addressKey, type Address, type GeoProvider, type GeoScope,
    type GeocodeResult, type GeocodeQuality, GeoUnavailableError,
} from './provider';

/** Lookups per provider per day. Nine pharmacies and a few hundred
 *  deliveries do not come near it; a loop does, immediately. */
export const DAILY_LOOKUP_CEILING = 2500;

export class GeoQuotaError extends Error {
    constructor(public readonly used: number, public readonly ceiling: number) {
        super(`The daily address lookup limit of ${ceiling} has been reached (${used} used). `
            + 'Nothing further will be looked up today. If this is unexpected, something is retrying.');
        this.name = 'GeoQuotaError';
    }
}

export interface LookupDeps {
    client: Client;
    provider: GeoProvider;
    /** The operating day, so the count resets with the contract's clock. */
    today: () => string;
    ceiling?: number;
}

export interface CachedGeocode extends GeocodeResult {
    /** True when no third party was asked. */
    cached: boolean;
}

const iso = () => new Date().toISOString();

export function createGeoLookup({ client, provider, today, ceiling = DAILY_LOOKUP_CEILING }: LookupDeps) {
    async function readCache(key: string): Promise<GeocodeResult | null> {
        const rs = await client.execute({
            sql: 'SELECT lat, lng, quality, formatted, provider FROM geocodes WHERE address_key = ?',
            args: [key],
        });
        const row = rs.rows[0];
        if (!row) return null;
        return {
            point: { lat: Number(row['lat']), lng: Number(row['lng']) },
            quality: String(row['quality']) as GeocodeQuality,
            formatted: String(row['formatted']),
            provider: String(row['provider']),
        };
    }

    async function usageRow(): Promise<{ id: string; lookups: number }> {
        const day = today();
        const id = `${provider.name}:${day}`;
        await client.execute({
            sql: `INSERT INTO geo_usage (id, provider, day, lookups, refused) VALUES (?, ?, ?, 0, 0)
                  ON CONFLICT(id) DO NOTHING`,
            args: [id, provider.name, day],
        });
        const rs = await client.execute({ sql: 'SELECT lookups FROM geo_usage WHERE id = ?', args: [id] });
        return { id, lookups: Number(rs.rows[0]?.['lookups'] ?? 0) };
    }

    return {
        /** What has been spent today, for a screen and for an alarm. */
        async usage(): Promise<{ day: string; lookups: number; refused: number; ceiling: number }> {
            const day = today();
            const rs = await client.execute({
                sql: 'SELECT lookups, refused FROM geo_usage WHERE id = ?',
                args: [`${provider.name}:${day}`],
            });
            const row = rs.rows[0];
            return {
                day,
                lookups: Number(row?.['lookups'] ?? 0),
                refused: Number(row?.['refused'] ?? 0),
                ceiling,
            };
        },

        /**
         * The cached point for an address, or null. Asks nobody.
         *
         * Useful on a read path that wants coordinates if they are already
         * known and must not spend money or disclose anything to get them.
         */
        async cached(address: Address): Promise<GeocodeResult | null> {
            return readCache(addressKey(address));
        },

        /**
         * Cache, then ceiling, then the provider.
         *
         * Throws GeoUnavailableError when nothing is configured, or when the
         * provider is not permitted this scope. Throws GeoQuotaError at the
         * ceiling. Never invents a point.
         */
        async geocode(address: Address, scope: GeoScope): Promise<CachedGeocode> {
            const key = addressKey(address);
            if (key === '') throw new GeoUnavailableError('There is no address to look up.');

            const hit = await readCache(key);
            if (hit) return { ...hit, cached: true };

            if (!provider.available) throw new GeoUnavailableError(provider.reason ?? 'No address lookup is configured.');

            const { id, lookups } = await usageRow();
            if (lookups >= ceiling) {
                await client.execute({ sql: 'UPDATE geo_usage SET refused = refused + 1 WHERE id = ?', args: [id] });
                throw new GeoQuotaError(lookups, ceiling);
            }

            /* Counted before the call, not after. A provider that times out
             * still cost us a request, and counting successes only is how a
             * retry loop runs all night inside its own limit. */
            await client.execute({ sql: 'UPDATE geo_usage SET lookups = lookups + 1 WHERE id = ?', args: [id] });

            const result = await provider.geocode(address, scope);

            await client.execute({
                sql: `INSERT INTO geocodes (address_key, scope, lat, lng, quality, formatted, provider, looked_up_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(address_key) DO UPDATE SET
                        lat = excluded.lat, lng = excluded.lng, quality = excluded.quality,
                        formatted = excluded.formatted, provider = excluded.provider,
                        looked_up_at = excluded.looked_up_at`,
                args: [key, scope, result.point.lat, result.point.lng, result.quality, result.formatted, result.provider, iso()],
            });

            return { ...result, cached: false };
        },
    };
}

export type GeoLookup = ReturnType<typeof createGeoLookup>;
