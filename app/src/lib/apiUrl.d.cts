/* Types for apiUrl.cjs, which is CommonJS because Expo's config loader can
 * only require plain JavaScript. See the header of apiUrl.cjs for why.
 *
 * Hand-written rather than generated: it is three exports, and a build step
 * to produce a declaration for a twenty-line guard is a build step that can
 * itself break the build. */

export declare class ApiUrlError extends Error {
    constructor(message: string);
}

/** Where a development build points when nothing says otherwise. */
export declare const DEV_FALLBACK: string;

export interface ResolveInput {
    /** EXPO_PUBLIC_API_URL, or whatever the build was given. */
    configured: string | undefined;
    /** The EAS profile, or undefined when somebody is running expo start. */
    profile: string | undefined;
}

/** The base URL for this build, or a refusal explaining what to set. */
export declare function resolveApiUrl(input: ResolveInput): string;
