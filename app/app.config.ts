/* Build-time configuration (ticket 7.6).
 *
 * app.json holds everything that does not change between builds. This file
 * holds the one thing that does, and refuses to produce a release build that
 * would be rejected: see src/lib/apiUrl.cjs for why a submitted app pointing
 * at 127.0.0.1 is a wasted review cycle rather than a bug somebody notices.
 *
 * It throws. That is the point. A build that stops with a sentence naming the
 * variable costs twenty seconds; one that succeeds and is rejected costs a
 * review.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
/* By its real extension, and it must stay that way. Expo transpiles THIS
   file with sucrase and then lets plain Node require whatever it imports, so
   an extensionless import of a .ts file throws at startup. */
import { resolveApiUrl } from './src/lib/apiUrl.cjs';

export default ({ config }: ConfigContext): ExpoConfig => {
    const apiBaseUrl = resolveApiUrl({
        configured: process.env['EXPO_PUBLIC_API_URL'],
        /* EAS sets this to the profile being built. Absent means somebody is
           running `expo start` on their own machine. */
        profile: process.env['EAS_BUILD_PROFILE'],
    });

    return {
        ...config,
        name: config.name ?? 'Izy Courier',
        slug: config.slug ?? 'izy-courier',
        extra: {
            ...config.extra,
            apiBaseUrl,
            /* ─────────────────────────────────────────────────────────────
             * TVHS TALKS TO A DIFFERENT SERVER FROM UH, ON PURPOSE.
             *
             * TVHS is live: two drivers file logs against it every day, and
             * the phone has to reach the same database the web portal does or
             * the two disagree. UH is still in test, so it stays on whatever
             * `apiBaseUrl` resolved to, which in development is the laptop.
             *
             * One app, two servers, chosen by the contract on the first
             * screen. That works because a session token belongs to the
             * server that issued it: see lib/api.ts, which keeps the base
             * that was in use when the driver signed in.
             *
             * Override with EXPO_PUBLIC_TVHS_API_URL to point TVHS somewhere
             * else, a staging copy for instance. Unset means production,
             * because that is where TVHS actually is.
             * ───────────────────────────────────────────────────────────── */
            tvhsApiBaseUrl: (process.env['EXPO_PUBLIC_TVHS_API_URL'] ?? 'https://logs.izyglobalservices.com').replace(/\/+$/, ''),
        },
        plugins: [
            ...(config.plugins ?? []),
            /* The camera, for a proof of delivery photo. iOS refuses to open
               it without a usage string and the store refuses the build, so
               this is not optional furniture.

               photosPermission is FALSE on purpose: lib/pod.ts opens the
               camera and never the library, because a picture chosen from
               the roll is not proof that anybody stood at a door. Asking for
               access to a courier's personal photos to deliver a parcel is a
               permission we should not hold. */
            ['expo-image-picker', {
                cameraPermission: 'Izy Courier uses the camera to photograph a doorstep as proof that a delivery was made.',
                photosPermission: false,
                microphonePermission: false,
            }],
        ],
    };
};
