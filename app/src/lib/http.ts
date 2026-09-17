/* Talking to the server, with no React Native in it (ticket 7.1).
 *
 * Deliberately pure: this module imports nothing from expo or react-native,
 * takes its token and its base URL as arguments, and therefore runs under
 * vitest on a laptop. Everything that cannot be tested without a simulator
 * lives in session.ts and api.ts, which are thin wrappers around this.
 *
 * WHY A TOKEN AND NOT A COOKIE. The web shell uses a cookie and will carry on
 * doing so. React Native's fetch does have a cookie jar on both platforms, so
 * relying on it would work on a good day, and it is still the wrong answer:
 * the jar is shared process-wide, persists differently on iOS and Android,
 * cannot be inspected by the app, and cannot be put in the Keychain. The
 * server grew an explicit bearer path for exactly this (ticket 7.1,
 * server/src/core/auth/sessions.ts) and hands the token to a client that asks
 * for it by header, instead of setting a cookie.
 */

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly details: string[] = [],
        public readonly code?: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

/** Sent on login to ask for a token instead of a cookie. */
export const CLIENT_HEADER = 'X-Izy-Client';
export const CLIENT_VALUE = 'app';

/** Joins a base and a path without doubling or dropping the slash. */
export function apiUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const rest = path.startsWith('/') ? path : `/${path}`;
    return `${base}${rest}`;
}

export interface RequestOptions {
    method?: string;
    json?: unknown;
    /** Null when nobody is signed in. */
    token?: string | null;
    /** Ask for a token in the response body rather than a cookie. */
    asApp?: boolean;
    signal?: AbortSignal;
}

export function headersFor(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.json !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.asApp) headers[CLIENT_HEADER] = CLIENT_VALUE;
    return headers;
}

/** Thrown when the server says the credential is no good. Callers sign out. */
export const isUnauthorized = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

export type Fetcher = typeof fetch;

/**
 * One request. Returns the parsed body, or throws ApiError.
 *
 * `fetcher` is injected so the tests below drive it without a network, and so
 * that nothing here depends on which runtime's fetch is in scope.
 */
export async function request<T>(
    fetcher: Fetcher,
    baseUrl: string,
    path: string,
    options: RequestOptions = {},
): Promise<T> {
    const res = await fetcher(apiUrl(baseUrl, path), {
        method: options.method ?? 'GET',
        headers: headersFor(options),
        ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    });

    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    if (!res.ok) {
        const b = (body ?? {}) as { error?: string; details?: string[]; code?: string };
        /* A phone loses signal mid-delivery, so the message a courier reads
           has to mean something without a network tab open. */
        throw new ApiError(
            res.status,
            b.error || (res.status >= 500 ? 'Dispatch is not answering. Try again in a moment.' : `Request failed (${res.status})`),
            b.details ?? [],
            b.code,
        );
    }
    return body as T;
}
