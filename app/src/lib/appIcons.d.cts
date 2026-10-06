/* Types for appIcons.cjs, which is CommonJS because Expo's config loader can
 * only require plain JavaScript. See the header of apiUrl.cjs for why. */

export declare class AppIconError extends Error {
    constructor(message: string);
}

/** The iOS and store icon, relative to the app directory. */
export declare const ICON: string;

/** The Android adaptive foreground layer. */
export declare const ADAPTIVE_ICON: string;

/** The colour behind the Android foreground layer. */
export declare const ADAPTIVE_BACKGROUND: string;

export interface RequiredAsset {
    path: string;
    /** What this file is for, in a sentence a person can act on. */
    what: string;
    /** Size, format and the constraints each store enforces. */
    spec: string;
}

/** Every file that must exist before a release build. */
export declare const REQUIRED: RequiredAsset[];

export interface ResolveIconsInput {
    /** The EAS profile, or undefined when somebody is running expo start. */
    profile: string | undefined;
    /** Whether a path exists. Injected so the decision is testable. */
    exists: (path: string) => boolean;
    /** Called instead of throwing for an internal build with no artwork.
     *  Absent means say nothing. */
    warn?: (message: string) => void;
}

export interface IconConfig {
    icon?: string;
    android?: {
        adaptiveIcon: {
            foregroundImage: string;
            backgroundColor: string;
        };
    };
}

/** Icon configuration for this build, or a refusal naming what is missing. */
export declare function resolveIcons(input: ResolveIconsInput): IconConfig;
