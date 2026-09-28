/* Which server a contract lives on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE APP, TWO SERVERS.
 *
 * TVHS is live. Two drivers file logs against it every day and an
 * administrator reads one report over both the phone and the web portal, so
 * the phone has to reach the same database the portal does. UH is still in
 * test, and while it is, it points at whatever the build was told: the
 * laptop in development, a staging service later.
 *
 * Pure and in its own file so it can be tested. `api.ts` imports
 * expo-constants, which a unit test cannot load, and this decision is the
 * part worth having a test for: sending a production session token to a
 * laptop produces a 401 that reads like an expired session rather than a
 * misdirected one, and that is a confusing afternoon.
 * ───────────────────────────────────────────────────────────────────────── */

export interface ServerConfig {
    /** The default. UH, and anything before a contract has been chosen. */
    apiBaseUrl?: string | undefined;
    /** TVHS only. Unset falls back to the default rather than failing. */
    tvhsApiBaseUrl?: string | undefined;
}

export class NoServerError extends Error {
    constructor() {
        super(
            'This build has no apiBaseUrl. app.config.ts sets it from EXPO_PUBLIC_API_URL, so either the '
            + 'config did not load or the variable is unset for this profile. It is not defaulted to '
            + 'localhost on purpose: see src/lib/apiUrl.cjs.',
        );
        this.name = 'NoServerError';
    }
}

const clean = (v: string | undefined): string => (v ?? '').trim().replace(/\/+$/, '');

/** The default server. Throws rather than guessing: see apiUrl.cjs. */
export function defaultServer(config: ServerConfig): string {
    const url = clean(config.apiBaseUrl);
    if (url === '') throw new NoServerError();
    return url;
}

/**
 * The server for one contract.
 *
 * FALLS BACK RATHER THAN FAILING when a contract has no server of its own.
 * A build that was never told where TVHS lives should still work against the
 * default, because that is what every build before this change did and a
 * driver on the road is not helped by a purist error message.
 */
export function serverForContract(config: ServerConfig, code: string): string {
    if (code === 'tvhs') {
        const tvhs = clean(config.tvhsApiBaseUrl);
        if (tvhs !== '') return tvhs;
    }
    return defaultServer(config);
}
