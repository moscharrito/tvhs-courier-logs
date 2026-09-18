/* Types for apiUrl.cjs, which is CommonJS because Expo's config loader can
 * only require plain JavaScript. See the header of apiUrl.cjs for why.
 *
 * Hand-written rather than generated: it is three exports, and a build step
 * to produce a declaration for a twenty-line guard is a build step that can
 * itself break the build. */

export declare class ApiUrlError extends Error {
    constructor(message: string);
}

/** Last resort for a development build on a machine with no network. */
export declare const DEV_FALLBACK: string;

/** The port the API server listens on in development. */
export declare const DEV_PORT: number;

/** One entry of Node's os.networkInterfaces() map. */
export interface NetworkAddress {
    address: string;
    family: string | number;
    internal: boolean;
}

/** The first real IPv4 address in the map, or null. Exported for the tests. */
export declare function lanAddress(
    interfaces: Record<string, NetworkAddress[] | undefined> | undefined,
): string | null;

export interface ResolveInput {
    /** EXPO_PUBLIC_API_URL, or whatever the build was given. */
    configured: string | undefined;
    /** The EAS profile, or undefined when somebody is running expo start. */
    profile: string | undefined;
    /** Injectable for tests. Defaults to os.networkInterfaces(). */
    interfaces?: Record<string, NetworkAddress[] | undefined>;
}

/** The base URL for this build, or a refusal explaining what to set. */
export declare function resolveApiUrl(input: ResolveInput): string;
